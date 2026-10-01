// Push-to-talk microphone capture → 16 kHz mono Float32 (what Whisper wants).
// Uses an AudioWorklet instead of MediaRecorder: no codec round-trip, works the
// same in WebView2, Android WebView and WKWebView, and gives a live level meter.

export const WHISPER_RATE = 16000;

/** Linear-interpolation resampler (plenty for speech). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

export function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

const WORKLET = `
class SupraRec extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("supra-rec", SupraRec);
`;

export interface Recording {
  samples: Float32Array;
  seconds: number;
}

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private stopped = false;

  constructor(private onLevel?: (level: number) => void) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // The user may have released the button while the permission prompt was open.
    if (this.stopped) return this.teardown();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: WHISPER_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, "supra-rec", { numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data);
      this.onLevel?.(rms(e.data));
    };
    src.connect(node);
    node.connect(mute).connect(ctx.destination);
    this.node = node;
    if (ctx.state === "suspended") await ctx.resume();
  }

  /** Stops capturing. Returns null when nothing usable was recorded. */
  async stop(minSeconds = 0.4): Promise<Recording | null> {
    this.stopped = true;
    const rate = this.ctx?.sampleRate ?? WHISPER_RATE;
    const chunks = this.chunks;
    this.chunks = [];
    await this.teardown();
    const total = chunks.reduce((a, c) => a + c.length, 0);
    if (!total) return null;
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    const samples = resample(all, rate, WHISPER_RATE);
    const seconds = samples.length / WHISPER_RATE;
    return seconds < minSeconds ? null : { samples, seconds };
  }

  private async teardown(): Promise<void> {
    try {
      this.node?.disconnect();
    } catch { /* ignore */ }
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      await this.ctx?.close();
    } catch { /* ignore */ }
    this.ctx = null;
  }
}
