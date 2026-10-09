import type { Gallery, GalleryItem } from "../lib/gallery";
import type { Manifest } from "../lib/models";
import type { ModelSpec } from "../lib/registry";
import type { Store } from "../lib/storage/types";

/** Shared app state handed to every UI module. */
export interface Ctx {
  store: Store;
  gallery: Gallery;
  /** True while a generation / download is running. */
  busy: boolean;
  /** Model currently selected (installed or not — see `installed`). */
  model: ModelSpec;
  /** Manifest of the selected model once it is on disk. */
  manifest: Manifest | null;
  /** True when the selected model is fully installed. */
  installed: boolean;
  switchView(name: "create" | "gallery"): void;
  /** Runs a generation from the Create tab controls (optionally with a prompt override). */
  generate(opts?: { prompt?: string; newSeed?: boolean }): Promise<void>;
  /** Puts a gallery item's parameters into the Create controls. */
  loadParams(item: GalleryItem, lockSeed: boolean): void;
  /** Drops cached engines after a settings change. */
  resetEngines(): void;
  /** Re-reads the installed state of the selected model. */
  refreshModel(): Promise<void>;
  /** Selects a model, downloading it first when needed. */
  useModel(id: string): Promise<void>;
  /** Re-renders the model list (installed by ui/models.ts). */
  refreshModels?: () => Promise<void>;
  /** Re-reads the per-model controls (installed by ui/create.ts). */
  syncControls?: () => void;
}
