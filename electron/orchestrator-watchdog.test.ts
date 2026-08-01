import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProgressWatchdog, DEFAULT_WATCHDOG_IDLE_MS } from "./orchestrator-watchdog.js";

describe("ProgressWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onStall after idleMs with no touch", () => {
    const onStall = vi.fn();
    const wd = new ProgressWatchdog(5000, onStall);

    vi.advanceTimersByTime(4999);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledOnce();

    wd.dispose();
  });

  it("touch resets the timer", () => {
    const onStall = vi.fn();
    const wd = new ProgressWatchdog(5000, onStall);

    vi.advanceTimersByTime(3000);
    wd.touch();

    vi.advanceTimersByTime(4999);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledOnce();

    wd.dispose();
  });

  it("dispose prevents stall from firing", () => {
    const onStall = vi.fn();
    const wd = new ProgressWatchdog(5000, onStall);

    vi.advanceTimersByTime(3000);
    wd.dispose();

    vi.advanceTimersByTime(10000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("touch after dispose is a no-op", () => {
    const onStall = vi.fn();
    const wd = new ProgressWatchdog(5000, onStall);

    wd.dispose();
    wd.touch();

    vi.advanceTimersByTime(10000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("multiple touches keep extending the deadline", () => {
    const onStall = vi.fn();
    const wd = new ProgressWatchdog(1000, onStall);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900);
      wd.touch();
    }

    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledOnce();

    wd.dispose();
  });

  it("DEFAULT_WATCHDOG_IDLE_MS is 4 minutes", () => {
    expect(DEFAULT_WATCHDOG_IDLE_MS).toBe(4 * 60 * 1000);
  });
});
