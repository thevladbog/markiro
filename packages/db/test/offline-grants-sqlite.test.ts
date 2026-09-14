import { DatabaseSync } from "node:sqlite";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assessClock } from "@markiro/domain";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import {
  offlineGrantClock,
  offlineGrantBoxCloseCommands,
  offlineGrantConfiguration,
  offlineGrantConfigurationCommands,
  offlineGrantConsumption,
  offlineGrantDecisions,
  offlineGrantEventCommands,
  offlineGrantEventEvidence,
  offlineGrantEvidenceCommitGuards,
  offlineGrantInventoryLeaveIntents,
  offlineGrantInventoryLeaveCommands,
  offlineGrantInventoryLeaveAckCommands,
  offlineGrantGrants,
  offlineGrantInstallCommands,
  offlineGrantKeysetCommands,
  offlineGrantInstallState,
  offlineGrantKeysets,
  offlineGrantPalletCloseCommands,
  offlineGrantReadinessOutbox,
  offlineGrantRetiredKids,
  offlineGrantScanCommands,
  offlineGrantSnapshots,
  offlineGrantTaskAdmissionCommands,
  offlineGrantTaskAdmissions,
} from "../src/sqlite/schema.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return db;
}

describe("offline grant SQLite ledger", () => {
  it("exports every authoritative offline grant table from the Drizzle schema", () => {
    expect(
      [
        offlineGrantBoxCloseCommands,
        offlineGrantClock,
        offlineGrantConfiguration,
        offlineGrantConfigurationCommands,
        offlineGrantConsumption,
        offlineGrantDecisions,
        offlineGrantEventCommands,
        offlineGrantEventEvidence,
        offlineGrantEvidenceCommitGuards,
        offlineGrantGrants,
        offlineGrantInstallCommands,
        offlineGrantKeysetCommands,
        offlineGrantInstallState,
        offlineGrantInventoryLeaveAckCommands,
        offlineGrantInventoryLeaveCommands,
        offlineGrantInventoryLeaveIntents,
        offlineGrantKeysets,
        offlineGrantPalletCloseCommands,
        offlineGrantReadinessOutbox,
        offlineGrantRetiredKids,
        offlineGrantScanCommands,
        offlineGrantSnapshots,
        offlineGrantTaskAdmissionCommands,
        offlineGrantTaskAdmissions,
      ].map(getTableName),
    ).toEqual([
      "offline_grant_box_close_commands",
      "offline_grant_clock",
      "offline_grant_configuration",
      "offline_grant_configuration_commands",
      "offline_grant_consumption",
      "offline_grant_decisions",
      "offline_grant_event_commands",
      "offline_grant_event_evidence",
      "offline_grant_evidence_commit_guards",
      "offline_grant_grants",
      "offline_grant_install_commands",
      "offline_grant_keyset_commands",
      "offline_grant_install_state",
      "offline_grant_inventory_leave_ack_commands",
      "offline_grant_inventory_leave_commands",
      "offline_grant_inventory_leave_intents",
      "offline_grant_keysets",
      "offline_grant_pallet_close_commands",
      "offline_grant_readiness_outbox",
      "offline_grant_retired_kids",
      "offline_grant_scan_commands",
      "offline_grant_snapshots",
      "offline_grant_task_admission_commands",
      "offline_grant_task_admissions",
    ]);
  });

  it("installs immutable grants, snapshots, clock, consumption and decisions", () => {
    const db = database();
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'offline_grant_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "offline_grant_box_close_commands",
      "offline_grant_clock",
      "offline_grant_configuration",
      "offline_grant_configuration_commands",
      "offline_grant_consumption",
      "offline_grant_decisions",
      "offline_grant_event_commands",
      "offline_grant_event_evidence",
      "offline_grant_evidence_commit_guards",
      "offline_grant_grants",
      "offline_grant_install_commands",
      "offline_grant_install_state",
      "offline_grant_inventory_leave_ack_commands",
      "offline_grant_inventory_leave_commands",
      "offline_grant_inventory_leave_intents",
      "offline_grant_keyset_commands",
      "offline_grant_keysets",
      "offline_grant_pallet_close_commands",
      "offline_grant_readiness_outbox",
      "offline_grant_retired_kids",
      "offline_grant_scan_commands",
      "offline_grant_snapshots",
      "offline_grant_task_admission_commands",
      "offline_grant_task_admissions",
    ]);
  });

  it("keeps consumption identity independent of renewed grant id and replays one event once", () => {
    const db = database();
    const insert = db.prepare(`INSERT INTO offline_grant_consumption
      (tenant_id,device_id,credential_epoch,task_kind,task_id,snapshot_digest,budget_line_id,consumed)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET consumed=consumed+excluded.consumed`);
    const key = ["t", "d", 2, "shift", "task", "digest", "units"];
    insert.run(...key, 2);
    insert.run("t", "d", 3, "shift", "task", "digest", "units", 3);
    expect(db.prepare("SELECT consumed FROM offline_grant_consumption").get()).toEqual({
      consumed: 5,
    });
    db.prepare(
      `INSERT INTO offline_grant_decisions(event_id,event_digest,decision_json,result_json) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
    ).run("event", "digest", '{"allow":true}', '{"stored":true}');
    db.prepare(
      `INSERT INTO offline_grant_decisions(event_id,event_digest,decision_json,result_json) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
    ).run("event", "changed", '{"allow":false}', '{"stored":false}');
    expect(
      db.prepare("SELECT decision_json FROM offline_grant_decisions WHERE event_id='event'").get(),
    ).toEqual({ decision_json: '{"allow":true}' });
  });

  it("publishes one install atomically, rejects stale races, and accumulates retirement tombstones", () => {
    const db = database();
    const command = db.prepare(
      "INSERT INTO offline_grant_install_commands(request_sequence,payload_json) VALUES(?,?)",
    );
    const payload = (
      mode: string,
      retiredKids: string[],
      grantJson = '{"ok":true}',
      grantId = "g",
    ) =>
      JSON.stringify({
        owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 2 },
        mode,
        keyset: {
          origin: "https://api.example",
          revision: "opaque",
          json: '{"keys":[]}',
          retiredKids,
        },
        grants: [
          {
            grantId,
            kid: "active",
            compact: `${grantId}.b.c`,
            json: grantJson,
            credentialEpoch: 2,
          },
        ],
        snapshots: [],
        clock: { serverMs: 10, monotonicMs: 4, bootId: "boot", wallMs: 20 },
      });
    command.run(2, payload("observe", ["old"]));
    expect(() => command.run(1, payload("strict", []))).toThrow(/OFFLINE_GRANT_STALE_INSTALL/);
    expect(
      db.prepare("SELECT mode,request_sequence FROM offline_grant_install_state").get(),
    ).toEqual({ mode: "observe", request_sequence: 2 });
    command.run(3, payload("strict", ["older"]));
    expect(db.prepare("SELECT kid FROM offline_grant_retired_kids ORDER BY kid").all()).toEqual([
      { kid: "old" },
      { kid: "older" },
    ]);
    expect(() => command.run(4, payload("strict", [], "not-json", "broken"))).toThrow();
    expect(db.prepare("SELECT request_sequence FROM offline_grant_install_state").get()).toEqual({
      request_sequence: 3,
    });
    const olderEpoch = JSON.parse(payload("strict", []));
    olderEpoch.owner.credentialEpoch = 1;
    expect(() => command.run(5, JSON.stringify(olderEpoch))).toThrow(/OFFLINE_GRANT_STALE_EPOCH/);
    expect(db.prepare("SELECT credential_epoch FROM offline_grant_install_state").get()).toEqual({
      credential_epoch: 2,
    });
  });

  it("keeps strict on missing policy and permits only an approved configuration to roll back", () => {
    const db = database();
    db.exec(`INSERT INTO offline_grant_install_state(id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
      VALUES(1,'t','d','station',2,1,'strict');
      INSERT INTO offline_grant_clock(id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
      VALUES(1,100,10,'boot',100,200);`);
    const command = db.prepare(
      "INSERT INTO offline_grant_configuration_commands(request_sequence,payload_json) VALUES(?,?)",
    );
    const payload = (mode: string, policyRevision: string | null) =>
      JSON.stringify({
        owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 2 },
        mode,
        policyRevision,
        serverTime: 110,
        keyset: null,
        clock: { monotonicMs: 20, bootId: "boot", wallMs: 150 },
      });
    command.run(2, payload("observe", null));
    expect(
      db.prepare("SELECT mode,policy_revision FROM offline_grant_configuration").get(),
    ).toEqual({ mode: "strict", policy_revision: null });
    expect(db.prepare("SELECT mode FROM offline_grant_install_state").get()).toEqual({
      mode: "strict",
    });
    command.run(3, payload("observe", "approved-r1"));
    expect(
      db.prepare("SELECT mode,policy_revision FROM offline_grant_configuration").get(),
    ).toEqual({ mode: "observe", policy_revision: "approved-r1" });
    expect(db.prepare("SELECT mode FROM offline_grant_install_state").get()).toEqual({
      mode: "observe",
    });
    expect(
      db.prepare("SELECT wall_high_water_ms,high_water_ms FROM offline_grant_clock").get(),
    ).toEqual({ wall_high_water_ms: 150, high_water_ms: 110 });
  });

  it("resets the local-wall baseline on authenticated resync without resetting server high-water or allowance", () => {
    const db = database();
    const command = db.prepare(
      "INSERT INTO offline_grant_install_commands(request_sequence,payload_json) VALUES(?,?)",
    );
    const payload = (serverMs: number, monotonicMs: number, wallMs: number) =>
      JSON.stringify({
        owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 2 },
        mode: "strict",
        keyset: {
          origin: "https://api.example",
          revision: "r",
          json: '{"keys":[]}',
          retiredKids: [],
        },
        grants: [],
        snapshots: [],
        clock: { serverMs, monotonicMs, bootId: "boot", wallMs },
      });
    command.run(1, payload(100, 10, 10_000));
    db.prepare(
      `INSERT INTO offline_grant_consumption
      (tenant_id,device_id,credential_epoch,task_kind,task_id,snapshot_digest,budget_line_id,consumed)
      VALUES ('t','d',2,'shift','task','digest','units',3)`,
    ).run();
    db.prepare("UPDATE offline_grant_clock SET high_water_ms=150 WHERE id=1").run();
    command.run(2, payload(160, 20, 500));
    expect(
      db
        .prepare("SELECT server_ms,high_water_ms,wall_high_water_ms FROM offline_grant_clock")
        .get(),
    ).toEqual({
      server_ms: 160,
      high_water_ms: 160,
      wall_high_water_ms: 500,
    });
    expect(db.prepare("SELECT consumed FROM offline_grant_consumption").get()).toEqual({
      consumed: 3,
    });
    expect(
      assessClock(
        { serverMs: 160, monotonicMs: 20, bootId: "boot", highWaterMs: 160, wallHighWaterMs: 500 },
        { monotonicMs: 21, bootId: "boot", wallMs: 501 },
      ),
    ).toEqual({ trusted: true, now: 161 });
  });

  it("atomically gives the final budget unit to one event and denies the racer", () => {
    const db = database();
    db.prepare(
      `INSERT INTO offline_grant_install_state
      (id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
      VALUES (1,'t','d','station',2,1,'strict')`,
    ).run();
    db.prepare(
      `INSERT INTO offline_grant_clock
      (id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
      VALUES (1,100,10,'boot',100,200)`,
    ).run();
    db.prepare(
      `INSERT INTO offline_grant_grants
      (grant_id,kid,compact,grant_json,credential_epoch,installed_sequence) VALUES (?,?,?,?,?,?)`,
    ).run(
      "grant",
      "kid",
      "a.b.c",
      JSON.stringify({ budget: [{ id: "shift.scan.v1:units", maximum: 1 }] }),
      2,
      1,
    );
    db.exec(`INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active)
      VALUES ('operator','Operator','operator','hash',1);
      INSERT INTO shift_mirror(id,status,mode,product_id,execution_scope_json)
      VALUES ('task','active','aggregation','product','{"shift":{"counterpartyName":null},"product":{}}');`);
    const executionScope = { shift: { counterpartyName: null }, product: {} };
    const payload = (eventDigest: string) =>
      JSON.stringify({
        owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 2 },
        mode: "strict",
        grantId: "grant",
        taskKind: "shift",
        taskId: "task",
        snapshotDigest: "snapshot",
        eventDigest,
        operatorId: "operator",
        executionScope,
        preDecision: { allow: true },
        cost: { "shift.scan.v1:units": 1 },
        clockHighWater: 101,
        wallHighWater: 201,
        resultJson: JSON.stringify({ stored: true }),
      });
    const command = db.prepare(
      "INSERT INTO offline_grant_event_commands(event_id,payload_json) VALUES(?,?)",
    );
    command.run("winner", payload("winner-digest"));
    command.run("loser", payload("loser-digest"));
    expect(db.prepare("SELECT consumed FROM offline_grant_consumption").get()).toEqual({
      consumed: 1,
    });
    expect(
      db
        .prepare("SELECT event_id,decision_json FROM offline_grant_decisions ORDER BY event_id")
        .all(),
    ).toEqual([
      {
        event_id: "loser",
        decision_json: '{"allow":false,"reason":"budget_exhausted","mode":"strict"}',
      },
      { event_id: "winner", decision_json: '{"allow":true,"reason":null,"mode":"strict"}' },
    ]);
  });
});
