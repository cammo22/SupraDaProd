// Supra2-IMG inference worker.
//
// Runs the three ONNX networks (Flan-T5 encoder → DiT flow model → SD VAE) off
// the UI thread, so the interface stays fluid and "Cancel" always works —
// even on the CPU/WASM backend where a single step blocks for seconds.
import * as ort from "ort";
import { Rpc, Transfer, type Port } from "./rpc";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult, InitArgs, ModelName } from "../engine/protocol";
import type { PipelineConfig } from "../lib/models";
import { eulerStep, gaussian, latentPreview, pixelsToRgba, predictX0, promptSeed, toFloat32 } from "../lib/sampler";

let cfg!: PipelineConfig;
let backend: Backend = "wasm";
let lean = false;
let cancelled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenizer: any = null;
const sessions: Partial<Record<ModelName, ort.InferenceSession>> = {};
const embedCache = new Map<string, Embedding>();

interface Embedding {
  ctx: Float32Array;
  mask: Float32Array;
}

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

async function init(a: InitArgs): Promise<{ backend: Backend }> {
  cfg = a.config;
  backend = a.backend;
  lean = a.lean;
  ort.env.wasm.wasmPaths = {
    mjs: `${a.base}ort/ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${a.base}ort/ort-wasm-simd-threaded.jsep.wasm`,
  };
  ort.env.wasm.numThreads = a.threads;
  ort.env.wasm.proxy = false;

  // The T5 tokenizer comes from Transformers.js; its files were downloaded to disk by the app.
  const tf = await import("@huggingface/transformers");
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = false;
  tokenizer = new tf.PreTrainedTokenizer(a.tokenizer.json as never, a.tokenizer.config as never);
  return { backend };
}

async function create(bytes: ArrayBuffer): Promise<ort.InferenceSession> {
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
    return create(bytes);
  }
}

async function ensure(name: ModelName): Promise<ort.InferenceSession> {
  const have = sessions[name];
  if (have) return have;
  emit({ ev: "progress", phase: "load", step: 0, steps: 0, detail: name });
  const bytes = await rpc.call<ArrayBuffer>("model", { name });
  const s = await create(bytes);
  sessions[name] = s;
  return s;
}

async function drop(name: ModelName) {
  const s = sessions[name];
  if (!s) return;
  delete sessions[name];
  try {
    await s.release();
  } catch {
    /* ignore */
  }
}

async function release(names?: ModelName[]) {
  for (const n of names ?? (["t5", "dit", "vae"] as ModelName[])) await drop(n);
}

async function warm() {
  for (const n of ["t5", "dit", "vae"] as ModelName[]) await ensure(n);
  return { backend };
}

async function encode(text: string): Promise<Embedding> {
  const hit = embedCache.get(text);
  if (hit) return hit;
  const t5 = await ensure("t5");
  const ctxLen = cfg.ctx_len;
  const tk = tokenizer(text, { padding: "max_length", truncation: true, max_length: ctxLen });
  const ids = BigInt64Array.from(tk.input_ids.data as ArrayLike<number | bigint>, (v) => BigInt(v));
  const am = BigInt64Array.from(tk.attention_mask.data as ArrayLike<number | bigint>, (v) => BigInt(v));
  const out = await t5.run({
    input_ids: new ort.Tensor("int64", ids, [1, ctxLen]),
    attention_mask: new ort.Tensor("int64", am, [1, ctxLen]),
  });
  const hidden = Object.values(out)[0];
  const ctx = toFloat32(hidden.data as never).slice();
  for (let i = 0; i < ctx.length; i++) {
    if (Number.isNaN(ctx[i])) throw new Error("text encoder returned NaN — try again");
  }
  const mask = new Float32Array(ctxLen);
  for (let i = 0; i < ctxLen; i++) mask[i] = am[i] === 0n ? 0 : 1;
  const emb = { ctx, mask };
  if (embedCache.size > 16) embedCache.delete(embedCache.keys().next().value as string);
  embedCache.set(text, emb);
  return emb;
}

async function run(a: GenerateArgs): Promise<GenerateResult> {
  const { prompt, negative, seed, steps, cfgScale } = a;
  const ctxLen = cfg.ctx_len;
  const N = cfg.latent_ch * cfg.latent_size * cfg.latent_size;
  const shape = [1, cfg.latent_ch, cfg.latent_size, cfg.latent_size];

  emit({ ev: "progress", phase: "encode", step: 0, steps });
  const cond = await encode(prompt);
  check();
  const uncond = await encode(negative);
  check();
  if (lean) await drop("t5");

  const dit = await ensure("dit");
  const toCtx = (c: Embedding) => new ort.Tensor("float32", c.ctx, [1, ctxLen, c.ctx.length / ctxLen]);
  const condCtx = toCtx(cond);
  const uncondCtx = toCtx(uncond);

  let z = gaussian(promptSeed(seed, prompt), N);
  let next: Float32Array = new Float32Array(N);
  const guided = new Float32Array(N);
  const x0 = new Float32Array(N);
  const dt = 1 / steps;

  for (let i = 0; i < steps; i++) {
    await tick();
    check();
    const t = new ort.Tensor("float32", new Float32Array([i * dt]), [1]);
    const feeds = (c: Embedding, ctx: ort.Tensor) => ({
      z: new ort.Tensor("float32", z, shape),
      t,
      ctx,
      ctx_mask: new ort.Tensor("float32", c.mask, [1, ctxLen]),
    });
    const outC = await dit.run(feeds(cond, condCtx));
    const vc = toFloat32(Object.values(outC)[0].data as never).slice();
    check();
    const outU = await dit.run(feeds(uncond, uncondCtx));
    const vu = toFloat32(Object.values(outU)[0].data as never);
    eulerStep(z, vc, vu, dt, cfgScale, next, guided);
    if (i % 2 === 0 || i === steps - 1) {
      predictX0(z, guided, i * dt, x0);
      const rgba = latentPreview(x0, cfg.latent_ch, cfg.latent_size);
      emit({ ev: "preview", rgba, size: cfg.latent_size }, [rgba.buffer]);
    }
    [z, next] = [next, z];
    emit({ ev: "progress", phase: "denoise", step: i + 1, steps });
  }
  if (lean) await drop("dit");

  emit({ ev: "progress", phase: "decode", step: steps, steps });
  await tick();
  check();
  const vae = await ensure("vae");
  const scaled = new Float32Array(N);
  for (let i = 0; i < N; i++) scaled[i] = z[i] / cfg.vae_scale;
  const img = await vae.run({ z: new ort.Tensor("float32", scaled, shape) });
  const pixels = toFloat32(Object.values(img)[0].data as never);
  if (lean) await drop("vae");

  return { rgba: pixelsToRgba(pixels, cfg.image_size), size: cfg.image_size, backend };
}

async function generate(a: GenerateArgs): Promise<Transfer> {
  cancelled = false;
  let res: GenerateResult;
  try {
    res = await run(a);
  } catch (e) {
    if (cancelled || (e as Error).name === "AbortError" || backend !== "webgpu") throw e;
    // The GPU path failed mid-run (device lost, out of memory, unsupported op…):
    // transparently redo the job on the CPU.
    console.warn("webgpu failed, retrying on wasm", e);
    await release();
    backend = "wasm";
    emit({ ev: "status", text: "webgpu_failed", backend });
    res = await run(a);
  }
  return new Transfer(res, [res.rgba.buffer]);
}
