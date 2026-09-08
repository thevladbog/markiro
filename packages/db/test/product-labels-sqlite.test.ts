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
