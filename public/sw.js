// Service worker for the browser / PWA build (the Tauri apps don't register it).
//  1. Adds COOP/COEP to every same-origin response → cross-origin isolation → multi-threaded WASM,
//     even on hosts (GitHub Pages…) that can't set headers.
//  2. Network-first with cache fallback → the app shell opens offline after the first visit.
// Models are NOT cached here: they live in the origin-private file system (see storage/opfs.ts).
const CACHE = "supradaprod-shell-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      // Drop shells from previous versions (the model files live in the OPFS, not here).
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    })(),
  ),
);

function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
        return isolate(res);
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
        if (hit) return isolate(hit);
        throw err;
      }
    })(),
  );
});
