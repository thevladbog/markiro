import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
import {
  appendWarehouseEvent,
  prepareWarehouseJob,
  saveWarehouseSession,
} from "../src/lib/warehouse-reprint/store";
import { purgeWarehouseJobs } from "../src/lib/warehouse-reprint/retention";
it("preserves pending/current-session facts and only releases older verified acknowledged jobs", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
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
      ["verified", 4],
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
  }
});
