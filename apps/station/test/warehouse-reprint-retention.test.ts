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

it("expires and bounds disposable lookups while retaining frozen local fields and pending or quarantined source jobs", async () => {
  const { cacheWarehouseClosedBox, findWarehouseSource } =
    await import("../src/lib/warehouse-reprint/sources");
  const { resolveWarehouseReprintScan } = await import("@markiro/domain");
  const { purgeWarehouseLookupCache } = await import("../src/lib/warehouse-reprint/retention");
  const folder = mkdtempSync(join(tmpdir(), "warehouse-cache-retention-"));
  const path = join(folder, "warehouse.sqlite");
  const db = openFileDatabase(path);
  const second = openFileDatabase(path);
  const exec = makeRotatingExec([db, second]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  try {
    await seedWarehouseOperator(exec, i.operatorId);
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
    await cacheWarehouseClosedBox(exec, i.owner, {
      sourceId: i.source.sourceId,
      sourceShiftId: i.source.sourceShiftId,
      fields: i.source.fields,
    });
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) VALUES(?,'box',?,?,'2020-01-01')",
      [i.owner, i.source.identity, JSON.stringify(i.source)],
    );
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) VALUES('other','box','expired-other','{}','2020-01-01')",
    );
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'box','ambiguous-legacy','{}')",
      [i.owner],
    );
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) VALUES(?,'box','expired','{}','2020-01-01')",
      [i.owner],
    );
    await exec.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1002)
      INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) SELECT ?,'box','lookup-'||i,'{}','2026-10-10T10:00:00.000Z' FROM n`,
      [i.owner],
    );
    for (const status of ["pending", "quarantined"] as const) {
      await exec.run("UPDATE warehouse_reprint_events SET receive_status=?", [status]);
      await purgeWarehouseLookupCache(exec, i.owner, "2026-10-01");
      expect(
        await exec.all(
          "SELECT identity FROM warehouse_reprint_cache WHERE owner=? AND identity=?",
          [i.owner, i.source.identity],
        ),
      ).toHaveLength(1);
    }
    expect(
      await exec.all(
        "SELECT identity FROM warehouse_reprint_cache WHERE owner=? AND identity LIKE 'lookup-%'",
        [i.owner],
      ),
    ).toHaveLength(1000);
    expect(
      await exec.all(
        "SELECT identity FROM warehouse_reprint_cache WHERE owner=? AND identity='expired'",
        [i.owner],
      ),
    ).toHaveLength(0);
    expect(
      await exec.all("SELECT identity FROM warehouse_reprint_cache WHERE owner='other'"),
    ).toHaveLength(1);
    expect(
      await exec.all(
        "SELECT identity FROM warehouse_reprint_cache WHERE identity='ambiguous-legacy'",
      ),
    ).toHaveLength(1);
    expect(
      (await findWarehouseSource(exec, i.owner, resolveWarehouseReprintScan(i.source.identity)))
        ?.fields,
    ).toEqual(i.source.fields);
    db.close();
    second.close();
    const restarted = openFileDatabase(path);
    try {
      const reopened = makeRotatingExec([restarted, restarted]);
      await applyMigrations(reopened);
      expect(
        (
          await findWarehouseSource(
            reopened,
            i.owner,
            resolveWarehouseReprintScan(i.source.identity),
          )
        )?.fields,
      ).toEqual(i.source.fields);
    } finally {
      restarted.close();
    }
  } finally {
    if (db.isOpen) db.close();
    if (second.isOpen) second.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
