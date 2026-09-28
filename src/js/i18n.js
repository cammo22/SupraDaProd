// IT / EN — that's it, that's the list 🇮🇹🇬🇧
export const I18N = {
  it: {
    tagline: "100M parametri di pura fantasia",
    stage_hint: "Scrivi, premi genera ✨",
    prompt_ph: "Descrivi l'immagine che vuoi…",
    random: "Random",
    tune: "Regola",
    generate: "Genera",
    steps: "Passi",
    cfg: "Fedeltà",
    tab_create: "Crea",
    tab_voice: "Voce",
    tab_gallery: "Galleria",
    voice_tip: "Tieni premuto il microfono e parla.<br>Rilascia e la magia parte.",
    rec_idle: "Pronto — tieni premuto",
    rec_hold: "🔴 Sto registrando… rilascia quando hai finito",
    rec_working: "🧠 Sto ascoltando…",
    rec_too_short: "Troppo corto! Tieni premuto mentre parli.",
    rec_denied: "Microfono negato — dai il permesso nelle impostazioni.",
    transcript: "Trascrizione",
    redo: "Riregistra",
    gen_from_voice: "Genera immagine",
    gallery: "Galleria",
    gallery_empty: "Le tue creazioni vivranno qui.",
    save: "Salva",
    reuse: "Riusa",
    dl_title: "Un solo scaricamento, poi è tutto tuo",
    dl_sub: "Il modello (~1 GB) viene salvato dentro l'app — dopo funziona anche offline.",
    need_prompt: "Scrivi o dica qualcosa prima ✨",
    saved: "Salvato in galleria 💾",
    deleted: "Eliminato",
    saving: "Salvataggio…",
    ph_encode: "Lettura del prompt (T5)…",
    ph_denoise: "La magia prende forma…",
    ph_decode: "Rivelazione dell'immagine…",
    gen_done: "Ecco l'immagine!",
    step_of: "passo",
    downloading: "scaricamento",
    cached: "già scaricato ✓",
    stt_dl: "Primo avvio: scarico whisper-tiny (~50 MB)…",
    stt_ready: "Trascrivo…",
    error_generic: "Ops, errore",
    img_missing: "Immagine non disponibile — riprova a generarla",
    prompt_en_hint: "💡 Il modello capisce meglio l'inglese, ma prova anche l'italiano!",
  },
  en: {
    tagline: "100M parameters of pure imagination",
    stage_hint: "Type it, hit generate ✨",
    prompt_ph: "Describe the image you want…",
    random: "Random",
    tune: "Tune",
    generate: "Generate",
    steps: "Steps",
    cfg: "Fidelity",
    tab_create: "Create",
    tab_voice: "Voice",
    tab_gallery: "Gallery",
    voice_tip: "Press & hold the mic and talk.<br>Release and the magic starts.",
    rec_idle: "Ready — press and hold",
    rec_hold: "🔴 Recording… release when done",
    rec_working: "🧠 Listening back…",
    rec_too_short: "Too short! Hold while you speak.",
    rec_denied: "Microphone denied — grant permission in settings.",
    transcript: "Transcript",
    redo: "Re-record",
    gen_from_voice: "Generate image",
    gallery: "Gallery",
    gallery_empty: "Your creations will live here.",
    save: "Save",
    reuse: "Reuse",
    dl_title: "One download, then it's all yours",
    dl_sub: "The model (~1 GB) is stored inside the app — works offline afterwards.",
    need_prompt: "Write or say something first ✨",
    saved: "Saved to gallery 💾",
    deleted: "Deleted",
    saving: "Saving…",
    ph_encode: "Reading your prompt (T5)…",
    ph_denoise: "The magic takes shape…",
    ph_decode: "Revealing the image…",
    gen_done: "Here's your image!",
    step_of: "step",
    downloading: "downloading",
    cached: "cached ✓",
    stt_dl: "First run: fetching whisper-tiny (~50 MB)…",
    stt_ready: "Transcribing…",
    error_generic: "Oops, error",
    img_missing: "Image unavailable — try generating it again",
    prompt_en_hint: "💡 The model understands English best — but try Italian too!",
  },
};

export let lang = localStorage.getItem("sdp_lang")
  || ((navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en");

export function t(key) {
  return I18N[lang][key] ?? I18N.en[key] ?? key;
}

export function setLang(l) {
  lang = l;
  localStorage.setItem("sdp_lang", l);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll("#langSwitch button").forEach((b) => {
    b.classList.toggle("on", b.dataset.lang === l);
  });
  document.documentElement.lang = l;
}
