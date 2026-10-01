// Tiny promise-based RPC over postMessage (window ⇄ worker, both directions).

export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

/** Wrap a handler's return value to hand buffers over without copying. */
export class Transfer {
  constructor(readonly value: unknown, readonly list: Transferable[]) {}
}

type Handler = (args: any) => unknown | Promise<unknown>;

type Msg =
  | { t: "req"; id: number; method: string; args: unknown }
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: { name: string; message: string } }
  | { t: "ev"; ev: unknown };

export class Rpc {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(
    private port: Port,
    private handlers: Record<string, Handler> = {},
    private onEvent?: (ev: any) => void,
  ) {
    port.addEventListener("message", (e) => void this.onMessage(e.data as Msg));
  }

  call<T = unknown>(method: string, args?: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ t: "req", id, method, args } satisfies Msg, transfer);
    });
  }

  emit(ev: unknown, transfer: Transferable[] = []): void {
    this.port.postMessage({ t: "ev", ev } satisfies Msg, transfer);
  }

  /** Reject everything in flight (worker died / terminated). */
  failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private async onMessage(m: Msg): Promise<void> {
    if (!m || typeof m !== "object") return;
    if (m.t === "ev") return void this.onEvent?.(m.ev);
    if (m.t === "res") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
      return;
    }
    if (m.t === "req") {
      try {
        const h = this.handlers[m.method];
        if (!h) throw new Error(`unknown method ${m.method}`);
        const out = await h(m.args);
        if (out instanceof Transfer) {
          this.port.postMessage({ t: "res", id: m.id, ok: true, result: out.value } satisfies Msg, out.list);
        } else {
          this.port.postMessage({ t: "res", id: m.id, ok: true, result: out } satisfies Msg);
        }
      } catch (e) {
        const err = e as Error;
        this.port.postMessage({
          t: "res",
          id: m.id,
          ok: false,
          error: { name: err?.name ?? "Error", message: err?.message ?? String(e) },
        } satisfies Msg);
      }
    }
  }
}
