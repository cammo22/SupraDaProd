export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

const toastEl = () => $("toast");
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, opts: { error?: boolean; ms?: number } = {}): void {
  const el = toastEl();
  el.textContent = msg;
  el.classList.toggle("err", !!opts.error);
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => (el.hidden = true), opts.ms ?? (opts.error ? 5200 : 2600));
}

export function confirmDialog(message: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>("confirmDialog");
  $("confirmMsg").textContent = message;
  return new Promise((resolve) => {
    const cleanup = () => {
      $("confirmYes").removeEventListener("click", yes);
      $("confirmNo").removeEventListener("click", no);
      dlg.removeEventListener("close", onClose);
    };
    const yes = () => {
      cleanup();
      dlg.close();
      resolve(true);
    };
    const no = () => dlg.close();
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    $("confirmYes").addEventListener("click", yes);
    $("confirmNo").addEventListener("click", no);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

/** Closes a <dialog> when the dark backdrop is clicked. */
export function closeOnBackdrop(dlg: HTMLDialogElement): void {
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
}
