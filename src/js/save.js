// Save the current PNG outside the app (system save dialog on desktop).
import { isTauri } from "./env.js";
import * as store from "./store.js";
import { t } from "./i18n.js";

export async function save(file, prompt) {
  const suggested = `supradaprod_${(prompt || "image").slice(0, 32).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "image"}.png`;
  if (!isTauri()) {
    // browser dev preview: plain download
    const bytes = await store.bytesOf(file);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return;
  }
  const bytes = await store.bytesOf(file);
  const { save: dialogSave } = await import("@tauri-apps/plugin-dialog");
  const dest = await dialogSave({
    defaultPath: suggested,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!dest) return;
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeFile(dest, bytes);
  toast(`${t("saved")} ✓`);
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2400);
}
