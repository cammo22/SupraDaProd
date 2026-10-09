// Shared contract between the engine worker and the model pipelines.
import type * as ort from "ort";
import type { Backend, EngineEvent, GenerateArgs, GenerateResult } from "../protocol";
import type { Family } from "../../lib/registry";
import type { ModelConfig } from "../../lib/models";

/** Minimal shape of a Transformers.js tokenizer (T5 and CLIP both match it). */
export interface Tokenizer {
  (text: string, opts?: Record<string, unknown>): {
    input_ids: { data: ArrayLike<number | bigint> };
    attention_mask?: { data: ArrayLike<number | bigint> };
  };
}

export interface PipeCtx {
  readonly family: Family;
  readonly config: ModelConfig;
  readonly backend: Backend;
  readonly lean: boolean;
  readonly tokenizer: Tokenizer;
  /** Embedding cache (keyed by text, owned by the worker). */
  readonly cache: Map<string, unknown>;
  /** Runs one of the model's networks, loading and caching it on first use. */
  run(role: string, feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  /** Loads a network without running it (used to warm the pipeline up). */
  load(role: string): Promise<void>;
  emit(e: EngineEvent, transfer?: Transferable[]): void;
  /** Throws an AbortError when the user pressed Stop. */
  check(): void;
  /** Lets worker messages through (call it between heavy steps). */
  tick(): Promise<void>;
  /** Frees sessions (all of them when `role` is omitted). */
  drop(role?: string): Promise<void>;
}

export interface Pipeline {
  /** Loads what should be resident (skipped in low-RAM mode). */
  warm(): Promise<void>;
  generate(args: GenerateArgs, ctx: PipeCtx): Promise<GenerateResult>;
}

export function makePipeline(family: Family, ctx: PipeCtx): Promise<Pipeline> {
  return family === "sd15" ? import("./sd15").then((m) => m.create(ctx)) : import("./flow").then((m) => m.create(ctx));
}
