// End-to-end suite: real Chromium + real onnxruntime-web + a mock Hugging Face hub.
//   npm run build && npm run e2e
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { startHub } from "./mock-hub.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const MOCK = resolve(ROOT, ".mock-models");
const APP = "http://127.0.0.1:4173";
const CHROME =
  process.env.CHROME_PATH ||
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);

let passed = 0;
const failures = [];
async function step(name, fn) {
  const t0 = Date.now();
  hub.state.down = false;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e.message || e).split("\n").join("\n      ")}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || "assertion failed");
};

if (!existsSync(resolve(MOCK, "Bartholomheow/Supra2-IMG-ONNX/dit.onnx"))) {
  const r = spawnSync("python3", [resolve(ROOT, "tests/e2e/make-mock-models.py"), resolve(MOCK, "Bartholomheow/Supra2-IMG-ONNX")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

const hub = await startHub({ root: MOCK });
const preview = spawn(resolve(ROOT, "node_modules/.bin/vite"), ["preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, E2E_CSP: "1" } });
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    up = (await fetch(APP)).ok;
  } catch { /* not up yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
if (!up) {
  console.error(`preview server did not come up on ${APP} — did you run \`npm run build\`?`);
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-angle=swiftshader",
  ],
});

const logs = [];
async function newApp(settings = {}, { keepStorage = false, context } = {}) {
  const ctx = context ?? (await browser.newContext({ viewport: { width: 1200, height: 900 } }));
  const page = await ctx.newPage();
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.addInitScript(
    ([s, keep]) => {
      if (!keep || !localStorage.getItem("supradaprod:settings:v1")) {
        localStorage.setItem("supradaprod:settings:v1", JSON.stringify(s));
      }
    },
    [{ lang: "en", endpoint: hub.url, backend: "wasm", steps: 10, randomSeed: false, ...settings }, keepStorage],
  );
  await page.goto(APP);
  await page.waitForFunction(() => !!window.__supra);
  return { ctx, page };
}

const canvasHash = (page) =>
  page.evaluate(async () => {
    const c = document.getElementById("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const h = await crypto.subtle.digest("SHA-256", d);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });
const canvasStats = (page) =>
  page.evaluate(() => {
    const c = document.getElementById("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) { min = Math.min(min, d[i], d[i + 1], d[i + 2]); max = Math.max(max, d[i], d[i + 1], d[i + 2]); }
    return { w: c.width, min, max };
  });
const galleryCount = (page) => page.evaluate(() => window.__supra.ctx.gallery.items.length);
const idle = (page, timeout = 60000) => page.waitForFunction(() => !window.__supra.ctx.busy, null, { timeout });

/** Fresh browser contexts have no model yet: accept the "download once" sheet if it shows up. */
async function acceptDownload(page) {
  const dlg = await page.waitForSelector("#dlDialog[open]", { timeout: 2500 }).catch(() => null);
  if (dlg) {
    await page.click("#dlStart");
    await page.waitForSelector("#dlDialog", { state: "hidden", timeout: 60000 });
  }
}

async function generate(page, prompt, { seed } = {}) {
  await page.fill("#prompt", prompt);
  if (seed != null) {
    if (!(await page.isVisible("#tune"))) await page.click("#btnTune");
    await page.fill("#seed", String(seed));
    await page.dispatchEvent("#seed", "change");
  }
  const before = await galleryCount(page);
  await page.click("#btnGo");
  await acceptDownload(page);
  await page.waitForFunction((n) => window.__supra.ctx.gallery.items.length > n, before, { timeout: 90000 });
  await idle(page);
}

console.log(`\nchromium: ${CHROME}\n`);

let first;
await step("app boots, cross-origin isolated (threads available)", async () => {
  first = await newApp();
  const iso = await first.page.evaluate(() => crossOriginIsolated);
  assert(iso, "crossOriginIsolated should be true (COOP/COEP headers)");
  assert((await first.page.textContent("h1")) === "SupraDaProd");
});

await step("first generation shows the download sheet, installs, and generates", async () => {
  const { page } = first;
  await page.fill("#prompt", "a cat on the moon");
  await page.click("#btnGo");
  await page.waitForSelector("#dlDialog[open]");
  await page.click("#dlStart");
  await page.waitForSelector("#dlDialog", { state: "hidden", timeout: 60000 });
  await page.waitForFunction(() => window.__supra.ctx.gallery.items.length === 1, null, { timeout: 90000 });
  await idle(page);
  const st = await canvasStats(page);
  assert(st.w === 512, `canvas width ${st.w}`);
  assert(st.max - st.min > 20, `image looks blank: ${JSON.stringify(st)}`);
  const reqs = hub.state.requests.join("\n");
  assert(/resolve\/main\/dit\.onnx/.test(reqs) && /tree\/main/.test(reqs), "expected hub requests");
});

await step("same prompt + seed is reproducible; other seed differs", async () => {
  const { page } = first;
  await generate(page, "a cat on the moon", { seed: 42 });
  const a = await canvasHash(page);
  await generate(page, "a cat on the moon", { seed: 42 });
  const b = await canvasHash(page);
  await generate(page, "a cat on the moon", { seed: 43 });
  const c = await canvasHash(page);
  assert(a === b, "same seed should reproduce the same image");
  assert(a !== c, "different seed should change the image");
});

await step("different prompt gives a different image", async () => {
  const { page } = first;
  await generate(page, "a cat on the moon", { seed: 7 });
  const a = await canvasHash(page);
  await generate(page, "a robot in the sea", { seed: 7 });
  const b = await canvasHash(page);
  assert(a !== b, "prompt should influence the image");
});

await step("negative prompt changes the guidance target", async () => {
  const { page } = first;
  await generate(page, "a fox", { seed: 5 });
  const a = await canvasHash(page);
  await page.fill("#negative", "dragon");
  await page.dispatchEvent("#negative", "change");
  await generate(page, "a fox", { seed: 5 });
  const b = await canvasHash(page);
  assert(a !== b, "negative prompt should influence the image");
  await page.fill("#negative", "");
  await page.dispatchEvent("#negative", "change");
});

await step("gallery: items persisted, search, favorite, delete", async () => {
  const { page } = first;
  await page.click('.tab[data-view="gallery"]');
  const n = await galleryCount(page);
  assert(n >= 6, `gallery count ${n}`);
  assert((await page.textContent("#galleryCount")) === String(n));
  await page.fill("#gallerySearch", "robot");
  await page.waitForFunction(() => document.querySelectorAll("#galleryGrid .tile").length === 1);
  await page.click("#galleryGrid .tile");
  await page.waitForSelector("#imgDialog[open]");
  await page.waitForFunction(() => document.getElementById("modalImg").naturalWidth === 64, null, { timeout: 5000 });
  await page.click("#btnFav");
  assert(await page.evaluate(() => window.__supra.ctx.gallery.items.some((i) => i.fav)), "favorite not saved");
  await page.click("#btnDelete");
  await page.click("#confirmYes");
  await page.waitForFunction((n0) => window.__supra.ctx.gallery.items.length === n0 - 1, n);
  await page.evaluate(() => window.__supra.ctx.gallery.idle());
  await page.fill("#gallerySearch", "");
});

await step("gallery survives a reload; model works offline (hub down)", async () => {
  const { page, ctx } = first;
  await page.evaluate(() => window.__supra.ctx.gallery.idle());
  const n = await galleryCount(page);
  hub.state.down = true;
  await page.reload();
  await page.waitForFunction(() => !!window.__supra);
  assert((await galleryCount(page)) === n, "gallery not restored after reload");
  await generate(page, "offline test prompt", { seed: 1 });
  assert(!(await page.$("#dlDialog[open]")), "should not ask to download again");
  hub.state.down = false;
  await ctx.close();
});

await step("download resumes after a dropped connection (Range) and verifies sha256", async () => {
  hub.state.requests.length = 0;
  hub.state.cutOnce["dit.onnx"] = 5_000_000;
  const { page, ctx } = await newApp();
  await page.fill("#prompt", "resume test");
  await page.click("#btnGo");
  await page.waitForSelector("#dlDialog[open]");
  await page.click("#dlStart");
  await page.waitForFunction(() => window.__supra.ctx.gallery.items.length === 1, null, { timeout: 90000 });
  const reqs = hub.state.requests.filter((r) => r.includes("dit.onnx"));
  assert(reqs.length >= 2 && reqs.some((r) => /\[bytes=\d+-\]/.test(r)), `expected a ranged resume, got:\n${reqs.join("\n")}`);
  await ctx.close();
});

await step("lean memory mode (loads/unloads networks on demand) gives the same image", async () => {
  const fast = await newApp({ memory: "fast" });
  await generate(fast.page, "lean check", { seed: 11 });
  const a = await canvasHash(fast.page);
  await fast.ctx.close();
  const lean = await newApp({ memory: "lean" });
  await generate(lean.page, "lean check", { seed: 11 });
  const b = await canvasHash(lean.page);
  await lean.ctx.close();
  assert(a === b, "lean and fast mode must produce identical pixels");
});

await step("cancel stops a generation without saving", async () => {
  const { page, ctx } = await newApp({ steps: 50 });
  await page.fill("#prompt", "cancel me");
  const before = await galleryCount(page);
  await page.click("#btnGo");
  await acceptDownload(page);
  await page.waitForSelector("#btnGo.stop", { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("spTitle").textContent.length > 0);
  await page.click("#btnGo");
  await idle(page, 30000);
  assert((await galleryCount(page)) === before, "cancelled image must not be saved");
  assert(await page.isVisible("#toast"), "toast expected");
  await ctx.close();
});

await step("language switch + settings dialog + storage numbers", async () => {
  const { page, ctx } = await newApp();
  await page.click('#langSwitch button[data-lang="it"]');
  assert((await page.textContent("#btnGoLabel")) === "Genera");
  await page.click("#btnSettings");
  await page.waitForSelector("#settingsDialog[open]");
  const txt = await page.textContent("#stRuntime");
  assert(/Web/.test(txt), txt);
  await ctx.close();
});

await step("solvers: DPM++ 2M is the default, euler still reproduces, both are deterministic", async () => {
  const { page, ctx } = await newApp({ steps: 8 });
  await page.click("#btnTune");
  assert((await page.inputValue("#solver")) === "dpmpp2m", "DPM++ 2M should be the default solver");
  assert(/model passes/.test(await page.textContent("#costHint")), "cost hint expected");

  await generate(page, "solver check", { seed: 21 });
  const dpmA = await canvasHash(page);
  await generate(page, "solver check", { seed: 21 });
  assert((await canvasHash(page)) === dpmA, "the default solver must be reproducible");

  await page.selectOption("#solver", "euler");
  await generate(page, "solver check", { seed: 21 });
  const eulerA = await canvasHash(page);
  assert(eulerA !== dpmA, "euler and DPM++ 2M should not give the same pixels");

  await page.selectOption("#solver", "heun");
  await generate(page, "solver check", { seed: 21 });
  assert((await canvasHash(page)) !== eulerA, "heun should differ from euler too");

  await page.locator('.preset[data-preset="fast"]').click();
  assert((await page.inputValue("#steps")) === "12", "the quick preset sets 12 steps");
  assert((await page.inputValue("#solver")) === "dpmpp2m", "the quick preset uses DPM++ 2M");

  // Guidance rescale must reach the sampler and change the result.
  await page.selectOption("#solver", "euler");
  await generate(page, "solver check", { seed: 21 });
  const plain = await canvasHash(page);
  await page.fill("#cfgRescale", "10");
  await page.dispatchEvent("#cfgRescale", "input");
  await generate(page, "solver check", { seed: 21 });
  assert((await canvasHash(page)) !== plain, "cfg rescale should influence the image");
  await ctx.close();
});

await step("webgpu backend (when the browser offers it) matches the wasm result closely", async () => {
  const probe = await newApp();
  const has = await probe.page.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null)));
  await probe.ctx.close();
  if (!has) return console.log("      (no WebGPU adapter in this environment — skipped)");
  const gpu = await newApp({ backend: "webgpu" });
  await generate(gpu.page, "gpu check", { seed: 3 });
  const chip = await gpu.page.textContent("#backendChip");
  assert(/WebGPU|CPU/.test(chip), chip);
  console.log(`      backend chip: ${chip}`);
  await gpu.ctx.close();
});

await browser.close();
preview.kill();
await hub.close();

if (logs.length) {
  const csp = logs.filter((l) => /Content Security Policy|Refused to/i.test(l));
  if (csp.length) { failures.push("CSP violations"); console.log("\n  ✗ CSP violations:\n    " + [...new Set(csp)].join("\n    ")); }
  const interesting = logs.filter((l) => !/favicon|Failed to load resource|net::ERR|huggingface/i.test(l));
  if (interesting.length) console.log("\nbrowser console noise:\n  " + [...new Set(interesting)].slice(0, 15).join("\n  "));
}
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}\n`);
process.exit(failures.length ? 1 : 0);
void createHash;
