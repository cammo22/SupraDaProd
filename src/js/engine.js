// Supra2-IMG engine — the 100M-param DiT runs 100% on-device in the webview
// via onnxruntime-web (WebGPU, with WASM fallback). Adapted from the validated
// reference implementation shipped with Bartholomheow/Supra2-IMG-ONNX
// (Apache-2.0). Weights by SupraLabs (SupraLabs/Supra2-IMG).
/* global ort */

export const REPO = "Bartholomheow/Supra2-IMG-ONNX";
const fileUrl = (p) => `https://huggingface.co/${REPO}/resolve/main/${p}`;
const CACHE = "supra2-img-v1";

let model = null;
let loadingPromise = null;

export function isLoaded() {
  return !!model;
}

export async function webgpuAvailable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(seed, n) {
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

// Download with Cache Storage so the ~1 GB of weights is fetched exactly once.
async function download(url, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    try {
      const head = await fetch(url, { method: "HEAD" });
      const total = Number(head.headers.get("content-length")) || null;
      if (total == null || buf.byteLength === total) {
        onProgress?.(buf.byteLength, total ?? buf.byteLength);
        return buf;
      }
      await cache.delete(url); // self-heal a truncated cache entry
    } catch {
      onProgress?.(buf.byteLength, buf.byteLength);
      return buf; // offline: serve what we have
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || null;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  if (total != null && loaded !== total) throw new Error("truncated download — retry");
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  await cache.put(url, new Response(buf.slice(0)));
  return buf.buffer;
}

function halfToFloat(h) {
  const s = (h & 0x8000) << 16;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s ? -Math.pow(2, -14) * (m / 1024) : Math.pow(2, -14) * (m / 1024);
  if (e === 0x1f) return m ? NaN : (s ? -Infinity : Infinity);
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  u[0] = s | ((e + 112) << 23) | (m << 13);
  return f[0];
}

async function makeSession(path, eps, onFileProgress, label) {
  const buf = await download(fileUrl(path), (l, t) => onFileProgress?.(label, l, t));
  return await ort.InferenceSession.create(buf, { executionProviders: eps });
}

// Load the whole pipeline (DiT + T5 encoder + VAE + tokenizer).
export function loadSupra(onFileProgress) {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const cfgRes = await fetch(fileUrl("pipeline_config.json"));
    if (!cfgRes.ok) throw new Error("cannot read pipeline_config.json");
    const cfg = await cfgRes.json();
    const useGpu = await webgpuAvailable();
    const eps = useGpu ? ["webgpu", "wasm"] : ["wasm"];
    const onp = onFileProgress || (() => {});
    const dit = await makeSession(cfg.dit, eps, onp, "dit");
    const t5 = await makeSession(cfg.text_encoder, eps, onp, "t5");
    const vae = await makeSession(cfg.vae_decoder, eps, onp, "vae");
    const tf = await import(
      /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1"
    );
    tf.env.allowLocalModels = false;
    const tokenizer = await tf.AutoTokenizer.from_pretrained(REPO);
    model = {
      dit, t5, vae, cfg, tokenizer,
      backend: useGpu ? "WebGPU ⚡" : "WASM (CPU)",
    };
    return model;
  })();
  return loadingPromise;
}

// Full generation: tokenize → T5 → Euler flow (CFG) → VAE decode.
// onProgress(phase, step, steps) and onLatent(z) power the live animation.
export async function generate(prompt, {
  seed = 0,
  steps = 30,
  cfgScale = 3.0,
  onProgress,
  onLatent,
} = {}) {
  if (!model) throw new Error("model not loaded");
  const { dit, t5, vae, cfg, tokenizer } = model;
  const ctxLen = cfg.ctx_len;
  const N = cfg.latent_ch * cfg.latent_size * cfg.latent_size;
  const shape = [1, cfg.latent_ch, cfg.latent_size, cfg.latent_size];
  const tokOpts = { padding: "max_length", truncation: true, max_length: ctxLen };

  async function encode(text) {
    const tk = tokenizer(text, tokOpts);
    const ids = BigInt64Array.from(tk.input_ids.data, (v) => BigInt(v));
    const am = BigInt64Array.from(tk.attention_mask.data, (v) => BigInt(v));
    const out = await t5.run({
      input_ids: new ort.Tensor("int64", ids, [1, ctxLen]),
      attention_mask: new ort.Tensor("int64", am, [1, ctxLen]),
    });
    const hidden = Object.values(out)[0];
    const raw = hidden.data;
    const data = raw instanceof Uint16Array ? Float32Array.from(raw, halfToFloat) : Float32Array.from(raw);
    for (let i = 0; i < data.length; i++) {
      if (Number.isNaN(data[i])) throw new Error("text encoder returned NaN — try again");
    }
    const mask = new Float32Array(ctxLen);
    for (let i = 0; i < ctxLen; i++) mask[i] = am[i] === 0n ? 0 : 1;
    return { ctx: data, mask };
  }

  onProgress?.("encode", 0, steps);
  const cond = await encode(prompt);
  const uncond = await encode("");
  const toCtx = (c) => new ort.Tensor("float32", c.ctx, [1, ctxLen, c.ctx.length / ctxLen]);

  // Seed from the user seed mixed with the prompt (same prompt+different seed
  // = different image; same seed+different prompt stays reproducible too).
  const promptHash = [...prompt].reduce((a, c) => (a * 31 + (c.codePointAt(0) || 0)) | 0, 7);
  let z = gaussian((seed ^ promptHash) >>> 0, N);
  const dt = 1 / steps;

  for (let i = 0; i < steps; i++) {
    const t = new ort.Tensor("float32", new Float32Array([i * dt]), [1]);
    const vs = [];
    for (const c of [cond, uncond]) {
      const out = await dit.run({
        z: new ort.Tensor("float32", z, shape),
        t,
        ctx: toCtx(c),
        ctx_mask: new ort.Tensor("float32", c.mask, [1, ctxLen]),
      });
      vs.push(Object.values(out)[0].data);
    }
    const [vc, vu] = vs;
    const next = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      next[j] = z[j] + dt * (vu[j] + cfgScale * (vc[j] - vu[j]));
    }
    z = next;
    onProgress?.("denoise", i + 1, steps);
    if (onLatent && (i % 2 === 0 || i === steps - 1)) onLatent(z);
  }

  onProgress?.("decode", steps, steps);
  const scaled = new Float32Array(N);
  for (let i = 0; i < N; i++) scaled[i] = z[i] / cfg.vae_scale;
  const img = await vae.run({ z: new ort.Tensor("float32", scaled, shape) });
  return { pixels: Object.values(img)[0].data, size: cfg.image_size };
}

// Paint the final image (NCHW float in [-1, 1]) onto a canvas.
export function paint(pixels, size, canvas) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const n = size * size;
  for (let i = 0; i < n; i++) {
    img.data[i * 4] = clampByte((pixels[i] + 1) / 2);
    img.data[i * 4 + 1] = clampByte((pixels[n + i] + 1) / 2);
    img.data[i * 4 + 2] = clampByte((pixels[2 * n + i] + 1) / 2);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Pseudo-color preview of the raw latent — this is what makes the generation
// feel alive: you literally watch the image condense out of noise.
export function paintLatent(z, latentCh, latentSize, canvas) {
  canvas.width = latentSize;
  canvas.height = latentSize;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(latentSize, latentSize);
  const n = latentSize * latentSize;
  const useB = latentCh > 2;
  for (let i = 0; i < n; i++) {
    const r = clampByte(z[i] * 0.45 + 0.5);
    const g = clampByte(z[n + i] * 0.45 + 0.5);
    const b = clampByte((useB ? z[2 * n + i] : z[i]) * 0.45 + 0.5);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function clampByte(v) {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
