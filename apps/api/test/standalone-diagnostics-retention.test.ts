import { afterEach, describe, expect, it, vi } from "vitest";
import { StandaloneDiagnosticsRetention } from "../src/modules/standalone-diagnostics/standalone-diagnostics-retention";
import type { StandaloneDiagnosticsService } from "../src/modules/standalone-diagnostics/standalone-diagnostics.service";

afterEach(() => vi.useRealTimers());

describe("support diagnostics retention schedule (plan ДИАГ А3)", () => {
  it("purges soon after the start (a restart must not reset the day) and then every day", () => {
    vi.useFakeTimers();
    const purgeExpired = vi.fn(() => Promise.resolve(0));
    const retention = new StandaloneDiagnosticsRetention({
      purgeExpired,
    } as unknown as StandaloneDiagnosticsService);
    retention.onModuleInit();
    expect(purgeExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    retention.onModuleDestroy();
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
  });

  it("survives a failing purge", async () => {
    vi.useFakeTimers();
    const purgeExpired = vi.fn(() => Promise.reject(new Error("db down")));
    const retention = new StandaloneDiagnosticsRetention({
      purgeExpired,
    } as unknown as StandaloneDiagnosticsService);
    retention.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    retention.onModuleDestroy();
  });
});
