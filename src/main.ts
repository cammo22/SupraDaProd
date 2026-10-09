import "./styles/main.css";
import { $, toast } from "./ui/dom";
import type { Ctx } from "./ui/context";
import { initCreate } from "./ui/create";
import { initGallery } from "./ui/gallery";
import { initSettings } from "./ui/settings";
import { initModels } from "./ui/models";
import { ensureModel } from "./ui/download";
import { Gallery } from "./lib/gallery";
import { applyI18n, t } from "./lib/i18n";
import { localStatus } from "./lib/models";
import { modelById } from "./lib/registry";
import { settings, update } from "./lib/settings";
import { getStore } from "./lib/storage";
import { isTauri } from "./lib/platform";

declare global {
  // injected by vite.config.ts
  const __APP_VERSION__: string;
}

function switchView(name: "create" | "gallery") {
  document.querySelectorAll<HTMLElement>(".tab").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll<HTMLElement>(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${name}`));
}

async function boot() {
  const store = await getStore();
  const gallery = new Gallery(store);
  await gallery.load();

  const ctx: Ctx = {
    store,
    gallery,
    busy: false,
    model: modelById(settings().modelId),
    manifest: null,
    installed: false,
    switchView,
    generate: async () => {},
    loadParams: () => {},
    resetEngines: () => {},
    refreshModel: async () => {
      const status = await localStatus(store, ctx.model);
      ctx.manifest = status.manifest;
      ctx.installed = status.installed;
    },
    useModel: async (id: string) => {
      const spec = modelById(id);
      if (spec.unavailable) return void toast(t(spec.unavailable === "no-onnx" ? "m_no_onnx" : "m_too_big"));
      if (ctx.busy) return;
      try {
        if (!ctx.installed || ctx.model.id !== spec.id) {
          const status = await localStatus(store, spec);
          if (!status.installed) await ensureModel({ ...ctx, model: spec }, spec);
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.warn(e);
        return;
      }
      ctx.resetEngines();
      update("modelId", spec.id);
      ctx.model = spec;
      await ctx.refreshModel();
      ctx.syncControls?.();
      await ctx.refreshModels?.();
      toast(t("m_selected", { name: spec.name }));
    },
  };

  applyI18n();
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) =>
    tab.addEventListener("click", () => switchView(tab.dataset.view as "create" | "gallery")),
  );
  initCreate(ctx);
  initModels(ctx);
  initGallery(ctx);
  initSettings(ctx);
  applyI18n();
  await ctx.refreshModel();
  ctx.syncControls?.();

  // Ask the browser not to evict our data (no-op inside Tauri).
  void navigator.storage?.persist?.().catch(() => {});

  // Test hook (only reads state): lets the e2e suite inspect the app.
  (window as unknown as { __supra?: unknown }).__supra = { ctx, $ };
}


/** Browser/PWA build: register the service worker (cross-origin isolation + offline shell). */
function registerServiceWorker() {
  if (isTauri() || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  if (!window.isSecureContext) return;
  navigator.serviceWorker
    .register(new URL("sw.js", document.baseURI).href)
    .then(async () => {
      await navigator.serviceWorker.ready;
      // First visit: the page was served without COOP/COEP; reload once so the worker can add them.
      if (!crossOriginIsolated && !sessionStorage.getItem("supradaprod:coi-reload")) {
        sessionStorage.setItem("supradaprod:coi-reload", "1");
        location.reload();
      }
    })
    .catch((e) => console.warn("service worker unavailable", e));
}

boot().then(registerServiceWorker).catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;inset:0;padding:24px;background:#200;color:#fbb;z-index:999;white-space:pre-wrap">${String(e?.stack || e)}</pre>`);
});
