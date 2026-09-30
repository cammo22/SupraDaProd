// Speech-to-text worker: Whisper-tiny (q8) through Transformers.js, CPU/WASM.
// Model files are fetched by Transformers.js itself but stored by the main
// thread in the app's own storage (so they survive restarts and show up in
// Settings → Storage), via the `cache.*` RPC calls below.
import { Rpc, type Port } from "./rpc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipe: any = null;

const rpc = new Rpc(self as unknown as Port, { init, transcribe });

interface InitArgs {
  base: string;
  endpoint: string;
  threads: number;
}

async function init(a: InitArgs) {
  if (pipe) return;
  const tf = await import("@huggingface/transformers");
  const env = tf.env;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.remoteHost = a.endpoint.replace(/\/+$/, "") + "/";
  env.customCache = {
    async match(key: string) {
      const hit = await rpc.call<ArrayBuffer | null>("cache.match", { key });
      return hit ? new Response(hit) : undefined;
    },
    async put(key: string, response: Response) {
      const buf = await response.arrayBuffer();
      await rpc.call("cache.put", { key, bytes: buf }, [buf]);
    },
  } as never;
  const onnx = env.backends.onnx as { wasm?: Record<string, unknown> };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = `${a.base}ort-tf/`;
    onnx.wasm.numThreads = a.threads;
    onnx.wasm.proxy = false;
  }
  pipe = await tf.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: unknown) => rpc.emit({ ev: "progress", p }),
  });
}

async function transcribe(a: { audio: Float32Array; language: "italian" | "english"; task: "transcribe" | "translate" }) {
  if (!pipe) throw new Error("whisper not initialised");
  const out = await pipe(a.audio, {
    language: a.language,
    task: a.task,
    chunk_length_s: 30,
    return_timestamps: false,
  });
  const text = Array.isArray(out) ? out.map((o: { text: string }) => o.text).join(" ") : out.text;
  return { text: String(text || "").trim() };
}
