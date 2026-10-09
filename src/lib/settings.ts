// User preferences — small, synchronous, persisted in localStorage.
// (In the portable Windows build localStorage lives in the portable data folder too.)
import { isSolver, type Solver } from "./sampler";
import { DEFAULT_ENDPOINT } from "./models";

export type Lang = "it" | "en";

export interface Settings {
  lang: Lang;
  steps: number;
  cfg: number; // guidance scale
  seed: number;
  negative: string;
  backend: "auto" | "webgpu" | "wasm";
  memory: "auto" | "fast" | "lean";
  endpoint: string;
  solver: Solver; // ODE integrator of the denoise loop
  cfgRescale: number; // 0 = off … 1 = counter the over-saturation of high guidance
  exportSize: 256 | 512 | 1024;
  randomSeed: boolean; // new seed on every generation
}

export const DEFAULTS: Settings = {
  lang: detectLang(),
  steps: 20,
  cfg: 3.0,
  seed: 0,
  negative: "",
  backend: "auto",
  memory: "auto",
  endpoint: DEFAULT_ENDPOINT,
  solver: "dpmpp2m",
  cfgRescale: 0,
  exportSize: 1024,
  randomSeed: true,
};

const KEY = "supradaprod:settings:v1";

function detectLang(): Lang {
  try {
    return /^it/i.test(navigator.language) ? "it" : "en";
  } catch {
    return "en";
  }
}

function read(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings>;
  } catch {
    return {};
  }
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Keeps hand-edited / older settings files from breaking the app. */
function sanitize(s: Partial<Settings>): Settings {
  const merged = { ...DEFAULTS, ...s };
  return {
    ...merged,
    lang: merged.lang === "it" ? "it" : "en",
    steps: Math.round(clamp(merged.steps, 4, 60, DEFAULTS.steps)),
    cfg: clamp(merged.cfg, 0, 8, DEFAULTS.cfg),
    cfgRescale: clamp(merged.cfgRescale, 0, 1, DEFAULTS.cfgRescale),
    seed: Math.abs(Math.round(clamp(merged.seed, 0, 999_999_999, 0))),
    solver: isSolver(merged.solver) ? merged.solver : DEFAULTS.solver,
    exportSize: merged.exportSize === 256 || merged.exportSize === 512 ? merged.exportSize : 1024,
  };
}

let current: Settings = sanitize(read());
const listeners = new Set<(s: Settings, changed: keyof Settings) => void>();

export const settings = (): Readonly<Settings> => current;

export function update<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / blocked storage: keep in memory */
  }
  listeners.forEach((l) => l(current, key));
}

export function onChange(fn: (s: Settings, changed: keyof Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
