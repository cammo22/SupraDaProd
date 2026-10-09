// Canvas helpers: paint worker output, export PNGs, smooth upscale for HD export.

/** Reused staging canvas for RGBA → canvas: the live preview calls this every other step. */
let staging: HTMLCanvasElement | null = null;
let stagingCtx: CanvasRenderingContext2D | null = null;

function stage(rgba: Uint8ClampedArray, size: number): HTMLCanvasElement {
  if (!staging || staging.width !== size) {
    staging = document.createElement("canvas");
    staging.width = size;
    staging.height = size;
    stagingCtx = staging.getContext("2d");
  }
  stagingCtx!.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
  return staging;
}

export function paintRgba(rgba: Uint8ClampedArray, size: number, canvas: HTMLCanvasElement, displaySize = size): void {
  if (canvas.width !== displaySize) canvas.width = displaySize;
  if (canvas.height !== displaySize) canvas.height = displaySize;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Same buffer size → the pixels are already there, no need to clear first.
  ctx.drawImage(stage(rgba, size), 0, 0, displaySize, displaySize);
}

export const canvasToBlob = (c: HTMLCanvasElement, type = "image/png"): Promise<Blob> =>
  new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type));

/** Doubles repeatedly (better quality than one big jump) and adds a touch of sharpening. */
export async function upscalePng(png: Blob, target: number): Promise<Blob> {
  const bmp = await createImageBitmap(png);
  let cur: HTMLCanvasElement | OffscreenCanvas = document.createElement("canvas");
  cur.width = bmp.width;
  cur.height = bmp.height;
  cur.getContext("2d")!.drawImage(bmp, 0, 0);
  let size = bmp.width;
  while (size < target) {
    const next = Math.min(size * 2, target);
    const c = document.createElement("canvas");
    c.width = next;
    c.height = next;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur as CanvasImageSource, 0, 0, next, next);
    cur = c;
    size = next;
  }
  const out = cur as HTMLCanvasElement;
  sharpen(out, 0.35);
  return canvasToBlob(out);
}

/** Unsharp-style 3×3 kernel, `amount` 0..1. */
export function sharpen(canvas: HTMLCanvasElement, amount: number): void {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const s = src.data;
  const d = dst.data;
  const k = amount;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const up = s[(Math.max(0, y - 1) * w + x) * 4 + c];
        const dn = s[(Math.min(h - 1, y + 1) * w + x) * 4 + c];
        const lf = s[(y * w + Math.max(0, x - 1)) * 4 + c];
        const rt = s[(y * w + Math.min(w - 1, x + 1)) * 4 + c];
        const v = s[i + c] * (1 + 4 * k) - k * (up + dn + lf + rt);
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
}
