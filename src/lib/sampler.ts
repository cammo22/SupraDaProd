// Pure math for the Supra2-IMG flow sampler. No DOM, no ONNX — unit-testable.
//
// The model predicts a velocity v(z, t). Sampling integrates it with plain
// Euler steps from noise (t = 0) to data (t = 1) using classifier-free
// guidance:  z ← z + dt · (v_uncond + cfg · (v_cond − v_uncond)).

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

/** One guided Euler step, writing into `out`. Also returns nothing; `guided` (optional) receives the CFG velocity. */
export function eulerStep(
  z: Float32Array,
  vCond: Float32Array,
  vUncond: Float32Array,
  dt: number,
  cfgScale: number,
  out: Float32Array,
  guided?: Float32Array,
): void {
  for (let j = 0; j < z.length; j++) {
    const v = vUncond[j] + cfgScale * (vCond[j] - vUncond[j]);
    if (guided) guided[j] = v;
    out[j] = z[j] + dt * v;
  }
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
