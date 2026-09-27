// Environment detection shared by all modules.
export function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}
