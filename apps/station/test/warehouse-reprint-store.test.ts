import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec, openFileDatabase } from "./support/sqlite-exec.js";
import {
  prepareWarehouseJob,
  readWarehouseJob,
  saveWarehouseSession,
  appendWarehouseEvent,
} from "../src/lib/warehouse-reprint/store.js";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint.js";

describe("warehouse jobs through a pooled executor", () => {
  it("persists preparation atomically, deduplicates identity and survives reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warehouse-print-"));
    const path = join(dir, "state.sqlite");
    const a = openFileDatabase(path);
    const b = openFileDatabase(path);
    const exec = makeRotatingExec([a, b]);
    try {
      await applyMigrations(exec);
      const input = warehousePreparedJobInput();
      await seedWarehouseOperator(exec, input.operatorId);
      await saveWarehouseSession(exec, {
        owner: input.owner,
        sessionId: input.sessionId,
        operatorId: input.operatorId,
        reason: input.reason,
        status: "active",
        unitTemplate: null,
        boxTemplate: input.template,
      });
      await expect(
        prepareWarehouseJob(exec, { ...input, fields: { ...input.fields, date: "01.01.2020" } }),
      ).rejects.toThrow("WAREHOUSE_REPRINT_INPUT_MISMATCH");
      expect(await prepareWarehouseJob(exec, input)).toBe("prepared");
      const secondId = "00000000-0000-4000-8000-000000000031";
      expect(
        await prepareWarehouseJob(exec, {
          ...input,
          jobId: secondId,
          preparedEvent: {
            ...input.preparedEvent,
            jobId: secondId,
            eventId: secondId,
            attemptId: secondId,
          },
        }),
      ).toBe("duplicate");
      expect((await readWarehouseJob(exec, "owner", input.jobId)).bytesBase64).toBe("cHJpbnQ=");
      expect(await exec.all("SELECT event_json FROM warehouse_reprint_events")).toHaveLength(1);
      await expect(readWarehouseJob(exec, "different-owner", input.jobId)).rejects.toThrow();
      a.close();
      b.close();
      const reopened = new DatabaseSync(path);
      try {
        expect(reopened.prepare("SELECT state FROM warehouse_reprint_jobs").get()?.state).toBe(
          "prepared",
        );
      } finally {
        reopened.close();
      }
    } finally {
      try {
        a.close();
      } catch {
        /* Already closed during restart assertion. */
      }
      try {
        b.close();
      } catch {
        /* Already closed during restart assertion. */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not leave half a job when the event write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warehouse-fault-"));
    const path = join(dir, "state.sqlite");
    const a = openFileDatabase(path);
    const b = openFileDatabase(path);
    const exec = makeRotatingExec([a, b]);
    try {
      await applyMigrations(exec);
      const input = warehousePreparedJobInput();
      await seedWarehouseOperator(exec, input.operatorId);
      await saveWarehouseSession(exec, {
        owner: input.owner,
        sessionId: input.sessionId,
        operatorId: input.operatorId,
        reason: input.reason,
        status: "active",
        unitTemplate: null,
        boxTemplate: input.template,
      });
      a.exec(
        "CREATE TRIGGER fail_warehouse_event BEFORE INSERT ON warehouse_reprint_events BEGIN SELECT RAISE(ABORT,'injected fault'); END;",
      );
      await expect(prepareWarehouseJob(exec, input)).rejects.toThrow("injected fault");
      expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toEqual([]);
      expect(await exec.all("SELECT attempt_id FROM warehouse_reprint_attempts")).toEqual([]);
      a.exec("DROP TRIGGER fail_warehouse_event");
      expect(await prepareWarehouseJob(exec, input)).toBe("prepared");
      const event = {
        eventId: "00000000-0000-4000-8000-000000000032",
        jobId: input.jobId,
        sessionId: input.sessionId,
        attemptId: input.preparedEvent.attemptId,
        operatorId: input.operatorId,
        sequence: 2,
        occurredAt: "2026-10-09T12:01:00.000Z",
        kind: "sending" as const,
      };
      const concurrent = await Promise.all([
        appendWarehouseEvent(exec, "owner", event),
        appendWarehouseEvent(exec, "owner", event),
      ]);
      expect(concurrent.sort()).toEqual(["applied", "replay"]);
      expect(await appendWarehouseEvent(exec, "owner", event)).toBe("replay");
      expect((await readWarehouseJob(exec, "owner", input.jobId)).projection.state).toBe("sending");
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
