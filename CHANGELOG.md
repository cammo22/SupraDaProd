# Changelog

Tutte le modifiche importanti. Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
le versioni [SemVer](https://semver.org/lang/it/).

## [2.0.0] — 2026-02

Una release grossa: l'app diventa **multi-modello**, impara Stable Diffusion, disegna meglio e più
veloce — e perde la parte vocale.

### Aggiunto
- **Selettore di modelli** (chip in alto → *Modelli*): catalogo con dimensioni, licenza, risoluzione e
  stato di installazione per ogni motore. Ogni modello vive nella sua cartella, si scarica una volta
  (riprendibile e verificato SHA-256) e convive con gli altri.
- **DreamShaper 8 (Stable Diffusion 1.5)**: seconda pipeline completa — tokenizer CLIP costruito al volo
  da `vocab.json` + `merges.txt`, text encoder, UNet fp16 con predizione ε, VAE decoder, 384/512/576/640 px,
  campionamento in spazio σ con lo stesso set di solver. Funziona anche senza WebGPU (conversione fp16 in JS).
- **Nuovi campionatori** per entrambe le famiglie:
  - **DPM++ 2M** (default): ordine 2, 3–6× più accurato di Euler a parità di valutazioni di rete;
  - **Heun**: predittore + correttore per la massima precisione;
  - **Euler**: identico al comportamento 1.x (stesso seed + stessi passi = stessa immagine).
- **Correzione saturazione** (CFG rescale) e **spaziatura Karras** per i modelli ε.
- **Valutazione congiunta condizionale/non condizionale** in una sola chiamata al DiT quando il grafo lo
  supporta (verificata al primo uso, con ripiego automatico su due chiamate): fino a ~2× più veloce su GPU.
- Preset di qualità (**⚡ Rapida / ★ Bilanciata / 🏆 Massima**), risoluzione e opzioni per modello,
  parametri ricordati per ciascun modello, galleria con modello/risoluzione usati.
- Il prompt `cfg = 1` salta del tutto il ramo negativo (metà del costo).
- Indicatore del costo in "passaggi nel modello" e anteprima live anche per i modelli SD.

### Ottimizzato
- Il denoise non alloca più nulla per passo (buffer riusati, stato del solver riusato, nessuna `.slice()`).
- Il worker non ricrea i tensori condivisi (embedding condizionale/non condizionale, maschera) a ogni passo.
- Anteprima live su un canvas di appoggio riusato invece di uno nuovo per ogni frame.
- Bundle web: rimossi gli asset ORT di Transformers.js e l'intero percorso Whisper (~11 MB in meno nel
  `dist`, meno codice scaricato all'avvio).
- Service worker `v2` con pulizia delle cache vecchie.

### Rimosso
- **Tutto il reparto voce**: tab Voce, registratore, worker Whisper, modello Whisper (~50 MB), l'opzione
  "traduci in inglese" e le voci correlate in Impostazioni. L'app si concentra sulle immagini.
- La cartella `src/voice/` e `whisper.worker.ts`; `translate` non è più nelle impostazioni.

### Note di aggiornamento
- L'installazione di Supra2-IMG **non va riscaricata**: i manifest 1.x vengono letti e aggiornati al volo.
- Gli elementi di galleria creati prima della 2.0 non hanno il campo `model`: valgono come Supra2-IMG.
- Da questa versione i preset cambiano solo il numero di passi; il solver si sceglie a parte.

## [1.0.2] — precedente
- Anteprima live durante il denoise, download riprendibile con verifica SHA-256, galleria locale,
  export HD, build Windows/macOS/Linux/Android + PWA.
