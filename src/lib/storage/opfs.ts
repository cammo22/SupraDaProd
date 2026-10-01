import { type Entry, type Store, type Writer, validatePath } from "./types";

/** Origin Private File System — the Store used in a regular browser (PWA / dev / e2e). */
export class OpfsStore implements Store {
  readonly kind = "opfs" as const;
  readonly location = "browser storage";
  private rootP: Promise<FileSystemDirectoryHandle> | null = null;

  private root() {
    return (this.rootP ??= navigator.storage.getDirectory());
  }

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = await this.root();
    for (const p of parts) {
      try {
        d = await d.getDirectoryHandle(p, { create });
      } catch {
        return null;
      }
    }
    return d;
  }

  private async file(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = validatePath(path).split("/");
    const name = parts.pop()!;
    const d = await this.dir(parts, create);
    if (!d) return null;
    try {
      return await d.getFileHandle(name, { create });
    } catch {
      return null;
    }
  }

  async stat(path: string) {
    const fh = await this.file(path, false);
    return fh ? { size: (await fh.getFile()).size } : null;
  }

  async readRange(path: string, offset: number, length: number) {
    const fh = await this.file(path, false);
    if (!fh) throw new Error(`not found: ${path}`);
    const f = await fh.getFile();
    return new Uint8Array(await f.slice(offset, offset + length).arrayBuffer());
  }

  async write(path: string, data: Uint8Array) {
    const fh = (await this.file(path, true))!;
    const w = await fh.createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  }

  async openWriter(path: string, append: boolean): Promise<Writer> {
    const fh = (await this.file(path, true))!;
    const size = append ? (await fh.getFile()).size : 0;
    let w = await fh.createWritable({ keepExistingData: append });
    if (append) await w.seek(size);
    let sinceFlush = 0;
    return {
      // A writable only becomes durable on close(); re-open periodically so an
      // interrupted download keeps most of its progress.
      write: async (chunk) => {
        await w.write(chunk as unknown as FileSystemWriteChunkType);
        sinceFlush += chunk.byteLength;
        if (sinceFlush >= 64 * 1024 * 1024) {
          await w.close();
          const cur = (await fh.getFile()).size;
          w = await fh.createWritable({ keepExistingData: true });
          await w.seek(cur);
          sinceFlush = 0;
        }
      },
      close: async () => {
        await w.close();
      },
    };
  }

  async remove(path: string) {
    const parts = validatePath(path).split("/");
    const name = parts.pop()!;
    const d = await this.dir(parts, false);
    if (!d) return;
    try {
      await d.removeEntry(name, { recursive: true });
    } catch {
      /* already gone */
    }
  }

  async rename(from: string, to: string) {
    const src = await this.file(from, false);
    if (!src) throw new Error(`not found: ${from}`);
    const dst = (await this.file(to, true))!;
    const w = await dst.createWritable();
    await w.write(await src.getFile());
    await w.close();
    await this.remove(from);
  }

  async list(dir: string): Promise<Entry[]> {
    const d = await this.dir(dir ? validatePath(dir).split("/") : [], false);
    if (!d) return [];
    const out: Entry[] = [];
    for await (const [name, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (h.kind === "directory") out.push({ name, size: 0, isDir: true });
      else out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size, isDir: false });
    }
    return out;
  }
}
