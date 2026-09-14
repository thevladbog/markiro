import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it } from "vitest";

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

describe("offline grant credential recovery", () => {
  it("clears admission eligibility at sealing while retaining signed history and decisions", () => {
    const db = database();
    db.exec(`
      INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash)
      VALUES(1,'machine','{}','active','credential');
      INSERT INTO offline_grant_install_state(id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
      VALUES(1,'tenant','device','station',2,1,'strict');
      INSERT INTO offline_grant_clock(id,server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms)
      VALUES(1,100,10,'boot',100,100);
      INSERT INTO offline_grant_grants(grant_id,kid,compact,grant_json,credential_epoch,installed_sequence)
      VALUES('grant','kid','a.b.c','{}',2,1);
      INSERT INTO offline_grant_decisions(event_id,event_digest,decision_json,result_json)
      VALUES('event','digest','{"allow":true}','{"stored":true}');
      INSERT INTO offline_grant_readiness_outbox
        (request_id,state_key,body_json,credential_ownership,attempts)
      VALUES('11111111-1111-4111-8111-111111111111','state','{}','credential',1);
      UPDATE station_device_recovery SET phase='sealing' WHERE id=1;
    `);
    expect(db.prepare("SELECT count(*) AS count FROM offline_grant_install_state").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM offline_grant_clock").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM offline_grant_grants").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT count(*) AS count FROM offline_grant_decisions").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT cancelled_at IS NOT NULL AS cancelled FROM offline_grant_readiness_outbox")
        .get(),
    ).toEqual({ cancelled: 1 });
  });
});
