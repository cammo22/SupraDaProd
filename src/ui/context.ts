import type { Gallery, GalleryItem } from "../lib/gallery";
import type { Store } from "../lib/storage/types";

/** Shared app state handed to every UI module. */
export interface Ctx {
  store: Store;
  gallery: Gallery;
  /** True while a generation / download / transcription is running. */
  busy: boolean;
  switchView(name: "create" | "voice" | "gallery"): void;
  /** Runs a generation from the Create tab controls (optionally with a prompt override). */
  generate(opts?: { prompt?: string; newSeed?: boolean }): Promise<void>;
  /** Puts a gallery item's parameters into the Create controls. */
  loadParams(item: GalleryItem, lockSeed: boolean): void;
  /** Drops cached engines after a settings change. */
  resetEngines(): void;
}
