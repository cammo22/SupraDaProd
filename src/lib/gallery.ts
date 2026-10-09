// Gallery persistence on top of the Store: `gallery/index.json` + one PNG per image.
// The index format is backward compatible with SupraDaProd 0.x (entries keyed by `file`).
import { type Store, readJson, writeJson } from "./storage/types";
import { isSolver, type Solver } from "./sampler";

export interface GalleryItem {
  /** Same as `file`; kept for clarity in the UI layer. */
  id: string;
  file: string;
  prompt: string;
  negative?: string;
  seed: number;
  steps: number;
  cfg: number;
  /** Integrator + guidance rescale used (2.x; absent in older items). */
  solver?: Solver;
  cfgRescale?: number;
  /** Which model painted it (2.x; older items are all Supra2-IMG). */
  model?: string;
  /** Output resolution in pixels (2.x). */
  size?: number;
  date: string;
  fav?: boolean;
  /** Only in memory: the image could not be written to disk. */
  volatile?: boolean;
}

const DIR = "gallery";
const INDEX = `${DIR}/index.json`;

interface RawItem extends Partial<GalleryItem> {
  file: string;
}

export class Gallery {
  items: GalleryItem[] = [];
  private urls = new Map<string, string>();
  private volatileBlobs = new Map<string, Blob>();
  private subs = new Set<() => void>();

  constructor(private store: Store) {}

  async load(): Promise<void> {
    const raw = (await readJson<RawItem[]>(this.store, INDEX)) ?? [];
    this.items = raw
      .filter((r) => r && typeof r.file === "string")
      .map((r) => ({
        id: r.file,
        file: r.file,
        prompt: r.prompt ?? "",
        negative: r.negative,
        seed: r.seed ?? 0,
        steps: r.steps ?? 0,
        cfg: r.cfg ?? 0,
        solver: isSolver(r.solver) ? r.solver : undefined,
        cfgRescale: typeof r.cfgRescale === "number" ? r.cfgRescale : undefined,
        model: typeof r.model === "string" ? r.model : undefined,
        size: typeof r.size === "number" ? r.size : undefined,
        date: r.date ?? new Date(0).toISOString(),
        fav: !!r.fav,
      }));
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit() {
    this.subs.forEach((f) => f());
  }

  // Index writes are serialised: two overlapping write-then-rename cycles would fight over the temp file.
  private queue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const run = () => {
      const disk = this.items.filter((i) => !i.volatile).map(({ volatile: _v, ...rest }) => rest);
      return writeJson(this.store, INDEX, disk);
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Resolves when every pending index write has hit the disk. */
  idle(): Promise<void> {
    return this.queue.catch(() => {});
  }

  /** Stores the image; resolves with `persisted=false` if only memory could be used. */
  async add(blob: Blob, meta: Omit<GalleryItem, "id" | "file" | "date">): Promise<{ item: GalleryItem; persisted: boolean }> {
    const file = `img_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
    const item: GalleryItem = { ...meta, id: file, file, date: new Date().toISOString() };
    let persisted = true;
    try {
      await this.store.write(`${DIR}/${file}`, new Uint8Array(await blob.arrayBuffer()));
      this.items.unshift(item);
      await this.persist();
    } catch (e) {
      console.warn("gallery: disk write failed, keeping image in memory", e);
      persisted = false;
      item.volatile = true;
      this.volatileBlobs.set(file, blob);
      if (!this.items.includes(item)) this.items.unshift(item);
    }
    this.emit();
    return { item, persisted };
  }

  async remove(id: string): Promise<void> {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    this.items = this.items.filter((i) => i.id !== id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.volatileBlobs.delete(id);
    this.emit();
    // Index first: it must never point at a file that is already gone.
    await this.persist();
    if (!it.volatile) await this.store.remove(`${DIR}/${it.file}`).catch(() => {});
  }

  async toggleFav(id: string): Promise<void> {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    it.fav = !it.fav;
    await this.persist();
    this.emit();
  }

  async bytes(id: string): Promise<Uint8Array> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error("image not found");
    const vol = this.volatileBlobs.get(id);
    if (vol) return new Uint8Array(await vol.arrayBuffer());
    const st = await this.store.stat(`${DIR}/${it.file}`);
    if (!st) throw new Error("image file missing");
    return this.store.readRange(`${DIR}/${it.file}`, 0, st.size);
  }

  async url(id: string): Promise<string | null> {
    const cached = this.urls.get(id);
    if (cached) return cached;
    try {
      const bytes = await this.bytes(id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      this.urls.set(id, url);
      return url;
    } catch {
      return null;
    }
  }
}
