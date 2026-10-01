// Gallery tab: lazy grid, search, favorites, detail viewer.
import { $, closeOnBackdrop, confirmDialog, toast } from "./dom";
import type { Ctx } from "./context";
import { t } from "../lib/i18n";
import { upscalePng } from "../lib/image";
import { exportImage, suggestName } from "../lib/export";
import type { GalleryItem } from "../lib/gallery";
import { settings } from "../lib/settings";

export function initGallery(ctx: Ctx) {
  const grid = $("galleryGrid");
  const empty = $("galleryEmpty");
  const count = $("galleryCount");
  const badge = $("galleryBadge");
  const search = $<HTMLInputElement>("gallerySearch");
  const favBtn = $<HTMLButtonElement>("btnFavFilter");
  const dlg = $<HTMLDialogElement>("imgDialog");
  const img = $<HTMLImageElement>("modalImg");
  closeOnBackdrop(dlg);

  let onlyFav = false;
  let shown: GalleryItem[] = [];
  let cursor = -1;
  let curId = "";

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target as HTMLElement;
        io.unobserve(tile);
        const id = tile.dataset.id!;
        void ctx.gallery.url(id).then((url) => {
          if (!url) return void tile.classList.add("broken");
          const im = document.createElement("img");
          im.alt = tile.dataset.alt ?? "";
          im.decoding = "async";
          im.onerror = () => {
            tile.classList.add("broken");
            im.remove();
          };
          im.src = url;
          tile.prepend(im);
        });
      }
    },
    { root: $("view-gallery"), rootMargin: "300px" },
  );

  function render() {
    const all = ctx.gallery.items;
    count.textContent = String(all.length);
    badge.textContent = String(all.length);
    badge.hidden = all.length === 0;
    const q = search.value.trim().toLowerCase();
    shown = all.filter((i) => (!onlyFav || i.fav) && (!q || i.prompt.toLowerCase().includes(q)));
    empty.hidden = shown.length > 0;
    empty.querySelector("p")!.textContent = all.length ? t("gallery_none_found") : t("gallery_empty");
    grid.replaceChildren();
    for (const [idx, item] of shown.entries()) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.id = item.id;
      tile.dataset.alt = item.prompt;
      tile.tabIndex = 0;
      tile.setAttribute("role", "button");
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = item.prompt;
      tile.append(cap);
      if (item.fav) {
        const f = document.createElement("span");
        f.className = "fav";
        f.innerHTML = '<svg class="i"><use href="#i-heart"/></svg>';
        tile.append(f);
      }
      tile.addEventListener("click", () => void open(idx));
      tile.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open(idx);
        }
      });
      grid.append(tile);
      io.observe(tile);
    }
  }

  async function open(idx: number) {
    const item = shown[idx];
    if (!item) return;
    cursor = idx;
    curId = item.id;
    const url = await ctx.gallery.url(item.id);
    if (!url) return toast(t("img_missing"), { error: true });
    img.src = url;
    img.alt = item.prompt;
    $("modalPrompt").textContent = item.prompt;
    const meta = [new Date(item.date).toLocaleString(), `seed ${item.seed}`, item.steps ? `${item.steps} steps` : "", item.cfg ? `cfg ${item.cfg}` : ""];
    $("modalInfo").textContent = meta.filter(Boolean).join(" · ");
    $("btnFav").classList.toggle("on", !!item.fav);
    $<HTMLButtonElement>("imgPrev").hidden = shown.length < 2;
    $<HTMLButtonElement>("imgNext").hidden = shown.length < 2;
    if (!dlg.open) dlg.showModal();
  }

  const step = (d: number) => {
    if (!shown.length) return;
    void open((cursor + d + shown.length) % shown.length);
  };
  $("imgPrev").addEventListener("click", () => step(-1));
  $("imgNext").addEventListener("click", () => step(1));
  $("imgClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  let sx = 0;
  img.addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
  img.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  });

  const current = () => ctx.gallery.items.find((i) => i.id === curId);

  $("btnFav").addEventListener("click", async () => {
    const it = current();
    if (!it) return;
    await ctx.gallery.toggleFav(it.id);
    $("btnFav").classList.toggle("on", !!it.fav);
  });
  $("btnReuse").addEventListener("click", () => {
    const it = current();
    if (!it) return;
    dlg.close();
    ctx.loadParams(it, true);
    ctx.switchView("create");
  });
  $("btnModalVar").addEventListener("click", () => {
    const it = current();
    if (!it) return;
    dlg.close();
    ctx.loadParams(it, false);
    ctx.switchView("create");
    void ctx.generate({ newSeed: true });
  });
  const save = async (hd: boolean) => {
    const it = current();
    if (!it) return;
    try {
      let bytes = await ctx.gallery.bytes(it.id);
      if (hd && settings().exportSize > 256) {
        bytes = new Uint8Array(await (await upscalePng(new Blob([bytes as BlobPart], { type: "image/png" }), settings().exportSize)).arrayBuffer());
      }
      const where = await exportImage(bytes, suggestName(it.prompt));
      if (where) toast(t("saved_to", { path: where }));
    } catch (e) {
      toast(`${t("save_failed")}: ${(e as Error).message}`, { error: true });
    }
  };
  $("btnModalSave").addEventListener("click", () => void save(false));
  $("btnModalSaveHd").addEventListener("click", () => void save(true));
  $("btnDelete").addEventListener("click", async () => {
    const it = current();
    if (!it) return;
    if (!(await confirmDialog(t("delete_confirm")))) return;
    dlg.close();
    await ctx.gallery.remove(it.id);
    toast(t("deleted"));
  });

  search.addEventListener("input", render);
  favBtn.addEventListener("click", () => {
    onlyFav = !onlyFav;
    favBtn.setAttribute("aria-pressed", String(onlyFav));
    render();
  });
  ctx.gallery.subscribe(render);
  render();
  return { render };
}
