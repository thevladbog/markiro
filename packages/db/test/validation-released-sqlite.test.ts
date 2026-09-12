import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

describe("released validation receipt upgrade", () => {
  it("adds a false tombstone to an existing occurrence without altering saved identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const boundary = STATION_MIGRATIONS.findIndex((statement) =>
        statement.startsWith("ALTER TABLE validation_occurrences ADD COLUMN ownership_released"),
      );
      expect(boundary).toBeGreaterThan(0);
      for (const statement of STATION_MIGRATIONS.slice(0, boundary)) {
        try {
          db.exec(statement);
        } catch (error) {
          // Runtime permits only legacy ADD COLUMN collisions on a fresh schema.
          if (!(error instanceof Error) || !/duplicate column name/i.test(error.message))
            throw error;
        }
      }
      db.prepare(
        "INSERT INTO validation_occurrences(shift_id,code_hash,scanned_at,credential_ownership,terminal_id,canonical_raw) VALUES(?,?,?,?,?,?)",
      ).run(
        "shift",
        "a".repeat(64),
        "2026-09-12T08:00:00.000Z",
        "owner",
        "device",
        "raw\u001d93CRYPTO",
      );
      const before = db.prepare("SELECT * FROM validation_occurrences").get();
      for (const statement of STATION_MIGRATIONS.slice(boundary)) db.exec(statement);
      expect(db.prepare("SELECT * FROM validation_occurrences").get()).toEqual({
        ...before,
        ownership_released: 0,
      });
    } finally {
      db.close();
    }
  });
});
