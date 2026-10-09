// Pure math for the Supra2-IMG flow sampler. No DOM, no ONNX — unit-testable.
//
// The model predicts a velocity v(z, t) for the straight interpolation
// between noise (t = 0) and data (t = 1):
//
//     z_t = (1 − t)·noise + t·data        v(z, t) = dz/dt = data − noise
//
// so the noise level is σ = 1 − t and the model also gives a data estimate
// D = z + σ·v (see `predictX0`). Sampling integrates dz/dt = v from t = 0 to
// t = 1 with classifier-free guidance:
//
//     v = v_uncond + cfg · (v_cond − v_uncond)
//
// Three integrators are available (see `Solver`): plain Euler — the historical
// behaviour, bit-identical to 1.x for the same seed/steps — DPM-Solver++(2M),
// which reaches the same quality with roughly half the steps, and Heun.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller Gaussian noise — identical stream to the reference implementation. */
export function gaussian(seed: number, n: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12)));
    const a = 2 * Math.PI * rand();
    out[i] = r * Math.cos(a);
    if (i + 1 < n) out[i + 1] = r * Math.sin(a);
  }
  return out;
}

/**
 * Mixes the user seed with the prompt: same prompt + other seed → other image,
 * same seed + other prompt → reproducible too.
 */
export function promptSeed(seed: number, prompt: string): number {
  const hash = [...prompt].reduce((a, c) => (a * 31 + (c.codePointAt(0) || 0)) | 0, 7);
  return (seed ^ hash) >>> 0;
}

/* ===================== solvers ===================== */

export type Solver = "euler" | "dpmpp2m" | "heun";

/** Recommended order (first = default in the UI). */
export const SOLVERS: readonly Solver[] = ["dpmpp2m", "euler", "heun"];

export const isSolver = (v: unknown): v is Solver => v === "dpmpp2m" || v === "euler" || v === "heun";

/** Network evaluations per denoise step (guidance may double it). */
export const evalsPerStep = (s: Solver): number => (s === "heun" ? 2 : 1);

/** One-tap quality presets for the Create tab. */
export interface Preset {
  id: "fast" | "balanced" | "max";
  steps: number;
  solver: Solver;
}
export const PRESETS: readonly Preset[] = [
  { id: "fast", steps: 12, solver: "dpmpp2m" },
  { id: "balanced", steps: 20, solver: "dpmpp2m" },
  { id: "max", steps: 32, solver: "dpmpp2m" },
];

/** Mean and standard deviation of a vector (one pass each). */
export function meanStd(x: Float32Array): { mean: number; sd: number } {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  const mean = sum / x.length;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    sq += d * d;
  }
  return { mean, sd: Math.sqrt(sq / x.length) };
}

/**
 * Classifier-free guidance: `v = v_uncond + cfg·(v_cond − v_uncond)`.
 * `vUncond = null` means "no guidance" (cfg = 1 in the app) and lets the caller
 * skip the second network evaluation entirely.
 */
export function guideVelocity(vCond: Float32Array, vUncond: Float32Array | null, cfgScale: number, out: Float32Array): void {
  if (!vUncond || cfgScale === 1) {
    out.set(vCond);
    return;
  }
  for (let j = 0; j < out.length; j++) out[j] = vUncond[j] + cfgScale * (vCond[j] - vUncond[j]);
}

/**
 * CFG rescale (Lin et al., "Common Diffusion Noise Schedules"): pulling the
 * guided velocity back towards the conditional one tames the over-saturated
 * colours strong guidance produces. `amount` 0 = off … 1 = match its scale.
 */
export function rescaleGuidance(vCond: Float32Array, v: Float32Array, amount: number): void {
  if (!(amount > 0)) return;
  const cond = meanStd(vCond);
  const guided = meanStd(v);
  const ratio = guided.sd > 1e-8 ? cond.sd / guided.sd : 1;
  const f = 1 - amount + amount * ratio;
  for (let i = 0; i < v.length; i++) v[i] *= f;
}

/** First-order step: `out ← z + dt·v`. */
export function integrateEuler(z: Float32Array, v: Float32Array, dt: number, out: Float32Array): void {
  for (let j = 0; j < z.length; j++) out[j] = z[j] + dt * v[j];
}

/** One guided Euler step — kept as the 1.x API (tests + reference sampler). */
export function eulerStep(
  z: Float32Array,
  vCond: Float32Array,
  vUncond: Float32Array,
  dt: number,
  cfgScale: number,
  out: Float32Array,
  guided?: Float32Array,
): void {
  const v = guided ?? vCond;
  guideVelocity(vCond, vUncond, cfgScale, v);
  integrateEuler(z, v, dt, out);
}

/** Trapezoid (Heun) correction: `out ← z + dt/2·(v + vNext)`. */
export function integrateHeun(z: Float32Array, v: Float32Array, vNext: Float32Array, dt: number, out: Float32Array): void {
  const h = dt / 2;
  for (let j = 0; j < z.length; j++) out[j] = z[j] + h * (v[j] + vNext[j]);
}

/* ---------------- rectified flow → noise level ---------------- */

/** σ = 1 − t for the flow pipelines (noise at t = 0, data at t = 1). */
export const flowSigma = (t: number): number => 1 - t;

/** Data estimate of a velocity model: D = z + σ·v. */
export function dataFromVelocity(z: Float32Array, v: Float32Array, sigma: number, out: Float32Array): void {
  for (let j = 0; j < z.length; j++) out[j] = z[j] + sigma * v[j];
}

/* ---------------- epsilon diffusion (SD 1.x / 2.x) ---------------- */

export interface BetaSchedule {
  beta_start: number;
  beta_end: number;
  num_train_timesteps: number;
  beta_schedule?: string; // "scaled_linear" (SD 1.x) or "linear"
}

export interface SigmaSchedule {
  /** Noise levels, from the most noisy down to (and including) 0. */
  sigmas: Float32Array;
  /** √ᾱ of each step — the UNet expects the *unscaled* latent x·√ᾱ. */
  alphas: Float32Array;
  /** Training timestep (the UNet's `timestep` input) matching each σ. */
  timesteps: Float32Array;
}

/**
 * The classic Stable-diffusion beta schedule (β = (β₀ + (β₁−β₀)·i/(T−1))² for
 * "scaled_linear") turned into the σ / √ᾱ pairs the samplers need.
 */
export function betaSigmas(cfg: BetaSchedule): Float32Array {
  const T = cfg.num_train_timesteps;
  const scaled = (cfg.beta_schedule ?? "scaled_linear") !== "linear";
  const out = new Float32Array(T + 1);
  let alphaCumprod = 1;
  for (let i = 0; i < T; i++) {
    const lin = cfg.beta_start + ((cfg.beta_end - cfg.beta_start) * i) / (T - 1);
    const beta = scaled ? lin * lin : lin;
    alphaCumprod *= 1 - beta;
    out[i] = Math.sqrt((1 - alphaCumprod) / alphaCumprod);
  }
  out[T] = 0; // the final "denoised" level
  return out;
}

/**
 * Picks `steps` evenly spaced noise levels the way diffusers does for SD 1.x
 * ("leading" spacing: every ⌊T/steps⌋ training level, walked from the noisiest
 * down) and appends σ = 0 so the last step lands on the image.
 */
export function sigmaSchedule(all: Float32Array, steps: number, karras = false): SigmaSchedule {
  const train = all.length - 1;
  const stepRatio = Math.max(1, Math.floor(train / steps));
  const picked: number[] = [];
  const pickedT: number[] = [];
  for (let k = 0; k < steps; k++) {
    const idx = Math.min(train, (steps - 1 - k) * stepRatio);
    picked.push(all[idx]);
    pickedT.push(idx);
  }
  picked.push(0);
  pickedT.push(0);

  let sigmas = Float32Array.from(picked);
  let timesteps = Float32Array.from(pickedT);
  if (karras) {
    // Karras et al.: spend the steps where they matter (ρ = 7, bounds from the schedule).
    const sMin = all[0];
    const sMax = picked[0];
    const rho = 7;
    const minInv = sMin ** (1 / rho);
    const maxInv = sMax ** (1 / rho);
    sigmas = Float32Array.from({ length: steps + 1 }, (_, i) =>
      i === steps ? 0 : (maxInv + (i / (steps - 1)) * (minInv - maxInv)) ** rho,
    );
    timesteps = Float32Array.from(sigmas, (s) => sigmaToTimestep(all, s));
  }
  const alphas = Float32Array.from(sigmas, (s) => 1 / Math.sqrt(s * s + 1));
  return { sigmas, alphas, timesteps };
}

/**
 * Inverse of the σ table: the (fractional) training timestep whose noise level
 * is `sigma`, interpolated in log σ like diffusers' `_sigma_to_t`.
 */
export function sigmaToTimestep(all: Float32Array, sigma: number): number {
  const train = all.length - 1;
  if (sigma <= 0) return 0;
  if (sigma <= all[0]) return 0;
  if (sigma >= all[train - 1]) return train - 1;
  let lo = 0;
  let hi = train - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (all[mid] <= sigma) lo = mid;
    else hi = mid;
  }
  const a = Math.log(all[lo]);
  const b = Math.log(all[hi]);
  const w = b > a ? (Math.log(sigma) - a) / (b - a) : 0;
  return lo + Math.min(1, Math.max(0, w));
}

/** Data estimate of an epsilon model in σ-space: D = x − σ·ε. */
export function dataFromEps(x: Float32Array, eps: Float32Array, sigma: number, out: Float32Array): void {
  for (let j = 0; j < x.length; j++) out[j] = x[j] - sigma * eps[j];
}

/** Scales the raw diffusers latent (√ᾱ·x₀ + √(1−ᾱ)·ε) into σ-space. */
export function toSigmaSpace(z: Float32Array, alphaSqrt: number, out: Float32Array): void {
  const inv = 1 / alphaSqrt;
  for (let j = 0; j < z.length; j++) out[j] = z[j] * inv;
}

/** State of the multistep solver (allocate once per generation). */
export interface IntegratorState {
  prevData: Float32Array;
  hPrev: number;
  hasPrev: boolean;
  data: Float32Array;
  scratch: Float32Array;
}

export function makeIntegratorState(n: number): IntegratorState {
  return { prevData: new Float32Array(n), hPrev: 0, hasPrev: false, data: new Float32Array(n), scratch: new Float32Array(n) };
}

export function resetIntegratorState(st: IntegratorState): void {
  st.hasPrev = false;
  st.hPrev = 0;
}

/**
 * DPM-Solver++(2M) — Lu et al., "DPM-Solver++" — in the noise-level (σ) form
 * shared by both pipelines:
 *
 *     dz/dσ = (z − D)/σ ,      σ = noise level (decreasing), D = data estimate
 *
 * This covers rectified flow (σ = 1 − t, D = z + σ·v) and epsilon-prediction
 * diffusion (σ = √((1−ᾱ)/ᾱ), D = z − σ·ε) alike: every step is exact for a
 * constant D and second order otherwise, at one network eval per step — i.e. the
 * same cost as Euler, but a much better image at low step counts.
 */
export function integrateDpmpp2m(
  st: IntegratorState,
  z: Float32Array,
  data: Float32Array,
  sigma: number,
  sigmaNext: number,
  out: Float32Array,
): void {
  const n = z.length;
  st.data.set(data);

  if (sigmaNext <= 0) {
    // σ → 0: the exponential integrator degenerates to "take the data estimate".
    out.set(data);
    return;
  }
  const a = sigmaNext / sigma; // damping of the current sample
  const h = Math.log(sigma / sigmaNext);
  if (st.hasPrev) {
    const c = h / (2 * st.hPrev); // 1/(2r), with r = hPrev/h
    const dm = st.scratch;
    for (let j = 0; j < n; j++) dm[j] = (1 + c) * data[j] - c * st.prevData[j];
    for (let j = 0; j < n; j++) out[j] = a * z[j] + (1 - a) * dm[j];
  } else {
    // First step: no history yet, so a plain (exact) exponential update.
    for (let j = 0; j < n; j++) out[j] = a * z[j] + (1 - a) * data[j];
  }
  st.hPrev = h;
  st.prevData.set(data);
  st.hasPrev = true;
}


/** Current best guess of the final latent: follow the velocity the rest of the way. */
export function predictX0(z: Float32Array, guided: Float32Array, t: number, out: Float32Array): void {
  const rest = 1 - t;
  for (let j = 0; j < z.length; j++) out[j] = z[j] + rest * guided[j];
}

export const clampByte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** Half-precision (Uint16 bits) → float, for models exporting fp16 outputs. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

// Scratch buffers for the float32 → float16 bit dance.
const f32buf = new Float32Array(1);
const i32buf = new Int32Array(f32buf.buffer);

/**
 * Float → half precision bits (round to nearest, even). Same as the Float16Array
 * the platform may provide, but available everywhere ort-web runs.
 */
export function floatToHalf(value: number): number {
  f32buf[0] = value;
  const x = i32buf[0];
  const sign = (x >>> 31) << 15;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (e <= 0) {
    if (e < -10) return sign; // too small → ±0
    const m = mant | 0x800000;
    const shift = 1 - e;
    let out = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && (out & 1))) out++;
    return sign | out;
  }
  let m = mant >>> 13;
  let ee = e;
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (m & 1))) {
    m++;
    if (m === 0x400) {
      m = 0;
      if (++ee >= 0x1f) return sign | 0x7c00;
    }
  }
  return sign | (ee << 10) | m;
}

/** Packs a float32 vector into the half-precision bits a fp16 model expects. */
export function toHalfBits(src: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = floatToHalf(src[i]);
  return out;
}

/** Normalises whatever typed array ORT hands back into Float32. */
export function toFloat32(data: ArrayLike<number> & { constructor: { name: string } }): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) return Float32Array.from(data, halfToFloat);
  return Float32Array.from(data as ArrayLike<number>);
}

// Linear approximation of Stable-Diffusion-VAE latents → RGB (the trick used by
// popular UIs for live previews). Works on model-space latents (already scaled).
const SD_LATENT_RGB = [
  [0.298, 0.207, 0.208],
  [0.187, 0.286, 0.173],
  [-0.158, 0.189, 0.264],
  [-0.184, -0.271, -0.473],
];

/** RGBA preview of a latent at latent resolution. */
export function latentPreview(z: Float32Array, channels: number, size: number): Uint8ClampedArray {
  const n = size * size;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number;
    if (channels === 4) {
      r = g = b = 0;
      for (let c = 0; c < 4; c++) {
        const v = z[c * n + i];
        r += v * SD_LATENT_RGB[c][0];
        g += v * SD_LATENT_RGB[c][1];
        b += v * SD_LATENT_RGB[c][2];
      }
      r = (r + 1) / 2;
      g = (g + 1) / 2;
      b = (b + 1) / 2;
    } else {
      r = z[i] * 0.45 + 0.5;
      g = z[n + (channels > 1 ? i : 0)] * 0.45 + 0.5;
      b = z[(channels > 2 ? 2 * n : 0) + i] * 0.45 + 0.5;
    }
    rgba[i * 4] = clampByte(r);
    rgba[i * 4 + 1] = clampByte(g);
    rgba[i * 4 + 2] = clampByte(b);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** NCHW float image in [-1, 1] → RGBA bytes. */
export function pixelsToRgba(pixels: Float32Array, size: number): Uint8ClampedArray {
  const n = size * size;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = clampByte((pixels[i] + 1) / 2);
    rgba[i * 4 + 1] = clampByte((pixels[n + i] + 1) / 2);
    rgba[i * 4 + 2] = clampByte((pixels[2 * n + i] + 1) / 2);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
