// ── Progress watchdog ────────────────────────────────────────────────────────
// Armed per backend node. The runner calls touch() on streaming chunks, file
// writes, and substep transitions. If no touch() arrives within `idleMs`, the
// onStall callback fires (abort node → retry or escalate).

export class ProgressWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly idleMs: number,
    private readonly onStall: () => void,
  ) {
    this.arm();
  }

  touch(): void {
    if (this.disposed) return;
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      this.onStall();
    }, this.idleMs);
  }
}

export const DEFAULT_WATCHDOG_IDLE_MS = 4 * 60 * 1000; // 4 minutes
