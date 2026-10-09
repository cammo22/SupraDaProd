// IT / EN — that's the whole list 🇮🇹🇬🇧
import { type Lang, settings, update } from "./settings";

const it = {
  tagline: "104M parametri, 100% sul tuo dispositivo",
  tab_create: "Crea",
  tab_gallery: "Galleria",
  settings: "Impostazioni",
  stage_hint: "Scrivi il prompt e premi Genera ✨",
  prompt_ph: "Descrivi l'immagine che vuoi… (in inglese il modello rende meglio)",
  random: "Random",
  tune: "Regola",
  generate: "Genera",
  stop: "Ferma",
  steps: "Passi",
  guidance: "Fedeltà al prompt",
  solver: "Metodo di campionamento",
  solver_dpmpp2m: "DPM++ 2M — consigliato",
  solver_euler: "Euler — classico (come la 1.x)",
  solver_heun: "Heun — preciso, 2× più lento",
  cfg_rescale: "Correzione saturazione",
  evals_hint: "≈ {n} passaggi nel modello",
  preset_fast: "Rapida",
  preset_balanced: "Bilanciata",
  preset_max: "Massima",
  seed: "Seed",
  seed_random: "Seed casuale a ogni immagine",
  negative: "Da evitare (opzionale)",
  negative_ph: "es. blurry, dark, text",
  need_prompt: "Scrivi qualcosa prima ✨",
  variation: "Variazione",
  save: "Salva",
  save_hd: "Salva HD",
  saved_gallery: "Salvato in galleria",
  saved_to: "Salvato: {path}",
  save_failed: "Non sono riuscito a salvare",
  mem_only: "Attenzione: non riesco a scrivere su disco, l'immagine resta solo finché l'app è aperta",
  cancelled: "Generazione annullata",
  error: "Ops, errore",
  backend_webgpu: "WebGPU ⚡",
  backend_wasm: "CPU (WASM)",
  fallback_cpu: "La GPU ha avuto un problema: passo alla CPU (più lento ma funziona)",
  lean_on: "modalità risparmio RAM",

  phase_load: "Carico il modello ({name})…",
  phase_encode: "Leggo il prompt…",
  phase_denoise: "La magia prende forma",
  phase_decode: "Rivelo l'immagine…",
  step_of: "passo {a}/{b}",
  eta: "~{s} rimanenti",

  gallery: "Galleria",
  gallery_empty: "Le tue creazioni vivranno qui.",
  gallery_none_found: "Nessun risultato.",
  search_ph: "Cerca nei prompt…",
  only_fav: "Solo preferiti",
  reuse: "Riusa",
  delete: "Elimina",
  delete_confirm: "Eliminare questa immagine?",
  deleted: "Eliminata",
  img_missing: "Immagine non disponibile",
  close: "Chiudi",
  favorite: "Preferito",

  dl_title: "Un solo scaricamento, poi è tutto tuo",
  dl_sub: "Il modello (~1 GB) viene salvato sul dispositivo: dopo funziona anche senza internet.",
  dl_mobile_hint: "Consiglio: usa il Wi-Fi. Se la connessione cade, riprendo da dove ero.",
  dl_start: "Scarica e inizia",
  dl_cancel: "Annulla",
  dl_pause: "Metti in pausa",
  dl_resume: "Riprendi",
  dl_retry: "Riprova",
  dl_paused: "In pausa — i dati scaricati sono al sicuro",
  dl_done: "Fatto!",
  dl_speed: "{s}/s",
  dl_failed: "Download non riuscito: {msg}",
  part_dit: "Modello immagini (DiT)",
  part_t5: "Comprensione testo (T5)",
  part_vae: "Decodificatore (VAE)",
  part_tok: "Tokenizer",

  st_language: "Lingua",
  st_backend: "Motore di calcolo",
  st_backend_auto: "Automatico (consigliato)",
  st_backend_webgpu: "WebGPU (GPU)",
  st_backend_wasm: "CPU (WASM)",
  st_memory: "Memoria",
  st_memory_auto: "Automatica",
  st_memory_fast: "Veloce (tiene tutto in RAM)",
  st_memory_lean: "Risparmio (carica a richiesta)",
  st_export: "Dimensione esportazione HD",
  st_endpoint: "Sorgente modelli",
  st_endpoint_hint: "Cambia solo se Hugging Face non è raggiungibile (es. un mirror).",
  st_storage: "Archiviazione",
  st_location: "Posizione",
  st_portable: "Modalità portatile: tutto resta accanto all'exe",
  st_model_size: "Modello immagini",
  st_gallery_size: "Galleria",
  st_open_folder: "Apri cartella",
  st_delete_model: "Elimina modello",
  st_delete_confirm: "Eliminare i file del modello? Dovrai riscaricarli.",
  st_about: "Info",
  st_version: "Versione",
  st_credits:
    "Pesi: SupraLabs/Supra2-IMG (Apache-2.0). Conversione ONNX: Bartholomheow (Apache-2.0). Flan-T5 (Google) · SD-VAE (Stability AI). Codice: MIT.",
  st_isolation_on: "Multi-thread attivo",
  st_isolation_off: "Single-thread (isolamento non attivo)",
  not_installed: "non installato",
  installed: "installato",
  wakelock: "Schermo acceso durante la generazione",
};

export type Key = keyof typeof it;

const en: Record<Key, string> = {
  tagline: "104M parameters, 100% on your device",
  tab_create: "Create",
  tab_gallery: "Gallery",
  settings: "Settings",
  stage_hint: "Type a prompt and hit Generate ✨",
  prompt_ph: "Describe the image you want… (English works best)",
  random: "Random",
  tune: "Tune",
  generate: "Generate",
  stop: "Stop",
  steps: "Steps",
  guidance: "Prompt fidelity",
  solver: "Sampling method",
  solver_dpmpp2m: "DPM++ 2M — recommended",
  solver_euler: "Euler — classic (as in 1.x)",
  solver_heun: "Heun — precise, 2× slower",
  cfg_rescale: "Saturation fix",
  evals_hint: "≈ {n} model passes",
  preset_fast: "Quick",
  preset_balanced: "Balanced",
  preset_max: "Maximum",
  seed: "Seed",
  seed_random: "New random seed every image",
  negative: "Avoid (optional)",
  negative_ph: "e.g. blurry, dark, text",
  need_prompt: "Type something first ✨",
  variation: "Variation",
  save: "Save",
  save_hd: "Save HD",
  saved_gallery: "Saved to gallery",
  saved_to: "Saved: {path}",
  save_failed: "Couldn't save",
  mem_only: "Heads-up: can't write to disk, the image only lives while the app is open",
  cancelled: "Generation cancelled",
  error: "Oops, error",
  backend_webgpu: "WebGPU ⚡",
  backend_wasm: "CPU (WASM)",
  fallback_cpu: "The GPU hit a problem: switching to CPU (slower but works)",
  lean_on: "low-RAM mode",

  phase_load: "Loading model ({name})…",
  phase_encode: "Reading the prompt…",
  phase_denoise: "The magic takes shape",
  phase_decode: "Revealing the image…",
  step_of: "step {a}/{b}",
  eta: "~{s} left",

  gallery: "Gallery",
  gallery_empty: "Your creations will live here.",
  gallery_none_found: "No results.",
  search_ph: "Search prompts…",
  only_fav: "Favorites only",
  reuse: "Reuse",
  delete: "Delete",
  delete_confirm: "Delete this image?",
  deleted: "Deleted",
  img_missing: "Image unavailable",
  close: "Close",
  favorite: "Favorite",

  dl_title: "Download once, own it forever",
  dl_sub: "The model (~1 GB) is stored on this device — afterwards it works without internet.",
  dl_mobile_hint: "Tip: use Wi-Fi. If the connection drops I pick up where I left off.",
  dl_start: "Download & start",
  dl_cancel: "Cancel",
  dl_pause: "Pause",
  dl_resume: "Resume",
  dl_retry: "Retry",
  dl_paused: "Paused — downloaded data is safe",
  dl_done: "Done!",
  dl_speed: "{s}/s",
  dl_failed: "Download failed: {msg}",
  part_dit: "Image model (DiT)",
  part_t5: "Text understanding (T5)",
  part_vae: "Decoder (VAE)",
  part_tok: "Tokenizer",

  st_language: "Language",
  st_backend: "Compute engine",
  st_backend_auto: "Automatic (recommended)",
  st_backend_webgpu: "WebGPU (GPU)",
  st_backend_wasm: "CPU (WASM)",
  st_memory: "Memory",
  st_memory_auto: "Automatic",
  st_memory_fast: "Fast (keep everything in RAM)",
  st_memory_lean: "Lean (load on demand)",
  st_export: "HD export size",
  st_endpoint: "Model source",
  st_endpoint_hint: "Only change this if Hugging Face isn't reachable (e.g. a mirror).",
  st_storage: "Storage",
  st_location: "Location",
  st_portable: "Portable mode: everything stays next to the exe",
  st_model_size: "Image model",
  st_gallery_size: "Gallery",
  st_open_folder: "Open folder",
  st_delete_model: "Delete model",
  st_delete_confirm: "Delete the model files? You'll need to download them again.",
  st_about: "About",
  st_version: "Version",
  st_credits:
    "Weights: SupraLabs/Supra2-IMG (Apache-2.0). ONNX conversion: Bartholomheow (Apache-2.0). Flan-T5 (Google) · SD-VAE (Stability AI). Code: MIT.",
  st_isolation_on: "Multi-threading on",
  st_isolation_off: "Single-threaded (isolation off)",
  not_installed: "not installed",
  installed: "installed",
  wakelock: "Screen stays on while generating",
};

const dict = { it, en } as const;

export const lang = (): Lang => settings().lang;

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = dict[lang()][key] ?? dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Applies translations to every `data-i18n*` element under `root`. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n as Key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach((el) => {
    (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh as Key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const v = t(el.dataset.i18nTitle as Key);
    el.title = v;
    el.setAttribute("aria-label", v);
  });
  document.documentElement.lang = lang();
}

export function setLang(l: Lang): void {
  update("lang", l);
  applyI18n();
}
