import "./styles/main.css";
import { $ } from "./ui/dom";
import type { Ctx } from "./ui/context";
import { initCreate } from "./ui/create";
import { initGallery } from "./ui/gallery";
import { initSettings } from "./ui/settings";
import { Gallery } from "./lib/gallery";
import { applyI18n } from "./lib/i18n";
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
    switchView,
    generate: async () => {},
    loadParams: () => {},
    resetEngines: () => {},
  };

  applyI18n();
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) =>
    tab.addEventListener("click", () => switchView(tab.dataset.view as "create" | "gallery")),
  );
  initCreate(ctx);
  initGallery(ctx);
  initSettings(ctx);
  applyI18n();

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
