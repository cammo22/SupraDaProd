// Storage abstraction. The app persists models and gallery through this
// interface so that the exact same code runs on:
//   • Tauri (Windows / macOS / Linux / Android) → real files via Rust commands
//   • a plain browser (PWA, dev server, e2e tests) → Origin Private File System
//   • unit tests → in-memory map

export interface Entry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface Writer {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface Store {
  readonly kind: "tauri" | "opfs" | "memory";
  /** Human-readable location, when there is one (shown in Settings). */
  readonly location?: string;
  /** True when running as the portable Windows build (everything next to the exe). */
  readonly portable?: boolean;
  stat(path: string): Promise<{ size: number } | null>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** Opens a writer; `append` keeps existing content, otherwise the file is truncated. */
  openWriter(path: string, append: boolean): Promise<Writer>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(dir: string): Promise<Entry[]>;
}

/** Slice size used whenever a big file crosses an IPC / worker boundary. */
export const CHUNK = 16 * 1024 * 1024;

export async function readAll(
  store: Store,
  path: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const st = await store.stat(path);
  if (!st) throw new Error(`not found: ${path}`);
  const out = new Uint8Array(st.size);
  let off = 0;
  while (off < st.size) {
    const part = await store.readRange(path, off, Math.min(CHUNK, st.size - off));
    if (part.byteLength === 0) throw new Error(`short read: ${path}`);
    out.set(part, off);
    off += part.byteLength;
    onProgress?.(off, st.size);
  }
  return out;
}

export async function readText(store: Store, path: string): Promise<string | null> {
  const st = await store.stat(path);
  if (!st) return null;
  return new TextDecoder().decode(await readAll(store, path));
}

export async function readJson<T>(store: Store, path: string): Promise<T | null> {
  try {
    const txt = await readText(store, path);
    return txt == null ? null : (JSON.parse(txt) as T);
  } catch {
    return null;
  }
}

export async function writeJson(store: Store, path: string, value: unknown): Promise<void> {
  // Write-then-rename so a crash never leaves a half-written index behind.
  const tmp = `${path}.tmp`;
  await store.write(tmp, new TextEncoder().encode(JSON.stringify(value)));
  await store.rename(tmp, path);
}

/** Total size of every file under `dir` (recursive). */
export async function usage(store: Store, dir: string): Promise<number> {
  let total = 0;
  for (const e of await store.list(dir)) {
    total += e.isDir ? await usage(store, `${dir}/${e.name}`) : e.size;
  }
  return total;
}

export async function removeTree(store: Store, dir: string): Promise<void> {
  for (const e of await store.list(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDir) await removeTree(store, p);
    else await store.remove(p);
  }
  await store.remove(dir);
}

export function validatePath(path: string): string {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || parts.some((p) => p === ".." || p === "." || p === "" || p.includes("\\") || p.includes(":"))) {
    throw new Error(`invalid storage path: ${path}`);
  }
  return path;
}
