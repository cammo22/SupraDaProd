// Gallery grid + detail modal.
import * as store from "./store.js";
import { t } from "./i18n.js";
import { save } from "./save.js";

const grid = document.getElementById("galleryGrid");
const empty = document.getElementById("galleryEmpty");
const count = document.getElementById("galleryCount");
const modal = document.getElementById("imgModal");
const modalImg = document.getElementById("modalImg");
const modalPrompt = document.getElementById("modalPrompt");
const modalInfo = document.getElementById("modalInfo");

let current = null;
let onReuse = null;

export function bind({ reuse }) {
  onReuse = reuse;
  document.getElementById("btnCloseModal").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.getElementById("btnDelete").addEventListener("click", async () => {
    if (!current) return;
    await store.removeItem(current.file);
    modal.hidden = true;
    render();
  });
  document.getElementById("btnSaveImg").addEventListener("click", async () => {
    if (!current) return;
    await save(current.file, current.prompt);
  });
  document.getElementById("btnReuse").addEventListener("click", () => {
    if (!current) return;
    modal.hidden = true;
    onReuse?.(current.prompt);
  });
}

export async function render() {
  const items = store.list();
  count.textContent = String(items.length);
  empty.style.display = items.length ? "none" : "flex";
  grid.innerHTML = "";
  for (const item of items) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = (await store.urlFor(item.file)) || "";
    img.alt = item.prompt || "";
    img.addEventListener("error", () => {
      tile.classList.add("broken");
      img.remove();
    });
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = item.prompt || "";
    cap.title = item.prompt || "";
    tile.append(img, cap);
    tile.addEventListener("click", () => open(item));
    grid.appendChild(tile);
  }
}

async function open(item) {
  current = item;
  const url = await store.urlFor(item.file);
  if (!url) {
    toast(t("img_missing"));
    return;
  }
  modalImg.onerror = () => toast(t("img_missing"));
  modalImg.src = url;
  modalPrompt.textContent = item.prompt || "";
  modalInfo.textContent = [
    new Date(item.date).toLocaleString(),
    `seed ${item.seed ?? "—"} · ${item.steps ?? "—"} steps · cfg ${item.cfg ?? "—"}`,
  ].join(" · ");
  modal.hidden = false;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}
