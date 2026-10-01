// Create tab: prompt → generation (with live preview) → save.
import { $, toast } from "./dom";
import type { Ctx } from "./context";
import { ensureModel } from "./download";
import { EngineClient } from "../engine/client";
import type { EngineEvent } from "../engine/protocol";
import { t } from "../lib/i18n";
import { canvasToBlob, paintRgba, upscalePng } from "../lib/image";
import { randomPrompt } from "../lib/prompts";
import { exportImage, suggestName } from "../lib/export";
import { formatDuration } from "../lib/platform";
import { onChange, settings, update } from "../lib/settings";
import { keepAwake } from "../lib/wakelock";
import type { GalleryItem } from "../lib/gallery";

const DISPLAY = 512;

export function initCreate(ctx: Ctx) {
  const el = {
    prompt: $<HTMLTextAreaElement>("prompt"),
    go: $<HTMLButtonElement>("btnGo"),
    goLabel: $("btnGoLabel"),
    random: $<HTMLButtonElement>("btnRandom"),
    tuneBtn: $<HTMLButtonElement>("btnTune"),
    tune: $("tune"),
    steps: $<HTMLInputElement>("steps"),
    stepsVal: $("stepsVal"),
    cfg: $<HTMLInputElement>("cfg"),
    cfgVal: $("cfgVal"),
    seed: $<HTMLInputElement>("seed"),
    shuffle: $<HTMLButtonElement>("btnShuffle"),
    randomSeed: $<HTMLInputElement>("randomSeed"),
    negative: $<HTMLInputElement>("negative"),
    stage: $("stage"),
    canvas: $<HTMLCanvasElement>("canvas"),
    hint: $("stageHint"),
    progress: $("stageProgress"),
    spTitle: $("spTitle"),
    spFill: $("spFill"),
    spSub: $("spSub"),
    actions: $("resultActions"),
    variation: $<HTMLButtonElement>("btnVariation"),
    saveNow: $<HTMLButtonElement>("btnSaveNow"),
    saveHd: $<HTMLButtonElement>("btnSaveHd"),
    chip: $("backendChip"),
  };

  let engine: EngineClient | null = null;
  let abort: AbortController | null = null;
  let last: { png: Blob; prompt: string } | null = null;

  /* ---------- controls ---------- */
  const s0 = settings();
  el.steps.value = String(s0.steps);
  el.stepsVal.textContent = String(s0.steps);
  el.cfg.value = String(Math.round(s0.cfg * 10));
  el.cfgVal.textContent = s0.cfg.toFixed(1);
  el.seed.value = String(s0.seed);
  el.randomSeed.checked = s0.randomSeed;
  el.negative.value = s0.negative;

  el.steps.addEventListener("input", () => {
    el.stepsVal.textContent = el.steps.value;
    update("steps", Number(el.steps.value));
  });
  el.cfg.addEventListener("input", () => {
    const v = Number(el.cfg.value) / 10;
    el.cfgVal.textContent = v.toFixed(1);
    update("cfg", v);
  });
  el.seed.addEventListener("change", () => update("seed", seedValue()));
  el.randomSeed.addEventListener("change", () => update("randomSeed", el.randomSeed.checked));
  el.negative.addEventListener("change", () => update("negative", el.negative.value.trim()));
  el.shuffle.addEventListener("click", () => {
    el.seed.value = String(newSeed());
    update("seed", seedValue());
  });
  el.tuneBtn.addEventListener("click", () => {
    el.tune.hidden = !el.tune.hidden;
    el.tuneBtn.setAttribute("aria-expanded", String(!el.tune.hidden));
  });
  el.random.addEventListener("click", () => {
    if (ctx.busy) return;
    el.prompt.value = randomPrompt(el.prompt.value);
    el.prompt.focus();
  });
  el.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void ctx.generate();
    }
  });

  const newSeed = () => Math.floor(Math.random() * 999_999_999);
  const seedValue = () => Math.abs(Math.floor(Number(el.seed.value) || 0)) % 1_000_000_000;

  /* ---------- progress ---------- */
  let t0 = 0;
  let denoiseStart = 0;

  const setBusy = (on: boolean) => {
    ctx.busy = on;
    el.stage.classList.toggle("busy", on);
    el.progress.hidden = !on;
    el.hint.hidden = on || el.canvas.classList.contains("show");
    el.go.classList.toggle("stop", on);
    el.goLabel.textContent = on ? t("stop") : t("generate");
    el.go.querySelector("use")!.setAttribute("href", on ? "#i-stop" : "#i-spark");
    el.random.disabled = on;
    keepAwake(on);
    if (!on) {
      el.spFill.style.width = "0%";
      el.spSub.textContent = "";
    }
  };

  const onEvent = (e: EngineEvent) => {
    if (e.ev === "preview") {
      paintRgba(e.rgba, e.size, el.canvas, DISPLAY);
      el.canvas.classList.add("show");
      el.hint.hidden = true;
    } else if (e.ev === "status") {
      if (e.text === "webgpu_failed") toast(t("fallback_cpu"), { ms: 4500 });
      if (e.backend) showBackend(e.backend);
    } else if (e.ev === "progress") {
      const { phase, step, steps } = e;
      if (phase === "load") {
        el.spTitle.textContent = t("phase_load", { name: (e.detail ?? "").toUpperCase() });
        el.spSub.textContent = "";
      } else if (phase === "encode") {
        el.spTitle.textContent = t("phase_encode");
        el.spFill.style.width = "4%";
      } else if (phase === "denoise") {
        if (step === 1) denoiseStart = performance.now();
        el.spTitle.textContent = t("phase_denoise");
        el.spFill.style.width = `${(6 + (step / steps) * 88).toFixed(1)}%`;
        const per = (performance.now() - denoiseStart) / Math.max(1, step);
        const left = ((steps - step) * per) / 1000;
        el.spSub.innerHTML = `<span>${t("step_of", { a: step, b: steps })}</span><span>${step > 1 ? t("eta", { s: formatDuration(left) }) : ""}</span>`;
      } else if (phase === "decode") {
        el.spTitle.textContent = t("phase_decode");
        el.spFill.style.width = "97%";
        el.spSub.textContent = "";
      }
    }
  };

  const showBackend = (b: "webgpu" | "wasm") => {
    el.chip.textContent = `⚙ ${b === "webgpu" ? t("backend_webgpu") : t("backend_wasm")}${engine?.lean ? ` · ${t("lean_on")}` : ""}`;
    el.chip.hidden = false;
  };

  /* ---------- generate ---------- */
  async function generate(opts: { prompt?: string; newSeed?: boolean } = {}) {
    if (ctx.busy) return;
    const prompt = (opts.prompt ?? el.prompt.value).trim();
    if (!prompt) return toast(t("need_prompt"));
    if (opts.prompt != null) el.prompt.value = prompt;

    ctx.busy = true;
    abort = new AbortController();
    try {
      const manifest = await ensureModel(ctx);
      setBusy(true);
      el.actions.hidden = true;
      el.spTitle.textContent = t("phase_load", { name: "" });
      el.spFill.style.width = "2%";

      const s = settings();
      engine ??= new EngineClient({ store: ctx.store, manifest, backend: s.backend, memory: s.memory, onEvent });
      if (opts.newSeed || (s.randomSeed && opts.newSeed !== false)) {
        el.seed.value = String(newSeed());
        update("seed", seedValue());
      }
      const seed = seedValue();
      const steps = Number(el.steps.value);
      const cfgScale = Number(el.cfg.value) / 10;
      const negative = el.negative.value.trim();

      t0 = performance.now();
      const res = await engine.generate({ prompt, negative, seed, steps, cfgScale }, abort.signal);
      showBackend(res.backend);

      paintRgba(res.rgba, res.size, el.canvas, DISPLAY);
      el.canvas.classList.add("show");
      const native = document.createElement("canvas");
      paintRgba(res.rgba, res.size, native);
      const png = await canvasToBlob(native);
      last = { png, prompt };
      el.actions.hidden = false;

      const { persisted } = await ctx.gallery.add(png, { prompt, negative: negative || undefined, seed, steps, cfg: cfgScale });
      toast(persisted ? `${t("saved_gallery")} · ${formatDuration((performance.now() - t0) / 1000)}` : t("mem_only"), { error: !persisted });
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        toast(t("cancelled"));
      } else {
        console.error(err);
        toast(`${t("error")}: ${e.message}`, { error: true });
        engine?.dispose();
        engine = null;
      }
      if (!last) el.canvas.classList.remove("show");
    } finally {
      abort = null;
      setBusy(false);
    }
  }

  el.go.addEventListener("click", () => {
    if (ctx.busy) abort?.abort();
    else void generate();
  });
  el.variation.addEventListener("click", () => void generate({ newSeed: true }));

  const save = async (hd: boolean) => {
    if (!last) return;
    try {
      let blob = last.png;
      const size = settings().exportSize;
      if (hd && size > 256) blob = await upscalePng(blob, size);
      const where = await exportImage(new Uint8Array(await blob.arrayBuffer()), suggestName(last.prompt));
      if (where) toast(t("saved_to", { path: where }));
    } catch (e) {
      console.error(e);
      toast(`${t("save_failed")}: ${(e as Error).message}`, { error: true });
    }
  };
  el.saveNow.addEventListener("click", () => void save(false));
  el.saveHd.addEventListener("click", () => void save(true));

  /* ---------- api for other tabs ---------- */
  ctx.generate = generate;
  ctx.loadParams = (item: GalleryItem, lockSeed: boolean) => {
    el.prompt.value = item.prompt;
    el.negative.value = item.negative ?? "";
    update("negative", el.negative.value);
    if (item.steps) {
      el.steps.value = String(item.steps);
      el.stepsVal.textContent = String(item.steps);
      update("steps", item.steps);
    }
    if (item.cfg) {
      el.cfg.value = String(Math.round(item.cfg * 10));
      el.cfgVal.textContent = item.cfg.toFixed(1);
      update("cfg", item.cfg);
    }
    el.seed.value = String(item.seed);
    update("seed", seedValue());
    if (lockSeed) {
      el.randomSeed.checked = false;
      update("randomSeed", false);
    }
  };
  ctx.resetEngines = () => {
    engine?.dispose();
    engine = null;
  };

  onChange((_s, key) => {
    if (key === "lang") {
      el.goLabel.textContent = ctx.busy ? t("stop") : t("generate");
    }
  });
}
