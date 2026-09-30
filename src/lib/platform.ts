// Runtime environment helpers shared by every module.

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isAndroid = /Android/i.test(ua);
export const isIOS = /iPhone|iPad|iPod/i.test(ua);
export const isMobile = isAndroid || isIOS;

/** Approximate device RAM in GB (Chromium only, capped at 8), or null if unknown. */
export function deviceMemoryGB(): number | null {
  const m = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof m === "number" ? m : null;
}

/** Threads for WebAssembly inference. Needs SharedArrayBuffer (cross-origin isolation). */
export function wasmThreads(): number {
  if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) return 1;
  const hc = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, hc - 1 || 1));
}

/** Directory the page is served from, always with a trailing slash. */
export function baseUrl(): string {
  return new URL(import.meta.env.BASE_URL || "/", document.baseURI).href.replace(/\/?$/, "/");
}

export async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
