# ⚡ SupraDaProd

> Text-to-image studio in tua tasca — **scrivilo o dilolo**, un modello da 104M parametri
> fa il resto. Completamente **on-device**: nessun server, nessuna API key, nessun abbonamento.

**Powered by [Supra2-IMG](https://huggingface.co/SupraLabs/Supra2-IMG)** (SupraLabs) — un
piccolissimo diffusion transformer (DiT ~104M parametri) addestrato da zero su 5.6M immagini.
Output 256×256, pipeline ONNX di riferimento: [Bartholomheow/Supra2-IMG-ONNX](https://huggingface.co/Bartholomheow/Supra2-IMG-ONNX).

---

## ✨ Cosa fa

| Pagina | Funzione |
| --- | --- |
| ✨ **Crea** | Prompt testuale, pulsante 🎲 random, seed/steps/fedeltà regolabili, animazione live |
| 🎙 **Voce** | **Tieni premuto** il microfono → parla (🇮🇹/🇬🇧) → rilascia → Whisper trascrive → genera |
| 🖼 **Galleria** | Tutte le creazioni salvate localmente con prompt, seed, data — salva/riusa/elimina |

- **Animazione di generazione live**: ad ogni passo di denoising vedi il *latente*
  condensarsi a schermo — l'immagine prende forma in tempo reale, davvero.
- **Tutto locale**: il modello gira dentro l'app via WebGPU (fallback WASM/CPU automatico).
  Al primo avvio scarica ~1 GB di pesi ONNX e li cachà — poi funziona anche offline.
- **Ultra light**: app ~15 MB, frontend ~50 KB, zero framework pesanti.
- 🇮🇹 / 🇬🇧 — interfaccia e voce in italiano e inglese, basta e avanza.

## 📦 Download

Vai alla pagina [**Releases**](../../releases): installer **Windows**, DMG **macOS**
(Apple Silicon + Intel) e APK **Android** firmati, generati automaticamente da GitHub Actions
ad ogni tag `v*`.

## 🛠 Sviluppo

```bash
npm install
npm run tauri dev      # desktop dev
npm run tauri build    # desktop release

npm run tauri android init
npm run tauri android build --apk   # Android
```

Requisiti: [Rust](https://rustup.rs), Node 20+, Android SDK/NDK (solo per Android).

## 🧠 Come funziona

1. `pipeline_config.json` + 3 modelli ONNX (DiT 417MB · T5 419MB · VAE 198MB) scaricati
   una volta in Cache Storage.
2. Il prompt viene tokenizzato (T5 tokenizer) e codificato dall'encoder Flan-T5.
3. Euler flow sampling con CFG (default 30 step / 3.0) — `z += dt·(v_uncond + cfg·(v_cond − v_uncond))`.
4. Il VAE SD decodifica il latente in un'immagine 256×256, salvata in galleria.

La voce usa **Whisper-tiny** (ONNX, ~50 MB, scaricato al primo utilizzo) per trascrivere
italiano e inglese al volo.

## 📄 Licenze & crediti

- Codice: MIT
- Pesi [SupraLabs/Supra2-IMG](https://huggingface.co/SupraLabs/Supra2-IMG): Apache-2.0
- Conversione ONNX: [Bartholomheow/Supra2-IMG-ONNX](https://huggingface.co/Bartholomheow/Supra2-IMG-ONNX) (Apache-2.0)
- Flan-T5 (Google) · SD-VAE (Stability AI) — grazie ♥
