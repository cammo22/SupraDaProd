/** Readable text for anything that can be thrown — Tauri commands reject with plain strings, not Errors. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
    try {
      return JSON.stringify(e);
    } catch { /* fall through */ }
  }
  return String(e);
}
