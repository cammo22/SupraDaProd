import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadFile, HttpError } from "../../src/lib/download";
import { MemoryStore } from "../../src/lib/storage/memory";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const payload = (n: number) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 255;
  return a;
};

interface FakeOpts {
  cutAfter?: number; // first request dies after this many bytes
  ignoreRange?: boolean;
  status?: number;
  corrupt?: boolean;
  chunk?: number;
}

function fakeFetch(data: Uint8Array, o: FakeOpts = {}) {
  const calls: Array<string | undefined> = [];
  let first = true;
  const impl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push(range);
    if (o.status) return new Response("nope", { status: o.status });
    let start = 0;
    let status = 200;
    const m = /bytes=(\d+)-/.exec(range ?? "");
    if (m && !o.ignoreRange) {
      start = Number(m[1]);
      status = 206;
    }
    let body = data.subarray(start);
    if (o.corrupt) body = body.map((v, i) => (i === 10 ? v ^ 1 : v));
    const chunk = o.chunk ?? 64 * 1024;
    let off = 0;
    const die = first && o.cutAfter != null && start === 0;
    first = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (die && off >= o.cutAfter!) return ctl.error(new TypeError("network error"));
        if (off >= body.length) return ctl.close();
        const end = Math.min(off + chunk, body.length, die ? o.cutAfter! : Infinity);
        ctl.enqueue(body.slice(off, end));
        off = end;
      },
    });
    return new Response(stream, { status, headers: { "content-length": String(body.length) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** vitest's toEqual on multi-MB typed arrays is glacial — compare bytes natively. */
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

const opts = { backoffMs: 1, maxAttempts: 4 };

describe("downloadFile", () => {
  it("downloads, verifies size + sha256 and renames the .part file", async () => {
    const data = payload(1_000_000);
    const store = new MemoryStore();
    const { impl } = fakeFetch(data);
    const progress: number[] = [];
    await downloadFile(store, "m/a.bin", { url: "x", size: data.length, sha256: sha(data) }, { ...opts, fetchImpl: impl, onProgress: (d) => progress.push(d) });
    expect(store.files.get("m/a.bin")).toEqual(data);
    expect(store.files.has("m/a.bin.part")).toBe(false);
    expect(progress.at(-1)).toBe(data.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("works without any metadata (just Content-Length)", async () => {
    const data = payload(300_000);
    const store = new MemoryStore();
    await downloadFile(store, "a.bin", { url: "x" }, { ...opts, fetchImpl: fakeFetch(data).impl });
    expect(same(store.files.get("a.bin"), data)).toBe(true);
  });

  it("skips files that are already complete", async () => {
    const data = payload(1000);
    const store = new MemoryStore();
    await store.write("a.bin", data);
    const { impl, calls } = fakeFetch(data);
    await downloadFile(store, "a.bin", { url: "x", size: 1000 }, { ...opts, fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });

  it("resumes with a Range request after the connection drops", async () => {
    const data = payload(9 * 1024 * 1024);
    const store = new MemoryStore();
    const { impl, calls } = fakeFetch(data, { cutAfter: 5 * 1024 * 1024 });
    await downloadFile(store, "a.bin", { url: "x", size: data.length, sha256: sha(data) }, { ...opts, fetchImpl: impl });
    expect(same(store.files.get("a.bin"), data)).toBe(true);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatch(/^bytes=\d+-$/);
    expect(Number(/(\d+)/.exec(calls[1]!)![1])).toBeGreaterThan(0);
  });

  it("resumes from a leftover .part file of a previous run (incl. hash)", async () => {
    const data = payload(6 * 1024 * 1024);
    const store = new MemoryStore();
    await store.write("a.bin.part", data.slice(0, 4 * 1024 * 1024));
    const { impl, calls } = fakeFetch(data);
    await downloadFile(store, "a.bin", { url: "x", size: data.length, sha256: sha(data) }, { ...opts, fetchImpl: impl });
    expect(calls).toEqual([`bytes=${4 * 1024 * 1024}-`]);
    expect(same(store.files.get("a.bin"), data)).toBe(true);
  });

  it("restarts from zero when the server ignores Range", async () => {
    const data = payload(5 * 1024 * 1024);
    const store = new MemoryStore();
    await store.write("a.bin.part", data.slice(0, 1024 * 1024));
    await downloadFile(store, "a.bin", { url: "x", size: data.length, sha256: sha(data) }, { ...opts, fetchImpl: fakeFetch(data, { ignoreRange: true }).impl });
    expect(same(store.files.get("a.bin"), data)).toBe(true);
  });

  it("rejects corrupted data (sha mismatch) and never exposes it", async () => {
    const data = payload(200_000);
    const store = new MemoryStore();
    await expect(
      downloadFile(store, "a.bin", { url: "x", size: data.length, sha256: sha(data) }, { ...opts, fetchImpl: fakeFetch(data, { corrupt: true }).impl }),
    ).rejects.toThrow(/checksum/);
    expect(store.files.has("a.bin")).toBe(false);
  });

  it("does not retry hard 4xx errors", async () => {
    const store = new MemoryStore();
    const { impl, calls } = fakeFetch(payload(10), { status: 404 });
    await expect(downloadFile(store, "a.bin", { url: "x" }, { ...opts, fetchImpl: impl })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx errors", async () => {
    const store = new MemoryStore();
    const { impl, calls } = fakeFetch(payload(10), { status: 503 });
    await expect(downloadFile(store, "a.bin", { url: "x" }, { ...opts, fetchImpl: impl })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(4);
  });

  it("aborts promptly and keeps the partial data for next time", async () => {
    const data = payload(8 * 1024 * 1024);
    const store = new MemoryStore();
    const ctl = new AbortController();
    const { impl } = fakeFetch(data);
    const p = downloadFile(store, "a.bin", { url: "x", size: data.length }, {
      ...opts, fetchImpl: impl, signal: ctl.signal,
      onProgress: (d) => { if (d >= 4 * 1024 * 1024) ctl.abort(); },
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(store.files.has("a.bin")).toBe(false);
    expect(store.files.get("a.bin.part")!.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it("detects a size mismatch", async () => {
    const data = payload(5000);
    const store = new MemoryStore();
    await expect(downloadFile(store, "a.bin", { url: "x", size: 6000 }, { ...opts, maxAttempts: 1, fetchImpl: fakeFetch(data).impl })).rejects.toThrow();
    expect(store.files.has("a.bin")).toBe(false);
  });
});
