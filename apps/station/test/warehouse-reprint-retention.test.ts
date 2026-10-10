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

it("preserves timestamped lookup sources for retained jobs under a verified previous credential", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { purgeWarehouseLookupCache } = await import("../src/lib/warehouse-reprint/retention");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  try {
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
    await prepareWarehouseJob(exec, input);
    const ownerJson = JSON.stringify({
      serverOrigin: "https://station.test",
      tenantId: "tenant",
      deviceId: input.deviceId,
      kind: "station",
    });
    await exec.run(
      "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,'machine',?,'active','new-owner')",
      [ownerJson],
    );
    await exec.run("INSERT INTO station_device_owners(credential_hash,owner_json) VALUES(?,?)", [
      input.owner,
      ownerJson,
    ]);
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) VALUES('new-owner','box',?,?,'2020-01-01')",
      [input.source.identity, JSON.stringify(input.source)],
    );
    for (const receiveStatus of ["pending", "quarantined"]) {
      await exec.run("UPDATE warehouse_reprint_events SET receive_status=?", [receiveStatus]);
      await purgeWarehouseLookupCache(exec, "new-owner", "2026-10-01");
      expect(
        await exec.all("SELECT identity FROM warehouse_reprint_cache WHERE owner='new-owner'"),
      ).toEqual([{ identity: input.source.identity }]);
    }
  } finally {
    db.close();
  }
});

it("expires acknowledged original snapshots, preserving unsynced, conflicting, referenced and foreign-owner boxes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "warehouse-local-retention-"));
  const path = join(folder, "warehouse.sqlite");
  const db = openFileDatabase(path);
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  const before = "2026-10-01T00:00:00.000Z";
  try {
    for (const identity of [
      "expired",
      "unsynced",
      "conflict",
      "outbox",
      "shift-close",
      "fresh",
      "foreign",
      "denied",
      i.source.identity,
    ]) {
      const source = {
        ...i.source,
        sourceId: identity,
        sourceShiftId: identity === "shift-close" ? "closing" : "shift",
        identity,
        fields: { ...i.source.fields, sscc: identity },
      };
      await exec.run(
        "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json,cached_at) VALUES(?,?,?,?)",
        [
          identity === "foreign" ? "other" : i.owner,
          identity,
          JSON.stringify(source),
          identity === "fresh" ? "2026-10-10" : "2020-01-01",
        ],
      );
      await exec.run(
        "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,acked_at) VALUES(?,?,?,'2020-01-01','2020-01-02',?)",
        [
          identity,
          identity === "shift-close" ? "closing" : "shift",
          identity,
          identity === "unsynced" ? null : "2020-01-03",
        ],
      );
    }
    await exec.run(
      "INSERT INTO box_reconciliation_issues(box_id,shift_id,status,reason_code,local_item_count,checked_at) VALUES('conflict','shift','content_mismatch','mismatch',0,'2020-01-03')",
    );
    await exec.run(
      "UPDATE warehouse_reprint_local_boxes SET eligibility_denied=1 WHERE identity='denied'",
    );
    await exec.run(
      "INSERT INTO outbox(shift_id,raw,verdict,scanned_at,box_id) VALUES('shift','raw','ok','2020-01-01','outbox')",
    );
    await exec.run(
      "INSERT INTO shift_close_outbox(event_id,shift_id,device_id,product_id,product_name,actual_qty,closed_box_count,closed_at) VALUES('close','closing','device','product','Product',0,0,'2020-01-02')",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES('shift','closed','validation','product')",
    );
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
    await exec.run("INSERT INTO station_meta(key,value) VALUES('sync_pending_batch_id','batch')");
    await purgeWarehouseJobs(exec, i.owner, before);
    expect(await exec.all("SELECT identity FROM warehouse_reprint_local_boxes")).toHaveLength(9);
    await exec.run("DELETE FROM station_meta WHERE key='sync_pending_batch_id'");
    await purgeWarehouseJobs(exec, i.owner, before);
    expect(
      (
        await exec.all<{ identity: string }>(
          "SELECT identity FROM warehouse_reprint_local_boxes ORDER BY identity",
        )
      ).map((row) => row.identity),
    ).toEqual(
      [
        i.source.identity,
        "conflict",
        "denied",
        "foreign",
        "fresh",
        "outbox",
        "shift-close",
        "unsynced",
      ].sort(),
    );
    expect(
      (
        await exec.all<{ value_json: string }>(
          "SELECT value_json FROM warehouse_reprint_local_boxes WHERE identity=?",
          [i.source.identity],
        )
      )[0]?.value_json,
    ).toBe(JSON.stringify({ ...i.source, sourceId: i.source.identity, sourceShiftId: "shift" }));
    db.close();
    const restarted = openFileDatabase(path);
    try {
      const reopened = makeRotatingExec([restarted, restarted]);
      await applyMigrations(reopened);
      await purgeWarehouseJobs(reopened, i.owner, before);
      expect(
        await reopened.all(
          "SELECT identity FROM warehouse_reprint_local_boxes WHERE identity='unsynced'",
        ),
      ).toHaveLength(1);
    } finally {
      restarted.close();
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("removes unused legacy lookups while preserving retained jobs, templates and unrecovered local evidence", async () => {
  const folder = mkdtempSync(join(tmpdir(), "warehouse-legacy-retention-"));
  const db = openFileDatabase(join(folder, "warehouse.sqlite"));
  const exec = makeRotatingExec([db, db]);
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
    for (const identity of ["ordinary", "recovered", "unrecovered", i.source.identity])
      await exec.run(
        "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'box',?,'{}')",
        [i.owner, identity],
      );
    await exec.run(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'unit','unit','{}'),(?,'templates','all','{}'),('other','box','foreign','{}')",
      [i.owner, i.owner],
    );
    for (const identity of ["recovered", "unrecovered"])
      await exec.run(
        "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,'shift',?,'2020-01-01','2020-01-02')",
        [identity, identity],
      );
    await exec.run(
      "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json) VALUES(?,'recovered','{}')",
      [i.owner],
    );
    await purgeWarehouseJobs(exec, i.owner, "2026-10-01");
    expect(
      (
        await exec.all<{ identity: string }>(
          "SELECT identity FROM warehouse_reprint_cache ORDER BY identity",
        )
      ).map((row) => row.identity),
    ).toEqual([i.source.identity, "all", "foreign", "unrecovered"].sort());
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("expires repack snapshots only after accepted closure and protects pending channels and pinned requests", async () => {
  const folder = mkdtempSync(join(tmpdir(), "warehouse-repack-retention-"));
  const db = openFileDatabase(join(folder, "warehouse.sqlite"));
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  try {
    for (const identity of [
      "accepted",
      "pending",
      "rejected",
      "outbox",
      "pinned",
      "failed-print",
    ]) {
      const source = {
        ...i.source,
        sourceId: identity,
        sourceShiftId: null,
        identity,
        fields: { ...i.source.fields, sscc: identity },
      };
      await exec.run(
        "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json,cached_at) VALUES(?,?,?,'2020-01-01')",
        [i.owner, identity, JSON.stringify(source)],
      );
      await exec.run(
        "INSERT INTO inventory_repack_boxes_mirror(inventory_id,snapshot_id,box_id,new_sscc,owner_device_id,capacity,production_date,state,print_state,opened_at,closed_at,updated_at,closed_event_id) VALUES(?,'snapshot',?,?,'device',10,'2020-01-01','closed',?,'2020-01-01','2020-01-02','2020-01-02',?)",
        [
          identity,
          identity,
          identity,
          identity === "failed-print" ? "failed" : "printed",
          identity,
        ],
      );
      await exec.run(
        "INSERT INTO inventory_scan_events_mirror(inventory_id,snapshot_id,event_id,device_id,device_sequence,operator_id,scanned_at,kind,normalized_identity,local_verdict,commit_state,legacy_audit_version,authoritative_verdict) VALUES(?,'snapshot',?,'device',1,'operator','2020-01-02','box',?,'expected','committed',1,?)",
        [
          identity,
          identity,
          identity,
          identity === "pending" ? null : identity === "rejected" ? "rejected" : "accepted",
        ],
      );
    }
    await exec.run(
      "INSERT INTO inventory_outbox(inventory_id,snapshot_id,event_id,device_sequence,payload_json,created_at) VALUES('outbox','snapshot','outbox',1,'{}','2020-01-02')",
    );
    await exec.run(
      "INSERT INTO station_meta(key,value) VALUES('inventory_sync_batch_v1:pinned:snapshot','{}')",
    );
    await purgeWarehouseJobs(exec, i.owner, "2026-10-01");
    expect(
      (
        await exec.all<{ identity: string }>(
          "SELECT identity FROM warehouse_reprint_local_boxes ORDER BY identity",
        )
      ).map((row) => row.identity),
    ).toEqual(["failed-print", "outbox", "pending", "pinned", "rejected"]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
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
    ).toHaveLength(0);
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
