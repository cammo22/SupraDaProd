// Getting an image out of the app: save dialog (desktop), Pictures gallery
// (Android) or a plain download (browser).
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

export function suggestName(prompt: string): string {
  const slug = (prompt || "image")
    .slice(0, 40)
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return `supradaprod_${slug || "image"}.png`;
}

/** Returns where it was saved, or null if the user cancelled. */
export async function exportImage(bytes: Uint8Array, name: string): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("export_image", bytes, { headers: { "x-name": encodeURIComponent(name) } });
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

/** Desktop only: open the data folder in the file manager. */
export async function revealDataFolder(): Promise<void> {
  if (isTauri()) await invoke("reveal_data_dir");
}
