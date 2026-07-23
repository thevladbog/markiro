import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) db.exec(stmt);
  return db;
}

describe("STATION_MIGRATIONS", () => {
  it("creates all six mirror tables", () => {
    const db = migratedDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("station_meta");
    expect(names).toContain("operators_mirror");
    expect(names).toContain("shift_mirror");
    expect(names).toContain("product_mirror");
    expect(names).toContain("codes_mirror");
    expect(names).toContain("scan_events_mirror");
  });

  it("round-trips an operators_mirror row with a nullable badge_hash", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("op_1", "Ivan", "operator", "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==", null, 1);

    const row = db
      .prepare(
        "SELECT operator_id, name, badge_hash, active FROM operators_mirror WHERE operator_id = ?",
      )
      .get("op_1") as {
      operator_id: string;
      name: string;
      badge_hash: string | null;
      active: number;
    };

    expect(row).toEqual({ operator_id: "op_1", name: "Ivan", badge_hash: null, active: 1 });
  });
});
