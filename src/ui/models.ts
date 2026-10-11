// Model selector: pick which network paints your images, download it once,
// delete the ones you don't use.
import { $, confirmDialog } from "./dom";
import type { Ctx } from "./context";
import { type Key, t } from "../lib/i18n";
import { formatBytes, isMobile, isTauri } from "../lib/platform";
import { localStatus, removeModel } from "../lib/models";
import { REGISTRY, type ModelSpec } from "../lib/registry";
import { downloadModel } from "./download";

/** The chip in the top bar always shows what will paint the next image. */
export function initModels(ctx: Ctx) {
  const dlg = $<HTMLDialogElement>("modelsDialog");
  const list = $("modelsList");
  const chip = $<HTMLButtonElement>("modelChip");
  const chipName = $("modelChipName");

  let downloading: string | null = null;

  const paintChip = () => {
    chipName.textContent = ctx.model.name;
    chip.title = `${ctx.model.name} · ${t("models")}`;
    chip.classList.toggle("missing", !ctx.installed);
  };

  const card = (spec: ModelSpec, installed: boolean, bytes: number) => {
    const el = document.createElement("article");
    el.className = "model-card";
    el.dataset.model = spec.id;
    if (spec.id === ctx.model.id) el.classList.add("on");
    if (spec.unavailable) el.classList.add("off");

    const badges = [
      installed && !spec.unavailable ? `<span class="chip ok">✓ ${t("installed")}</span>` : "",
      `<span class="chip">${spec.params}</span>`,
      `<span class="chip">${spec.resolution}×${spec.resolution}</span>`,
      `<span class="chip">${spec.license}</span>`,
    ]
      .filter(Boolean)
      .join("");
    const size = spec.unavailable ? "" : ` · ${formatBytes(installed ? bytes : spec.bytes)}`;
    el.innerHTML = `
      <header>
        <b>${spec.name}</b>
        <span class="grow"></span>
        ${badges}
      </header>
      <p class="muted small">${t(`${spec.i18n}.tagline` as Key)}</p>
      <p class="muted small">${t(`${spec.i18n}.blurb` as Key)}${size}</p>
      <p class="muted small credits">${t(`${spec.i18n}.credits` as Key)}</p>
      <div class="bar" hidden><i></i></div>
      <div class="model-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".model-actions")!;
    const bar = el.querySelector<HTMLElement>(".bar")!;
    const barFill = el.querySelector<HTMLElement>(".bar i")!;

    if (spec.unavailable) {
      actions.innerHTML = `<span class="chip warn">${t("m_unavailable")}</span><span class="muted small">${t(
        spec.unavailable === "no-onnx" ? "m_no_onnx" : "m_too_big",
      )}</span>`;
      return el;
    }

    const use = document.createElement("button");
    use.className = "btn primary";
    use.innerHTML = `<b>${spec.id === ctx.model.id ? t("m_in_use") : t("m_use")}</b>`;
    use.disabled = spec.id === ctx.model.id;
    use.addEventListener("click", () => void ctx.useModel(spec.id).then(() => dlg.close()));

    if (!installed) {
      const dl = document.createElement("button");
      dl.className = "btn ghost";
      dl.innerHTML = `<span>${t("m_download")}</span>`;
      dl.disabled = downloading !== null;
      dl.addEventListener("click", async () => {
        downloading = spec.id;
        dl.disabled = true;
        bar.hidden = false;
        try {
          // The card shows the same progress the download sheet does.
          await downloadModel(ctx, spec, {
            onProgress: (p) => {
              barFill.style.width = `${(p.total ? Math.min(1, p.done / p.total) : 0) * 100}%`;
            },
          });
          await ctx.useModel(spec.id);
          await render();
          dlg.close();
        } catch (e) {
          console.warn(e);
        } finally {
          downloading = null;
          bar.hidden = true;
          barFill.style.width = "0%";
        }
      });
      actions.append(dl, use);
    } else {
      const del = document.createElement("button");
      del.className = "btn danger ghost";
      del.innerHTML = `<span>${t("st_delete_model")}</span>`;
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(t("m_delete_confirm", { name: spec.name })))) return;
        if (spec.id === ctx.model.id) ctx.resetEngines();
        await removeModel(ctx.store, spec);
        await ctx.refreshModel();
        render();
      });
      actions.append(del, use);
    }
    return el;
  };

  const render = async () => {
    const items = await Promise.all(
      REGISTRY.map(async (spec) => {
        const status = await localStatus(ctx.store, spec);
        return { spec, status };
      }),
    );
    list.innerHTML = "";
    for (const { spec, status } of items) list.append(card(spec, status.installed, status.bytes));
    const installedBytes = items.reduce((a, i) => a + (i.status.installed ? i.status.bytes : 0), 0);
    $("modelsFoot").textContent = t("m_foot", {
      n: items.filter((i) => i.status.installed).length,
      size: formatBytes(installedBytes),
      location: ctx.store.location ?? (isTauri() ? "app data" : "browser storage"),
    });
    $("modelsHint").textContent = isMobile ? t("m_mobile_hint") : t("m_desktop_hint");
    paintChip();
  };

  chip.addEventListener("click", () => {
    render()
      .then(() => dlg.showModal())
      .catch((e) => console.error(e));
  });
  $("modelsClose").addEventListener("click", () => dlg.close());

  ctx.refreshModels = render;
  ctx.refreshChip = paintChip;
  paintChip();
}
