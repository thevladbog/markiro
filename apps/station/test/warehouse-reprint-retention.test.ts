import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec, openFileDatabase } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
import {
  appendWarehouseEvent,
  prepareWarehouseJob,
  saveWarehouseSession,
} from "../src/lib/warehouse-reprint/store";
import { purgeWarehouseJobs } from "../src/lib/warehouse-reprint/retention";
it.each(["sent", "verified"] as const)(
  "preserves pending/current-session facts and releases older acknowledged %s jobs",
  async (state) => {
    const folder = mkdtempSync(join(tmpdir(), "warehouse-retention-"));
    const db = openFileDatabase(join(folder, "warehouse.sqlite"));
    const second = openFileDatabase(join(folder, "warehouse.sqlite"));
    const exec = makeRotatingExec([db, second]);
    await applyMigrations(exec);
    await applyMigrations(exec);
    const i = warehousePreparedJobInput();
    await seedWarehouseOperator(exec, i.operatorId);
    try {
      const s = {
        owner: i.owner,
        sessionId: i.sessionId,
        operatorId: i.operatorId,
        reason: i.reason,
        status: "active" as const,
        unitTemplate: null,
        boxTemplate: i.template,
      };
      await saveWarehouseSession(exec, s);
      await prepareWarehouseJob(exec, i);
      await purgeWarehouseJobs(exec, i.owner, "2030-01-01");
      expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(1);
      for (const [kind, sequence] of [
        ["sending", 2],
        ["sent", 3],
      ] as const)
        await appendWarehouseEvent(exec, i.owner, {
          kind,
          sequence,
          eventId: crypto.randomUUID(),
          jobId: i.jobId,
          sessionId: i.sessionId,
          attemptId: i.preparedEvent.attemptId,
          operatorId: i.operatorId,
          occurredAt: i.preparedEvent.occurredAt,
        });
      if (state === "verified")
        await appendWarehouseEvent(exec, i.owner, {
          kind: "verified",
          sequence: 4,
          eventId: crypto.randomUUID(),
          jobId: i.jobId,
          sessionId: i.sessionId,
          attemptId: i.preparedEvent.attemptId,
          operatorId: i.operatorId,
          occurredAt: i.preparedEvent.occurredAt,
        });
      await exec.run("UPDATE warehouse_reprint_events SET receive_status='accepted'");
      await purgeWarehouseJobs(exec, i.owner, "2030-01-01");
      expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(1);
      await exec.run(
        "UPDATE warehouse_reprint_events SET receive_status='quarantined' WHERE sequence=1",
      );
      await saveWarehouseSession(exec, { ...s, status: "paused" });
      await saveWarehouseSession(exec, { ...s, sessionId: crypto.randomUUID(), status: "paused" });
      await purgeWarehouseJobs(exec, i.owner, "2030-01-01");
      expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(1);
      await exec.run("UPDATE warehouse_reprint_events SET receive_status='accepted'");
      await purgeWarehouseJobs(exec, i.owner, "2030-01-01");
      expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(0);
      expect(await exec.all("SELECT event_id FROM warehouse_reprint_events")).toHaveLength(0);
    } finally {
      db.close();
      second.close();
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
