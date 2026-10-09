// "Download once" sheet: shown the first time a model is needed.
import { $, toast } from "./dom";
import type { Ctx } from "./context";
import { type Key, t } from "../lib/i18n";
import { formatBytes, formatDuration, isMobile } from "../lib/platform";
import { type InstallProgress, type Manifest, installModel, localStatus, partsFor } from "../lib/models";
import type { ModelSpec } from "../lib/registry";
import { settings } from "../lib/settings";
import { errMsg } from "../lib/errors";

/** Resolves with the manifest once the model is on disk (downloading if needed). */
export async function ensureModel(ctx: Ctx, spec: ModelSpec): Promise<Manifest> {
  const status = await localStatus(ctx.store, spec);
  if (status.installed && status.manifest) return status.manifest;
  return new Promise<Manifest>((resolve, reject) => runSheet(ctx, spec, resolve, reject, false));
}

/** Opens the sheet and starts downloading right away (model selector). */
export function downloadModel(ctx: Ctx, spec: ModelSpec, _opts?: { autoModel?: boolean }): Promise<Manifest> {
  return new Promise<Manifest>((resolve, reject) => runSheet(ctx, spec, resolve, reject, true));
}

function runSheet(
  ctx: Ctx,
  spec: ModelSpec,
  resolve: (m: Manifest) => void,
  reject: (e: Error) => void,
  autoStart: boolean,
): void {
  const dlg = $<HTMLDialogElement>("dlDialog");
  const partsEl = $("dlParts");
  const fill = $("dlFill");
  const pct = $("dlPct");
  const info = $("dlInfo");
  const statusEl = $("dlStatus");
  const start = $<HTMLButtonElement>("dlStart");
  const cancel = $<HTMLButtonElement>("dlCancel");
  $("dlMobileHint").hidden = !isMobile;
  $("dlTitle").textContent = t("dl_title", { name: spec.name });
  $("dlSub").textContent = t("dl_sub", { name: spec.name, size: formatBytes(spec.bytes) });

  const keys = partsFor(spec);
  partsEl.innerHTML = "";
  const rows = new Map<string, { root: HTMLElement; txt: HTMLElement; bar: HTMLElement }>();
  for (const k of keys) {
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
    for (const k of keys) {
      const r = rows.get(k)!;
      const { done, total } = p.parts[k] ?? { done: 0, total: null };
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
      const manifest = await installModel(ctx.store, spec, {
        endpoint: settings().endpoint,
        signal: ctl.signal,
        onProgress: render,
      });
      finished = true;
      statusEl.textContent = t("dl_done");
      dlg.close();
      resolve(manifest);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        statusEl.textContent = t("dl_paused");
        setButtons("paused");
      } else {
        statusEl.textContent = t("dl_failed", { msg: errMsg(e) });
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
  if (autoStart) void go();
}
