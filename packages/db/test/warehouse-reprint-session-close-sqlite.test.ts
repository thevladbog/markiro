import { DatabaseSync } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import * as schema from "../src/sqlite/schema.js";

function apply(db: DatabaseSync, statements: readonly string[]) {
  for (const sql of statements) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}

it("upgrades active and paused warehouse history with durable immutable closure facts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const boundary = STATION_MIGRATIONS.findIndex((sql) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS warehouse_reprint_session_closures"),
    );
    expect(boundary).toBeGreaterThan(0);
    apply(db, STATION_MIGRATIONS.slice(0, boundary));
    db.exec(
      "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES('operator','Operator','operator','synthetic',1)",
    );
    db.exec(
      "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES('owner','active-session','operator','active','{}'),('owner','paused-session','operator','paused','{}')",
    );
    apply(db, STATION_MIGRATIONS.slice(boundary));
    db.exec(
      "INSERT INTO warehouse_reprint_session_closures(owner,session_id,operator_id,closed_at) VALUES('owner','active-session','operator','2026-10-10T00:00:00Z')",
    );
    apply(db, STATION_MIGRATIONS);
    expect(
      db
        .prepare("SELECT session_id,status FROM warehouse_reprint_sessions ORDER BY session_id")
        .all(),
    ).toEqual([
      { session_id: "active-session", status: "paused" },
      { session_id: "paused-session", status: "paused" },
    ]);
    expect(
      db
        .prepare("SELECT session_id,operator_id,closed_at FROM warehouse_reprint_session_closures")
        .all(),
    ).toEqual([
      { session_id: "active-session", operator_id: "operator", closed_at: "2026-10-10T00:00:00Z" },
    ]);
    expect(() => db.exec("DELETE FROM warehouse_reprint_session_closures")).toThrow(
      "WAREHOUSE_SESSION_CLOSED",
    );
    expect(() =>
      db.exec("UPDATE warehouse_reprint_session_closures SET closed_at='later'"),
    ).toThrow("WAREHOUSE_SESSION_CLOSED");
    db.exec(
      "CREATE TRIGGER reject_finish_pause BEFORE UPDATE OF status ON warehouse_reprint_sessions WHEN NEW.session_id='paused-session' BEGIN SELECT RAISE(ABORT,'interrupted closure'); END",
    );
    expect(() =>
      db.exec(
        "INSERT INTO warehouse_reprint_session_closures(owner,session_id,operator_id,closed_at) VALUES('owner','paused-session','operator','2026-10-10T00:01:00Z')",
      ),
    ).toThrow("interrupted closure");
    expect(db.prepare("SELECT session_id FROM warehouse_reprint_session_closures").all()).toEqual([
      { session_id: "active-session" },
    ]);
    const closure = getTableConfig(schema.warehouseReprintSessionClosures);
    expect(closure.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "owner",
      "session_id",
    ]);
    expect(closure.foreignKeys[0]?.reference().columns.map((column) => column.name)).toEqual([
      "owner",
      "session_id",
    ]);
  } finally {
    db.close();
  }
});

it.each(["prepared", "sending", "delivery_unknown", "failed_before_send"])(
  "guards a closure against %s work in another session before any fact commits",
  (state) => {
    const db = new DatabaseSync(":memory:");
    try {
      apply(db, STATION_MIGRATIONS);
      db.exec(
        "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES('operator','Operator','operator','synthetic',1)",
      );
      db.exec(
        "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES('owner','session','operator','active','{}'),('owner','other-session','operator','active','{}')",
      );
      db.prepare(
        "INSERT INTO warehouse_reprint_jobs(owner,job_id,session_id,identity,source_kind,job_json,projection_json,state,latest_sequence,attempt_id,updated_at) VALUES('owner','job','other-session','sscc','box','{}','{}',?,1,'attempt','2026-10-10T00:00:00Z')",
      ).run(state);
      expect(() =>
        db.exec(
          "INSERT INTO warehouse_reprint_session_closures(owner,session_id,operator_id,closed_at) VALUES('owner','session','operator','2026-10-10T00:00:00Z')",
        ),
      ).toThrow("WAREHOUSE_RECOVERY_REQUIRED");
      expect(db.prepare("SELECT * FROM warehouse_reprint_session_closures").all()).toEqual([]);
      expect(db.prepare("SELECT state FROM warehouse_reprint_jobs").all()).toEqual([{ state }]);
    } finally {
      db.close();
    }
  },
);
