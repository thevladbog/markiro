import { Logger } from "@nestjs/common";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DeviceReplacementExecutionRepairService } from "../src/modules/device-licensing/device-replacement-execution-repair.service";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

describe.skipIf(!process.env.DATABASE_URL)("replacement background repair", () => {
  const h = replacementExecutionHarness();

  it("runs on startup, retries a failed scan, prevents overlap and stops on shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const scan = vi
      .spyOn(h.repair, "repairPending")
      .mockRejectedValueOnce(new Error("private database detail"));
    h.repair.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ event: "device_replacement_repair_scan_failed" });
    let release: () => void = () => {
      throw new Error("Repair scan was not started");
    };
    const flight = new Promise<[]>((resolve) => {
      release = () => resolve([]);
    });
    scan.mockImplementationOnce(() => flight);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(scan).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stop = h.repair.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("keeps an empty database unchanged and quiet", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await h.repair.repairPending()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs failed committed work and repairs once across independent replicas and retries", async () => {
    const f = await h.ready();
    const p = await h.preview(f);
    const revoke = vi.spyOn(h.db, "delete").mockImplementationOnce(() => {
      throw new Error("interrupted");
    });
    await expect(
      h.execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toThrow("interrupted");
    revoke.mockRestore();
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const attempt = vi
      .spyOn(h.repair, "repairExecution")
      .mockRejectedValueOnce(new Error("private failure"));
    const pending = await h.repair.repairPending();
    expect(pending).toEqual([{ executionId: expect.any(String), status: "pending" }]);
    expect(warn).toHaveBeenCalledWith({
      event: "device_replacement_repair_pending",
      executionId: pending[0]?.executionId,
    });
    attempt.mockRestore();
    expect(await h.repair.repairPending()).toEqual([]);
    const [scheduled] = await h.db
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(eq(schema.workingDeviceReplacementExecutions.tenantId, f.tenantId));
    if (!scheduled?.nextRepairAt) throw new Error("Missing retry schedule");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduled.nextRepairAt);
    const replica = new DeviceReplacementExecutionRepairService(h.db, h.execution);
    await Promise.all([h.repair.repairPending(), replica.repairPending()]);
    expect(await h.repair.repairPending()).toEqual([]);
    expect(
      await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, f.tenantId)),
    ).toHaveLength(2);
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementExecutions)
        .where(eq(schema.workingDeviceReplacementExecutions.tenantId, f.tenantId)),
    ).toMatchObject([{ state: "completed", step: "transferred" }]);
    expect(log).toHaveBeenCalledWith({
      event: "device_replacement_repair_completed",
      executionId: pending[0]?.executionId,
    });
  });
});
