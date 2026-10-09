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
 * DPM-Solver++(2M) — Lu et al., "DPM-Solver++" — specialised to the rectified
 * flow parameterisation used here. With σ = 1 − t the probability-flow ODE is
 *
 *     dz/dσ = (z − D)/σ ,   D = z + σ·v          (the data estimate)
 *
 * which is exactly the semi-linear form the solver was derived for: each step is
 * exact for a constant D and second order otherwise, at one network eval per
 * step (i.e. the same cost as Euler, but a much better image at low step counts).
 */
export function integrateDpmpp2m(
  st: IntegratorState,
  z: Float32Array,
  v: Float32Array,
  t: number,
  tNext: number,
  out: Float32Array,
): void {
  const n = z.length;
  const sigma = 1 - t;
  const sigmaNext = 1 - tNext;
  const data = st.data;
  for (let j = 0; j < n; j++) data[j] = z[j] + sigma * v[j];

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
