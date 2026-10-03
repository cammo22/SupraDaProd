import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { errMsg } from "../errors";
import { type Entry, type Store, type Writer, validatePath } from "./types";

interface StoreInfo {
  root: string;
  portable: boolean;
}

/** `invoke` that always rejects with a real Error (Rust returns bare strings). */
async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    throw e instanceof Error ? e : new Error(`${cmd}: ${errMsg(e)}`);
  }
}

function toBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
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
    const buf = await invoke<ArrayBuffer | number[]>("store_read", { path: validatePath(path), offset, length });
    return buf instanceof ArrayBuffer ? new Uint8Array(buf) : Uint8Array.from(buf as ArrayLike<number>);
  }

  /**
   * Raw binary body when the webview supports it; base64 in a JSON argument when it does not
   * (Android's WebView cannot hand request bodies to custom protocols → "expected a raw binary body").
   * The first failure flips the mode for the rest of the session.
   */
  private rawBody = true;

  private async put(path: string, data: Uint8Array, append: boolean) {
    if (this.rawBody) {
      try {
        await invoke("store_write", data, { headers: { "x-path": enc(path), "x-append": append ? "1" : "0" } });
        return;
      } catch (e) {
        if (!/raw binary body|missing x-path/i.test(errMsg(e))) throw e;
        this.rawBody = false;
      }
    }
    await invoke("store_write_b64", { path: validatePath(path), append, data: toBase64(data) });
  }

  async write(path: string, data: Uint8Array) {
    await this.put(path, data, false);
  }

  async openWriter(path: string, append: boolean): Promise<Writer> {
    if (!append) await this.write(path, new Uint8Array(0));
    return {
      write: async (chunk) => {
        await this.put(path, chunk, true);
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
