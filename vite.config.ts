import { defineConfig, defaultClientConditions, type Plugin } from "vite";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// onnxruntime-web ships its WebAssembly next to the JS. To keep the app 100%
// offline (no CDN at runtime) we copy exactly the files we need into /public.
//   /ort/ → onnxruntime-web 1.30 (WebGPU + CPU, "jsep" build) — used by Supra2-IMG
// Transformers.js is only used for *tokenizing* the prompt, so its own copy of the
// WASM runtime is never instantiated and is not shipped.
const mainDist = dirname(require.resolve("ort"));
const tfRequire = createRequire(require.resolve("@huggingface/transformers"));
const tfOrtDist = dirname(tfRequire.resolve("onnxruntime-web"));

const ORT_FILES: Array<[string, string, string]> = [
  [mainDist, "ort-wasm-simd-threaded.jsep.mjs", "ort"],
  [mainDist, "ort-wasm-simd-threaded.jsep.wasm", "ort"],
];

function ortAssets(): Plugin {
  return {
    name: "supradaprod:ort-assets",
    buildStart() {
      for (const [dir, file, dest] of ORT_FILES) {
        const out = resolve("public", dest);
        mkdirSync(out, { recursive: true });
        const src = join(dir, file);
        const dst = join(out, file);
        if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
      }
    },
  };
}

// The e2e suite serves the production build with the very same CSP the desktop/Android shell enforces.
const csp: string | undefined = process.env.E2E_CSP
  ? (JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: string } } }).app.security.csp
  : undefined;

// Cross-origin isolation → SharedArrayBuffer → multi-threaded WebAssembly.
const isolation: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  ...(csp ? { "Content-Security-Policy": csp } : {}),
};

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: "../public",
  clearScreen: false,
  plugins: [ortAssets()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: "es", plugins: () => [ortAssets()] },
  resolve: {
    conditions: [...defaultClientConditions, "onnxruntime-web-use-extern-wasm"],
    alias: [
      // Transformers.js is here for the T5 tokenizer only, so point its ONNX runtime at
      // the small CPU-only build instead of the full WebGPU bundle.
      { find: /^onnxruntime-web$/, replacement: join(tfOrtDist, "ort.wasm.min.mjs") },
    ],
  },
  optimizeDeps: { exclude: ["ort", "@huggingface/transformers"] },
  server: { port: 1420, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: {
    target: "es2022",
    outDir: "../dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2500,
  },
});
