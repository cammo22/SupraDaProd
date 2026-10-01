// `tauri android init` generates the Android project at build time (src-tauri/gen is not committed).
// This script applies the few things SupraDaProd needs on top of the template:
//   • RECORD_AUDIO / MODIFY_AUDIO_SETTINGS  → push-to-talk voice input
//   • largeHeap                               → headroom for the ~1 GB of model data
//   • adjustResize                            → the on-screen keyboard must not cover the prompt
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(import.meta.dirname, "../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
if (!existsSync(file)) {
  console.error("manifest not found — run `npx tauri android init` first");
  process.exit(1);
}
let xml = readFileSync(file, "utf8");

for (const perm of ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]) {
  if (!xml.includes(perm)) xml = xml.replace("<application", `<uses-permission android:name="${perm}" />\n    <application`);
}
if (!/android:largeHeap=/.test(xml)) xml = xml.replace("<application", '<application android:largeHeap="true"');
if (!/android:windowSoftInputMode=/.test(xml)) xml = xml.replace("<activity", '<activity android:windowSoftInputMode="adjustResize"');

writeFileSync(file, xml);
for (const must of ["RECORD_AUDIO", "largeHeap", "adjustResize"]) {
  if (!xml.includes(must)) {
    console.error(`patch failed: ${must} missing`);
    process.exit(1);
  }
}
console.log("AndroidManifest.xml patched");
