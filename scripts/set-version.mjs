// Keeps package.json, tauri.conf.json and Cargo.toml on one version.
//   node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const v = (process.argv[2] || "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(v)) {
  console.error("usage: set-version.mjs <major.minor.patch>");
  process.exit(1);
}
const root = resolve(import.meta.dirname, "..");
const patchJson = (file) => {
  const p = resolve(root, file);
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.version = v;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
};
patchJson("package.json");
patchJson("src-tauri/tauri.conf.json");
const cargo = resolve(root, "src-tauri/Cargo.toml");
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${v}"`));
console.log("version →", v);
