import { isTauri } from "../platform";
import type { Store } from "./types";

export * from "./types";

let cached: Promise<Store> | null = null;

/** The Store for the current environment (opened once). */
export function getStore(): Promise<Store> {
  return (cached ??= (async () => {
    if (isTauri()) {
      const { TauriStore } = await import("./tauri");
      return TauriStore.open();
    }
    const { OpfsStore } = await import("./opfs");
    return new OpfsStore();
  })());
}
