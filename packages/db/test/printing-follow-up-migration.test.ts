import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
it("keeps original legacy raw recovery proof while future facts and reconciliation create no new raw copies", () => {
  const db = new DatabaseSync(":memory:");
  const apply = (sql: string) => {
    try {
      db.exec(sql);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
  };
  try {
    const start = STATION_MIGRATIONS.findIndex((sql) =>
      sql.startsWith("ALTER TABLE warehouse_pallet_sources ADD COLUMN production_delivery_json"),
    );
    expect(start).toBeGreaterThan(0);
    STATION_MIGRATIONS.slice(0, start).forEach(apply);
    db.prepare(
      "INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,fields_json) VALUES('owner','s',?,'old','FULL-LEGACY',?)",
    ).run("b".repeat(64), JSON.stringify({ "km.code": "FULL-LEGACY", expiry: "original" }));
    STATION_MIGRATIONS.slice(start).forEach(apply);
    expect(
      db.prepare("SELECT canonical_raw,fields_json FROM unit_label_facts").get(),
    ).toMatchObject({
      canonical_raw: "FULL-LEGACY",
      fields_json: JSON.stringify({ "km.code": "FULL-LEGACY", expiry: "original" }),
    });
    db.exec(
      "INSERT INTO product_mirror(id,gtin14,name,status) VALUES('p','04600000000015','Fresh','active'); INSERT INTO shift_mirror(id,status,mode,product_id) VALUES('s','active','aggregation','p')",
    );
    const insert = db.prepare(
      "INSERT INTO outbox(shift_id,raw,verdict,scanned_at,code_hash,gtin14,replay_origin) VALUES('s','FULL-NEW','ok',?,?,'04600000000015',?)",
    );
    insert.run("fresh", "a".repeat(64), 0);
    insert.run("replayed", "c".repeat(64), 1);
    expect(
      db.prepare("SELECT canonical_raw FROM unit_label_facts WHERE accepted_at='fresh'").get(),
    ).toEqual({ canonical_raw: "" });
    expect(db.prepare("SELECT 1 FROM unit_label_facts WHERE accepted_at='replayed'").all()).toEqual(
      [],
    );
    expect(() => db.exec("UPDATE unit_label_facts SET fields_json='{}'")).toThrow(
      "UNIT_LABEL_FACTS_IMMUTABLE",
    );
    STATION_MIGRATIONS.slice(start).forEach(apply);
    expect(db.prepare("SELECT count(*) n FROM unit_label_facts").get()).toEqual({ n: 2 });
  } finally {
    db.close();
  }
});
