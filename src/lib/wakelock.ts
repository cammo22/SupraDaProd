// Keeps the screen on while something long is running (phones love to sleep mid-generation).
let lock: WakeLockSentinel | null = null;
let wanted = false;

async function acquire() {
  try {
    lock = (await navigator.wakeLock?.request("screen")) ?? null;
    lock?.addEventListener("release", () => (lock = null));
  } catch {
    lock = null; // denied / unsupported — not critical
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wanted && !lock) void acquire();
});

export function keepAwake(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else {
    void lock?.release().catch(() => {});
    lock = null;
  }
}
