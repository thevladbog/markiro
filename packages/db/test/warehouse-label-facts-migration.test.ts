import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
it("captures a new acceptance atomically without reconstructing pre-upgrade facts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const apply = (sql: string) => {
      try {
        db.exec(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column name")) throw error;
      }
    };
    const start = STATION_MIGRATIONS.findIndex((sql) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS unit_label_facts"),
    );
    expect(start).toBeGreaterThan(0);
    STATION_MIGRATIONS.slice(0, start).forEach(apply);
    db.exec(
      "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('p','04600000000015','Old','active',1); INSERT INTO shift_mirror(id,status,mode,product_id,production_date) VALUES('s','active','aggregation','p','2026-02-28')",
    );
    const insert =
      "INSERT INTO outbox(shift_id,raw,verdict,scanned_at,code_hash,gtin14,serial) VALUES('s','raw','ok','2026-03-01T12:00:00.000Z','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','04600000000015','serial')";
    db.exec(insert);
    STATION_MIGRATIONS.slice(start).forEach(apply);
    expect(db.prepare("SELECT count(*) n FROM unit_label_facts").get()).toMatchObject({ n: 0 });
    db.prepare("UPDATE shift_mirror SET execution_scope_json=? WHERE id='s'").run(
      '{"product":{"name":"Frozen","printName":null,"gtin14":"04600000000015","egaisCode":null,"shelfLifeDays":1},"shift":{"productionDate":"2026-02-28","number":null,"counterpartyName":null}}',
    );
    db.exec(
      "UPDATE product_mirror SET shelf_life_days=365; UPDATE shift_mirror SET production_date='2026-03-01'",
    );
    db.exec(insert);
    expect(
      db
        .prepare(
          "SELECT json_extract(context_json,'$.productionDate') day,json_extract(context_json,'$.shelfLifeDays') days FROM unit_label_facts",
        )
        .get(),
    ).toMatchObject({ day: "2026-02-28", days: 1 });
    db.exec(
      "DELETE FROM unit_label_facts; CREATE TRIGGER fail_publication AFTER INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test interruption');END;",
    );
    expect(() => db.exec(insert)).toThrow("test interruption");
    expect(db.prepare("SELECT count(*) n FROM unit_label_facts").get()).toMatchObject({ n: 0 });
  } finally {
    db.close();
  }
});
