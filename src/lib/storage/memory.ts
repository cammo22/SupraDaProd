import { type Entry, type Store, type Writer, validatePath } from "./types";

/** In-memory Store — used by unit tests. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  files = new Map<string, Uint8Array>();

  async stat(path: string) {
    const f = this.files.get(validatePath(path));
    return f ? { size: f.byteLength } : null;
  }

  async readRange(path: string, offset: number, length: number) {
    const f = this.files.get(validatePath(path));
    if (!f) throw new Error(`not found: ${path}`);
    return f.slice(offset, offset + length);
  }

  async write(path: string, data: Uint8Array) {
    this.files.set(validatePath(path), data.slice());
  }

  async openWriter(path: string, append: boolean): Promise<Writer> {
    validatePath(path);
    if (!append || !this.files.has(path)) this.files.set(path, new Uint8Array(0));
    return {
      write: async (chunk) => {
        const cur = this.files.get(path)!;
        const next = new Uint8Array(cur.byteLength + chunk.byteLength);
        next.set(cur);
        next.set(chunk, cur.byteLength);
        this.files.set(path, next);
      },
      close: async () => {},
    };
  }

  async remove(path: string) {
    validatePath(path);
    this.files.delete(path);
    for (const k of [...this.files.keys()]) if (k.startsWith(`${path}/`)) this.files.delete(k);
  }

  async rename(from: string, to: string) {
    const f = this.files.get(validatePath(from));
    if (!f) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(validatePath(to), f);
  }

  async list(dir: string): Promise<Entry[]> {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, Entry>();
    for (const [k, v] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, { name: rest, size: v.byteLength, isDir: false });
      else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), size: 0, isDir: true });
    }
    return [...seen.values()];
  }
}
