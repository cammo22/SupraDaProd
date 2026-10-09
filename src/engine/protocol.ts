import type { Solver } from "../lib/sampler";
import type { PipelineConfig } from "../lib/models";

export type Backend = "webgpu" | "wasm";

export interface InitArgs {
  /** Absolute URL of the directory that holds /ort and /ort-tf. */
  base: string;
  threads: number;
  backend: Backend;
  config: PipelineConfig;
  tokenizer: { json: unknown; config: unknown };
  /** true → load/unload each network on demand (low RAM devices). */
  lean: boolean;
}

export interface GenerateArgs {
  prompt: string;
  negative: string;
  seed: number;
  steps: number;
  cfgScale: number;
  /** Integrator used for the denoise loop (see lib/sampler). */
  solver: Solver;
  /** 0 = off … 1 = keep the guided velocity at the conditional scale. */
  cfgRescale: number;
}

export type Phase = "load" | "encode" | "denoise" | "decode";

export type EngineEvent =
  | { ev: "progress"; phase: Phase; step: number; steps: number; detail?: string }
  | { ev: "preview"; rgba: Uint8ClampedArray; size: number }
  | { ev: "status"; text: string; backend?: Backend };

export interface GenerateResult {
  rgba: Uint8ClampedArray;
  size: number;
  backend: Backend;
}

export type ModelName = "t5" | "dit" | "vae";
