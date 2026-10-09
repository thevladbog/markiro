import type { PrintTarget } from "../src/lib/hardware";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
import {
  saveWarehouseSession,
  prepareWarehouseJob,
  readWarehouseJob,
} from "../src/lib/warehouse-reprint/store";
import {
  printWarehouseJob,
  recoverWarehouseJobs,
  verifyWarehouseJob,
  reprintWarehouseJob,
} from "../src/lib/warehouse-reprint/printing";
it("keeps one send, rejects !1 verification and explicitly replays frozen bytes", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  try {
    await saveWarehouseSession(exec, {
      owner: input.owner,
      sessionId: input.sessionId,
      operatorId: input.operatorId,
      reason: input.reason,
      status: "active",
      unitTemplate: null,
      boxTemplate: input.template,
    });
    await prepareWarehouseJob(exec, input);
    const transport = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array): Promise<void> => {
      expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
        "sending",
      );
      throw new Error("lost response");
    });
    const deps = {
      exec,
      owner: input.owner,
      operatorId: input.operatorId,
      profile: input.printer,
      print: transport,
      isCurrent: () => true,
    };
    await Promise.all([printWarehouseJob(deps, input.jobId), printWarehouseJob(deps, input.jobId)]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "delivery_unknown",
    );
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      await verifyWarehouseJob(
        exec,
        input.owner,
        input.jobId,
        input.operatorId,
        `!100${input.source.identity}`,
      ),
    ).toBe(false);
    expect(
      await verifyWarehouseJob(
        exec,
        input.owner,
        input.jobId,
        input.operatorId,
        `00${input.source.identity}`,
      ),
    ).toBe(true);
    transport.mockImplementation(async (_target, bytes) => {
      expect(btoa(String.fromCharCode(...bytes))).toBe(input.bytesBase64);
    });
    await reprintWarehouseJob(deps, input.jobId, "lost");
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
  }
});
it("requires an explicit recovery before changing the frozen endpoint", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  try {
    await saveWarehouseSession(exec, {
      owner: i.owner,
      sessionId: i.sessionId,
      operatorId: i.operatorId,
      reason: i.reason,
      status: "active",
      unitTemplate: null,
      boxTemplate: i.template,
    });
    await prepareWarehouseJob(exec, i);
    const print = vi.fn().mockResolvedValue(undefined);
    const profile = {
      ...i.printer,
      id: "new",
      name: "Replacement",
      target: { kind: "tcp" as const, host: "127.0.0.2", port: 9100 },
    };
    const deps = {
      exec,
      owner: i.owner,
      operatorId: i.operatorId,
      profile,
      print,
      isCurrent: () => true,
    };
    await printWarehouseJob(deps, i.jobId);
    expect(print).not.toHaveBeenCalled();
    expect((await readWarehouseJob(exec, i.owner, i.jobId)).projection.state).toBe(
      "failed_before_send",
    );
    await reprintWarehouseJob(deps, i.jobId, "not_printed");
    expect(print).toHaveBeenCalledWith(profile.target, expect.any(Uint8Array));
    expect((await readWarehouseJob(exec, i.owner, i.jobId)).printer).toEqual(profile);
  } finally {
    db.close();
  }
});
