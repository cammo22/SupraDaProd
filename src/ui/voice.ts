// Voice tab: hold the mic → Whisper-tiny transcribes → generate.
import { $, toast } from "./dom";
import type { Ctx } from "./context";
import { t } from "../lib/i18n";
import { pickLean } from "../engine/client";
import { settings, update } from "../lib/settings";
import { Recorder } from "../voice/recorder";
import { WhisperClient } from "../voice/whisper";
import { errMsg } from "../lib/errors";

export function initVoice(ctx: Ctx) {
  const btn = $<HTMLButtonElement>("holdBtn");
  const zone = btn.parentElement!;
  const status = $("recStatus");
  const card = $("transcriptCard");
  const text = $<HTMLTextAreaElement>("transcript");
  const translate = $<HTMLInputElement>("translate");
  translate.checked = settings().translate;
  translate.addEventListener("change", () => update("translate", translate.checked));

  let recorder: Recorder | null = null;
  let whisper: WhisperClient | null = null;
  let recording = false;
  let lvl = 0;

  const setStatus = (msg: string, cls: "" | "rec" | "working" = "") => {
    status.textContent = msg;
    status.className = `rec-status ${cls}`.trim();
  };
  setStatus(t("rec_idle"));

  const setLevel = (raw: number) => {
    lvl = Math.max(raw * 7, lvl * 0.82);
    btn.style.setProperty("--lvl", Math.min(1, lvl).toFixed(3));
  };

  async function begin() {
    if (recording || ctx.busy) return;
    recording = true;
    btn.classList.add("recording");
    zone.classList.add("rec");
    setStatus(t("rec_hold"), "rec");
    const rec = new Recorder(setLevel);
    recorder = rec;
    try {
      await rec.start();
    } catch (e) {
      console.warn(e);
      recording = false;
      recorder = null;
      reset();
      toast(t("rec_denied"), { error: true });
    }
  }

  function reset() {
    btn.classList.remove("recording");
    zone.classList.remove("rec");
    btn.style.setProperty("--lvl", "0");
    lvl = 0;
  }

  async function end() {
    if (!recording || !recorder) return;
    const rec = recorder;
    recorder = null;
    recording = false;
    reset();
    const clip = await rec.stop();
    if (!clip) {
      setStatus(t("rec_idle"));
      return toast(t("rec_too_short"));
    }
    setStatus(t("rec_working"), "working");
    ctx.busy = true;
    try {
      whisper ??= new WhisperClient({
        store: ctx.store,
        endpoint: settings().endpoint,
        onStatus: (kind, d) => {
          if (kind === "download") setStatus(`${t("stt_dl")} ${Math.round(d?.progress ?? 0)}%`, "working");
          else setStatus(t("stt_ready"), "working");
        },
      });
      const out = await whisper.transcribe(clip.samples, settings().lang, settings().translate);
      if (!out) throw new Error("empty transcript");
      text.value = out;
      card.hidden = false;
      setStatus(t("rec_idle"));
      if (pickLean(settings().memory)) {
        whisper.dispose();
        whisper = null;
      }
    } catch (e) {
      console.warn(e);
      whisper?.dispose();
      whisper = null;
      setStatus(t("rec_idle"));
      toast(`${t("error")}: ${errMsg(e)}`, { error: true });
    } finally {
      ctx.busy = false;
    }
  }

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    void begin();
  });
  btn.addEventListener("pointerup", () => void end());
  btn.addEventListener("pointercancel", () => void end());
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  // Keyboard: hold Space / Enter.
  btn.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      void begin();
    }
  });
  btn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") void end();
  });

  $("btnRedo").addEventListener("click", () => {
    card.hidden = true;
    text.value = "";
    setStatus(t("rec_idle"));
  });
  $("btnVoiceGo").addEventListener("click", () => {
    const v = text.value.trim();
    if (!v) return;
    ctx.switchView("create");
    void ctx.generate({ prompt: v });
  });

  ctx.resetEngines = ((prev) => () => {
    prev();
    whisper?.dispose();
    whisper = null;
  })(ctx.resetEngines);
}
