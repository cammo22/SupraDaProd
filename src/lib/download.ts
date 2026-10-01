// Resumable, verified downloads straight to disk.
//
//  • streams to `<dest>.part` so memory stays flat even for 400 MB files
//  • resumes with HTTP Range after a crash / lost connection / app restart
//  • retries with backoff and a stall watchdog (mobile networks are flaky)
//  • optionally verifies size and SHA-256 before the file becomes visible
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { type Store, type Writer, CHUNK } from "./storage/types";

export interface RemoteFile {
  url: string;
  /** Expected size in bytes (from the Hub tree API), if known. */
  size?: number;
  /** Expected SHA-256 (hex), if known. */
  sha256?: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** (bytes on disk so far, total bytes or null) */
  onProgress?: (done: number, total: number | null) => void;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  stallMs?: number;
  backoffMs?: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const FLUSH = 4 * 1024 * 1024;

const abortError = () => new DOMException("aborted", "AbortError");
const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });

/** Incremental SHA-256 that can be resumed from a partial file on disk. */
class Hasher {
  private h = sha256.create();
  pos = 0;
  update(b: Uint8Array) {
    this.h.update(b);
    this.pos += b.byteLength;
  }
  hex() {
    return bytesToHex(this.h.digest());
  }
}

async function hashPrefix(store: Store, path: string, length: number, signal?: AbortSignal): Promise<Hasher> {
  const h = new Hasher();
  let off = 0;
  while (off < length) {
    if (signal?.aborted) throw abortError();
    const part = await store.readRange(path, off, Math.min(CHUNK, length - off));
    if (!part.byteLength) break;
    h.update(part);
    off += part.byteLength;
    await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
  }
  return h;
}

export async function downloadFile(
  store: Store,
  dest: string,
  file: RemoteFile,
  opts: DownloadOptions = {},
): Promise<void> {
  const { signal, onProgress, fetchImpl = fetch } = opts;
  const maxAttempts = opts.maxAttempts ?? 6;
  const stallMs = opts.stallMs ?? 30_000;
  const backoff = opts.backoffMs ?? 1500;
  const part = `${dest}.part`;

  // Already complete and intact?
  const existing = await store.stat(dest);
  if (existing && (file.size == null || existing.size === file.size)) {
    onProgress?.(existing.size, existing.size);
    return;
  }

  let hasher: Hasher | null = null;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) await sleep(Math.min(backoff * 2 ** (attempt - 1), 15_000), signal);

    let have = (await store.stat(part))?.size ?? 0;
    if (file.size != null && have > file.size) {
      await store.remove(part);
      have = 0;
      hasher = null;
    }

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctl.abort(), stallMs);
    };

    let writer: Writer | null = null;
    try {
      if (file.sha256 && (!hasher || hasher.pos !== have)) {
        hasher = have > 0 ? await hashPrefix(store, part, have, signal) : new Hasher();
      }

      if (file.size != null && have === file.size) {
        // Everything is on disk already; only the verification is left.
      } else {
        arm();
        const res = await fetchImpl(file.url, {
          headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
          signal: ctl.signal,
        });
        if (res.status === 416) {
          await store.remove(part);
          have = 0;
          hasher = null;
          throw new Error("server rejected range — restarting");
        }
        if (!res.ok) throw new HttpError(res.status, file.url);
        if (!res.body) throw new Error("no response body");

        let append = have > 0;
        if (have > 0 && res.status !== 206) {
          // Server ignored Range: start over.
          have = 0;
          append = false;
          hasher = file.sha256 ? new Hasher() : null;
        }
        const len = Number(res.headers.get("content-length"));
        const total = file.size ?? (Number.isFinite(len) && len > 0 ? have + len : null);

        writer = await store.openWriter(part, append);
        const reader = res.body.getReader();
        let buf = new Uint8Array(FLUSH);
        let fill = 0;
        let done = have;
        onProgress?.(done, total);

        const flush = async () => {
          if (!fill) return;
          const slice = buf.subarray(0, fill);
          await writer!.write(slice);
          hasher?.update(slice);
          done += fill;
          fill = 0;
          onProgress?.(done, total);
          if (hasher) await new Promise((r) => setTimeout(r, 0));
        };

        for (;;) {
          const { done: end, value } = await reader.read();
          if (signal?.aborted) {
            void reader.cancel().catch(() => {});
            throw abortError();
          }
          if (end) break;
          arm();
          let off = 0;
          while (off < value.byteLength) {
            const n = Math.min(buf.byteLength - fill, value.byteLength - off);
            buf.set(value.subarray(off, off + n), fill);
            fill += n;
            off += n;
            if (fill === buf.byteLength) await flush();
          }
        }
        await flush();
        buf = new Uint8Array(0);
        await writer.close();
        writer = null;
        have = done;
      }

      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);

      const finalSize = (await store.stat(part))?.size ?? 0;
      if (file.size != null && finalSize !== file.size) {
        throw new Error(`size mismatch: got ${finalSize}, expected ${file.size}`);
      }
      if (file.sha256) {
        const got = hasher!.hex();
        if (got !== file.sha256.toLowerCase()) {
          await store.remove(part);
          hasher = null;
          throw new Error("checksum mismatch — file was corrupted, retrying");
        }
      }
      await store.rename(part, dest);
      onProgress?.(finalSize, finalSize);
      return;
    } catch (e) {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      try { await writer?.close(); } catch { /* ignore */ }
      if (signal?.aborted) throw abortError();
      if (isAbort(e) && !signal?.aborted) {
        lastErr = new Error("connection stalled");
        continue;
      }
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
