// User preferences — small, synchronous, persisted in localStorage.
// (In the portable Windows build localStorage lives in the portable data folder too.)
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
  translate: boolean; // voice: Whisper translates speech to English
  exportSize: 256 | 512 | 1024;
  randomSeed: boolean; // new seed on every generation
}

export const DEFAULTS: Settings = {
  lang: detectLang(),
  steps: 30,
  cfg: 3.0,
  seed: 0,
  negative: "",
  backend: "auto",
  memory: "auto",
  endpoint: DEFAULT_ENDPOINT,
  translate: false,
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

let current: Settings = { ...DEFAULTS, ...read() };
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
