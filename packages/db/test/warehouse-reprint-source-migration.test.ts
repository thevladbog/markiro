import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import { warehouseBoxSource, warehouseSourceSchema } from "@markiro/domain";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import { warehouseReprintCache, warehouseReprintLocalBoxes } from "../src/sqlite/schema.js";

function apply(db: DatabaseSync, statements: readonly string[]) {
  for (const sql of statements) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}
it("upgrades proven legacy local closures once and preserves ambiguous cache without local provenance", () => {
  const db = new DatabaseSync(":memory:");
  const start = STATION_MIGRATIONS.findIndex((sql) =>
    sql.startsWith("ALTER TABLE warehouse_reprint_cache ADD COLUMN cached_at"),
  );
  expect(start).toBeGreaterThan(0);
  try {
    apply(db, STATION_MIGRATIONS.slice(0, start));
    const source = warehouseBoxSource();
    db.prepare(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,?,?,'open','closed')",
    ).run(source.sourceId, source.sourceShiftId, source.identity);
    const insert = db.prepare(
      "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'box',?,?)",
    );
    insert.run("owner", source.identity, JSON.stringify(source));
    insert.run(
      "owner",
      "remote",
      JSON.stringify({
        ...source,
        identity: "remote",
        fields: { ...source.fields, sscc: "remote" },
      }),
    );
    apply(db, STATION_MIGRATIONS.slice(start));
    expect(
      db.prepare("SELECT identity,value_json FROM warehouse_reprint_local_boxes").all(),
    ).toEqual([{ identity: source.identity, value_json: JSON.stringify(source) }]);
    db.prepare("UPDATE warehouse_reprint_cache SET value_json='{}' WHERE identity=?").run(
      source.identity,
    );
    apply(db, STATION_MIGRATIONS.slice(start));
    expect(
      db.prepare("SELECT value_json FROM warehouse_reprint_local_boxes").get()?.value_json,
    ).toBe(JSON.stringify(source));
    expect(
      db.prepare("SELECT identity FROM warehouse_reprint_cache ORDER BY identity").all(),
    ).toEqual([{ identity: source.identity }, { identity: "remote" }]);
    expect(
      warehouseSourceSchema.parse(
        JSON.parse(
          String(
            db.prepare("SELECT value_json FROM warehouse_reprint_local_boxes").get()?.value_json,
          ),
        ),
      ),
    ).toEqual(source);
    for (const table of [warehouseReprintCache, warehouseReprintLocalBoxes]) {
      const name =
        table === warehouseReprintCache
          ? "warehouse_reprint_cache"
          : "warehouse_reprint_local_boxes";
      const expected = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
      expect(
        db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => column.name)
          .sort(),
      ).toEqual(expected);
    }
  } finally {
    db.close();
  }
});

it("appends the group override upgrade after history acknowledgments and preserves prior frozen JSON", () => {
  const db = new DatabaseSync(":memory:");
  const index = STATION_MIGRATIONS.findIndex((sql) =>
    sql.startsWith("ALTER TABLE warehouse_reprint_local_boxes ADD COLUMN group_override_json"),
  );
  const history = STATION_MIGRATIONS.findIndex((sql) =>
    sql.startsWith("CREATE TABLE IF NOT EXISTS warehouse_reprint_history_acknowledgements"),
  );
  expect(index).toBeGreaterThan(history);
  try {
    apply(db, STATION_MIGRATIONS.slice(0, index));
    const original = JSON.stringify(warehouseBoxSource());
    db.prepare(
      "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json) VALUES('owner','identity',?)",
    ).run(original);
    apply(db, STATION_MIGRATIONS.slice(index));
    expect(
      db.prepare("SELECT value_json,group_override_json FROM warehouse_reprint_local_boxes").get(),
    ).toEqual({ value_json: original, group_override_json: null });
    db.exec("UPDATE warehouse_reprint_local_boxes SET group_override_json='null'");
    apply(db, STATION_MIGRATIONS.slice(index));
    expect(
      db.prepare("SELECT value_json,group_override_json FROM warehouse_reprint_local_boxes").get(),
    ).toEqual({ value_json: original, group_override_json: "null" });
  } finally {
    db.close();
  }
});

it("checks retained source jobs by the full source key without scanning an owner's history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    apply(db, STATION_MIGRATIONS);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM warehouse_reprint_jobs WHERE owner=? AND source_kind=? AND identity=?",
      )
      .all("owner", "box", "identity");
    expect(plan.map((step) => step.detail).join("\n")).toMatch(
      /owner=\? AND source_kind=\? AND identity=\?/,
    );
  } finally {
    db.close();
  }
});

it("appends original snapshot retention metadata without changing or re-aging historical fields", () => {
  const db = new DatabaseSync(":memory:");
  const index = STATION_MIGRATIONS.findIndex((sql) =>
    sql.startsWith("ALTER TABLE warehouse_reprint_local_boxes ADD COLUMN cached_at"),
  );
  expect(index).toBeGreaterThan(
    STATION_MIGRATIONS.findIndex((sql) =>
      sql.startsWith("CREATE INDEX IF NOT EXISTS warehouse_reprint_jobs_source_idx"),
    ),
  );
  try {
    apply(db, STATION_MIGRATIONS.slice(0, index));
    const original = JSON.stringify(warehouseBoxSource());
    db.prepare(
      "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json,eligibility_denied,group_override_json) VALUES('owner','identity',?,1,'null')",
    ).run(original);
    apply(db, STATION_MIGRATIONS.slice(index));
    const row = db
      .prepare(
        "SELECT value_json,eligibility_denied,group_override_json,cached_at FROM warehouse_reprint_local_boxes",
      )
      .get();
    expect(row).toMatchObject({
      value_json: original,
      eligibility_denied: 1,
      group_override_json: "null",
    });
    expect(row?.cached_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    apply(db, STATION_MIGRATIONS.slice(index));
    expect(
      db
        .prepare(
          "SELECT value_json,eligibility_denied,group_override_json,cached_at FROM warehouse_reprint_local_boxes",
        )
        .get(),
    ).toEqual(row);
    expect(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT identity FROM warehouse_reprint_local_boxes WHERE owner=? AND cached_at<?",
        )
        .all("owner", "before")
        .map((step) => step.detail)
        .join("\n"),
    ).toMatch(/owner=\? AND cached_at<\?/);
  } finally {
    db.close();
  }
});
