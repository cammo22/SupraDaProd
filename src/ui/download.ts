// "Download once" sheet: shown the first time the model is needed.
import { $, toast } from "./dom";
import type { Ctx } from "./context";
import { type Key, t } from "../lib/i18n";
import { formatBytes, formatDuration, isMobile } from "../lib/platform";
import { type InstallProgress, type Manifest, type PartKey, installSupra, localStatus } from "../lib/models";
import { settings } from "../lib/settings";

const PARTS: PartKey[] = ["dit", "t5", "vae", "tok"];

/** Resolves with the manifest once the model is on disk (downloading if needed). */
export async function ensureModel(ctx: Ctx): Promise<Manifest> {
  const status = await localStatus(ctx.store);
  if (status.installed && status.manifest) return status.manifest;
  return new Promise<Manifest>((resolve, reject) => runSheet(ctx, resolve, reject));
}

function runSheet(ctx: Ctx, resolve: (m: Manifest) => void, reject: (e: Error) => void): void {
  const dlg = $<HTMLDialogElement>("dlDialog");
  const partsEl = $("dlParts");
  const fill = $("dlFill");
  const pct = $("dlPct");
  const info = $("dlInfo");
  const statusEl = $("dlStatus");
  const start = $<HTMLButtonElement>("dlStart");
  const cancel = $<HTMLButtonElement>("dlCancel");
  $("dlMobileHint").hidden = !isMobile;

  partsEl.innerHTML = "";
  const rows = new Map<PartKey, { root: HTMLElement; txt: HTMLElement; bar: HTMLElement }>();
  for (const k of PARTS) {
    const root = document.createElement("div");
    root.className = "part";
    root.innerHTML = `<span>${t(`part_${k}` as Key)}</span><b>0%</b><div class="bar"><i></i></div>`;
    partsEl.appendChild(root);
    rows.set(k, { root, txt: root.querySelector("b")!, bar: root.querySelector("i")! });
  }

  let ctl: AbortController | null = null;
  let finished = false;
  let running = false;

  const render = (p: InstallProgress) => {
    for (const k of PARTS) {
      const r = rows.get(k)!;
      const { done, total } = p.parts[k];
      const f = total ? Math.min(1, done / total) : 0;
      r.bar.style.width = `${(f * 100).toFixed(1)}%`;
      r.txt.textContent = total ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(done);
      r.root.classList.toggle("done", !!total && done >= total);
    }
    const f = p.total ? Math.min(1, p.done / p.total) : 0;
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    pct.textContent = `${Math.round(f * 100)}%`;
    const eta = p.total && p.speed > 0 ? (p.total - p.done) / p.speed : NaN;
    info.textContent = [p.speed > 0 ? t("dl_speed", { s: formatBytes(p.speed) }) : "", Number.isFinite(eta) ? t("eta", { s: formatDuration(eta) }) : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const setButtons = (mode: "start" | "running" | "paused" | "error") => {
    const label = start.querySelector("span")!;
    start.disabled = mode === "running";
    cancel.textContent = mode === "running" ? t("dl_pause") : t("dl_cancel");
    label.textContent = mode === "paused" ? t("dl_resume") : mode === "error" ? t("dl_retry") : t("dl_start");
  };

  const go = async () => {
    if (running) return;
    running = true;
    ctl = new AbortController();
    statusEl.textContent = "";
    statusEl.classList.remove("err");
    setButtons("running");
    try {
      const manifest = await installSupra(ctx.store, { endpoint: settings().endpoint, signal: ctl.signal, onProgress: render });
      finished = true;
      statusEl.textContent = t("dl_done");
      dlg.close();
      resolve(manifest);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        statusEl.textContent = t("dl_paused");
        setButtons("paused");
      } else {
        statusEl.textContent = t("dl_failed", { msg: (e as Error).message });
        statusEl.classList.add("err");
        setButtons("error");
      }
    } finally {
      running = false;
    }
  };

  start.onclick = () => void go();
  cancel.onclick = () => {
    if (running) ctl?.abort();
    else dlg.close();
  };
  dlg.addEventListener(
    "close",
    () => {
      ctl?.abort();
      if (!finished) {
        toast(t("dl_paused"));
        reject(Object.assign(new Error("model download cancelled"), { name: "AbortError" }));
      }
    },
    { once: true },
  );

  setButtons("start");
  pct.textContent = "0%";
  fill.style.width = "0%";
  info.textContent = "";
  statusEl.textContent = "";
  dlg.showModal();
}
