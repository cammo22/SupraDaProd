// Main-thread handle to the inference worker.
import { Rpc, Transfer } from "../workers/rpc";
import { baseUrl, deviceMemoryGB, isAndroid, wasmThreads, webgpuAvailable } from "../lib/platform";
import { isFlowConfig, type Manifest } from "../lib/models";
import type { ModelSpec } from "../lib/registry";
import { type Store, readAll, readJson, readText } from "../lib/storage/types";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult, InitArgs, TokenizerPayload } from "./protocol";
import { errMsg } from "../lib/errors";

export type BackendPref = "auto" | "webgpu" | "wasm";
export type MemoryPref = "auto" | "fast" | "lean";

export interface EngineOptions {
  store: Store;
  spec: ModelSpec;
  manifest: Manifest;
  backend: BackendPref;
  memory: MemoryPref;
  onEvent?: (e: EngineEvent) => void;
}

export function pickLean(pref: MemoryPref): boolean {
  if (pref === "lean") return true;
  if (pref === "fast") return false;
  return isAndroid || (deviceMemoryGB() ?? 8) <= 4;
}

const aborted = () => new DOMException("aborted", "AbortError");

export class EngineClient {
  private worker: Worker | null = null;
  private rpc: Rpc | null = null;
  backend: Backend = "wasm";
  lean = false;
  readonly spec: ModelSpec;

  constructor(private opts: EngineOptions) {
    this.spec = opts.spec;
  }

  get running(): boolean {
    return !!this.worker;
  }

  /** Which repo file backs each network, for the engine worker. */
  private roles(): Record<string, string> {
    const { manifest } = this.opts;
    const cfg = manifest.config;
    if (isFlowConfig(cfg)) return { dit: cfg.dit, t5: cfg.text_encoder, vae: cfg.vae_decoder };
    const find = (re: RegExp) => manifest.files.find((f) => re.test(f.path) && !/\.(data|pb|bin)$/.test(f.path))?.path ?? "";
    return {
      unet: find(/^unet\/.*\.onnx$/),
      clip: find(/^text_encoder\/.*\.onnx$/),
      vae: find(/^vae_decoder\/.*\.onnx$/),
    };
  }

  private async tokenizer(): Promise<TokenizerPayload> {
    const { store, spec, manifest } = this.opts;
    const dir = spec.dir;
    if (spec.family === "flow") {
      const json = await readJson<unknown>(store, `${dir}/tokenizer.json`);
      const config = await readJson<unknown>(store, `${dir}/tokenizer_config.json`);
      if (!json || !config) throw new Error("tokenizer files missing — reinstall the model");
      return { kind: "t5", json, config };
    }
    // Repos are free to nest the tokenizer wherever they like: take the paths
    // from the manifest instead of assuming `tokenizer/`.
    const find = (name: string) => manifest.files.find((f) => f.path.endsWith(`/${name}`) || f.path === name)?.path ?? `tokenizer/${name}`;
    const json = await readJson<Record<string, number>>(store, `${dir}/${find("vocab.json")}`);
    const merges = await readText(store, `${dir}/${find("merges.txt")}`);
    const config = await readJson<unknown>(store, `${dir}/${find("tokenizer_config.json")}`);
    if (!json) throw new Error("tokenizer files missing — reinstall the model");
    return { kind: "clip", json, config: config ?? {}, merges: merges ?? "" };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.worker) {
      if (signal?.aborted) throw aborted();
      return;
    }
    const { store, spec, manifest } = this.opts;
    const pref = this.opts.backend;
    const backend: Backend = pref === "wasm" ? "wasm" : (await webgpuAvailable()) ? "webgpu" : "wasm";
    this.lean = pickLean(this.opts.memory);

    const worker = new Worker(new URL("../workers/engine.worker.ts", import.meta.url), { type: "module" });
    const rpc = new Rpc(
      worker,
      {
        model: async ({ path }: { path: string }) => {
          const bytes = await readAll(store, `${spec.dir}/${path}`);
          return new Transfer(bytes.buffer, [bytes.buffer]);
        },
      },
      (e) => this.opts.onEvent?.(e as EngineEvent),
    );
    worker.addEventListener("error", (e) => rpc.failAll(new Error(e.message || "worker crashed")));
    worker.addEventListener("messageerror", () => rpc.failAll(new Error("worker message error")));
    this.worker = worker;
    this.rpc = rpc;

    // Loading the networks is the slowest part of a generation: "Stop" has to
    // reach the worker here too, not only once the denoise loop is running.
    const onAbort = () => void rpc.call("cancel").catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      const init: InitArgs = {
        base: baseUrl(),
        threads: wasmThreads(),
        backend,
        family: spec.family,
        dir: spec.dir,
        config: manifest.config,
        roles: this.roles(),
        tokenizer: await this.tokenizer(),
        lean: this.lean,
      };
      if (signal?.aborted) throw aborted();
      const res = await rpc.call<{ backend: Backend }>("init", init);
      this.backend = res.backend;
      if (signal?.aborted) throw aborted();
      if (!this.lean) {
        const w = await rpc.call<{ backend: Backend }>("warm", undefined, []);
        this.backend = w.backend;
      }
      if (signal?.aborted) throw aborted();
    } catch (e) {
      this.dispose();
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async generate(args: GenerateArgs, signal?: AbortSignal): Promise<GenerateResult> {
    await this.start(signal);
    const rpc = this.rpc!;
    const onAbort = () => void rpc.call("cancel").catch(() => {});
    if (signal?.aborted) throw aborted();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await rpc.call<GenerateResult>("generate", args);
      this.backend = res.backend;
      return res;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        // A crashed/out-of-memory worker can't be trusted any more.
        if (/worker|memory|allocation|out of/i.test(errMsg(e))) this.dispose();
      }
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    this.rpc?.failAll(new Error("engine stopped"));
    this.worker?.terminate();
    this.worker = null;
    this.rpc = null;
  }
}
