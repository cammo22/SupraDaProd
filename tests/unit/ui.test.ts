// @vitest-environment jsdom
//
// UI tests: the real index.html + the real src/main.ts, with a fake engine and an
// in-memory store. They cover the wiring the e2e suite cannot reach quickly (model
// state on the chip, gallery viewer metadata, "reuse" across models, Stop while a
// download is open, translations of the accessible names).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/lib/storage/memory";
import { modelById, REGISTRY } from "../../src/lib/registry";
import type { Ctx } from "../../src/ui/context";
import { click, dialog, mountDom, waitFor } from "./dom-env";

interface GenerateArgs {
  steps: number;
  size: number;
  [k: string]: unknown;
}

const h = vi.hoisted(() => ({
  store: null as unknown,
  engines: 0,
  failWith: null as Error | null,
  stepDelay: 0,
}));

vi.mock("../../src/lib/storage", () => ({ getStore: async () => h.store }));

vi.mock("../../src/engine/client", () => {
  interface Opts {
    spec: { id: string };
    onEvent?: (e: unknown) => void;
  }
  class EngineClient {
    readonly backend = "wasm";
    readonly lean = false;
    readonly spec: { id: string };
    constructor(private opts: Opts) {
      this.spec = opts.spec;
      h.engines++;
    }
    get running(): boolean {
      return true;
    }
    async start(): Promise<void> {}
    async generate(args: GenerateArgs, signal?: AbortSignal) {
      const emit = (e: unknown) => this.opts.onEvent?.(e);
      emit({ ev: "progress", phase: "encode", step: 0, steps: args.steps });
      for (let i = 1; i <= args.steps; i++) {
        await new Promise((r) => setTimeout(r, h.stepDelay));
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        emit({ ev: "progress", phase: "denoise", step: i, steps: args.steps });
        emit({ ev: "preview", rgba: new Uint8ClampedArray(4 * 4 * 4).fill(180), size: 4 });
      }
      if (h.failWith) throw h.failWith;
      emit({ ev: "progress", phase: "decode", step: args.steps, steps: args.steps });
      const size = args.size || 8;
      const rgba = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) % 256;
      return { rgba, size, backend: this.backend };
    }
    dispose(): void {}
  }
  return { EngineClient, pickLean: () => false };
});

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;
const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const input = (id: string) => $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
const appCtx = () => (window as unknown as { __supra: { ctx: Ctx } }).__supra.ctx;

/** Writes a manifest + dummy weights so the model counts as installed. */
async function fakeInstall(store: MemoryStore, id: string): Promise<void> {
  const spec = modelById(id);
  const flow = spec.family === "flow";
  const paths = flow
    ? ["d.onnx", "t.onnx", "v.onnx", "tokenizer.json", "tokenizer_config.json"]
    : [
        "unet/model.onnx",
        "text_encoder/model.onnx",
        "vae_decoder/model.onnx",
        "tokenizer/vocab.json",
        "tokenizer/merges.txt",
        "tokenizer/tokenizer_config.json",
        "scheduler/scheduler_config.json",
      ];
  const config = flow
    ? { dit: "d.onnx", text_encoder: "t.onnx", vae_decoder: "v.onnx", ctx_len: 8, latent_ch: 4, latent_size: 4, vae_scale: 0.18215, image_size: 16 }
    : {
        image_size: spec.resolution,
        latent_ch: 4,
        latent_size: spec.resolution / 8,
        vae_scale: 0.18215,
        ctx_len: 77,
        beta_start: 0.00085,
        beta_end: 0.012,
        num_train_timesteps: 1000,
        beta_schedule: "scaled_linear",
        steps_offset: 1,
        prediction_type: "epsilon",
      };
  for (const p of paths) await store.write(`${spec.dir}/${p}`, new Uint8Array(8));
  const manifest = {
    version: 2,
    id: spec.id,
    repo: spec.repo,
    family: spec.family,
    config,
    files: paths.map((path) => ({ path, size: 8, key: "tok" })),
    installedAt: new Date().toISOString(),
  };
  await store.write(`${spec.dir}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
}

async function boot(installed: string[] = []): Promise<{ ctx: Ctx; store: MemoryStore }> {
  vi.resetModules();
  mountDom();
  localStorage.clear();
  h.engines = 0;
  h.failWith = null;
  h.stepDelay = 0;
  const store = new MemoryStore();
  for (const id of installed) await fakeInstall(store, id);
  h.store = store;
  // A previous boot() left its handle on window: drop it so we wait for the new one.
  delete (window as unknown as { __supra?: unknown }).__supra;
  await import("../../src/main");
  await waitFor(() => (window as unknown as { __supra?: unknown }).__supra, 4000, "app boot");
  return { ctx: appCtx(), store };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("boot", () => {
  it("mounts every view and follows the installed state on the model chip", async () => {
    const { ctx } = await boot(["supra2-img"]);
    expect($("btnGoLabel").textContent).toBe("Generate");
    expect($("modelChipName").textContent).toBe("Supra2-IMG");
    // The chip warns only while the model really is missing — also right after boot.
    expect($("modelChip").classList.contains("missing")).toBe(false);
    expect(ctx.installed).toBe(true);
    expect(ctx.manifest?.id).toBe("supra2-img");
    expect($("view-create").classList.contains("on")).toBe(true);

    click(q('.tab[data-view="gallery"]'));
    expect($("view-gallery").classList.contains("on")).toBe(true);
    expect($("view-create").classList.contains("on")).toBe(false);
    expect(q('.tab[data-view="gallery"]').getAttribute("aria-selected")).toBe("true");
  });

  it("warns on the chip when nothing is installed yet", async () => {
    const { ctx } = await boot([]);
    expect($("modelChip").classList.contains("missing")).toBe(true);
    expect(ctx.installed).toBe(false);
  });
});

describe("create tab", () => {
  it("generates, previews and stores the image with its full recipe", async () => {
    const { ctx } = await boot(["supra2-img"]);
    input("prompt").value = "a cat on the moon";
    click($("btnGo"));
    await waitFor(() => ctx.gallery.items.length === 1, 4000, "a gallery item");
    expect(ctx.gallery.items[0]).toMatchObject({
      prompt: "a cat on the moon",
      model: "supra2-img",
      size: 256,
      steps: 20,
      cfg: 3,
      solver: "dpmpp2m",
    });
    expect($("canvas").classList.contains("show")).toBe(true);
    expect($("resultActions").hidden).toBe(false);
    expect($("backendChip").textContent).toContain("CPU");
    expect(ctx.busy).toBe(false);
    expect($("btnGoLabel").textContent).toBe("Generate");
    expect(h.engines).toBe(1);
  });

  it("does not start without a prompt", async () => {
    const { ctx } = await boot(["supra2-img"]);
    click($("btnGo"));
    expect(ctx.busy).toBe(false);
    expect($("toast").textContent).toContain("Type something");
    expect(h.engines).toBe(0);
  });

  it("Stop cancels a running generation and saves nothing", async () => {
    const { ctx } = await boot(["supra2-img"]);
    h.stepDelay = 4;
    input("prompt").value = "cancel me";
    click($("btnGo"));
    await waitFor(() => $("btnGo").classList.contains("stop"), 2000, "the busy state");
    expect($("btnGoLabel").textContent).toBe("Stop");
    click($("btnGo"));
    await waitFor(() => !ctx.busy, 3000, "idle again");
    expect(ctx.gallery.items).toHaveLength(0);
    expect($("toast").textContent).toContain("cancelled");
    expect($("btnGoLabel").textContent).toBe("Generate");
  });

  it("Stop also closes the download sheet of a model that is not installed", async () => {
    const { ctx } = await boot([]);
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    input("prompt").value = "download me";
    click($("btnGo"));
    await waitFor(() => dialog("dlDialog").open, 2000, "the download sheet");
    expect(ctx.busy).toBe(true);
    click($("btnGo")); // Stop, while the sheet waits for "Download & start"
    await waitFor(() => !ctx.busy, 3000, "idle again");
    expect(dialog("dlDialog").open).toBe(false);
    expect(ctx.gallery.items).toHaveLength(0);
    expect($("toast").textContent).toContain("cancelled");
  });

  it("reports engine errors and recovers on the next run", async () => {
    const { ctx } = await boot(["supra2-img"]);
    h.failWith = new Error("out of memory");
    input("prompt").value = "boom";
    click($("btnGo"));
    await waitFor(() => !ctx.busy, 3000, "idle again");
    expect(ctx.gallery.items).toHaveLength(0);
    expect($("toast").textContent).toContain("out of memory");
    expect($("toast").classList.contains("err")).toBe(true);
    h.failWith = null;
    click($("btnGo"));
    await waitFor(() => ctx.gallery.items.length === 1, 3000, "the second attempt");
  });

  it("remembers the tuning controls per model", async () => {
    const { ctx } = await boot(["supra2-img", "dreamshaper-8"]);
    click($("btnTune"));
    expect($("tune").hidden).toBe(false);
    input("steps").value = "30";
    input("steps").dispatchEvent(new Event("input"));
    expect($("stepsVal").textContent).toBe("30");
    expect($("costHint").textContent).toContain("60");
    // The SD model exposes resolution + Karras, the flow model does not.
    expect(await ctx.useModel("dreamshaper-8", { install: false })).toBe(true);
    expect($("sizeField").hidden).toBe(false);
    expect($("karrasField").hidden).toBe(false);
    expect(input("steps").value).toBe("24"); // its own default, not the 30 of the other model
    expect(await ctx.useModel("supra2-img", { install: false })).toBe(true);
    expect($("sizeField").hidden).toBe(true);
    expect($("karrasField").hidden).toBe(true);
    expect(input("steps").value).toBe("30"); // …and the 30 is still there
  });
});


describe("gallery", () => {
  const openFirst = async () => {
    click(q('.tab[data-view="gallery"]'));
    await waitFor(() => document.querySelectorAll("#galleryGrid .tile").length > 0, 2000, "tiles");
    click(q("#galleryGrid .tile"));
    await waitFor(() => dialog("imgDialog").open, 2000, "the viewer");
  };

  it("shows how the image was made and reuses it on the right model", async () => {
    const { ctx } = await boot(["supra2-img", "dreamshaper-8"]);
    await ctx.gallery.add(png(), {
      prompt: "anime portrait",
      negative: "blurry",
      seed: 7,
      steps: 24,
      cfg: 7,
      solver: "heun",
      cfgRescale: 0.5,
      model: "dreamshaper-8",
      size: 512,
    });
    await openFirst();
    const info = $("modalInfo").textContent!;
    expect(info).toContain("DreamShaper 8");
    expect(info).toContain("512×512");
    expect(info).toContain("seed 7");
    expect(info).toContain("24 steps");
    expect(info).toContain("cfg 7");
    expect(info).toContain("Heun");
    expect(info).toContain("50%");

    click($("btnReuse"));
    await waitFor(() => ctx.model.id === "dreamshaper-8", 2000, "the model switch");
    expect(input("prompt").value).toBe("anime portrait");
    expect(input("negative").value).toBe("blurry");
    expect(input("seed").value).toBe("7");
    expect(input("solver").value).toBe("heun");
    expect(input("size").value).toBe("512");
    expect($<HTMLInputElement>("randomSeed").checked).toBe(false); // "reuse" locks the seed
    expect($("view-create").classList.contains("on")).toBe(true);
  });

  it("does not download a missing model when reusing an old image", async () => {
    const { ctx } = await boot(["supra2-img"]);
    await ctx.gallery.add(png(), { prompt: "old dream", seed: 3, steps: 10, cfg: 5, model: "dreamshaper-8", size: 512 });
    await openFirst();
    click($("btnReuse"));
    await waitFor(() => $("toast").textContent!.includes("not installed"), 2000, "the explanation");
    expect(ctx.model.id).toBe("supra2-img");
    expect(dialog("dlDialog").open).toBe(false);
    expect(input("prompt").value).toBe("old dream"); // the prompt is still worth reusing
    expect($("view-create").classList.contains("on")).toBe(true);
  });

  it("keeps an unknown model id visible instead of guessing", async () => {
    const { ctx } = await boot(["supra2-img"]);
    await ctx.gallery.add(png(), { prompt: "from the future", seed: 1, steps: 8, cfg: 2, model: "model-that-is-gone", size: 256 });
    await openFirst();
    expect($("modalInfo").textContent).toContain("model-that-is-gone");
  });

  it("favorites, searches and deletes from the viewer", async () => {
    const { ctx } = await boot(["supra2-img"]);
    await ctx.gallery.add(png(), { prompt: "keep me", seed: 1, steps: 8, cfg: 2 });
    await ctx.gallery.add(png(), { prompt: "drop me", seed: 2, steps: 8, cfg: 2 });
    await openFirst();
    click($("btnFav"));
    expect(ctx.gallery.items[0].fav).toBe(true);

    click($("btnDelete"));
    await waitFor(() => dialog("confirmDialog").open, 2000, "the confirmation");
    click($("confirmYes"));
    await waitFor(() => ctx.gallery.items.length === 1, 2000, "the deletion");
    expect($("galleryCount").textContent).toBe("1");
    expect($("galleryBadge").textContent).toBe("1");

    input("gallerySearch").value = "nothing matches";
    input("gallerySearch").dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#galleryGrid .tile")).toHaveLength(0);
    expect($("galleryEmpty").hidden).toBe(false);
    expect($("galleryEmpty").textContent).toContain("No results");
  });
});


describe("model selector", () => {
  it("lists the catalogue with credits, state and a hidden progress bar", async () => {
    await boot(["supra2-img"]);
    click($("modelChip"));
    await waitFor(() => dialog("modelsDialog").open, 2000, "the selector");
    const cards = [...document.querySelectorAll<HTMLElement>("#modelsList .model-card")];
    expect(cards).toHaveLength(REGISTRY.length);
    expect(cards.filter((c) => c.classList.contains("off"))).toHaveLength(2);

    const supra = cards.find((c) => c.dataset.model === "supra2-img")!;
    expect(supra.textContent).toContain("Bartholomheow"); // weight / ONNX-conversion credits
    expect(supra.textContent).toContain("installed");
    expect(supra.querySelector<HTMLButtonElement>(".btn.primary")!.disabled).toBe(true);
    expect(supra.querySelector<HTMLElement>(".bar")!.hidden).toBe(true);

    const dream = cards.find((c) => c.dataset.model === "dreamshaper-8")!;
    expect(dream.querySelector(".btn.ghost")).toBeTruthy(); // download
    expect(dream.querySelector<HTMLElement>(".bar")!.hidden).toBe(true);
    expect(dream.textContent).not.toContain("installed");

    const iris = cards.find((c) => c.dataset.model === "iris-3b")!;
    expect(iris.textContent).toContain("unavailable");
    expect(iris.querySelector("button")).toBeNull();
    expect($("modelsFoot").textContent).toContain("1 models installed");
  });

  it("never starts a download it was not asked for", async () => {
    const { ctx } = await boot(["supra2-img"]);
    expect(await ctx.useModel("dreamshaper-8", { install: false })).toBe(false);
    expect(ctx.model.id).toBe("supra2-img");
    expect(dialog("dlDialog").open).toBe(false);
    // Models without an ONNX export explain themselves instead of downloading.
    expect(await ctx.useModel("iris-3b")).toBe(false);
    expect(ctx.model.id).toBe("supra2-img");
    expect(dialog("dlDialog").open).toBe(false);
  });

  it("switches between two installed models and follows on the chip", async () => {
    const { ctx } = await boot(["supra2-img", "dreamshaper-8"]);
    expect(await ctx.useModel("dreamshaper-8")).toBe(true);
    expect($("modelChipName").textContent).toBe("DreamShaper 8");
    expect($("modelChip").classList.contains("missing")).toBe(false);
    expect(await ctx.useModel("supra2-img")).toBe(true);
    expect($("modelChipName").textContent).toBe("Supra2-IMG");
  });
});

describe("settings", () => {
  it("opens on the stored values, shows the storage and translates the UI", async () => {
    await boot(["supra2-img"]);
    click($("btnSettings"));
    expect(dialog("settingsDialog").open).toBe(true);
    expect($("stVersion").textContent).toBe("0.0.0-test");
    expect($("stRuntime").textContent).toContain("Web");
    await waitFor(() => $("stModels").textContent!.length > 0, 2000, "the storage rows");
    expect($("stModels").textContent).toContain("Supra2-IMG ✓");
    expect($("stModels").textContent).toContain("not installed");
    expect($<HTMLSelectElement>("stBackend").value).toBe("auto");
    expect($<HTMLSelectElement>("stMemory").value).toBe("auto");
    expect($<HTMLSelectElement>("stExport").value).toBe("1024");

    click(q('#langSwitch button[data-lang="it"]'));
    expect($("btnGoLabel").textContent).toBe("Genera");
    expect($("langSwitch").getAttribute("aria-label")).toBe("Lingua");
    expect($("btnShuffle").getAttribute("aria-label")).toBe("Seed casuale");
    expect($("imgNext").getAttribute("aria-label")).toBe("Immagine successiva");
    expect(document.documentElement.lang).toBe("it");
  });

  it("validates the model source", async () => {
    await boot(["supra2-img"]);
    click($("btnSettings"));
    input("stEndpoint").value = "not a url";
    input("stEndpoint").dispatchEvent(new Event("change"));
    expect(input("stEndpoint").value).toBe("https://huggingface.co");
    input("stEndpoint").value = "https://mirror.example/hf/";
    input("stEndpoint").dispatchEvent(new Event("change"));
    expect(input("stEndpoint").value).toBe("https://mirror.example/hf");
  });
});

