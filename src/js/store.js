// Gallery persistence. Inside Tauri: real files in the app data dir.
// In a plain browser (dev preview): in-memory fallback so nothing crashes.
import { isTauri } from "./env.js";

let fsMod = null;
let pathMod = null;
let baseDir = null;
let index = [];

export async function init() {
  if (!isTauri()) return;
  fsMod = await import("@tauri-apps/plugin-fs");
  pathMod = await import("@tauri-apps/api/path");
  baseDir = await pathMod.join(await pathMod.appDataDir(), "gallery");
  if (!(await fsMod.exists(baseDir))) {
    await fsMod.mkdir(baseDir, { recursive: true });
  }
  const idxPath = await pathMod.join(baseDir, "index.json");
  if (await fsMod.exists(idxPath)) {
    try {
      const raw = await fsMod.readFile(idxPath);
      index = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      index = [];
    }
  }
}

async function persistIndex() {
  if (!fsMod) return;
  const idxPath = await pathMod.join(baseDir, "index.json");
  await fsMod.writeFile(idxPath, new TextEncoder().encode(JSON.stringify(index, null, 2)));
}

export function list() {
  return index;
}

export async function save(blob, meta) {
  const name = `img_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
  const entry = { file: name, ...meta, date: new Date().toISOString() };
  if (isTauri() && fsMod) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await fsMod.writeFile(await pathMod.join(baseDir, name), bytes);
    index.unshift(entry);
    await persistIndex();
  } else {
    entry.url = URL.createObjectURL(blob);
    memory.set(name, entry.url);
    index.unshift(entry);
  }
  return entry;
}

export async function urlFor(file) {
  if (isTauri() && fsMod) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(await pathMod.join(baseDir, file));
  }
  return memory.get(file) || null;
}

export async function bytesOf(file) {
  if (isTauri() && fsMod) {
    return await fsMod.readFile(await pathMod.join(baseDir, file));
  }
  const url = memory.get(file);
  if (!url) return null;
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

export async function removeItem(file) {
  if (isTauri() && fsMod) {
    try { await fsMod.remove(await pathMod.join(baseDir, file)); } catch { /* already gone */ }
  } else {
    const url = memory.get(file);
    if (url) URL.revokeObjectURL(url);
    memory.delete(file);
  }
  index = index.filter((e) => e.file !== file);
  await persistIndex();
}

const memory = new Map();
