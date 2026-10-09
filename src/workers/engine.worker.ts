// Inference worker.
//
// Hosts whichever pipeline the selected model needs (rectified flow for
// Supra2-IMG, epsilon diffusion for Stable-diffusion 1.x), keeps the ONNX
// sessions warm, and runs everything off the UI thread so the interface stays
// fluid and "Stop" always works — even on the CPU backend, where a single step
// blocks for seconds.
import * as ort from "ort";
import { Rpc, Transfer, type Port } from "./rpc";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult, InitArgs } from "../engine/protocol";
import { makePipeline, type Pipeline, type PipeCtx, type Tokenizer } from "../engine/pipelines/types";
import { buildClipTokenizerJson } from "../lib/cliptok";
import type { ModelConfig } from "../lib/models";
import type { Family } from "../lib/registry";

let cfg!: ModelConfig;
let family: Family = "flow";
let backend: Backend = "wasm";
let lean = false;
let cancelled = false;
let pipeline: Pipeline | null = null;
let tokenizer!: Tokenizer;
let roles: Record<string, string> = {};
const sessions = new Map<string, ort.InferenceSession>();
const cache = new Map<string, unknown>();

const rpc = new Rpc(self as unknown as Port, {
  init,
  warm,
  generate,
  release,
  cancel: () => {
    cancelled = true;
  },
});
const emit = (e: EngineEvent, t: Transferable[] = []) => rpc.emit(e, t);
// Yield to the event loop so a "cancel" message can get through between steps.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "AbortError";
  }
}
const check = () => {
  if (cancelled) throw new Cancelled();
};

async function createSession(bytes: ArrayBuffer): Promise<ort.InferenceSession> {
  const eps = backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  try {
    return await ort.InferenceSession.create(new Uint8Array(bytes), {
      executionProviders: eps,
      graphOptimizationLevel: "all",
    });
  } catch (e) {
    if (backend !== "webgpu") throw e;
    backend = "wasm";
    emit({ ev: "status", text: "webgpu_failed", backend });
    return createSession(bytes);
  }
}

/** Loads one of the model's networks (and keeps it for the next step). */
async function load(role: string): Promise<void> {
  if (sessions.has(role)) return;
  const path = roles[role];
  if (!path) throw new Error(`this model has no "${role}" network`);
  emit({ ev: "progress", phase: "load", step: 0, steps: 0, detail: role });
  const bytes = await rpc.call<ArrayBuffer>("model", { path });
  sessions.set(role, await createSession(bytes));
}

async function drop(role?: string): Promise<void> {
  for (const name of role ? [role] : [...sessions.keys()]) {
    const s = sessions.get(name);
    if (!s) continue;
    sessions.delete(name);
    try {
      await s.release();
    } catch {
      /* ignore */
    }
  }
}

const ctx: PipeCtx = {
  get family() {
    return family;
  },
  get config() {
    return cfg;
  },
  get backend() {
    return backend;
  },
  get lean() {
    return lean;
  },
  get tokenizer() {
    return tokenizer;
  },
  cache,
  run: async (role, feeds) => {
    await load(role);
    return sessions.get(role)!.run(feeds);
  },
  load,
  emit,
  check,
  tick,
  drop,
};


async function init(a: InitArgs): Promise<{ backend: Backend }> {
  cfg = a.config;
  family = a.family;
  backend = a.backend;
  lean = a.lean;
  roles = a.roles;
  cancelled = false;
  cache.clear();
  ort.env.logLevel = "error";
  ort.env.wasm.wasmPaths = {
    mjs: `${a.base}ort/ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${a.base}ort/ort-wasm-simd-threaded.jsep.wasm`,
  };
  ort.env.wasm.numThreads = a.threads;
  ort.env.wasm.proxy = false;

  // Transformers.js is used for tokenizing only — its SentencePiece normalizer
  // (Supra2-IMG) and CLIP BPE (Stable diffusion) are not worth re-implementing —
  // and no inference ever runs through it.
  const tf = await import("@huggingface/transformers");
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = false;
  tokenizer =
    a.tokenizer.kind === "clip"
      ? (new tf.CLIPTokenizer(
          buildClipTokenizerJson(a.tokenizer.json as Record<string, number>, a.tokenizer.merges ?? ""),
          a.tokenizer.config as never,
        ) as never)
      : (new tf.PreTrainedTokenizer(a.tokenizer.json as never, a.tokenizer.config as never) as never);

  pipeline = await makePipeline(family, ctx);
  return { backend };
}

async function warm(): Promise<{ backend: Backend }> {
  await pipeline?.warm();
  return { backend };
}

async function release(): Promise<void> {
  await drop();
  cache.clear();
}

async function generate(a: GenerateArgs): Promise<Transfer> {
  cancelled = false;
  if (!pipeline) throw new Error("engine not initialised");
  let res: GenerateResult;
  try {
    res = await pipeline.generate(a, ctx);
  } catch (e) {
    if (cancelled || (e as Error).name === "AbortError" || backend !== "webgpu") throw e;
    // The GPU path failed mid-run (device lost, out of memory, unsupported op…):
    // transparently redo the job on the CPU.
    console.warn("webgpu failed, retrying on wasm", e);
    await release();
    backend = "wasm";
    emit({ ev: "status", text: "webgpu_failed", backend });
    res = await pipeline.generate(a, ctx);
  }
  return new Transfer(res, [res.rgba.buffer]);
}
