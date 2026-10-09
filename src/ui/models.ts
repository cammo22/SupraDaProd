// Model selector: pick which network paints your images, download it once,
// delete the ones you don't use.
import { $, confirmDialog } from "./dom";
import type { Ctx } from "./context";
import { type Key, t } from "../lib/i18n";
import { formatBytes, isMobile, isTauri } from "../lib/platform";
import { localStatus, removeModel } from "../lib/models";
import { REGISTRY, modelById, type ModelSpec } from "../lib/registry";
import { settings, updateParams } from "../lib/settings";
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
      `<span class="chip">${spec.params}</span>`,
      `<span class="chip">${spec.resolution}×${spec.resolution}</span>`,
      `<span class="chip">${spec.license}</span>`,
    ].join("");
    const size = spec.unavailable ? "" : ` · ${formatBytes(installed ? bytes : spec.bytes)}`;
    el.innerHTML = `
      <header>
        <b>${spec.name}</b>
        <span class="grow"></span>
        ${badges}
      </header>
      <p class="muted small">${t(`${spec.i18n}.tagline` as Key)}</p>
      <p class="muted small">${t(`${spec.i18n}.blurb` as Key)}${size}</p>
      <div class="bar"><i></i></div>
      <div class="model-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".model-actions")!;
    const label = el.querySelector<HTMLElement>(".model-actions")!;

    if (spec.unavailable) {
      label.innerHTML = `<span class="chip warn">${t("m_unavailable")}</span><span class="muted small">${t(
        spec.unavailable === "no-onnx" ? "m_no_onnx" : "m_too_big",
      )}</span>`;
      return el;
    }

    const use = document.createElement("button");
    use.className = "btn primary";
    use.innerHTML = `<b>${spec.id === ctx.model.id ? t("m_in_use") : t("m_use")}</b>`;
    use.disabled = spec.id === ctx.model.id;
    use.addEventListener("click", () => void ctx.useModel(spec.id));

    if (!installed) {
      const dl = document.createElement("button");
      dl.className = "btn ghost";
      dl.innerHTML = `<span>${t("m_download")}</span>`;
      dl.disabled = downloading !== null;
      dl.addEventListener("click", async () => {
        downloading = spec.id;
        dl.disabled = true;
        try {
          await downloadModel(ctx, spec, { autoModel: true });
          await ctx.useModel(spec.id);
          render();
        } catch (e) {
          console.warn(e);
        } finally {
          downloading = null;
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
  paintChip();
}

/** Applies a model's stored sampling parameters to the settings of the app. */
export function paramsFor(id: string) {
  const spec = modelById(id);
  const stored = settings().params[id];
  const params = stored ?? { ...spec.defaults, karras: false };
  updateParams(id, params);
  return params;
}
