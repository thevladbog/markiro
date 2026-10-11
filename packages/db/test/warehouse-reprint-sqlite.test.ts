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
        "warehouse_reprint_history_acknowledgements",
        "warehouse_reprint_jobs",
        "warehouse_reprint_local_boxes",
        "warehouse_reprint_session_closures",
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
  it("upgrades an old cleanup trigger and adds the numeric product group without rebuilding jobs", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const upgrade = STATION_MIGRATIONS.findIndex((sql) =>
        sql.startsWith("ALTER TABLE product_mirror ADD COLUMN chz_product_group_code"),
      );
      for (const statement of STATION_MIGRATIONS.slice(0, upgrade)) {
        try {
          db.exec(statement);
        } catch (error) {
          if (!(error instanceof Error && /duplicate column name/i.test(error.message)))
            throw error;
        }
      }
      db.exec(
        "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES('owner','session','operator','paused','{}')",
      );
      for (const statement of STATION_MIGRATIONS.slice(upgrade)) db.exec(statement);
      expect(db.prepare("SELECT session_id FROM warehouse_reprint_sessions").all()).toEqual([
        { session_id: "session" },
      ]);
      const columns = db.prepare("PRAGMA table_info(product_mirror)").all();
      expect(columns.find((c) => c.name === "chz_product_group_code")).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(() =>
        db.exec(
          "INSERT INTO product_mirror(id,gtin14,name,status,chz_product_group_code) VALUES('p','04600682000013','Unit','active',15)",
        ),
      ).not.toThrow();
      expect(() => db.exec("UPDATE product_mirror SET chz_product_group_code=-1")).toThrow(/CHECK/);
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name='warehouse_reprint_safe_cleanup'")
          .get()?.sql,
      ).toContain("OLD.state NOT IN ('sent','verified')");
    } finally {
      db.close();
    }
  });
});
