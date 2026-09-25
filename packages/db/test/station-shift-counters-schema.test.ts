import { DatabaseSync } from "node:sqlite";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import * as sqliteSchema from "../src/sqlite/schema.js";

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const statement of STATION_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return db;
}

describe("station shift counter indexes", () => {
  it("installs both indexes idempotently", () => {
    const db = migrated();
    for (const statement of STATION_MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
    const names = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
    expect(names("scan_events_mirror")).toContain("scan_events_mirror_shift_verdict_idx");
    expect(names("codes_mirror")).toContain("codes_mirror_shift_idx");
  });

  it("answers the per-shift journal counts from the covering index", () => {
    const db = migrated();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT SUM(CASE WHEN verdict = 'duplicate' THEN 1 ELSE 0 END) FROM scan_events_mirror WHERE shift_id = ?",
      )
      .all("s1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "COVERING INDEX scan_events_mirror_shift_verdict_idx",
    );
  });

  it("declares the indexes in the Drizzle SQLite schema for parity", () => {
    expect(
      getSqliteTableConfig(sqliteSchema.scanEventsMirror).indexes.map((item) => item.config.name),
    ).toContain("scan_events_mirror_shift_verdict_idx");
    expect(
      getSqliteTableConfig(sqliteSchema.codesMirror).indexes.map((item) => item.config.name),
    ).toContain("codes_mirror_shift_idx");
  });
});
