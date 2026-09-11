import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import { stationDeviceOwners, stationDeviceRecovery } from "../src/sqlite/schema.js";
describe("durable Station recovery migration", () => {
  it("appends repeatable singleton and credential association DDL without secrets", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const statement of STATION_MIGRATIONS) {
        try {
          db.exec(statement);
        } catch (error) {
          if (!String(error).includes("duplicate column name")) throw error;
        }
      }
      const index = STATION_MIGRATIONS.findIndex((sql) =>
        sql.includes("CREATE TABLE IF NOT EXISTS station_device_recovery"),
      );
      for (const statement of STATION_MIGRATIONS.slice(index)) db.exec(statement);
      expect(getTableName(stationDeviceRecovery)).toBe("station_device_recovery");
      expect(getTableName(stationDeviceOwners)).toBe("station_device_owners");
      expect(
        db
          .prepare("PRAGMA table_info(station_device_recovery)")
          .all()
          .map((row) => row.name),
      ).toEqual(["id", "machine_id", "owner_json", "phase", "active_hash", "candidate_hash"]);
      db.prepare(
        "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,'local','owner','active','hash-a')",
      ).run();
      expect(db.prepare("SELECT * FROM station_device_owners").all()).toEqual([
        { credential_hash: "hash-a", owner_json: "owner" },
      ]);
      expect(() =>
        db.exec(
          "INSERT INTO station_device_recovery(id,machine_id,phase) VALUES(2,'other','active')",
        ),
      ).toThrow();
      db.exec("UPDATE station_device_recovery SET phase='restoring',candidate_hash='hash-b'");
      expect(db.prepare("SELECT COUNT(*) AS count FROM station_device_owners").get()?.count).toBe(
        1,
      );
      db.exec(
        "UPDATE station_device_recovery SET phase='active',active_hash=candidate_hash,candidate_hash=NULL",
      );
      expect(
        db.prepare("SELECT * FROM station_device_owners ORDER BY credential_hash").all(),
      ).toEqual([
        { credential_hash: "hash-a", owner_json: "owner" },
        { credential_hash: "hash-b", owner_json: "owner" },
      ]);
    } finally {
      db.close();
    }
  });
});
