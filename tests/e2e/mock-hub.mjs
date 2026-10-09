// A fake Hugging Face Hub that serves the mock Supra2-IMG repo (tests/e2e/make-mock-models.py).
// Supports Range requests, CORS, the tree API with sha256, and fault injection.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function startHub({ root, repo = "Bartholomheow/Supra2-IMG-ONNX", port = 4599 }) {
  const dir = join(root, repo);
  const files = new Map();
  for (const name of readdirSync(dir)) {
    const buf = readFileSync(join(dir, name));
    files.set(name, { buf, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  const state = {
    requests: [],
    /** { "dit.onnx": bytes } → the first request for that file dies after `bytes` bytes. */
    cutOnce: {},
    /** Serve the dynamic-batch DiT graph in place of dit.onnx (see make-mock-models.py). */
    dynamicBatch: false,
    down: false,
  };

  /** Which file contents a request for `name` should return right now. */
  const resolve = (name) => {
    if (state.dynamicBatch && (name === "dit.onnx" || name === "dit-dyn.onnx")) return "dit-dyn.onnx";
    return name;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    state.requests.push(`${req.method} ${url.pathname}${req.headers.range ? ` [${req.headers.range}]` : ""}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag, X-Linked-Size");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "range");
      res.writeHead(204).end();
      return;
    }
    if (state.down) return void req.socket.destroy();

    if (url.pathname === `/api/models/${repo}/tree/main`) {
      const tree = [...files]
        .filter(([path]) => !(path === "dit-dyn.onnx" && !state.dynamicBatch))
        .map(([path0, f]) => {
          const path = resolve(path0);
          const real = files.get(path) ?? f;
          return {
            type: "file",
            path,
            size: real.buf.length,
            ...(path.endsWith(".onnx") ? { lfs: { oid: real.sha256, size: real.buf.length } } : {}),
          };
        });
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify(tree));
    }
    const prefix = `/${repo}/resolve/main/`;
    if (!url.pathname.startsWith(prefix)) return void res.writeHead(404).end("not found");
    const name = resolve(decodeURIComponent(url.pathname.slice(prefix.length)));
    const f = files.get(name);
    if (!f) return void res.writeHead(404).end("not found");

    let start = 0;
    let status = 200;
    const m = /^bytes=(\d+)-/.exec(req.headers.range || "");
    if (m) {
      start = Number(m[1]);
      status = 206;
      if (start >= f.buf.length) return void res.writeHead(416).end();
    }
    const body = f.buf.subarray(start);
    res.setHeader("Content-Type", name.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Content-Length", body.length);
    if (status === 206) res.setHeader("Content-Range", `bytes ${start}-${f.buf.length - 1}/${f.buf.length}`);
    res.writeHead(status);
    const cut = state.cutOnce[name];
    if (cut != null && start === 0) {
      delete state.cutOnce[name];
      res.write(body.subarray(0, cut), () => setTimeout(() => req.socket.destroy(), 20));
      return;
    }
    res.end(body);
  });

  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${port}`, state, files, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }),
    ),
  );
}
