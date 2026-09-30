// Main-thread handle for the Whisper worker (lazy: nothing loads until first use).
import { Rpc, Transfer } from "../workers/rpc";
import { baseUrl, wasmThreads } from "../lib/platform";
import { WHISPER_DIR, DEFAULT_ENDPOINT } from "../lib/models";
import { type Store, readAll } from "../lib/storage/types";

export interface WhisperOptions {
  store: Store;
  endpoint?: string;
  onStatus?: (kind: "download" | "ready", detail?: { file?: string; progress?: number }) => void;
}

/** URL/path key → a flat, filesystem-safe file name. */
export function cachePath(key: string): string {
  const flat = encodeURIComponent(key);
  return `${WHISPER_DIR}/${flat.length > 180 ? flat.slice(-180) : flat}`;
}

export class WhisperClient {
  private worker: Worker | null = null;
  private rpc: Rpc | null = null;
  private ready: Promise<void> | null = null;

  constructor(private opts: WhisperOptions) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    const { store } = this.opts;
    const worker = new Worker(new URL("../workers/whisper.worker.ts", import.meta.url), { type: "module" });
    const rpc = new Rpc(
      worker,
      {
        "cache.match": async ({ key }: { key: string }) => {
          const p = cachePath(key);
          if (!(await store.stat(p))) return null;
          const bytes = await readAll(store, p);
          return new Transfer(bytes.buffer, [bytes.buffer]);
        },
        "cache.put": async ({ key, bytes }: { key: string; bytes: ArrayBuffer }) => {
          await store.write(cachePath(key), new Uint8Array(bytes));
          return true;
        },
      },
      (ev: { ev: string; p?: { status?: string; file?: string; progress?: number } }) => {
        if (ev.ev === "progress" && ev.p?.status === "progress") {
          this.opts.onStatus?.("download", { file: ev.p.file, progress: ev.p.progress });
        }
      },
    );
    worker.addEventListener("error", (e) => rpc.failAll(new Error(e.message || "worker crashed")));
    this.worker = worker;
    this.rpc = rpc;
    this.ready = rpc
      .call("init", { base: baseUrl(), endpoint: this.opts.endpoint || DEFAULT_ENDPOINT, threads: wasmThreads() })
      .then(() => this.opts.onStatus?.("ready"))
      .catch((e) => {
        this.dispose();
        throw e;
      });
    return this.ready;
  }

  async transcribe(audio: Float32Array, lang: "it" | "en", translate = false): Promise<string> {
    await this.ensure();
    const res = await this.rpc!.call<{ text: string }>(
      "transcribe",
      { audio, language: lang === "it" ? "italian" : "english", task: translate ? "translate" : "transcribe" },
      [audio.buffer],
    );
    return res.text;
  }

  dispose(): void {
    this.rpc?.failAll(new Error("whisper stopped"));
    this.worker?.terminate();
    this.worker = null;
    this.rpc = null;
    this.ready = null;
  }
}
