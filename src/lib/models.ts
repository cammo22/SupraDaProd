// Model manager: knows which files make up each pipeline, installs them once
// (resumable + verified) and answers "is this model here?" offline.
import { downloadFile } from "./download";
import { type Store, readJson, removeTree, usage, writeJson } from "./storage/types";
import type { Family, ModelSpec } from "./registry";

export const DEFAULT_ENDPOINT = "https://huggingface.co";

/** Supra2-IMG (flow) pipeline descriptor, as published by the ONNX repo. */
export interface PipelineConfig {
  dit: string;
  text_encoder: string;
  vae_decoder: string;
  ctx_len: number;
  latent_ch: number;
  latent_size: number;
  vae_scale: number;
  image_size: number;
}

/** Stable-diffusion 1.x descriptor (beta schedule + geometry). */
export interface SdConfig {
  image_size: number;
  latent_ch: number;
  latent_size: number;
  vae_scale: number;
  ctx_len: number;
  beta_start: number;
  beta_end: number;
  num_train_timesteps: number;
  beta_schedule: string;
}

export type ModelConfig = PipelineConfig | SdConfig;

export const isFlowConfig = (c: ModelConfig): c is PipelineConfig => "dit" in c;

export interface ManifestFile {
  path: string;
  size: number;
  sha256?: string;
  /** Which progress row this file belongs to. */
  key?: string;
}

export interface Manifest {
  version: 2;
  id: string;
  repo: string;
  family: Family;
  config: ModelConfig;
  files: ManifestFile[];
  installedAt: string;
}

/** 0.x/1.x manifests: only Supra2-IMG existed. */
interface ManifestV1 {
  version: 1;
  repo: string;
  config: PipelineConfig;
  files: Array<{ key?: string; path: string; size: number; sha256?: string }>;
  installedAt: string;
}

interface TreeItem {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid: string; size: number };
}

interface SchedulerConfig {
  beta_start?: number;
  beta_end?: number;
  num_train_timesteps?: number;
  beta_schedule?: string;
}

const joinUrl = (endpoint: string, ...p: string[]) => [endpoint.replace(/\/+$/, ""), ...p].join("/");
export const fileUrl = (endpoint: string, repo: string, path: string) =>
  joinUrl(endpoint, repo, "resolve", "main", path.split("/").map(encodeURIComponent).join("/"));

function safeRel(path: string): string {
  if (!path || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "" || s.includes("\\") || s.includes(":"))) {
    throw new Error(`unsafe path in model config: ${path}`);
  }
  return path;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Which progress row a repo path belongs to (also drives the i18n label). */
export function partOf(spec: ModelSpec, path: string, cfg?: ModelConfig): string {
  if (spec.family === "flow") {
    const flow = cfg && isFlowConfig(cfg) ? cfg : null;
    if (flow) {
      if (path === flow.dit) return "dit";
      if (path === flow.text_encoder) return "t5";
      if (path === flow.vae_decoder) return "vae";
    }
    if (/tokenizer/.test(path)) return "tok";
    if (path.includes("dit")) return "dit";
    if (path.includes("t5") || path.includes("text_encoder")) return "t5";
    return path.includes("vae") ? "vae" : "tok";
  }
  const top = path.split("/")[0];
  if (top === "unet") return "unet";
  if (top === "text_encoder") return "clip";
  if (top === "vae_decoder") return "vae";
  return "tok";
}

/** Ordered progress rows of a model. */
export const partsFor = (spec: ModelSpec): string[] =>
  spec.family === "flow" ? ["dit", "t5", "vae", "tok"] : ["unet", "clip", "vae", "tok"];

/* ------------------------------------------------------------------ *
 *  Installed state                                                    *
 * ------------------------------------------------------------------ */

export async function readManifest(store: Store, spec: ModelSpec): Promise<Manifest | null> {
  const raw = await readJson<Manifest | ManifestV1>(store, `${spec.dir}/manifest.json`);
  if (!raw) return null;
  if (raw.version === 2) return { ...raw, id: raw.id ?? spec.id, family: raw.family ?? spec.family };
  // 1.x install: upgraded on the fly, nothing has to be re-downloaded.
  return {
    version: 2,
    id: spec.id,
    repo: raw.repo ?? spec.repo,
    family: "flow",
    config: raw.config,
    files: (raw.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, key: f.key })),
    installedAt: raw.installedAt ?? new Date(0).toISOString(),
  };
}

export interface LocalStatus {
  installed: boolean;
  bytes: number;
  manifest: Manifest | null;
}

/** Offline check: every file from the manifest exists with the right size. */
export async function localStatus(store: Store, spec: ModelSpec): Promise<LocalStatus> {
  const manifest = await readManifest(store, spec);
  if (!manifest) return { installed: false, bytes: 0, manifest: null };
  let bytes = 0;
  for (const f of manifest.files) {
    const st = await store.stat(`${spec.dir}/${f.path}`);
    if (!st || st.size !== f.size) return { installed: false, bytes, manifest };
    bytes += st.size;
  }
  return { installed: true, bytes, manifest };
}

export const modelUsage = async (store: Store, spec: ModelSpec): Promise<number> =>
  usage(store, spec.dir).catch(() => 0);

export async function removeModel(store: Store, spec: ModelSpec): Promise<void> {
  await removeTree(store, spec.dir).catch(() => {});
}

/* ------------------------------------------------------------------ *
 *  Installation                                                       *
 * ------------------------------------------------------------------ */

export interface InstallProgress {
  /** Per progress row: bytes on disk and expected total (null while unknown). */
  parts: Record<string, { done: number; total: number | null }>;
  done: number;
  total: number | null;
  /** bytes per second (smoothed) */
  speed: number;
  current: string | null;
}

export interface InstallOptions {
  endpoint?: string;
  signal?: AbortSignal;
  onProgress?: (p: InstallProgress) => void;
}

/** Reads the descriptor the pipeline needs (and caches it for offline restarts). */
async function readConfig(store: Store, spec: ModelSpec, endpoint: string, signal?: AbortSignal): Promise<ModelConfig> {
  const cached = await readJson<ModelConfig>(store, `${spec.dir}/config.json`);
  if (spec.family === "flow") {
    try {
      const cfg = await fetchJson<PipelineConfig>(fileUrl(endpoint, spec.repo, "pipeline_config.json"), signal);
      safeRel(cfg.dit);
      safeRel(cfg.text_encoder);
      safeRel(cfg.vae_decoder);
      return cfg;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  }
  // sd15: the beta schedule comes from the repo, the geometry from the spec.
  const extra = spec.extra ?? {};
  let sched: SchedulerConfig = {};
  try {
    sched = await fetchJson<SchedulerConfig>(fileUrl(endpoint, spec.repo, "scheduler/scheduler_config.json"), signal);
  } catch {
    /* SD 1.x defaults below */
  }
  const downsample = extra.downsample ?? 8;
  return {
    image_size: spec.resolution,
    latent_ch: 4,
    latent_size: Math.round(spec.resolution / downsample),
    vae_scale: extra.vae_scale ?? 0.18215,
    ctx_len: extra.ctx_len ?? 77,
    beta_start: sched.beta_start ?? 0.00085,
    beta_end: sched.beta_end ?? 0.012,
    num_train_timesteps: sched.num_train_timesteps ?? 1000,
    beta_schedule: sched.beta_schedule ?? "scaled_linear",
  } satisfies SdConfig;
}

export async function installModel(store: Store, spec: ModelSpec, opts: InstallOptions = {}): Promise<Manifest> {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const { signal, onProgress } = opts;

  // 1. Config (falls back to a previous copy if the Hub is unreachable).
  const config = await readConfig(store, spec, endpoint, signal);
  await writeJson(store, `${spec.dir}/config.json`, config).catch(() => {});

  // 2. The repo file list (sizes + sha256 of the LFS objects, when available).
  const meta = new Map<string, { size?: number; sha256?: string }>();
  try {
    const tree = await fetchJson<TreeItem[]>(
      joinUrl(endpoint, "api", "models", spec.repo, "tree", "main?recursive=true"),
      signal,
    );
    for (const it of tree) {
      if (it.type === "file") meta.set(it.path, { size: it.lfs?.size ?? it.size, sha256: it.lfs?.oid });
    }
  } catch {
    /* no verification metadata: fall back to Content-Length */
  }

  // 3. Expand the plan against what the repo actually contains.
  const wanted: string[] = [];
  const add = (path: string) => {
    if (!meta.has(path)) return; // not in this export → skip quietly
    if (!wanted.includes(path)) wanted.push(safeRel(path));
  };
  for (const entry of spec.plan) {
    if (entry.endsWith("/")) {
      for (const path of meta.keys()) if (path.startsWith(entry)) add(path);
    } else add(entry);
  }
  if (isFlowConfig(config)) {
    // The Supra2-IMG ONNX file names live in pipeline_config.json.
    add(config.dit);
    add(config.text_encoder);
    add(config.vae_decoder);
  }
  if (!wanted.length) throw new Error(`nothing to download for ${spec.id} — is the repo reachable?`);
  // Small files first, then the big networks: the progress feels smoother.
  wanted.sort((a, b) => (meta.get(a)?.size ?? 0) - (meta.get(b)?.size ?? 0));

  const prog: InstallProgress = {
    parts: Object.fromEntries(partsFor(spec).map((p) => [p, { done: 0, total: null }])),
    done: 0,
    total: null,
    speed: 0,
    current: null,
  };
  const perFile = new Map<string, number>();
  let knownTotal = 0;
  let allKnown = true;
  for (const path of wanted) {
    const size = meta.get(path)?.size ?? null;
    if (size == null) allKnown = false;
    else knownTotal += size;
    const row = prog.parts[partOf(spec, path, config)];
    if (row && size != null) row.total = (row.total ?? 0) + size;
  }
  prog.total = allKnown ? knownTotal : null;

  let lastT = performance.now();
  let lastBytes = 0;
  const emit = (key: string) => {
    prog.current = key;
    for (const k of Object.keys(prog.parts)) prog.parts[k].done = 0;
    let done = 0;
    for (const path of wanted) {
      const d = perFile.get(path) ?? 0;
      done += d;
      const row = prog.parts[partOf(spec, path, config)];
      if (row) row.done += d;
    }
    prog.done = done;
    const now = performance.now();
    if (now - lastT >= 500) {
      const inst = ((done - lastBytes) / (now - lastT)) * 1000;
      prog.speed = prog.speed ? prog.speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastBytes = done;
    }
    onProgress?.(prog);
  };

  // 4. Download everything next to each other, one file at a time.
  const files: ManifestFile[] = [];
  for (const path of wanted) {
    const m = meta.get(path);
    const dest = `${spec.dir}/${path}`;
    const key = partOf(spec, path, config);
    await downloadFile(
      store,
      dest,
      { url: fileUrl(endpoint, spec.repo, path), size: m?.size, sha256: m?.sha256 },
      {
        signal,
        onProgress: (done, total) => {
          perFile.set(path, done);
          const row = prog.parts[key];
          if (row && total != null && row.total == null) row.total = total;
          emit(key);
        },
      },
    );
    const st = await store.stat(dest);
    files.push({ path, size: st?.size ?? 0, sha256: m?.sha256, key });
  }

  const manifest: Manifest = {
    version: 2,
    id: spec.id,
    repo: spec.repo,
    family: spec.family,
    config,
    files,
    installedAt: new Date().toISOString(),
  };
  await writeJson(store, `${spec.dir}/manifest.json`, manifest);
  return manifest;
}
