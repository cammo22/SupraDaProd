// Press-and-hold voice recording → Whisper-tiny (local, ONNX) → prompt text.
import { t } from "./i18n.js";

let asr = null;
let asrLoading = null;

async function ensureWhisper(onStatus) {
  if (asr) return asr;
  if (!asrLoading) {
    asrLoading = (async () => {
      onStatus?.(t("stt_dl"));
      const tf = await import(
        /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1"
      );
      tf.env.allowLocalModels = false;
      // whisper-tiny is tiny (~50 MB q8) yet handles both Italian and English.
      asr = await tf.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        dtype: "q8",
        device: "wasm",
      });
      return asr;
    })();
    asrLoading.catch(() => { asrLoading = null; });
  }
  return asrLoading;
}

export async function transcribe(blob, language, onStatus) {
  const pipe = await ensureWhisper(onStatus);
  onStatus?.(t("stt_ready"));
  const audio = await blobTo16kMono(blob);
  const out = await pipe(audio, {
    language: language === "it" ? "italian" : "english",
    task: "transcribe",
  });
  return (out.text || "").trim();
}

async function blobTo16kMono(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(buf);
  await ctx.close();
  // Resample anything (44.1k/48k, mono/stereo) to 16 kHz mono Float32.
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000) || 16000, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

export class HoldRecorder {
  constructor({ onStateChange }) {
    this.onStateChange = onStateChange; // ("idle" | "recording" | "processing")
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mimes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];
    const mimeType = mimes.find((m) => m === "" || MediaRecorder.isTypeSupported(m));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.recorder.start(250);
    this.onStateChange?.("recording");
  }

  async stop() {
    const dur = Date.now() - this.startedAt;
    if (!this.recorder) return null;
    const rec = this.recorder;
    this.recorder = null;
    const stopped = new Promise((resolve) => {
      rec.onstop = () => resolve();
    });
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.onStateChange?.("processing");
    if (dur < 500 || !this.chunks.length) return null;
    const type = this.chunks[0].type || "audio/webm";
    return new Blob(this.chunks, { type });
  }

  abort() {
    try { if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* noop */ }
    this.recorder = null;
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.onStateChange?.("idle");
  }
}
