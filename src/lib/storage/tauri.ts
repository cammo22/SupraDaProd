import { invoke } from "@tauri-apps/api/core";
import { type Entry, type Store, type Writer, validatePath } from "./types";

interface StoreInfo {
  root: string;
  portable: boolean;
}

const enc = (p: string) => encodeURIComponent(validatePath(p));

/** Real files on disk, served by the Rust `store_*` commands (see src-tauri/src/store.rs). */
export class TauriStore implements Store {
  readonly kind = "tauri" as const;
  constructor(readonly location: string, readonly portable: boolean) {}

  static async open(): Promise<TauriStore> {
    const info = await invoke<StoreInfo>("store_info");
    return new TauriStore(info.root, info.portable);
  }

  async stat(path: string) {
    return invoke<{ size: number } | null>("store_stat", { path: validatePath(path) });
  }

  async readRange(path: string, offset: number, length: number) {
    const buf = await invoke<ArrayBuffer>("store_read", { path: validatePath(path), offset, length });
    return new Uint8Array(buf);
  }

  async write(path: string, data: Uint8Array) {
    await invoke("store_write", data, { headers: { "x-path": enc(path), "x-append": "0" } });
  }

  async openWriter(path: string, append: boolean): Promise<Writer> {
    if (!append) await this.write(path, new Uint8Array(0));
    return {
      write: async (chunk) => {
        await invoke("store_write", chunk, { headers: { "x-path": enc(path), "x-append": "1" } });
      },
      close: async () => {},
    };
  }

  async remove(path: string) {
    await invoke("store_remove", { path: validatePath(path) });
  }

  async rename(from: string, to: string) {
    await invoke("store_rename", { from: validatePath(from), to: validatePath(to) });
  }

  async list(dir: string): Promise<Entry[]> {
    return invoke<Entry[]>("store_list", { path: dir ? validatePath(dir) : "" });
  }
}
