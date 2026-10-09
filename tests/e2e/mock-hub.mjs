// A fake Hugging Face Hub that serves the mock repos (tests/e2e/make-mock-models.py).
// Supports Range requests, CORS, the tree API with sha256, and fault injection.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every file under `root`, grouped by "owner/name" repo id. */
function scanRepos(root) {
  const repos = new Map();
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const parts = relative(root, full).split(sep).join("/").split("/");
      if (parts.length < 3) continue; // not inside an owner/name repo
      const id = `${parts[0]}/${parts[1]}`;
      const inner = parts.slice(2).join("/");
      if (!repos.has(id)) repos.set(id, new Map());
      const buf = readFileSync(full);
      repos.get(id).set(inner, { buf, sha256: createHash("sha256").update(buf).digest("hex") });
    }
  };
  walk(root);
  return repos;
}

export function startHub({ root, repo = "Bartholomheow/Supra2-IMG-ONNX", port = 4599 }) {
  const repos = scanRepos(root);
  const files = repos.get(repo) ?? new Map();
  const state = {
    requests: [],
    /** { "path/in/repo": bytes } → the first request for that file dies after `bytes` bytes. */
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

    // /api/models/<owner>/<name>/tree/main
    const treeMatch = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main/.exec(url.pathname);
    if (treeMatch) {
      const repoFiles = repos.get(decodeURIComponent(treeMatch[1])) ?? new Map();
      const tree = [...repoFiles]
        // dit-dyn.onnx is an implementation detail: only the canonical name is listed,
        // pointing at whichever graph is currently served (see `resolve`).
        .filter(([path]) => path !== "dit-dyn.onnx")
        .map(([path]) => {
          const real = repoFiles.get(resolve(path)) ?? repoFiles.get(path);
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
    // /<owner>/<name>/resolve/main/<path>
    const fileMatch = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (!fileMatch) return void res.writeHead(404).end("not found");
    const repoFiles = repos.get(decodeURIComponent(fileMatch[1]));
    if (!repoFiles) return void res.writeHead(404).end("not found");
    const name = resolve(decodeURIComponent(fileMatch[2]));
    const f = repoFiles.get(name);
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
      // Long enough that the app has written what it received and closed the writer
      // before the connection dies: the retry is then a real ranged resume.
      res.write(body.subarray(0, cut), () => setTimeout(() => req.socket.destroy(), 400));
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
