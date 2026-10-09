// User preferences — small, synchronous, persisted in localStorage.
// (In the portable Windows build localStorage lives in the portable data folder too.)
import { isSolver, type Solver } from "./sampler";
import { DEFAULT_ENDPOINT } from "./models";
import { DEFAULT_MODEL_ID, modelById, type ModelSpec } from "./registry";

export type Lang = "it" | "en";

/** Sampling knobs, remembered per model. */
export interface ModelParams {
  steps: number;
  cfg: number;
  solver: Solver;
  cfgRescale: number;
  size: number;
  karras: boolean;
}

export interface Settings {
  lang: Lang;
  backend: "auto" | "webgpu" | "wasm";
  memory: "auto" | "fast" | "lean";
  endpoint: string;
  exportSize: 256 | 512 | 1024;
  randomSeed: boolean;
  negative: string;
  seed: number;
  /** Currently selected model id (see lib/registry). */
  modelId: string;
  /** Last used parameters of each model id. */
  params: Record<string, ModelParams>;
}

export const paramsOf = (spec: ModelSpec): ModelParams => ({ ...spec.defaults, karras: false } as ModelParams);

export const DEFAULTS: Settings = {
  lang: detectLang(),
  backend: "auto",
  memory: "auto",
  endpoint: DEFAULT_ENDPOINT,
  exportSize: 1024,
  randomSeed: true,
  negative: "",
  seed: 0,
  modelId: DEFAULT_MODEL_ID,
  params: {},
};

const KEY = "supradaprod:settings:v1";

function detectLang(): Lang {
  try {
    return /^it/i.test(navigator.language) ? "it" : "en";
  } catch {
    return "en";
  }
}

function read(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function sanitizeParams(raw: unknown, spec: ModelSpec): ModelParams {
  const d = paramsOf(spec);
  const r = (raw ?? {}) as Partial<ModelParams>;
  const sizes = spec.family === "sd15" ? [384, 512, 576, 640] : [spec.resolution];
  return {
    steps: Math.round(clamp(r.steps, 4, 60, d.steps)),
    cfg: clamp(r.cfg, 0, 8, d.cfg),
    solver: isSolver(r.solver) ? r.solver : d.solver,
    cfgRescale: clamp(r.cfgRescale, 0, 1, d.cfgRescale),
    size: sizes.includes(Number(r.size)) ? Number(r.size) : d.size,
    karras: !!r.karras,
  };
}

/** Keeps hand-edited / older settings files from breaking the app. */
function sanitize(s: Record<string, unknown>): Settings {
  const merged = { ...DEFAULTS, ...s } as Settings;
  const params: Record<string, ModelParams> = {};
  for (const [id, value] of Object.entries((s.params as Record<string, unknown>) ?? {})) {
    if (modelById(id).id === id) params[id] = sanitizeParams(value, modelById(id));
  }
  // 2.0 stored the sampling knobs globally: keep them for the default model.
  const legacy = { steps: s.steps, cfg: s.cfg, solver: s.solver, cfgRescale: s.cfgRescale };
  if (!params[DEFAULT_MODEL_ID] && (s.steps != null || s.cfg != null || s.solver != null)) {
    params[DEFAULT_MODEL_ID] = sanitizeParams(legacy, modelById(DEFAULT_MODEL_ID));
  }
  return {
    ...merged,
    lang: merged.lang === "it" ? "it" : "en",
    seed: Math.abs(Math.round(clamp(merged.seed, 0, 999_999_999, 0))),
    exportSize: merged.exportSize === 256 || merged.exportSize === 512 ? merged.exportSize : 1024,
    modelId: modelById(merged.modelId).id,
    params,
  };
}

let current: Settings = sanitize(read());
const listeners = new Set<(s: Settings, changed: keyof Settings) => void>();

export const settings = (): Readonly<Settings> => current;

/** Sampling parameters of a model: the user's last choice, or its defaults. */
export const modelParams = (id: string): ModelParams => current.params[id] ?? paramsOf(modelById(id));

export function update<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist();
  listeners.forEach((l) => l(current, key));
}

/** Stores the sampling knobs of one model (a change per field, merged). */
export function updateParams(id: string, patch: Partial<ModelParams>): void {
  const spec = modelById(id);
  const next = { ...modelParams(id), ...patch };
  current = { ...current, params: { ...current.params, [id]: sanitizeParams(next, spec) } };
  persist();
  listeners.forEach((l) => l(current, "params"));
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / blocked storage: keep in memory */
  }
}

export function onChange(fn: (s: Settings, changed: keyof Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
