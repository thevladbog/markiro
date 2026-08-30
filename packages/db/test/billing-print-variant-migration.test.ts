import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe("billing print variant migration metadata", () => {
  it("keeps the snapshot chain contiguous through 0101", async () => {
    const [previousText, currentText, journalText] = await Promise.all([
      readFile(new URL("../migrations/meta/0100_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0101_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find(({ idx }) => idx === 101)).toMatchObject({
      idx: 101,
      tag: "0101_billing_print_variants",
    });
  });
});

describe.skipIf(!databaseUrl)("billing print variant migration", () => {
  const databaseName = `markiro_billing_print_variant_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
  });

  it("defaults legacy-compatible invoice and act document metadata to clean", async () => {
    const result = await pool.query<{
      table_name: string;
      column_default: string | null;
      is_nullable: string;
    }>(
      `SELECT table_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND column_name = 'print_variant'
       ORDER BY table_name`,
      [["billing_act_documents", "invoice_documents"]],
    );

    expect(result.rows).toEqual([
      {
        table_name: "billing_act_documents",
        column_default: "'clean'::text",
        is_nullable: "NO",
      },
      {
        table_name: "invoice_documents",
        column_default: "'clean'::text",
        is_nullable: "NO",
      },
    ]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
