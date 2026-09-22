import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it } from "vitest";
import { StationGrantAdmission } from "../src/lib/offline-grants/admission.js";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

function fixture(mode: "observe" | "strict") {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  db.exec(`INSERT INTO offline_grant_install_state
    (id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
    VALUES (1,'tenant','device','station',3,1,'${mode}');
    INSERT INTO offline_grant_clock
    (id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
    VALUES (1,100,10,'boot',100,200);
    INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active)
    VALUES ('operator','Operator','operator','hash',1);
    INSERT INTO inventory_task_mirror
      (inventory_id,inventory_number,active_snapshot_id,active_combined_digest,active_content_digest,active_manifest_json)
    VALUES ('inventory','INV-1','snapshot','combined','content','{}');`);
  const exec: SqlExecutor = {
    async run(sql: string, params: unknown[] = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  return {
    db,
    admission: new StationGrantAdmission(exec, async () => ({
      bootId: "boot",
      monotonicMs: 11,
      wallMs: 201,
    })),
  };
}

const owner = {
  tenantId: "tenant",
  deviceId: "device",
  kind: "station" as const,
  credentialEpoch: 3,
};
const intent = {
  owner,
  capability: "inventory.start.v1" as const,
  taskId: "inventory",
  snapshotDigest: "digest",
  eventId: "event",
  eventType: "inventory.scan.v1" as const,
  cost: {},
};
const execution = {
  taskKind: "inventory" as const,
  taskId: "inventory",
  scope: {
    manifest: {},
    snapshotId: "snapshot",
    combinedDigest: "combined",
    contentDigest: "content",
  },
};

describe("Station offline admission", () => {
  function seedNewWorkAuthority(db: DatabaseSync) {
    const device = {
      version: 1,
      kindOfGrant: "device",
      issuer: "https://issuer.invalid",
      grantId: "device-grant",
      tenantId: "tenant",
      deviceId: "device",
      kind: "station",
      credentialEpoch: 3,
      entitlementRevision: "entitlement",
      policyRevision: "policy",
      issuedAt: 50,
      notBefore: 50,
      startNotAfter: 1_000,
      capabilities: ["inventory.start.v1"],
    };
    const task = {
      version: 1,
      kindOfGrant: "task",
      issuer: "https://issuer.invalid",
      grantId: "task-grant",
      tenantId: "tenant",
      deviceId: "device",
      kind: "station",
      credentialEpoch: 3,
      entitlementRevision: "entitlement",
      policyRevision: "policy",
      issuedAt: 50,
      notBefore: 50,
      taskKind: "inventory",
      taskId: "inventory",
      snapshotDigest: "digest",
      completeNotAfter: 2_000,
      eventTypes: ["inventory.scan.v1"],
      budget: [{ id: "inventory.scan.v1:events", unit: "event", maximum: 1 }],
    };
    db.exec(`INSERT INTO offline_grant_configuration
      (id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode,policy_revision)
      VALUES(1,'tenant','device','station',3,1,'strict','policy')`);
    const insertGrant = db.prepare(
      "INSERT INTO offline_grant_grants(grant_id,kid,compact,grant_json,credential_epoch,installed_sequence) VALUES(?,?,?,?,?,?)",
    );
    insertGrant.run("device-grant", "kid", "device", JSON.stringify(device), 3, 1);
    insertGrant.run("task-grant", "kid", "task", JSON.stringify(task), 3, 1);
    db.prepare(
      "INSERT INTO offline_grant_snapshots(task_kind,task_id,snapshot_digest,canonical,scope_json,installed_sequence) VALUES(?,?,?,?,?,?)",
    ).run("inventory", "inventory", "digest", "canonical", JSON.stringify(execution.scope), 1);
  }

  it.each(["observe", "strict"] as const)(
    "retains grants but refuses every productive admission during %s evidence recovery",
    async (mode) => {
      const state = fixture(mode);
      seedNewWorkAuthority(state.db);
      state.db.prepare("UPDATE offline_grant_configuration SET mode=?").run(mode);
      state.db.prepare("INSERT INTO station_meta(key,value) VALUES(?,?)").run(
        "replacement_evidence_recovery_v1",
        JSON.stringify({
          tenantId: "tenant",
          deviceId: "device",
          serverOrigin: "https://factory.invalid",
          credentialOwnership: "hash",
          recovery: {
            version: 1,
            purpose: "replacement_evidence_recovery",
            operatorRoster: "preserve_sealed" as const,
            executionId: crypto.randomUUID(),
            intentId: crypto.randomUUID(),
            credentialEpoch: 4,
            requestedAt: "2026-09-17T00:00:00Z",
            expiresAt: "2026-09-18T00:00:00Z",
          },
          sequence: -1,
          body: null,
          completed: false,
        }),
      );
      const denied = { allow: false, reason: "missing_grant", mode: "strict" };
      await expect(state.admission.assessNewWork(intent)).resolves.toEqual(denied);
      await expect(
        state.admission.commitNewWork(
          { intent, execution },
          createCredentialGeneration("recovery"),
        ),
      ).resolves.toEqual(denied);
      await expect(
        state.admission.assessTaskWork({
          owner,
          capability: intent.capability,
          eventType: intent.eventType,
          execution,
        }),
      ).resolves.toEqual(denied);
      const completion = {
        operatorId: "operator",
        intent,
        execution,
        event: { id: "event" },
        facts: {},
        result: { accepted: true },
      };
      await expect(state.admission.commitCompletion(completion)).resolves.toEqual({
        decision: denied,
        result: null,
        replay: false,
      });
      await expect(
        state.admission.commitCompletionPair({
          first: completion,
          second: { ...completion, intent: { ...intent, eventId: "second" } },
          ownerStatements: [],
        }),
      ).resolves.toEqual({ first: denied, second: denied, result: null });
      expect(state.db.prepare("SELECT count(*) count FROM offline_grant_grants").get()).toEqual({
        count: 2,
      });
      expect(state.db.prepare("SELECT count(*) count FROM offline_grant_decisions").get()).toEqual({
        count: 0,
      });
      state.db.close();
    },
  );

  it("durably records successful new-work admission and never marks a retired credential", async () => {
    const first = fixture("strict");
    seedNewWorkAuthority(first.db);
    const generation = createCredentialGeneration("secret");
    await expect(
      first.admission.assessTaskWork({
        owner,
        capability: "inventory.start.v1",
        eventType: "inventory.scan.v1",
        execution,
      }),
    ).resolves.toEqual({ allow: false, reason: "wrong_task", mode: "strict" });
    await expect(first.admission.commitNewWork({ intent, execution }, generation)).resolves.toEqual(
      { allow: true, mode: "strict" },
    );
    expect(
      first.db
        .prepare("SELECT task_kind,task_id,snapshot_digest FROM offline_grant_task_admissions")
        .get(),
    ).toEqual({ task_kind: "inventory", task_id: "inventory", snapshot_digest: "digest" });
    await expect(
      first.admission.assessTaskWork({
        owner,
        capability: "inventory.start.v1",
        eventType: "inventory.scan.v1",
        execution,
      }),
    ).resolves.toEqual({ allow: true, mode: "strict" });

    const retired = fixture("strict");
    seedNewWorkAuthority(retired.db);
    const retiredGeneration = createCredentialGeneration("secret");
    await sealCredentialGeneration(retiredGeneration);
    await expect(
      retired.admission.commitNewWork({ intent, execution }, retiredGeneration),
    ).rejects.toThrow(/stale credential/);
    expect(
      retired.db.prepare("SELECT count(*) count FROM offline_grant_task_admissions").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("rolls back admission when configuration ownership changes before the marker command", async () => {
    const state = fixture("strict");
    seedNewWorkAuthority(state.db);
    state.db.prepare("UPDATE offline_grant_configuration SET credential_epoch=4").run();
    await expect(
      state.admission.commitNewWork({ intent, execution }, createCredentialGeneration("secret")),
    ).rejects.toThrow(/STALE_OWNER/);
    expect(
      state.db.prepare("SELECT count(*) count FROM offline_grant_task_admissions").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("records a would-deny diagnostic while observation preserves the legacy result", async () => {
    const { admission } = fixture("observe");
    const committed = await admission.commitCompletion({
      operatorId: "operator",
      intent,
      execution,
      event: { raw: "one" },
      facts: { units: 1 },
      result: { stored: true },
    });
    expect(committed).toEqual({
      decision: { allow: true, reason: "missing_grant", mode: "observe" },
      result: { stored: true },
      replay: false,
    });
  });

  it("returns the saved result before charging and rejects altered event replay", async () => {
    const { admission } = fixture("observe");
    await admission.commitCompletion({
      operatorId: "operator",
      intent,
      execution,
      event: { raw: "one" },
      facts: { units: 1 },
      result: { stored: true },
    });
    await expect(
      admission.commitCompletion({
        operatorId: "operator",
        intent,
        execution,
        event: { raw: "one" },
        facts: { units: 99 },
        result: { stored: false },
      }),
    ).resolves.toEqual({
      decision: { allow: true, reason: "missing_grant", mode: "observe" },
      result: { stored: true },
      replay: true,
    });
    await expect(
      admission.commitCompletion({
        operatorId: "operator",
        intent,
        execution,
        event: { raw: "changed" },
        facts: { units: 1 },
        result: { stored: false },
      }),
    ).rejects.toThrow(/replay mismatch/);
  });

  it("strict mode durably denies when no grant is installed", async () => {
    const { admission } = fixture("strict");
    const committed = await admission.commitCompletion({
      operatorId: "operator",
      intent,
      execution,
      event: { raw: "one" },
      facts: { units: 1 },
      result: { stored: true },
    });
    expect(committed.decision).toEqual({ allow: false, reason: "missing_grant", mode: "strict" });
  });
});
