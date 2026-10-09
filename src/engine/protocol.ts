import type { Solver } from "../lib/sampler";
import type { Family } from "../lib/registry";
import type { ModelConfig } from "../lib/models";

export type Backend = "webgpu" | "wasm";

/** What the worker needs to build the tokenizer of a pipeline. */
export interface TokenizerPayload {
  kind: "t5" | "clip";
  /** t5: tokenizer.json · clip: vocab.json */
  json: unknown;
  config: unknown;
  /** clip only: the content of merges.txt */
  merges?: string;
}

export interface InitArgs {
  /** Absolute URL of the directory that holds /ort. */
  base: string;
  threads: number;
  backend: Backend;
  /** Which pipeline implementation to build. */
  family: Family;
  /** Model directory inside the app storage (`models/<id>`). */
  dir: string;
  config: ModelConfig;
  /** Role → path inside `dir` (unet/clip/vae for sd15, dit/t5/vae for flow). */
  roles: Record<string, string>;
  tokenizer: TokenizerPayload;
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
  /** 0 = off … 1 = keep the guided field at the conditional scale. */
  cfgRescale: number;
  /** Output resolution in pixels; the pipeline derives its latent size. */
  size: number;
  /** Karras noise spacing (epsilon pipelines only). */
  karras?: boolean;
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
