// Model manager: knows which files make up the Supra2-IMG pipeline, installs
// them once (resumable + verified) and answers "is everything here?" offline.
import { downloadFile } from "./download";
import { type Store, readJson, removeTree, usage, writeJson } from "./storage/types";

export const SUPRA_REPO = "Bartholomheow/Supra2-IMG-ONNX";
export const DEFAULT_ENDPOINT = "https://huggingface.co";
export const SUPRA_DIR = "models/supra2-img";
export const WHISPER_DIR = "models/whisper";

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

export type PartKey = "dit" | "t5" | "vae" | "tok";

export interface Manifest {
  version: 1;
  repo: string;
  config: PipelineConfig;
  files: Array<{ key: PartKey; path: string; size: number; sha256?: string }>;
  installedAt: string;
}

export interface InstallProgress {
  parts: Record<PartKey, { done: number; total: number | null }>;
  done: number;
  total: number | null;
  /** bytes per second (smoothed) */
  speed: number;
  current: PartKey | null;
}

interface TreeItem {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid: string; size: number };
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

export async function readManifest(store: Store): Promise<Manifest | null> {
  return readJson<Manifest>(store, `${SUPRA_DIR}/manifest.json`);
}

export interface LocalStatus {
  installed: boolean;
  bytes: number;
  manifest: Manifest | null;
}

/** Offline check: every file from the manifest exists with the right size. */
export async function localStatus(store: Store): Promise<LocalStatus> {
  const manifest = await readManifest(store);
  if (!manifest) return { installed: false, bytes: 0, manifest: null };
  let bytes = 0;
  for (const f of manifest.files) {
    const st = await store.stat(`${SUPRA_DIR}/${f.path}`);
    if (!st || st.size !== f.size) return { installed: false, bytes, manifest };
    bytes += st.size;
  }
  return { installed: true, bytes, manifest };
}

export async function installSupra(
  store: Store,
  opts: {
    endpoint?: string;
    signal?: AbortSignal;
    onProgress?: (p: InstallProgress) => void;
  } = {},
): Promise<Manifest> {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const { signal, onProgress } = opts;

  // 1. Config (falls back to a previous copy if the Hub is unreachable).
  let cfg: PipelineConfig;
  const cfgPath = `${SUPRA_DIR}/pipeline_config.json`;
  try {
    cfg = await fetchJson<PipelineConfig>(fileUrl(endpoint, SUPRA_REPO, "pipeline_config.json"), signal);
    await writeJson(store, cfgPath, cfg);
  } catch (e) {
    const local = await readJson<PipelineConfig>(store, cfgPath);
    if (!local || signal?.aborted) throw e;
    cfg = local;
  }

  // 2. Sizes + checksums from the tree API (best effort — only used to verify).
  const meta = new Map<string, { size?: number; sha256?: string }>();
  try {
    const tree = await fetchJson<TreeItem[]>(
      joinUrl(endpoint, "api", "models", SUPRA_REPO, "tree", "main?recursive=true"),
      signal,
    );
    for (const it of tree) {
      if (it.type === "file") meta.set(it.path, { size: it.lfs?.size ?? it.size, sha256: it.lfs?.oid });
    }
  } catch {
    /* no verification metadata: fall back to Content-Length */
  }

  const plan: Array<{ key: PartKey; path: string }> = [
    { key: "tok", path: "tokenizer.json" },
    { key: "tok", path: "tokenizer_config.json" },
    { key: "vae", path: safeRel(cfg.vae_decoder) },
    { key: "t5", path: safeRel(cfg.text_encoder) },
    { key: "dit", path: safeRel(cfg.dit) },
  ];

  const prog: InstallProgress = {
    parts: { dit: { done: 0, total: null }, t5: { done: 0, total: null }, vae: { done: 0, total: null }, tok: { done: 0, total: null } },
    done: 0,
    total: null,
    speed: 0,
    current: null,
  };
  for (const p of plan) {
    const m = meta.get(p.path);
    const t = prog.parts[p.key];
    t.total = m?.size != null ? (t.total ?? 0) + m.size : t.total;
  }
  const knownTotal = plan.every((p) => meta.get(p.path)?.size != null)
    ? plan.reduce((a, p) => a + meta.get(p.path)!.size!, 0)
    : null;

  const perFile = new Map<string, number>();
  let lastT = performance.now();
  let lastBytes = 0;
  const emit = (key: PartKey) => {
    prog.current = key;
    const partDone: Record<PartKey, number> = { dit: 0, t5: 0, vae: 0, tok: 0 };
    let done = 0;
    for (const p of plan) {
      const d = perFile.get(p.path) ?? 0;
      partDone[p.key] += d;
      done += d;
    }
    for (const k of Object.keys(partDone) as PartKey[]) prog.parts[k].done = partDone[k];
    prog.done = done;
    prog.total = knownTotal;
    const now = performance.now();
    if (now - lastT >= 500) {
      const inst = ((done - lastBytes) / (now - lastT)) * 1000;
      prog.speed = prog.speed ? prog.speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastBytes = done;
    }
    onProgress?.(prog);
  };

  // 3. Download everything next to each other, one file at a time.
  const files: Manifest["files"] = [];
  for (const p of plan) {
    const m = meta.get(p.path);
    const dest = `${SUPRA_DIR}/${p.path}`;
    await downloadFile(
      store,
      dest,
      { url: fileUrl(endpoint, SUPRA_REPO, p.path), size: m?.size, sha256: m?.sha256 },
      {
        signal,
        onProgress: (done, total) => {
          perFile.set(p.path, done);
          if (total != null && prog.parts[p.key].total == null) prog.parts[p.key].total = total;
          emit(p.key);
        },
      },
    );
    const st = await store.stat(dest);
    files.push({ key: p.key, path: p.path, size: st?.size ?? 0, sha256: m?.sha256 });
  }

  const manifest: Manifest = { version: 1, repo: SUPRA_REPO, config: cfg, files, installedAt: new Date().toISOString() };
  await writeJson(store, `${SUPRA_DIR}/manifest.json`, manifest);
  return manifest;
}

export async function removeSupra(store: Store): Promise<void> {
  await removeTree(store, SUPRA_DIR).catch(() => {});
}

export async function removeWhisper(store: Store): Promise<void> {
  await removeTree(store, WHISPER_DIR).catch(() => {});
}

export const modelsUsage = async (store: Store) => ({
  supra: await usage(store, SUPRA_DIR).catch(() => 0),
  whisper: await usage(store, WHISPER_DIR).catch(() => 0),
});
