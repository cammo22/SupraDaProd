// The catalogue of models the app can run. One entry = one Hugging Face repo
// plus everything needed to install, describe and sample it.
//
// Adding a model is meant to be a data change, not a code change: pick a family
// (`flow` = Supra2-IMG style velocity DiT, `sd15` = Stable-diffusion 1.x
// epsilon UNet), list the files and say how big it is.
import type { Solver } from "./sampler";

export type Family = "flow" | "sd15";

export interface ModelDefaults {
  steps: number;
  cfg: number;
  solver: Solver;
  cfgRescale: number;
  size: number;
}

export interface ModelSpec {
  id: string;
  /** Directory under `models/` — must stay stable so installs survive updates. */
  dir: string;
  repo: string;
  family: Family;
  /** Display name (product name, never translated). */
  name: string;
  /** i18n keys: `<i18n>.tagline`, `<i18n>.blurb`, `<i18n>.credits`. */
  i18n: string;
  /** Native resolution in pixels. */
  resolution: number;
  params: string;
  /** Approximate download size in bytes. */
  bytes: number;
  license: string;
  defaults: ModelDefaults;
  /** Steps proposed as one-tap presets (< fast · balanced · max). */
  presets: [number, number, number];
  /** Files (or directories) to take from the repo. */
  plan: string[];
  /** A GPU is strongly recommended (fp16 weights, big tensors). */
  gpuRecommended?: boolean;
  /** Not runnable yet — the reason is shown instead of the download button. */
  unavailable?: "no-onnx" | "too-big";
  /** Extra constants the pipeline needs (filled from the repo config where possible). */
  extra?: Record<string, number>;
}

export const REGISTRY: readonly ModelSpec[] = [
  {
    id: "supra2-img",
    dir: "models/supra2-img",
    repo: "Bartholomheow/Supra2-IMG-ONNX",
    family: "flow",
    name: "Supra2-IMG",
    i18n: "m_supra2",
    resolution: 256,
    params: "104M",
    bytes: 1_040_000_000,
    license: "Apache-2.0",
    defaults: { steps: 20, cfg: 3, solver: "dpmpp2m", cfgRescale: 0, size: 256 },
    presets: [12, 20, 32],
    plan: ["pipeline_config.json", "tokenizer.json", "tokenizer_config.json"],
  },
  {
    id: "dreamshaper-8",
    dir: "models/dreamshaper-8",
    repo: "Nikolai1902/Dreamshaper8-ONNX-Olive",
    family: "sd15",
    name: "DreamShaper 8",
    i18n: "m_dreamshaper",
    resolution: 512,
    params: "983M",
    bytes: 2_100_000_000,
    license: "CreativeML OpenRAIL-M",
    defaults: { steps: 24, cfg: 7, solver: "dpmpp2m", cfgRescale: 0, size: 512 },
    presets: [10, 24, 40],
    plan: [
      "model_index.json",
      "scheduler/scheduler_config.json",
      "tokenizer/vocab.json",
      "tokenizer/merges.txt",
      "tokenizer/tokenizer_config.json",
      "tokenizer/special_tokens_map.json",
      "text_encoder/",
      "unet/",
      "vae_decoder/",
    ],
    gpuRecommended: true,
    extra: { vae_scale: 0.18215, ctx_len: 77, downsample: 8 },
  },
  {
    id: "iris-3b",
    dir: "models/iris-3b",
    repo: "speridlabs/iris-3b",
    family: "flow",
    name: "Iris 3B",
    i18n: "m_iris",
    resolution: 1024,
    params: "3B",
    bytes: 0,
    license: "Apache-2.0",
    defaults: { steps: 24, cfg: 4, solver: "dpmpp2m", cfgRescale: 0, size: 1024 },
    presets: [12, 24, 40],
    plan: [],
    unavailable: "no-onnx",
  },
  {
    id: "anima",
    dir: "models/anima",
    repo: "circlestone-labs/Anima",
    family: "flow",
    name: "Anima (Cosmos 2B)",
    i18n: "m_anima",
    resolution: 1024,
    params: "2B + Qwen3-0.6B",
    bytes: 0,
    license: "CircleStone non-commercial",
    defaults: { steps: 8, cfg: 1, solver: "dpmpp2m", cfgRescale: 0, size: 1024 },
    presets: [8, 12, 20],
    plan: [],
    unavailable: "no-onnx",
  },
];

export const DEFAULT_MODEL_ID = "supra2-img";

export const modelById = (id: string | undefined | null): ModelSpec =>
  REGISTRY.find((m) => m.id === id) ?? REGISTRY[0];

export const modelsByFamily = (family: Family): ModelSpec[] => REGISTRY.filter((m) => m.family === family);

/** Output sizes offered per family (pixels). */
export const sizesFor = (spec: ModelSpec): number[] =>
  spec.family === "sd15" ? [384, 512, 576, 640] : [spec.resolution];
