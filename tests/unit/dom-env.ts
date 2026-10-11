// The DOM scaffolding the UI unit tests run on.
//
// jsdom has no canvas, no <dialog> top layer, no IntersectionObserver and no object
// URLs, so this file provides the smallest possible fakes and mounts the *real*
// src/index.html — the UI tests then drive the real src/main.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Blob as NodeBlob } from "node:buffer";

const HTML = readFileSync(resolve(process.cwd(), "src/index.html"), "utf8");

class FakeCtx {
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  constructor(readonly canvas: HTMLCanvasElement) {}
  putImageData(): void {}
  drawImage(): void {}
  fillRect(): void {}
  clearRect(): void {}
  createImageData(w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
}

let blobs = 0;

/** Rebuilds the document and installs the browser APIs jsdom is missing. */
export function mountDom(): void {
  const body = HTML.slice(HTML.indexOf("<body>") + "<body>".length, HTML.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
  document.documentElement.lang = "en";

  const g = globalThis as Record<string, unknown>;
  // jsdom's Blob has no arrayBuffer()/text(): the gallery needs them.
  if (typeof (Blob.prototype as unknown as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    g.Blob = NodeBlob;
  }
  g.ImageData = class ImageData {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  g.IntersectionObserver = class IntersectionObserver {
    constructor(private cb: (entries: Array<{ isIntersecting: boolean; target: Element }>, obs: unknown) => void) {}
    observe(el: Element) {
      // Everything is "on screen": the gallery loads its thumbnails at once.
      this.cb([{ isIntersecting: true, target: el }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords() {
      return [];
    }
  };

  const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  canvasProto.getContext = function (this: HTMLCanvasElement) {
    return new FakeCtx(this);
  };
  canvasProto.toBlob = function (cb: (b: Blob | null) => void) {
    cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
  };

  const dialogProto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  dialogProto.show = function (this: HTMLDialogElement) {
    this.open = true;
  };
  dialogProto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  dialogProto.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };

  URL.createObjectURL = () => `blob:mock/${++blobs}`;
  URL.revokeObjectURL = () => {};

  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      persist: async () => true,
      getDirectory: async () => {
        throw new Error("OPFS is not available in unit tests");
      },
    },
  });
}

/** `<dialog>` open state, the way the UI reads it. */
export const dialog = (id: string) => document.getElementById(id) as HTMLDialogElement;

export const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Waits for `fn()` to be truthy (polling, like vi.waitFor but without the noise). */
export async function waitFor(fn: () => unknown, timeout = 4000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await tick(5);
  }
}
