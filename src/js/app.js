// SupraDaProd — app glue: navigation, i18n, generation flow, voice flow, gallery.
import { t, setLang, lang } from "./i18n.js";
import * as engine from "./engine.js";
import * as store from "./store.js";
import { save } from "./save.js";
import * as gallery from "./gallery.js";
import { HoldRecorder, transcribe } from "./voice.js";
import { randomPrompt } from "./prompts.js";

const $ = (id) => document.getElementById(id);
const el = {
  prompt: $("prompt"), btnGo: $("btnGo"), btnRandom: $("btnRandom"), btnTune: $("btnTune"),
  tune: $("tune"), steps: $("steps"), stepsVal: $("stepsVal"), cfg: $("cfg"), cfgVal: $("cfgVal"),
  seed: $("seed"), btnShuffle: $("btnShuffle"),
  stage: $("stage"), canvas: $("canvas"), stageHint: $("stageHint"),
  stageProgress: $("stageProgress"), spTitle: $("spTitle"), spFill: $("spFill"), spSub: $("spSub"),
  backendChip: $("backendChip"),
  dlOverlay: $("dlOverlay"), dlStatus: $("dlStatus"),
  dlDit: $("dlDit"), dlT5: $("dlT5"), dlVae: $("dlVae"),
  dlDitTxt: $("dlDitTxt"), dlT5Txt: $("dlT5Txt"), dlVaeTxt: $("dlVaeTxt"),
  holdBtn: $("holdBtn"), recStatus: $("recStatus"),
  transcriptCard: $("transcriptCard"), transcript: $("transcript"), btnRedo: $("btnRedo"),
  btnVoiceGo: $("btnVoiceGo"),
  toast: $("toast"),
};

let busy = false;
let recorder = null;

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.toast.hidden = true), 2600);
}

/* ---------------- navigation ---------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

function switchView(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${name}`));
  if (name === "gallery") gallery.render();
}

/* ---------------- language ---------------- */
$("langSwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-lang]");
  if (btn) setLang(btn.dataset.lang);
});

/* ---------------- tune controls ---------------- */
el.btnTune.addEventListener("click", () => (el.tune.hidden = !el.tune.hidden));
el.steps.addEventListener("input", () => (el.stepsVal.textContent = el.steps.value));
el.cfg.addEventListener("input", () => (el.cfgVal.textContent = (el.cfg.value / 10).toFixed(1)));
el.btnShuffle.addEventListener("click", () => (el.seed.value = Math.floor(Math.random() * 999999999)));

el.btnRandom.addEventListener("click", () => {
  if (busy) return;
  el.prompt.value = randomPrompt(el.prompt.value);
  el.prompt.focus();
});

/* ---------------- generation flow ---------------- */
el.btnGo.addEventListener("click", () => doGenerate(el.prompt.value));

function setStageLoading(on) {
  el.stage.classList.toggle("loading", on);
  el.stage.classList.toggle("busy", on);
  el.stageProgress.hidden = !on;
  el.stageHint.style.display = on ? "none" : "";
  if (!on) {
    el.spFill.style.width = "0%";
    el.spSub.textContent = "";
  }
}


async function ensureModel() {
  if (engine.isLoaded()) return engine.loadSupra();
  el.dlOverlay.hidden = false;
  el.dlStatus.textContent = "";
  const bars = { dit: [el.dlDit, el.dlDitTxt], t5: [el.dlT5, el.dlT5Txt], vae: [el.dlVae, el.dlVaeTxt] };
  for (const [fill, txt] of Object.values(bars)) { fill.style.width = "0%"; txt.textContent = "0%"; }
  const model = await engine.loadSupra((label, loaded, total) => {
    const [fill, txt] = bars[label] || [null, null];
    if (!fill) return;
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    fill.style.width = `${pct}%`;
    txt.textContent = total ? `${pct}%` : `${Math.round(loaded / 1048576)}MB`;
  });
  el.dlStatus.textContent = `${model.backend} · ${t("cached")}`;
  el.backendChip.textContent = `⚙ ${model.backend} · Supra2-IMG (104M)`;
  el.backendChip.hidden = false;
  setTimeout(() => (el.dlOverlay.hidden = true), 700);
  return model;
}

async function doGenerate(text) {
  const prompt = (text || "").trim();
  if (busy) return;
  if (!prompt) {
    toast(t("need_prompt"));
    return;
  }
  busy = true;
  el.btnGo.disabled = true;
  setStageLoading(true);
  el.canvas.classList.remove("show");
  try {
    const model = await ensureModel();
    const steps = Number(el.steps.value);
    const cfgScale = Number(el.cfg.value) / 10;
    const seed = Math.abs(Number(el.seed.value) || 0) % 1000000000;
    el.canvas.classList.add("show");
    const { pixels, size } = await engine.generate(prompt, {
      seed,
      steps,
      cfgScale,
      onProgress: showProgress,
      onLatent: (z) => engine.paintLatent(z, model.cfg.latent_ch, model.cfg.latent_size, el.canvas),
    });
    engine.paint(pixels, size, el.canvas);
    toast(t("saved"));
    const blob = await new Promise((res) => el.canvas.toBlob(res, "image/png"));
    await store.save(blob, { prompt, seed, steps, cfg: cfgScale });
  } catch (err) {
    console.error(err);
    toast(`⚠ ${t("error_generic")}: ${err.message}`);
    el.canvas.classList.remove("show");
  } finally {
    busy = false;
    el.btnGo.disabled = false;
    setStageLoading(false);
  }
}

/* ---------------- voice flow ---------------- */
async function startRec() {
  if (busy) return;
  try {
    recorder = new HoldRecorder({ onStateChange: applyRecState });
    await recorder.start();
  } catch (err) {
    console.warn(err);
    toast(`⚠ ${t("rec_denied")}`);
    recorder = null;
  }
}

async function stopRec() {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  const blob = await rec.stop();
  if (!blob) {
    toast(t("rec_too_short"));
    applyRecState("idle");
    return;
  }
  try {
    const text = await transcribe(blob, lang, (s) => (el.recStatus.textContent = s));
    if (!text) throw new Error("empty");
    el.transcript.value = text;
    el.transcriptCard.hidden = false;
    applyRecState("idle");
  } catch (err) {
    console.warn(err);
    toast(`⚠ ${t("error_generic")}`);
    applyRecState("idle");
  }
}

function applyRecState(state) {
  const rec = state === "recording";
  el.holdBtn.classList.toggle("recording", rec);
  el.recStatus.classList.toggle("rec", rec);
  el.recStatus.classList.toggle("working", state === "processing");
  el.recStatus.innerHTML = rec ? t("rec_hold") : state === "processing" ? t("rec_working") : t("rec_idle");
}

el.holdBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startRec();
});
el.holdBtn.addEventListener("pointerup", () => stopRec());
el.holdBtn.addEventListener("pointercancel", () => stopRec());
el.holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());

el.btnRedo.addEventListener("click", () => {
  el.transcriptCard.hidden = true;
  el.transcript.value = "";
  applyRecState("idle");
});

el.btnVoiceGo.addEventListener("click", () => {
  const text = el.transcript.value.trim();
  if (!text) return;
  switchView("create");
  el.prompt.value = text;
  doGenerate(text);
});

/* ---------------- boot ---------------- */
setLang(lang);
await store.init();
gallery.bind({
  reuse: (prompt) => {
    switchView("create");
    el.prompt.value = prompt;
  },
});
gallery.render();
engine.webgpuAvailable().then((ok) => {
  if (ok) {
    el.backendChip.textContent = "⚙ WebGPU ready · Supra2-IMG (104M)";
    el.backendChip.hidden = false;
  }
});
