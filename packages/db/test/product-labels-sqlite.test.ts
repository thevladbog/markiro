import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import * as schema from "../src/sqlite/schema.js";

describe("product label SQLite schema parity", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  it("upgrades legacy shift mirrors without inventing a print policy and enforces JSON storage", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const contextIndex = STATION_MIGRATIONS.findIndex((statement) =>
      statement.startsWith("ALTER TABLE shift_mirror ADD COLUMN validation_print_context"),
    );
    expect(contextIndex).toBeGreaterThan(0);
    const apply = (statements: readonly string[]) => {
      for (const statement of statements) {
        try {
          db.exec(statement);
        } catch (error) {
          if (!(error instanceof Error && /duplicate column name/i.test(error.message)))
            throw error;
        }
      }
    };
    apply(STATION_MIGRATIONS.slice(0, contextIndex));
    db.prepare(
      "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES ('legacy','active','validation','product')",
    ).run();
    apply(STATION_MIGRATIONS.slice(contextIndex));
    apply(STATION_MIGRATIONS.slice(contextIndex));
    expect(
      db.prepare("SELECT validation_print_context FROM shift_mirror WHERE id='legacy'").get()
        ?.validation_print_context,
    ).toBeNull();
    expect(
      db
        .prepare("PRAGMA table_info(shift_mirror)")
        .all()
        .map((row) => row.name)
        .sort(),
    ).toEqual(
      Object.values(getTableColumns(schema.shiftMirror))
        .map((column) => column.name)
        .sort(),
    );
    expect(() =>
      db
        .prepare("UPDATE shift_mirror SET validation_print_context='not json' WHERE id='legacy'")
        .run(),
    ).toThrow(/CHECK constraint/);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'product_label_mirror_guard_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "product_label_mirror_guard_insert" },
      { name: "product_label_mirror_guard_update" },
    ]);
  });

  it("creates matching local command, job, attempt, event and outbox columns", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    for (const sql of STATION_MIGRATIONS) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
      }
    }
    const tables = [
      ["product_label_accept_commands", schema.productLabelAcceptCommands],
      ["product_label_jobs", schema.productLabelJobs],
      ["product_label_attempts", schema.productLabelAttempts],
      ["product_label_events", schema.productLabelEvents],
      ["product_label_outbox", schema.productLabelOutbox],
    ] as const;
    for (const [name, table] of tables) {
      const actual = db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => row.name);
      expect(actual).toEqual(Object.values(getTableColumns(table)).map((column) => column.name));
      expect(actual).toContain("credential_ownership");
    }
    for (const table of [
      "product_label_jobs",
      "product_label_attempts",
      "product_label_events",
      "product_label_outbox",
    ]) {
      expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "credential_ownership",
            to: "credential_ownership",
            on_delete: "CASCADE",
          }),
        ]),
      );
    }
    expect(db.prepare("PRAGMA index_list(product_label_jobs)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "product_label_jobs_one_unresolved_owner_uq",
          unique: 1,
          partial: 1,
        }),
      ]),
    );
  });
});
