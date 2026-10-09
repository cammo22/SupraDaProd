# ⚡ SupraDaProd

> Text-to-image **sul tuo dispositivo** — scegli il modello, scrivi il prompt, il resto è offline.
> Nessun server, nessuna API key, nessun abbonamento. Windows · Android · macOS · Linux · Web.

<p align="center">
  <a href="https://cammo22.github.io/SupraDaProd/"><img alt="Apri l'app web" src="https://img.shields.io/badge/%E2%96%B6%20Apri%20l'app%20web-GitHub%20Pages-8b5cf6?style=for-the-badge"></a>
  <a href="../../releases/latest"><img alt="Scarica" src="https://img.shields.io/badge/%E2%AC%87%20Scarica-ultima%20release-22d3ee?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/cammo22/SupraDaProd/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cammo22/SupraDaProd/actions/workflows/ci.yml/badge.svg"></a>
  <a href="../../releases/latest"><img alt="Versione" src="https://img.shields.io/github/v/release/cammo22/SupraDaProd?label=versione"></a>
  <img alt="Licenza" src="https://img.shields.io/badge/licenza-MIT-blue">
  <img alt="Piattaforme" src="https://img.shields.io/badge/Windows%20%C2%B7%20Android%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Web-555">
</p>

## 🎨 I modelli

Il selettore in alto a destra (o la voce **Modelli**) scarica e tiene in cache ogni motore
separatamente: si paga una volta la connessione, poi tutto funziona offline.

| Modello | Tipo | Output | Download | Note |
| --- | --- | --- | --- | --- |
| **Supra2-IMG** ⭐ | DiT flow 104M ([SupraLabs](https://huggingface.co/SupraLabs/Supra2-IMG)) | 256×256 | ~1 GB | Veloce anche senza GPU, ideale su telefono |
| **DreamShaper 8** | Stable Diffusion 1.5 ([Lykon](https://huggingface.co/Lykon/dreamshaper-8)) | 384–640 px | ~2 GB | Molto più dettagliato; consigliata una GPU (export fp16) |

Altri due modelli sono già in catalogo ma **non ancora eseguibili**, perché pubblicano i pesi in
formati che il motore ONNX del browser non legge (GGUF/INT4 per ComfyUI) e non esiste una
conversione ONNX:

| Modello | Stato | Perché |
| --- | --- | --- |
| [Iris 3B](https://huggingface.co/speridlabs/iris-3b) | ⏳ in attesa | 3B parametri, ~12 GB in fp32: serve un export ONNX quantizzato (q4) |
| [Anima](https://huggingface.co/circlestone-labs/Anima) | 🚫 | 2B con licenza non commerciale e nessun export ONNX |

> Aggiungere un modello = 20 righe in `src/lib/registry.ts` (famiglia, file da scaricare,
> risoluzione, licenza): appena esce una conversione ONNX di Iris o Anima si abilita da lì.

## ✨ Cosa fa

| Tab | Funzione |
| --- | --- |
| ✨ **Crea** | Prompt, 🎲 random, preset di qualità, passi / fedeltà / seed / risoluzione, prompt negativo, **anteprima live** dell'immagine che si forma, pulsante **Ferma** |
| 🖼 **Galleria** | Tutto salvato in locale |
| ⚙ **Modelli** | Selettore con dimensioni, licenza, stato e download riprendibile per ogni modello |

**Campionamento** (novità della 2.0, tutte disponibili per entrambe le famiglie):

| Solver | Costo | A cosa serve |
| --- | --- | --- |
| **DPM++ 2M** (default) | 1 valutazione/passo | Ordine 2 nella stessa forma dell'Euler: a parità di passi l'errore è 3–6× più piccolo, quindi si può scendere di passi senza perdere qualità |
| **Euler** | 1 valutazione/passo | Il comportamento storico: stesso seed + stessi passi = stessa immagine della 1.x |
| **Heun** | 2 valutazioni/passo | Predittore + correttore, per la massima precisione |

Più: **correzione saturazione** (CFG rescale) per i prompt con fedeltà alta, **spaziatura Karras**
per i modelli epsilon, e la valutazione congiunta condizionale/non condizionale in una sola
chiamata al modello quando il grafo lo consente (circa 1,3–2× più veloce su GPU).

## 🚀 Provala subito

La versione web gira direttamente nel browser, senza installare nulla: **[cammo22.github.io/SupraDaProd](https://cammo22.github.io/SupraDaProd/)**.
Al primo uso scarica il modello scelto, poi funziona anche offline. Per le prestazioni migliori usa un
browser con **WebGPU** (Chrome/Edge recenti); altrimenti ripiega sulla CPU, più lenta.

Tutto gira in locale: i modelli si scaricano **una volta** e poi l'app funziona anche **offline**.
La galleria (ricerca, ❤ preferiti, riusa prompt+seed, variazioni, esporta anche in **HD 1024px**) e le
impostazioni (motore, memoria, sorgente modelli, spazio occupato) vivono sul dispositivo.

## 📦 Download

Ultima versione → **[Releases](../../releases/latest)**. I link sotto non cambiano mai:

| Piattaforma | File |
| --- | --- |
| 🪟 **Windows – installer** (per-utente, niente admin, IT/EN) | [`SupraDaProd-windows-setup.exe`](../../releases/latest/download/SupraDaProd-windows-setup.exe) (oppure `.msi`) |
| 🪟 **Windows – portable** (un solo `.exe`, non lascia tracce) | [`SupraDaProd-windows-portable.exe`](../../releases/latest/download/SupraDaProd-windows-portable.exe) |
| 🤖 **Android 8+** | [`SupraDaProd-android.apk`](../../releases/latest/download/SupraDaProd-android.apk) |
| 🍎 macOS Apple Silicon / Intel | [`arm64.dmg`](../../releases/latest/download/SupraDaProd-macos-arm64.dmg) · [`x64.dmg`](../../releases/latest/download/SupraDaProd-macos-x64.dmg) |
| 🐧 Linux | [`SupraDaProd-linux.AppImage`](../../releases/latest/download/SupraDaProd-linux.AppImage) · `.deb` |

### 🪟 Portable vs installer
- **Installer**: installa per l'utente corrente (`%LOCALAPPDATA%`), voce nel menu Start, disinstallazione pulita. Se manca WebView2 lo installa da solo.
- **Portable**: copia l'exe dove vuoi (anche su chiavetta). Il nome contiene *portable* → l'app tiene **tutto** (modelli, galleria, persino il profilo WebView2)
  nella cartella `SupraDaProd-data` accanto all'exe. Cancelli la cartella e non resta nulla sul PC. Richiede il runtime **WebView2**, già presente su Windows 10/11 aggiornati.
  Puoi anche forzare la modalità portable creando un file `portable.flag` accanto all'exe.

### 🤖 Android
- Abilita "installa da fonti sconosciute" per il browser/file manager, apri l'APK.
- Il modello (~1 GB) si scarica in Wi-Fi; se la connessione cade **riprende da dove era**.
- Con poca RAM (≤ 4 GB) l'app passa da sola alla **modalità risparmio**: carica e scarica le reti a richiesta, così non viene uccisa dal sistema. Più lenta, ma funziona.
- Le immagini si esportano direttamente in **Galleria → Pictures/SupraDaProd**.
- Il WebGPU su Android dipende dal WebView di sistema; se non c'è si usa la CPU (WASM multi-thread).

### 🌐 Web / PWA (bonus)
La stessa UI gira in qualsiasi browser moderno (storage = OPFS, service worker per isolamento multi-thread e shell offline).
Il workflow `pages.yml` la pubblica su GitHub Pages ([apri l'app](https://cammo22.github.io/SupraDaProd/); la prima volta abilita *Settings → Pages → Source: GitHub Actions*). Su **Android Chrome** puoi "Aggiungi a schermata Home":
Chrome ha WebGPU e più memoria del WebView, quindi è spesso la via più veloce sul telefono.

### 🍎 macOS / 🐧 Linux
Le build macOS non sono firmate: tasto destro → Apri la prima volta. Su Linux WebKitGTK non ha WebGPU, quindi si usa la CPU.

## 🧠 Come funziona

```
        ┌──────────────────────────── webview (UI, TypeScript, ~70 KB) ────────────────────────────┐
prompt ▶│ Crea · Galleria · Modelli · Impostazioni          Storage (Tauri: file reali / web: OPFS) │
        └───────┬───────────────────────────────────────────────┬──────────────────────────────────┘
                │ Worker (off-thread, una pipeline per famiglia) │ download riprendibile
     ┌──────────▼───────────────────┐  ┌──────────────────────────┐  ┌────────────────┐
     │ flow:  T5 → DiT(σ) → VAE      │  │ sd15: CLIP → UNet(σ)     │  │ Range + sha256 │
     │ 256×256, velocity, CFG batch  │  │ → VAE, 384–640 px, fp16  │  │ → disco        │
     │ onnxruntime-web: WebGPU|WASM  │  │ WebGPU | WASM            │  └────────────────┘
     └───────────────────────────────┘  └──────────────────────────┘
```

1. Il **selettore Modelli** scarica su disco solo i file del modello scelto (dalla tree-API del Hub:
   nomi, dimensioni e **SHA-256**), in streaming, con ripresa (`Range`), retry, watchdog di stallo.
   Ogni modello ha la sua cartella `models/<id>` e il suo manifest: possono convivere.
2. Il prompt viene tokenizzato dall'encoder giusto (SentencePiece/Flan-T5 oppure **CLIP BPE**, costruito
   al volo dai file `vocab.json` + `merges.txt`). Il prompt negativo fa da ramo "uncond".
3. Il denoise lavora **in spazio σ** (livello di rumore) per entrambe le famiglie:
   `z = x₀ + σ·ε` per i modelli epsilon, `σ = 1 − t`, `x₀ = z + σ·v` per il flow. Lo stesso campionatore
   (Euler / DPM++ 2M / Heun) guida quindi sia Supra2-IMG sia Stable Diffusion.
4. Durante i passi l'anteprima mostra la **stima dell'immagine finale** proiettata in RGB, non il rumore.
5. Il VAE decodifica il latente (256×256 oppure 384–640 px) e la galleria salva il PNG con prompt, seed,
   passi, solver e modello usato.

Tutta l'inferenza è in un **Web Worker**: l'interfaccia resta fluida e **Ferma** funziona sempre, anche
su CPU. Con `COOP/COEP` attivi (l'app li imposta) il WASM usa **più thread**; i modelli fp16 girano anche
sul backend CPU (con conversione a metà precisione fatta in JS, così funziona ovunque).

## 🔧 Sviluppo

```bash
npm install
npm run dev            # solo frontend nel browser (storage = OPFS)
npm run tauri dev      # app desktop
npm run tauri build    # installer/bundle della tua piattaforma

npm run typecheck && npm test     # tipi + 55 unit test
npm run build && npm run e2e      # Chromium vero + onnxruntime-web vero + "Hugging Face" finto
```

L'e2e (`tests/e2e`) genera con Python due mini-repo finti (Supra2-IMG e un SD 1.5 con le stesse firme di
tensori dei veri export ONNX), li serve da un hub finto con `Range`/tree-API e guida l'app con Playwright:
download, ripresa dopo connessione caduta, riproducibilità dei seed, prompt negativo, solvers, batteria di
guidance, modalità risparmio RAM, annullamento, galleria, offline, cambio modello e download del secondo
modello. Requisiti: Node 22+, Rust stabile; per e2e `pip install onnx numpy`.
Android: Android SDK + NDK, poi `npx tauri android init && node scripts/patch-android.mjs && npx tauri android build --apk`.


### Release
Un tag `vX.Y.Z` fa partire `.github/workflows/release.yml`: builda Windows (installer + msi + portable), macOS, Linux, Android e pubblica la Release
con i nomi stabili qui sopra + `SHA256SUMS.txt`. Da *Actions → Release → Run workflow* ottieni solo gli artifact.

#### Firma Android
Senza segreti l'APK è firmato con una chiave temporanea (si installa, ma per aggiornare devi prima disinstallare). Per aggiornamenti "sopra":

```bash
keytool -genkeypair -keystore supradaprod.keystore -alias supradaprod -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 supradaprod.keystore   # → secret ANDROID_KEYSTORE_BASE64
```
Imposta nei *Secrets* del repo: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (e opz. `ANDROID_KEY_PASSWORD`). Conserva il keystore: se lo perdi non potrai più aggiornare le installazioni esistenti.

## 🩺 Problemi comuni
- **Hugging Face non raggiungibile** (rete aziendale, paese bloccato): Impostazioni → *Sorgente modelli* → inserisci un mirror.
- **Lenta**: il chip in alto mostra il motore in uso. "CPU (WASM)" è 5–20× più lenta di WebGPU; usa la
  preset **⚡ Rapida** (12 passi DPM++ 2M) o riduci i passi. DreamShaper 8 è molto più pesante di Supra2-IMG:
  su CPU si misura in minuti, meglio WebGPU o un modello più piccolo.
- **Crash su telefono / poca RAM**: Impostazioni → Memoria → *Risparmio* (carica le reti a richiesta).
- **Spazio insufficiente**: ogni modello occupa la sua cartella; da *Modelli* puoi eliminare quelli che non usi.

## 📄 Licenze & crediti
- Codice: MIT
- **Supra2-IMG** — pesi [SupraLabs/Supra2-IMG](https://huggingface.co/SupraLabs/Supra2-IMG) (Apache-2.0) ·
  conversione ONNX [Bartholomheow/Supra2-IMG-ONNX](https://huggingface.co/Bartholomheow/Supra2-IMG-ONNX) (Apache-2.0)
- **DreamShaper 8** — [Lykon/dreamshaper-8](https://huggingface.co/Lykon/dreamshaper-8), CreativeML OpenRAIL-M ·
  export ONNX fp16 di [Nikolai1902](https://huggingface.co/Nikolai1902/Dreamshaper8-ONNX-Olive)
- Componenti: Flan-T5 (Google) · CLIP (OpenAI) · SD-VAE (Stability AI) · onnxruntime-web (Microsoft) ·
  Transformers.js (Hugging Face) · Tauri
- I pesi non sono inclusi: l'app li scarica dal Hub su richiesta, con la licenza del modello originale.
