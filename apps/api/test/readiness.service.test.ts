import { describe, expect, it, vi } from "vitest";
import { ReadinessService } from "../src/health/readiness.service";

const NOW = new Date("2026-08-04T09:00:00.000Z");

function healthyDependencies() {
  return {
    database: vi.fn<() => Promise<void>>(async () => undefined),
    jobs: vi.fn<() => Promise<void>>(async () => undefined),
    smtp: vi.fn<() => Promise<{ status: "healthy" | "degraded" | "unknown" }>>(async () => ({
      status: "healthy",
    })),
    storage: vi.fn<() => Promise<void>>(async () => undefined),
    now: vi.fn<() => Date>(() => NOW),
  };
}

describe("ReadinessService", () => {
  it("reports every healthy dependency without provider details", async () => {
    const service = new ReadinessService(healthyDependencies());
    await expect(service.ready()).resolves.toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
      checks: {
        database: { status: "healthy", checkedAt: NOW.toISOString() },
        jobs: { status: "healthy", checkedAt: NOW.toISOString() },
        smtp: { status: "healthy", checkedAt: NOW.toISOString() },
        storage: { status: "healthy", checkedAt: NOW.toISOString() },
      },
    });
  });

  it("marks a required database failure unavailable and sanitizes the error", async () => {
    const dependencies = healthyDependencies();
    dependencies.database.mockRejectedValue(
      new Error("password=secret postgres://user:secret@database.internal/markiro"),
    );
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("unavailable");
    expect(report.checks.database).toEqual({
      status: "unavailable",
      category: "database_unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|database\.internal|postgres:\/\//);
  });

  it("marks a pg-boss probe failure unavailable", async () => {
    const dependencies = healthyDependencies();
    dependencies.jobs.mockRejectedValue(new Error("pg-boss connection lost"));
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("unavailable");
    expect(report.checks.jobs).toEqual({
      status: "unavailable",
      category: "jobs_unavailable",
      checkedAt: NOW.toISOString(),
    });
  });

  it("keeps SMTP and S3 failures degraded rather than unavailable", async () => {
    const dependencies = healthyDependencies();
    dependencies.smtp.mockResolvedValue({ status: "degraded" });
    dependencies.storage.mockRejectedValue(new Error("AccessDenied: private detail"));
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("degraded");
    expect(report.checks.smtp).toEqual({
      status: "degraded",
      category: "smtp_unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(report.checks.storage).toEqual({
      status: "degraded",
      category: "storage_unavailable",
      checkedAt: NOW.toISOString(),
    });
  });

  it("coalesces concurrent calls and caches the report for ten seconds", async () => {
    const dependencies = healthyDependencies();
    const service = new ReadinessService(dependencies);
    await Promise.all([service.ready(), service.ready()]);
    await service.ready();
    expect(dependencies.database).toHaveBeenCalledTimes(1);
    expect(dependencies.smtp).toHaveBeenCalledTimes(1);
    expect(dependencies.storage).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging probe at two seconds", async () => {
    vi.useFakeTimers();
    const dependencies = healthyDependencies();
    dependencies.database.mockImplementation(() => new Promise(() => undefined));
    const result = new ReadinessService(dependencies).ready();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({
      status: "unavailable",
      checks: { database: { category: "database_timeout" } },
    });
    vi.useRealTimers();
  });
});
