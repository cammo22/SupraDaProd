// Main-thread handle to the inference worker.
import { Rpc, Transfer } from "../workers/rpc";
import { baseUrl, deviceMemoryGB, isAndroid, wasmThreads, webgpuAvailable } from "../lib/platform";
import { type Manifest, SUPRA_DIR } from "../lib/models";
import { type Store, readAll, readJson } from "../lib/storage/types";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult, InitArgs, ModelName } from "./protocol";

export type BackendPref = "auto" | "webgpu" | "wasm";
export type MemoryPref = "auto" | "fast" | "lean";

export interface EngineOptions {
  store: Store;
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

export class EngineClient {
  private worker: Worker | null = null;
  private rpc: Rpc | null = null;
  backend: Backend = "wasm";
  lean = false;

  constructor(private opts: EngineOptions) {}

  get running(): boolean {
    return !!this.worker;
  }

  async start(): Promise<void> {
    if (this.worker) return;
    const { store, manifest } = this.opts;
    const dir = SUPRA_DIR;
    const tokJson = await readJson<unknown>(store, `${dir}/tokenizer.json`);
    const tokCfg = await readJson<unknown>(store, `${dir}/tokenizer_config.json`);
    if (!tokJson || !tokCfg) throw new Error("tokenizer files missing — reinstall the model");

    const pref = this.opts.backend;
    const backend: Backend = pref === "wasm" ? "wasm" : (await webgpuAvailable()) ? "webgpu" : "wasm";
    this.lean = pickLean(this.opts.memory);

    const worker = new Worker(new URL("../workers/supra.worker.ts", import.meta.url), { type: "module" });
    const rpc = new Rpc(
      worker,
      {
        model: async ({ name }: { name: ModelName }) => {
          const part = manifest.files.find((f) => f.key === name);
          if (!part) throw new Error(`model file for ${name} not in manifest`);
          const bytes = await readAll(store, `${dir}/${part.path}`);
          return new Transfer(bytes.buffer, [bytes.buffer]);
        },
      },
      (e) => this.opts.onEvent?.(e as EngineEvent),
    );
    worker.addEventListener("error", (e) => rpc.failAll(new Error(e.message || "worker crashed")));
    worker.addEventListener("messageerror", () => rpc.failAll(new Error("worker message error")));
    this.worker = worker;
    this.rpc = rpc;

    try {
      const init: InitArgs = {
        base: baseUrl(),
        threads: wasmThreads(),
        backend,
        config: manifest.config,
        tokenizer: { json: tokJson, config: tokCfg },
        lean: this.lean,
      };
      const res = await rpc.call<{ backend: Backend }>("init", init);
      this.backend = res.backend;
      if (!this.lean) {
        const w = await rpc.call<{ backend: Backend }>("warm");
        this.backend = w.backend;
      }
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  async generate(args: GenerateArgs, signal?: AbortSignal): Promise<GenerateResult> {
    await this.start();
    const rpc = this.rpc!;
    const onAbort = () => void rpc.call("cancel").catch(() => {});
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await rpc.call<GenerateResult>("generate", args);
      this.backend = res.backend;
      return res;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        // A crashed/out-of-memory worker can't be trusted any more.
        if (/worker|memory|allocation|out of/i.test((e as Error).message)) this.dispose();
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
