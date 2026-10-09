// Stable-diffusion 1.x pipeline (DreamShaper 8, SD 1.5, most diffusers ONNX
// exports): CLIP text encoder → epsilon UNet → VAE decoder.
//
// Everything happens in noise-level space: x = z/√ᾱ so that x = x₀ + σ·ε, which
// is exactly what lib/sampler integrates. The UNet is fed the plain diffusers
// latent (x·√ᾱ) and predicts ε; the sampler turns ε into x₀.
import * as ort from "ort";
import {
  betaSigmas, dataFromEps, gaussian, guideVelocity, integrateDpmpp2m, integrateEuler, integrateHeun, isSolver,
  latentPreview, makeIntegratorState, pixelsToRgba, promptSeed, rescaleGuidance, sigmaSchedule, toFloat32,
  toHalfBits, toSigmaSpace, type Solver,
} from "../../lib/sampler";
import type { SdConfig } from "../../lib/models";
import type { GenerateArgs, GenerateResult } from "../protocol";
import type { PipeCtx, Pipeline } from "./types";

interface TextEmbedding {
  /** [1, ctx_len, 768] CLIP hidden states. */
  hidden: Float32Array;
}

export function create(ctx: PipeCtx): Pipeline {
  const cfg = ctx.config as SdConfig;
  const ctxLen = cfg.ctx_len;
  const trainSigmas = betaSigmas({
    beta_start: cfg.beta_start,
    beta_end: cfg.beta_end,
    num_train_timesteps: cfg.num_train_timesteps,
    beta_schedule: cfg.beta_schedule,
  });

  /** CLIP hidden states of a prompt (cached, the empty prompt included). */
  const encode = async (text: string): Promise<TextEmbedding> => {
    const hit = ctx.cache.get(text) as TextEmbedding | undefined;
    if (hit) return hit;
    // CLIP pads/truncates to 77 tokens, filling with <|endoftext|>.
    const tk = ctx.tokenizer(text, { padding: "max_length", truncation: true, max_length: ctxLen });
    const ids = Int32Array.from(tk.input_ids.data as ArrayLike<number>, (v) => Number(v));
    const out = await ctx.run("clip", { input_ids: new ort.Tensor("int32", ids, [1, ctxLen]) });
    const hidden = toFloat32(Object.values(out)[0].data as never).slice();
    for (let i = 0; i < hidden.length; i++) {
      if (Number.isNaN(hidden[i])) throw new Error("text encoder returned NaN — try again");
    }
    const value = { hidden };
    if (ctx.cache.size > 16) ctx.cache.delete(ctx.cache.keys().next().value as string);
    ctx.cache.set(text, value);
    return value;
  };


  const generate = async (a: GenerateArgs): Promise<GenerateResult> => {
    const { prompt, negative, seed, steps, cfgScale } = a;
    const solver: Solver = isSolver(a.solver) ? a.solver : "euler";
    const rescale = Math.min(1, Math.max(0, a.cfgRescale ?? 0));
    const image = a.size > 0 ? a.size : cfg.image_size;
    const ch = cfg.latent_ch;
    const ls = Math.max(4, Math.round(image / 8));
    const N = ch * ls * ls;
    const dims = [1, ch, ls, ls];

    ctx.emit({ ev: "progress", phase: "encode", step: 0, steps });
    const cond = await encode(prompt);
    ctx.check();
    // cfg = 1 = "no guidance": skip the unconditional pass entirely.
    const uncond = cfgScale === 1 ? null : await encode(negative);
    ctx.check();
    if (ctx.lean) await ctx.drop("clip");

    const { sigmas, alphas, timesteps } = sigmaSchedule(trainSigmas, steps, !!a.karras);
    // The exported UNet and VAE take fp16 tensors.
    const f16 = (data: Float32Array, d: number[]) => new ort.Tensor("float16", toHalfBits(data), d);
    const t16 = (t: number) => new ort.Tensor("float16", toHalfBits([t]), [1]);

    let cur = new Float32Array(N);
    toSigmaSpace(gaussian(promptSeed(seed, prompt), N), alphas[0], cur);
    let spare = new Float32Array(N);
    const epsCond = new Float32Array(N);
    const epsUncond = new Float32Array(N);
    const eps = new Float32Array(N);
    const epsNext = new Float32Array(N);
    const predictor = new Float32Array(N);
    const scaledIn = new Float32Array(N);
    const data = new Float32Array(N);
    const st = makeIntegratorState(N);

    /** ε of both branches at (x, σ) → written into `eps` (already guided). */
    const evaluate = async (xBuf: Float32Array, i: number): Promise<void> => {
      const k = alphas[i];
      for (let j = 0; j < N; j++) scaledIn[j] = xBuf[j] * k;
      const feeds = (hidden: Float32Array) => ({
        sample: f16(scaledIn, dims),
        timestep: t16(timesteps[i]),
        encoder_hidden_states: f16(hidden, [1, ctxLen, hidden.length / ctxLen]),
      });
      epsCond.set(toFloat32(Object.values(await ctx.run("unet", feeds(cond.hidden)))[0].data as never));
      if (!uncond) {
        eps.set(epsCond);
        return;
      }
      await ctx.tick();
      ctx.check();
      epsUncond.set(toFloat32(Object.values(await ctx.run("unet", feeds(uncond.hidden)))[0].data as never));
      guideVelocity(epsCond, epsUncond, cfgScale, eps);
      if (rescale > 0) rescaleGuidance(epsCond, eps, rescale);
    };

    for (let i = 0; i < steps; i++) {
      await ctx.tick();
      ctx.check();
      const sigma = sigmas[i];
      const sigmaNext = sigmas[i + 1];
      const target = spare;
      await evaluate(cur, i);
      dataFromEps(cur, eps, sigma, data);

      if (solver === "dpmpp2m") {
        integrateDpmpp2m(st, cur, data, sigma, sigmaNext, target);
      } else if (solver === "heun" && i < steps - 1) {
        integrateEuler(cur, eps, sigmaNext - sigma, predictor);
        await evaluate(predictor, i + 1);
        ctx.check();
        epsNext.set(eps);
        integrateHeun(cur, eps, epsNext, sigmaNext - sigma, target);
      } else {
        integrateEuler(cur, eps, sigmaNext - sigma, target);
      }

      if (i % 2 === 0 || i === steps - 1) {
        // Same cheap latent→RGB preview the flow pipeline uses.
        const rgba = latentPreview(data, ch, ls);
        ctx.emit({ ev: "preview", rgba, size: ls }, [rgba.buffer]);
      }
      spare = cur;
      cur = target;
      ctx.emit({ ev: "progress", phase: "denoise", step: i + 1, steps });
    }
    if (ctx.lean) await ctx.drop("unet");

    ctx.emit({ ev: "progress", phase: "decode", step: steps, steps });
    await ctx.tick();
    ctx.check();
    const vaeIn = new Float32Array(N);
    for (let j = 0; j < N; j++) vaeIn[j] = cur[j] / cfg.vae_scale;
    const img = await ctx.run("vae", { latent_sample: f16(vaeIn, dims) });
    const pixels = toFloat32(Object.values(img)[0].data as never);
    if (ctx.lean) await ctx.drop("vae");
    return { rgba: pixelsToRgba(pixels, image), size: image, backend: ctx.backend };
  };

  return {
    warm: async () => {
      for (const role of ["clip", "unet", "vae"]) await ctx.load(role);
    },
    generate,
  };
}

