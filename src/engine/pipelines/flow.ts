// Rectified-flow pipeline (Supra2-IMG): Flan-T5 → velocity DiT → SD VAE.
//
// The sampler works in noise-level space (σ = 1 − t, decreasing), which is the
// same form the epsilon pipelines use — see lib/sampler.
import * as ort from "ort";
import {
  dataFromVelocity, gaussian, guideVelocity, integrateDpmpp2m, integrateEuler, integrateHeun, isSolver, latentPreview,
  makeIntegratorState, pixelsToRgba, predictX0, promptSeed, rescaleGuidance, toFloat32, type Solver,
} from "../../lib/sampler";
import type { PipelineConfig } from "../../lib/models";
import type { GenerateArgs, GenerateResult } from "../protocol";
import type { PipeCtx, Pipeline } from "./types";

interface Embedding {
  ctx: Float32Array;
  mask: Float32Array;
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

export function create(ctx: PipeCtx): Pipeline {
  const cfg = ctx.config as PipelineConfig;
  const ctxLen = cfg.ctx_len;
  /** null = not probed yet; false = the DiT only accepts a batch of 1. */
  let batched: boolean | null = null;

  /** Flan-T5 hidden states + attention mask of a prompt (cached). */
  const encode = async (text: string): Promise<Embedding> => {
    const hit = ctx.cache.get(text) as Embedding | undefined;
    if (hit) return hit;
    const tk = ctx.tokenizer(text, { padding: "max_length", truncation: true, max_length: ctxLen });
    const ids = BigInt64Array.from(tk.input_ids.data as ArrayLike<number | bigint>, (v) => BigInt(v));
    const am = BigInt64Array.from(tk.attention_mask!.data as ArrayLike<number | bigint>, (v) => BigInt(v));
    const out = await ctx.run("t5", {
      input_ids: new ort.Tensor("int64", ids, [1, ctxLen]),
      attention_mask: new ort.Tensor("int64", am, [1, ctxLen]),
    });
    const emb = toFloat32(Object.values(out)[0].data as never).slice();
    for (let i = 0; i < emb.length; i++) {
      if (Number.isNaN(emb[i])) throw new Error("text encoder returned NaN — try again");
    }
    const mask = new Float32Array(ctxLen);
    for (let i = 0; i < ctxLen; i++) mask[i] = am[i] === 0n ? 0 : 1;
    const value = { ctx: emb, mask };
    if (ctx.cache.size > 16) ctx.cache.delete(ctx.cache.keys().next().value as string);
    ctx.cache.set(text, value);
    return value;
  };

  const generate = async (a: GenerateArgs): Promise<GenerateResult> => {
    const { prompt, negative, seed, steps, cfgScale } = a;
    const solver: Solver = isSolver(a.solver) ? a.solver : "euler";
    const rescale = Math.min(1, Math.max(0, a.cfgRescale ?? 0));
    const ch = cfg.latent_ch;
    const ls = cfg.latent_size;
    const N = ch * ls * ls;
    const shape = [1, ch, ls, ls];

    ctx.emit({ ev: "progress", phase: "encode", step: 0, steps });
    const cond = await encode(prompt);
    ctx.check();
    // cfg = 1 means "follow the prompt only": skipping the unconditional pass
    // halves the cost of the whole denoise loop.
    const uncond = cfgScale === 1 ? null : await encode(negative);
    ctx.check();
    if (ctx.lean) await ctx.drop("t5");

    const f32 = (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);
    const condCtx = f32(cond.ctx, [1, ctxLen, cond.ctx.length / ctxLen]);
    const condMask = f32(cond.mask, [1, ctxLen]);
    const uncondCtx = uncond ? f32(uncond.ctx, [1, ctxLen, uncond.ctx.length / ctxLen]) : null;
    const uncondMask = uncond ? f32(uncond.mask, [1, ctxLen]) : null;
    const pair = uncond ? stackPair(cond, uncond) : null;
    let useBatch = !!pair && batched !== false;


    let z: Float32Array = gaussian(promptSeed(seed, prompt), N);
    let spare: Float32Array = new Float32Array(N);
    const vCond = new Float32Array(N);
    const vUncond = new Float32Array(N);
    const v = new Float32Array(N);
    const vNext = new Float32Array(N);
    const predictor = new Float32Array(N);
    const data = new Float32Array(N);
    const x0 = new Float32Array(N);
    const st = makeIntegratorState(N);
    const pairZ = new Float32Array(2 * N);

    const feed = async (feeds: Record<string, ort.Tensor>): Promise<Float32Array> => {
      const out = await ctx.run("dit", feeds);
      return toFloat32(Object.values(out)[0].data as never);
    };
    const single = (zBuf: Float32Array, t: number, c: ort.Tensor, mask: ort.Tensor) =>
      feed({ z: f32(zBuf, shape), t: f32(Float32Array.of(t), [1]), ctx: c, ctx_mask: mask });

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
      await ctx.tick();
      ctx.check();
      vUncond.set(await single(zBuf, t, uncondCtx, uncondMask));
    };

    const guide = (out: Float32Array) => {
      guideVelocity(vCond, uncond ? vUncond : null, cfgScale, out);
      if (rescale > 0 && uncond) rescaleGuidance(vCond, out, rescale);
    };


    const dt = 1 / steps;
    for (let i = 0; i < steps; i++) {
      await ctx.tick();
      ctx.check();
      const t = i * dt;
      const sigma = 1 - t;
      const sigmaNext = 1 - (t + dt);
      const target = spare;
      await evaluate(z, t);
      guide(v);
      dataFromVelocity(z, v, sigma, data);

      if (solver === "dpmpp2m") {
        integrateDpmpp2m(st, z, data, sigma, sigmaNext, target);
      } else if (solver === "heun" && i < steps - 1) {
        // Predictor + corrector: twice the evals, but a whole extra order of accuracy.
        integrateEuler(z, v, sigmaNext - sigma, predictor);
        await evaluate(predictor, t + dt);
        ctx.check();
        guide(vNext);
        integrateHeun(z, v, vNext, sigmaNext - sigma, target);
      } else {
        // Euler, and the last step of Heun where t = 1 would be the data already.
        integrateEuler(z, v, sigmaNext - sigma, target);
      }

      if (i % 2 === 0 || i === steps - 1) {
        predictX0(z, v, t, x0);
        const rgba = latentPreview(x0, ch, ls);
        ctx.emit({ ev: "preview", rgba, size: ls }, [rgba.buffer]);
      }
      spare = z; // the buffer we just consumed becomes the next scratch
      z = target;
      ctx.emit({ ev: "progress", phase: "denoise", step: i + 1, steps });
    }
    if (ctx.lean) await ctx.drop("dit");

    ctx.emit({ ev: "progress", phase: "decode", step: steps, steps });
    await ctx.tick();
    ctx.check();
    const scaled = new Float32Array(N);
    for (let i = 0; i < N; i++) scaled[i] = z[i] / cfg.vae_scale;
    const img = await ctx.run("vae", { z: f32(scaled, shape) });
    const pixels = toFloat32(Object.values(img)[0].data as never);
    if (ctx.lean) await ctx.drop("vae");
    return { rgba: pixelsToRgba(pixels, cfg.image_size), size: cfg.image_size, backend: ctx.backend };
  };

  return {
    warm: async () => {
      for (const role of ["t5", "dit", "vae"]) await ctx.load(role);
    },
    generate,
  };
}
