import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

describe("warehouse reprint runtime SQLite", () => {
  it("adds durable state without changing historical migrations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const statement of STATION_MIGRATIONS) {
        try {
          db.exec(statement);
        } catch (error) {
          if (!(error instanceof Error && /duplicate column name/i.test(error.message)))
            throw error;
        }
      }
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'warehouse_reprint_%' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(names).toEqual([
        "warehouse_reprint_attempts",
        "warehouse_reprint_cache",
        "warehouse_reprint_commands",
        "warehouse_reprint_events",
        "warehouse_reprint_jobs",
        "warehouse_reprint_sessions",
      ]);
      expect(() =>
        db
          .prepare(
            "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES('owner','session','operator','active','broken')",
          )
          .run(),
      ).toThrow(/CHECK constraint/);
    } finally {
      db.close();
    }
  });
});
