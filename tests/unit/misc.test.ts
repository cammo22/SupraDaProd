import { describe, expect, it } from "vitest";
import { Rpc, Transfer } from "../../src/workers/rpc";
import { MemoryStore } from "../../src/lib/storage/memory";
import { readAll, readJson, removeTree, usage, validatePath, writeJson } from "../../src/lib/storage/types";
import { PROMPTS, randomPrompt } from "../../src/lib/prompts";
import { formatBytes, formatDuration } from "../../src/lib/platform";
import { fileUrl, installModel, localStatus, removeModel } from "../../src/lib/models";
import { modelById, DEFAULT_MODEL_ID } from "../../src/lib/registry";
import { Gallery } from "../../src/lib/gallery";
import { suggestName } from "../../src/lib/export";
import { t } from "../../src/lib/i18n";

describe("rpc", () => {
  const link = () => {
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    return [port1, port2] as const;
  };

  it("calls handlers both ways, propagates errors and events", async () => {
    const [a, b] = link();
    const events: unknown[] = [];
    const left = new Rpc(a as never, { ping: (x: number) => x + 1, boom: () => { throw Object.assign(new Error("bad"), { name: "AbortError" }); } });
    const right = new Rpc(b as never, { twice: async (x: number) => x * 2 }, (e) => events.push(e));
    expect(await right.call("ping", 41)).toBe(42);
    expect(await left.call("twice", 21)).toBe(42);
    await expect(right.call("boom")).rejects.toMatchObject({ message: "bad", name: "AbortError" });
    await expect(right.call("nope")).rejects.toThrow(/unknown method/);
    left.emit({ ev: "hello" });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([{ ev: "hello" }]);
    a.close(); b.close();
  });

  it("transfers buffers without copying", async () => {
    const [a, b] = link();
    const big = new Uint8Array(1024).fill(9);
    const left = new Rpc(a as never, { get: () => new Transfer(big.buffer, [big.buffer]) });
    const right = new Rpc(b as never, {});
    const got = await right.call<ArrayBuffer>("get");
    expect(new Uint8Array(got)[5]).toBe(9);
    expect(big.byteLength).toBe(0); // detached → zero-copy
    void left;
    a.close(); b.close();
  });

  it("failAll rejects pending calls", async () => {
    const [a, b] = link();
    const r = new Rpc(a as never, {});
    new Rpc(b as never, { slow: () => new Promise(() => {}) });
    const p = r.call("slow");
    r.failAll(new Error("gone"));
    await expect(p).rejects.toThrow("gone");
    a.close(); b.close();
  });
});

describe("storage helpers", () => {
  it("validates paths", () => {
    for (const bad of ["", "/a", "a/../b", "a//b", "a\\b", "C:/x", "."]) expect(() => validatePath(bad)).toThrow();
    expect(validatePath("a/b.c")).toBe("a/b.c");
  });
  it("round-trips json, lists, sizes and removes trees", async () => {
    const s = new MemoryStore();
    await writeJson(s, "x/i.json", { a: 1 });
    expect(await readJson(s, "x/i.json")).toEqual({ a: 1 });
    expect(await readJson(s, "x/missing.json")).toBeNull();
    await s.write("x/y/z.bin", new Uint8Array(10));
    expect(await usage(s, "x")).toBeGreaterThan(10);
    expect((await s.list("x")).map((e) => e.name).sort()).toEqual(["i.json", "y"]);
    expect(await readAll(s, "x/y/z.bin")).toHaveLength(10);
    await removeTree(s, "x");
    expect(await s.list("x")).toEqual([]);
  });
});

describe("prompts / formatting / i18n", () => {
  it("random prompt avoids repeating the current one", () => {
    for (let i = 0; i < 50; i++) expect(randomPrompt(PROMPTS[0])).not.toBe(PROMPTS[0]);
  });
  it("formats sizes and durations", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(417 * 1024 * 1024)).toBe("417 MB");
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(125)).toBe("2m 05s");
  });
  it("has every key in both languages and interpolates", () => {
    expect(t("saved_to", { path: "/x" })).toContain("/x");
    expect(t("step_of", { a: 3, b: 9 })).toMatch(/3\/9/);
  });
  it("suggests safe file names", () => {
    expect(suggestName("a cat: on/the moon!")).toBe("supradaprod_a_cat_onthe_moon.png");
    expect(suggestName("")).toBe("supradaprod_image.png");
  });
});

describe("model manager", () => {
  it("builds hub urls", () => {
    expect(fileUrl("https://hf.co/", "a/b", "dir/x y.onnx")).toBe("https://hf.co/a/b/resolve/main/dir/x%20y.onnx");
  });

  it("installs from a hub, verifies, and reports status offline", async () => {
    const cfg = { dit: "d.onnx", text_encoder: "t.onnx", vae_decoder: "v.onnx", ctx_len: 4, latent_ch: 4, latent_size: 8, vae_scale: 0.18, image_size: 64 };
    const files: Record<string, Uint8Array> = {
      "tokenizer.json": new TextEncoder().encode("{}"),
      "tokenizer_config.json": new TextEncoder().encode("{}"),
      "d.onnx": new Uint8Array(3000).fill(1),
      "t.onnx": new Uint8Array(2000).fill(2),
      "v.onnx": new Uint8Array(1000).fill(3),
    };
    const { createHash } = await import("node:crypto");
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("pipeline_config.json")) return new Response(JSON.stringify(cfg));
      if (url.includes("/tree/main")) {
        return new Response(JSON.stringify(Object.entries(files).map(([path, b]) => ({
          type: "file", path, size: b.length,
          ...(path.endsWith(".onnx") ? { lfs: { oid: createHash("sha256").update(b).digest("hex"), size: b.length } } : {}),
        }))));
      }
      const name = decodeURIComponent(url.split("/resolve/main/")[1]);
      return new Response(files[name] as unknown as BodyInit, { headers: { "content-length": String(files[name].length) } });
    }) as typeof fetch;
    try {
      const s = new MemoryStore();
      const supra = modelById(DEFAULT_MODEL_ID);
      expect((await localStatus(s, supra)).installed).toBe(false);
      const seen: number[] = [];
      const man = await installModel(s, supra, { endpoint: "https://hub.test", onProgress: (p) => seen.push(p.done) });
      expect(man.files.map((f) => f.key).sort()).toEqual(["dit", "t5", "tok", "tok", "vae"]);
      expect(man.version).toBe(2);
      expect(seen.at(-1)).toBe(3000 + 2000 + 1000 + 4);
      globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
      const st = await localStatus(s, supra);
      expect(st.installed).toBe(true);
      expect(st.bytes).toBe(6004);
      // truncating a file invalidates the install
      await s.write(`${supra.dir}/d.onnx`, new Uint8Array(5));
      expect((await localStatus(s, supra)).installed).toBe(false);
      await removeModel(s, supra);
      expect(await s.list(supra.dir)).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("rejects configs with path traversal", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("pipeline_config.json")) return new Response(JSON.stringify({ dit: "../evil", text_encoder: "t", vae_decoder: "v" }));
      return new Response("[]");
    }) as typeof fetch;
    try {
      await expect(installModel(new MemoryStore(), modelById(DEFAULT_MODEL_ID), { endpoint: "https://hub.test" })).rejects.toThrow(/unsafe path/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("gallery", () => {
  const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

  it("adds, persists, favorites, removes", async () => {
    const s = new MemoryStore();
    const g = new Gallery(s);
    await g.load();
    const { item, persisted } = await g.add(png(), { prompt: "p", seed: 1, steps: 10, cfg: 3 });
    expect(persisted).toBe(true);
    await g.toggleFav(item.id);
    const g2 = new Gallery(s);
    await g2.load();
    expect(g2.items).toHaveLength(1);
    expect(g2.items[0]).toMatchObject({ prompt: "p", seed: 1, fav: true });
    expect((await g2.bytes(item.id))[0]).toBe(137);
    await g2.remove(item.id);
    expect((await s.list("gallery")).map((e) => e.name)).toEqual(["index.json"]);
    expect(g2.items).toHaveLength(0);
  });

  it("reads the 0.x index format", async () => {
    const s = new MemoryStore();
    await s.write("gallery/index.json", new TextEncoder().encode(JSON.stringify([{ file: "img_1_2.png", prompt: "old", seed: 3, steps: 30, cfg: 3, date: "2026-01-01T00:00:00Z" }])));
    await s.write("gallery/img_1_2.png", new Uint8Array([1, 2, 3]));
    const g = new Gallery(s);
    await g.load();
    expect(g.items[0]).toMatchObject({ id: "img_1_2.png", prompt: "old", fav: false });
    expect(await g.bytes("img_1_2.png")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("keeps the image in memory when the disk write fails", async () => {
    const s = new MemoryStore();
    s.write = async () => { throw new Error("disk full"); };
    const g = new Gallery(s);
    const { item, persisted } = await g.add(png(), { prompt: "p", seed: 1, steps: 1, cfg: 1 });
    expect(persisted).toBe(false);
    expect(item.volatile).toBe(true);
    expect(g.items).toHaveLength(1);
    expect(await g.url(item.id)).toMatch(/^blob:/);
  });
});
