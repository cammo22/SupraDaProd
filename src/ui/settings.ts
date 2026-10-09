import { $, closeOnBackdrop, confirmDialog, toast } from "./dom";
import type { Ctx } from "./context";
import { applyI18n, setLang, t } from "../lib/i18n";
import { formatBytes, isAndroid, isTauri } from "../lib/platform";
import { DEFAULT_ENDPOINT, localStatus, modelUsage, removeSupra } from "../lib/models";
import { revealDataFolder } from "../lib/export";
import { onChange, settings, update } from "../lib/settings";
import { usage } from "../lib/storage/types";

export function initSettings(ctx: Ctx) {
  const dlg = $<HTMLDialogElement>("settingsDialog");
  closeOnBackdrop(dlg);
  const backend = $<HTMLSelectElement>("stBackend");
  const memory = $<HTMLSelectElement>("stMemory");
  const exp = $<HTMLSelectElement>("stExport");
  const endpoint = $<HTMLInputElement>("stEndpoint");

  const s = settings();
  backend.value = s.backend;
  memory.value = s.memory;
  exp.value = String(s.exportSize);
  endpoint.value = s.endpoint;

  backend.addEventListener("change", () => {
    update("backend", backend.value as "auto" | "webgpu" | "wasm");
    ctx.resetEngines();
  });
  memory.addEventListener("change", () => {
    update("memory", memory.value as "auto" | "fast" | "lean");
    ctx.resetEngines();
  });
  exp.addEventListener("change", () => update("exportSize", Number(exp.value) as 256 | 512 | 1024));
  endpoint.addEventListener("change", () => {
    const v = endpoint.value.trim().replace(/\/+$/, "");
    update("endpoint", /^https?:\/\//.test(v) ? v : DEFAULT_ENDPOINT);
    endpoint.value = settings().endpoint;
  });

  async function refresh() {
    const bytes = await modelUsage(ctx.store);
    const st = await localStatus(ctx.store);
    $("stModelSize").textContent = st.installed ? formatBytes(bytes) : bytes ? `${formatBytes(bytes)} (${t("not_installed")})` : t("not_installed");
    $("stGallerySize").textContent = `${ctx.gallery.items.length} · ${formatBytes(await usage(ctx.store, "gallery").catch(() => 0))}`;
    $("stLocation").textContent = ctx.store.location ?? "—";
    $("stPortable").hidden = !ctx.store.portable;
    $("stOpenFolder").hidden = !(isTauri() && !isAndroid);
  }

  $("btnSettings").addEventListener("click", () => {
    void refresh();
    $("stVersion").textContent = __APP_VERSION__;
    $("stRuntime").textContent = `${isTauri() ? "Tauri" : "Web"} · ${crossOriginIsolated ? t("st_isolation_on") : t("st_isolation_off")}`;
    dlg.showModal();
  });
  $("settingsClose").addEventListener("click", () => dlg.close());
  $("stOpenFolder").addEventListener("click", () => void revealDataFolder().catch((e) => toast(String(e), { error: true })));

  $("stDelModel").addEventListener("click", async () => {
    if (!(await confirmDialog(t("st_delete_confirm")))) return;
    ctx.resetEngines();
    await removeSupra(ctx.store);
    void refresh();
  });

  // language switch lives in the top bar
  const sw = $("langSwitch");
  const mark = () => sw.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.lang === settings().lang));
  sw.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-lang]");
    if (b) {
      setLang(b.dataset.lang as "it" | "en");
      mark();
    }
  });
  mark();
  onChange((_s, k) => {
    if (k === "lang") applyI18n();
  });
}
