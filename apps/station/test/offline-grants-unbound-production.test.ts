import { upsertBundle } from "../src/lib/mirror.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { recordProductLabelAcceptanceWithOfflineGrant } from "../src/lib/product-labels/acceptance.js";
import { restoreProductLabelWork } from "../src/lib/product-labels/recovery.js";
import { requireProductLabelJob } from "../src/lib/product-labels/store.js";
import { recordScanWithOfflineGrant } from "../src/lib/journal.js";
import { closeShiftOfflineWithGrant } from "../src/lib/shift-close.js";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { SqlExecutor } from "../src/lib/mirror.js";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

/** A station that received grant configuration but was never given a task grant. */
async function fixture(mode: "observe" | "strict") {
  const generation = createCredentialGeneration("test-label-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("missing owner");
  const h = await openProductLabelWork("required", owner, false);
  cleanups.push(() => h.close());
  const [file] = await h.exec.all<{ file: string }>("PRAGMA database_list");
  if (!file) throw new Error("missing SQLite fixture");
  const held = new DatabaseSync(file.file);
  cleanups.push(() => held.close());
  const exec = {
    ...h.exec,
    async atomic(statements: readonly { sql: string; values?: readonly unknown[] }[]) {
      held.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map((s) =>
          Number(held.prepare(s.sql).run(...((s.values ?? []) as never[])).changes),
        );
        held.exec("COMMIT");
        return changes;
      } catch (error) {
        held.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const value = h.input;
  const shift = {
    id: value.shiftId,
    productId: "product",
    mode: "validation",
    lineId: null,
    counterpartyId: null,
    counterpartyName: null,
    labelTemplateId: null,
    boxLabelTemplateId: null,
    palletLabelTemplateId: null,
    validationPrintMode: value.policy.mode,
    allowPreviouslyAcceptedCodes: false,
    validationPrintVerification: value.policy.verification,
    validationPrintTemplateId: value.policy.templateId,
    validationPrintSnapshot: value.policy.snapshot,
    validationPrintPolicyRevision: value.policy.policyRevision,
    boxCapacity: null,
    palletsEnabled: false,
    palletBoxCapacity: null,
    stationClosePolicy: null,
    stationCloseOwnerDeviceId: null,
    plannedDate: "2026-09-08",
    productionDate: "2026-09-08",
    number: value.fields["shift.no"],
  };
  await upsertBundle(exec, {
    shift: {
      ...shift,
      status: "active",
      productName: value.fields["product.name"],
      lineName: null,
      labelTemplateName: null,
      plannedQty: 20,
      openedAt: value.acceptedAt,
      validationPrint: value.policy,
      ssccIssuerCounterpartyId: null,
      createdFrom: "admin",
    },
    product: {
      id: "product",
      gtin14: value.gtin14,
      name: value.fields["product.name"],
      printName: null,
      egaisCode: null,
      shelfLifeDays: 30,
      productGroup: null,
      boxCapacity: null,
      palletBoxCapacity: null,
      status: "active",
      defaultCounterpartyId: null,
      defaultLabelTemplateId: null,
    },
    labelTemplate: null,
    boxLabelTemplate: null,
    palletLabelTemplate: null,
    counterpartyGln: null,
    operators: [],
    sscc: null,
  });
  await exec.run(
    "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,?,?,?,1)",
    [value.operatorId, "Operator", "operator", "hash"],
  );
  // Exactly what the grant configuration receipt installs: owner + mode, no
  // grants and no policy revision.
  await exec.run("INSERT INTO offline_grant_install_state VALUES(1,?,?,?,1,1,?)", [
    "tenant",
    value.deviceId,
    "station",
    mode,
  ]);
  await exec.run("INSERT INTO offline_grant_clock VALUES(1,100,10,'boot',100,200)");
  return { exec, value, generation };
}

describe("production on a station that cannot bind its shift", () => {
  it("accepts a scan while grant state exists but no task grant does", async () => {
    const f = await fixture("observe");

    const result = await recordProductLabelAcceptanceWithOfflineGrant(
      f.exec,
      f.value,
      f.generation,
      async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
    );

    expect(result).toEqual({ status: "accepted", jobId: f.value.jobId });

    // What refresh() does right after acceptance, and what the screen calls
    // "restoring the job".
    const job = await requireProductLabelJob(f.exec, f.value.credentialOwnership, f.value.jobId);
    expect(job.jobId).toBe(f.value.jobId);
    const restored = await restoreProductLabelWork(f.exec, f.value.credentialOwnership, {
      operatorId: f.value.operatorId,
      newId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    });
    expect(restored?.jobId).toBe(f.value.jobId);
  });

  it("keeps accepting product labels in observe mode without an execution projection", async () => {
    const f = await fixture("observe");
    // What a station looks like when the bundle mirror never wrote a scope:
    // entry itself now proceeds in observe, and production must follow.
    await f.exec.run("UPDATE shift_mirror SET execution_scope_json=NULL WHERE id=?", [
      f.value.shiftId,
    ]);

    await expect(
      recordProductLabelAcceptanceWithOfflineGrant(f.exec, f.value, f.generation, async () => ({
        bootId: "boot",
        monotonicMs: 11,
        wallMs: 201,
      })),
    ).resolves.toEqual({ status: "accepted", jobId: f.value.jobId });
    const restored = await restoreProductLabelWork(f.exec, f.value.credentialOwnership, {
      operatorId: f.value.operatorId,
      newId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    });
    expect(restored?.jobId).toBe(f.value.jobId);
  });

  it("refuses an unbound product label in strict mode", async () => {
    const f = await fixture("strict");
    await f.exec.run("UPDATE shift_mirror SET execution_scope_json=NULL WHERE id=?", [
      f.value.shiftId,
    ]);

    await expect(
      recordProductLabelAcceptanceWithOfflineGrant(f.exec, f.value, f.generation, async () => ({
        bootId: "boot",
        monotonicMs: 11,
        wallMs: 201,
      })),
    ).rejects.toThrow("offline grant active shift requires a fresh bundle");
  });

  it("keeps journalling scans in observe mode without an execution projection", async () => {
    const f = await fixture("observe");
    await f.exec.run("UPDATE shift_mirror SET execution_scope_json=NULL WHERE id=?", [
      f.value.shiftId,
    ]);

    await recordScanWithOfflineGrant(
      f.exec,
      {
        eventId: crypto.randomUUID(),
        shiftId: f.value.shiftId,
        terminalId: f.value.terminalId,
        raw: f.value.raw,
        verdict: "duplicate",
        scannedAt: f.value.acceptedAt,
        operatorId: f.value.operatorId,
      },
      null,
      f.generation,
      async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
    );

    const [journalled] = await f.exec.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scan_events_mirror WHERE shift_id=?",
      [f.value.shiftId],
    );
    expect(journalled?.n).toBe(1);
  });

  it("refuses an unbound scan in strict mode", async () => {
    const f = await fixture("strict");
    await f.exec.run("UPDATE shift_mirror SET execution_scope_json=NULL WHERE id=?", [
      f.value.shiftId,
    ]);

    await expect(
      recordScanWithOfflineGrant(
        f.exec,
        {
          eventId: crypto.randomUUID(),
          shiftId: f.value.shiftId,
          terminalId: f.value.terminalId,
          raw: f.value.raw,
          verdict: "duplicate",
          scannedAt: f.value.acceptedAt,
          operatorId: f.value.operatorId,
        },
        null,
        f.generation,
        async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
      ),
    ).rejects.toThrow("offline grant active shift requires a fresh bundle");
  });
});

/** A plain station DB: active shift, active operator, grant state, no scope. */
function unboundShift(mode: "observe" | "strict") {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  db.prepare(
    "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,?,?,?,1)",
  ).run("operator", "Operator", "operator", "hash");
  db.prepare(
    "INSERT INTO shift_mirror(id,status,mode,product_id,planned_qty) VALUES(?,?,?,?,?)",
  ).run("shift", "active", "aggregation", "product", 0);
  db.exec(`INSERT INTO offline_grant_install_state(id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
    VALUES(1,'tenant','device','station',1,1,'${mode}');
    INSERT INTO offline_grant_clock(id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
    VALUES(1,100,10,'boot',100,200);`);
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  cleanups.push(() => db.close());
  return { db, exec, generation: createCredentialGeneration("close-secret") };
}

describe("closing a shift a station cannot bind", () => {
  it("closes through the ungranted path in observe mode", async () => {
    const f = unboundShift("observe");

    const closed = await closeShiftOfflineWithGrant(
      f.exec,
      { shiftId: "shift", deviceId: "device", operatorId: "operator" },
      f.generation,
      () => new Date("2026-09-21T01:00:00.000Z"),
      async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
    );

    expect(closed).toEqual(expect.objectContaining({ shiftId: "shift" }));
    expect(f.db.prepare("SELECT status FROM shift_mirror WHERE id='shift'").get()).toEqual({
      status: "closed",
    });
  });

  it("refuses to close an unbound shift in strict mode", async () => {
    const f = unboundShift("strict");

    await expect(
      closeShiftOfflineWithGrant(
        f.exec,
        { shiftId: "shift", deviceId: "device", operatorId: "operator" },
        f.generation,
        () => new Date("2026-09-21T01:00:00.000Z"),
        async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
      ),
    ).rejects.toThrow("offline grant active shift requires a fresh bundle");
  });
});
