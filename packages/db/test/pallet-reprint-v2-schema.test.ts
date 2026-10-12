import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.js";
import { PALLET_REPRINT_V2_MIGRATIONS } from "../src/sqlite/pallet-reprint-v2-migrations.js";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
function migrate(db: DatabaseSync, statements: readonly string[] = STATION_MIGRATIONS) {
  for (const statement of statements) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}
it("adds nullable rendering columns while keeping legacy jobs intact on repeated migration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const v2 = new Set<string>(PALLET_REPRINT_V2_MIGRATIONS);
    migrate(
      db,
      STATION_MIGRATIONS.filter((statement) => !v2.has(statement)),
    );
    expect(
      db
        .prepare("PRAGMA table_info(warehouse_pallet_jobs)")
        .all()
        .map((row) => row.name),
    ).not.toContain("rendering_json");
    db.prepare(
      "INSERT INTO warehouse_pallet_jobs(owner,job_id,sscc,source_revision,source_json,profile_json,bytes_base64,bytes_digest,state,event_json) VALUES('owner','legacy','sscc','revision','{}','{}','saved bytes','digest','sent',?)",
    ).run(JSON.stringify({ eventId: "legacy-event" }));
    const before = db
      .prepare("SELECT source_json,bytes_base64,state FROM warehouse_pallet_jobs")
      .all();
    migrate(db);
    expect(
      db.prepare("SELECT source_json,bytes_base64,state FROM warehouse_pallet_jobs").all(),
    ).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT rendering_json,rendering_revision,protocol,session_id FROM warehouse_pallet_jobs",
        )
        .get(),
    ).toMatchObject({
      rendering_json: null,
      rendering_revision: null,
      protocol: null,
      session_id: null,
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='warehouse_pallet_production_resolutions'",
        )
        .get(),
    ).toBeDefined();
  } finally {
    db.close();
  }
});
it("tenant-scopes rendering and resolution keys", () => {
  expect(
    getTableConfig(schema.palletReprintRenderings).primaryKeys[0]?.columns.map((c) => c.name),
  ).toEqual(["tenant_id", "device_id", "job_id"]);
  expect(
    getTableConfig(schema.palletProductionResolutions).primaryKeys[0]?.columns.map((c) => c.name),
  ).toEqual(["tenant_id", "source_device_id", "event_id"]);
});
