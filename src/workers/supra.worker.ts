// Supra2-IMG inference worker.
//
// Runs the three ONNX networks (Flan-T5 encoder → DiT flow model → SD VAE) off
// the UI thread, so the interface stays fluid and "Cancel" always works — even
// on the CPU/WASM backend where a single step blocks for seconds.
//
// The denoise loop is written to stay allocation-free: the latent, the two
// velocities, the guided field and the solver state all live in buffers that are
// created once per generation. The conditional and the unconditional branch are
// evaluated in a single batched DiT call whenever the exported graph allows it
// (verified on the first use, two calls otherwise).
import * as ort from "ort";
import { Rpc, Transfer, type Port } from "./rpc";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult, InitArgs, ModelName } from "../engine/protocol";
import type { PipelineConfig } from "../lib/models";
import {
  gaussian, guideVelocity, integrateDpmpp2m, integrateEuler, integrateHeun, isSolver, latentPreview, makeIntegratorState,
  pixelsToRgba, predictX0, promptSeed, rescaleGuidance, toFloat32, type Solver,
} from "../lib/sampler";

let cfg!: PipelineConfig;
let backend: Backend = "wasm";
let lean = false;
let cancelled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenizer: any = null;
/** null = not probed yet; false = the DiT only accepts a batch of 1. */
let batched: boolean | null = null;
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
  batched = null;
  ort.env.logLevel = "error";
  ort.env.wasm.wasmPaths = {
    mjs: `${a.base}ort/ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${a.base}ort/ort-wasm-simd-threaded.jsep.wasm`,
  };
  ort.env.wasm.numThreads = a.threads;
  ort.env.wasm.proxy = false;

  // The T5 tokenizer comes from Transformers.js (its Precompiled SentencePiece
  // normalizer is not something we want to re-implement); its files were
  // downloaded to disk by the app. No inference ever runs through it.
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

/** Stacks two embeddings into one batch-2 embedding for the guided DiT call. */
function stackPair(a: Embedding, b: Embedding): { ctx: Float32Array; mask: Float32Array; dim: number } {
  const ctx = new Float32Array(a.ctx.length + b.ctx.length);
  ctx.set(a.ctx, 0);
  ctx.set(b.ctx, a.ctx.length);
  const mask = new Float32Array(a.mask.length + b.mask.length);
  mask.set(a.mask, 0);
  mask.set(b.mask, a.mask.length);
  return { ctx, mask, dim: a.ctx.length / a.mask.length };
}

async function run(a: GenerateArgs): Promise<GenerateResult> {
  const { prompt, negative, seed, steps, cfgScale } = a;
  const solver: Solver = isSolver(a.solver) ? a.solver : "euler";
  const rescale = Math.min(1, Math.max(0, a.cfgRescale ?? 0));
  const ctxLen = cfg.ctx_len;
  const ch = cfg.latent_ch;
  const ls = cfg.latent_size;
  const N = ch * ls * ls;
  const shape = [1, ch, ls, ls];

  emit({ ev: "progress", phase: "encode", step: 0, steps });
  const cond = await encode(prompt);
  check();
  // cfg = 1 means "follow the prompt only": skipping the unconditional pass
  // halves the cost of the whole denoise loop.
  const uncond = cfgScale === 1 ? null : await encode(negative);
  check();
  if (lean) await drop("t5");

  const dit = await ensure("dit");
  const f32 = (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);
  const condCtx = f32(cond.ctx, [1, ctxLen, cond.ctx.length / ctxLen]);
  const condMask = f32(cond.mask, [1, ctxLen]);
  const uncondCtx = uncond ? f32(uncond.ctx, [1, ctxLen, uncond.ctx.length / ctxLen]) : null;
  const uncondMask = uncond ? f32(uncond.mask, [1, ctxLen]) : null;
  const pair = uncond ? stackPair(cond, uncond) : null;

  let z: Float32Array = gaussian(promptSeed(seed, prompt), N);
  let spare: Float32Array = new Float32Array(N);
  const vCond = new Float32Array(N);
  const vUncond = new Float32Array(N);
  const v = new Float32Array(N);
  const vNext = new Float32Array(N);
  const predictor = new Float32Array(N);
  const x0 = new Float32Array(N);
  const st = makeIntegratorState(N);
  const pairZ = new Float32Array(2 * N);
  const dt = 1 / steps;
  let useBatch = !!pair && batched !== false;

  const feed = async (feeds: Record<string, ort.Tensor>): Promise<Float32Array> => {
    const out = await dit.run(feeds);
    return toFloat32(Object.values(out)[0].data as never);
  };
  const single = (zBuf: Float32Array, t: number, ctx: ort.Tensor, mask: ort.Tensor) =>
    feed({ z: f32(zBuf, shape), t: f32(Float32Array.of(t), [1]), ctx, ctx_mask: mask });

  /** Velocity of both branches at (z, t) → written into vCond / vUncond. */
  const evaluate = async (zBuf: Float32Array, t: number): Promise<void> => {
    if (!uncond || !uncondCtx || !uncondMask) {
      vCond.set(await single(zBuf, t, condCtx, condMask));
      return;
    }
    if (useBatch && pair) {
      pairZ.set(zBuf, 0);
      pairZ.set(zBuf, N);
      try {
        const out = await feed({
          z: f32(pairZ, [2, ch, ls, ls]),
          t: f32(Float32Array.of(t, t), [2]),
          ctx: f32(pair.ctx, [2, ctxLen, pair.dim]),
          ctx_mask: f32(pair.mask, [2, ctxLen]),
        });
        if (out.length !== 2 * N) throw new Error(`batched DiT returned ${out.length} values, expected ${2 * N}`);
        batched = true;
        vCond.set(out.subarray(0, N));
        vUncond.set(out.subarray(N, 2 * N)); // copied: the output buffer is not ours to keep
        return;
      } catch (e) {
        // A graph exported with a fixed batch of 1 rejects the call. Remember it
        // and do one call per branch from now on: the shape check fails before
        // anything runs, so the session itself stays perfectly usable.
        console.debug("batched guidance unavailable, falling back to two calls", e);
        batched = false;
        useBatch = false;
      }
    }
    vCond.set(await single(zBuf, t, condCtx, condMask));
    await tick();
    check();
    vUncond.set(await single(zBuf, t, uncondCtx, uncondMask));
  };

  const guide = (out: Float32Array) => {
    guideVelocity(vCond, uncond ? vUncond : null, cfgScale, out);
    if (rescale > 0 && uncond) rescaleGuidance(vCond, out, rescale);
  };

  for (let i = 0; i < steps; i++) {
    await tick();
    check();
    const t = i * dt;
    const target = spare;
    await evaluate(z, t);
    guide(v);

    if (solver === "dpmpp2m") {
      integrateDpmpp2m(st, z, v, t, t + dt, target);
    } else if (solver === "heun" && i < steps - 1) {
      // Predictor + corrector: twice the evals, but a whole extra order of accuracy.
      integrateEuler(z, v, dt, predictor);
      await evaluate(predictor, t + dt);
      check();
      guide(vNext);
      integrateHeun(z, v, vNext, dt, target);
    } else {
      // Euler, and the last step of Heun where t = 1 would be the data already.
      integrateEuler(z, v, dt, target);
    }

    if (i % 2 === 0 || i === steps - 1) {
      predictX0(z, v, t, x0);
      const rgba = latentPreview(x0, ch, ls);
      emit({ ev: "preview", rgba, size: ls }, [rgba.buffer]);
    }
    spare = z; // the buffer we just consumed becomes the next scratch
    z = target;
    emit({ ev: "progress", phase: "denoise", step: i + 1, steps });
  }
  if (lean) await drop("dit");

  emit({ ev: "progress", phase: "decode", step: steps, steps });
  await tick();
  check();
  const vae = await ensure("vae");
  const scaled = new Float32Array(N);
  for (let i = 0; i < N; i++) scaled[i] = z[i] / cfg.vae_scale;
  const img = await vae.run({ z: f32(scaled, shape) });
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
