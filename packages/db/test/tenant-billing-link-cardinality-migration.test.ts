import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe("tenant billing target cardinality migration", () => {
  it("adds 0095 after the immutable 0094 snapshot", async () => {
    const [previousText, currentText, journalText, sqlText] = await Promise.all([
      readFile(new URL("../migrations/meta/0094_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0095_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
      readFile(
        new URL("../migrations/0095_tenant_billing_target_cardinality.sql", import.meta.url),
        "utf8",
      ),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find(({ idx }) => idx === 95)).toMatchObject({
      idx: 95,
      tag: "0095_tenant_billing_target_cardinality",
    });
    for (const target of ["offer", "invoice", "act"] as const) {
      expect(sqlText).toContain(`tenant_billing_request_links_${target}_uq`);
      expect(sqlText).toMatch(
        new RegExp(
          `UNIQUE INDEX[^;]+\\("tenant_id","${target}_id"\\)[^;]+"${target}_id" is not null`,
          "s",
        ),
      );
    }
    expect(sqlText).toContain("tenant_billing_request_link_target_ambiguity");
  });
});

describe.skipIf(!databaseUrl)("tenant billing target cardinality upgrade", () => {
  const databaseName = `markiro_billing_cardinality_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-billing-cardinality-"));
    const migrationsThrough0094 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0094,
      lastIncludedIndex: 94,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0094 });
    await pool.query(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('billing-cardinality', 'Billing cardinality', 'billing-cardinality', now());
      INSERT INTO platform_users (id, name, email, role, status)
      VALUES ('billing-cardinality-actor', 'Actor', 'cardinality@example.invalid',
              'accountant', 'active');
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('billing-cardinality-user', 'User', 'cardinality-user@example.invalid', true,
              now(), now());
      INSERT INTO tenant_billing_requests
        (id, tenant_id, number, type, status, description, responsible_side,
         idempotency_key, created_by_user_id)
      VALUES
        ('00000000-0000-4000-8000-000000007101', 'billing-cardinality', 'BR-0071-1',
         'other', 'new', 'First', 'markiro', '00000000-0000-4000-8000-000000007111',
         'billing-cardinality-user'),
        ('00000000-0000-4000-8000-000000007102', 'billing-cardinality', 'BR-0071-2',
         'other', 'new', 'Second', 'markiro', '00000000-0000-4000-8000-000000007112',
         'billing-cardinality-user');
      INSERT INTO commercial_offers
        (id, tenant_id, family_id, revision, status, created_by_platform_user_id)
      VALUES ('00000000-0000-4000-8000-000000007121', 'billing-cardinality',
              '00000000-0000-4000-8000-000000007120', 1, 'draft',
              'billing-cardinality-actor');
      INSERT INTO invoices
        (id, tenant_id, number, created_by_platform_user_id)
      VALUES ('00000000-0000-4000-8000-000000007131', 'billing-cardinality', 'INV-0071',
              'billing-cardinality-actor');
      INSERT INTO billing_acts
        (id, tenant_id, number, period_start, period_end, created_by_platform_user_id)
      VALUES ('00000000-0000-4000-8000-000000007141', 'billing-cardinality', 'ACT-0071',
              '2026-08-01', '2026-08-02', 'billing-cardinality-actor');
      INSERT INTO tenant_billing_request_links (tenant_id, request_id, offer_id)
      VALUES
        ('billing-cardinality', '00000000-0000-4000-8000-000000007101',
         '00000000-0000-4000-8000-000000007121'),
        ('billing-cardinality', '00000000-0000-4000-8000-000000007102',
         '00000000-0000-4000-8000-000000007121');
      INSERT INTO tenant_billing_request_links (tenant_id, request_id, invoice_id)
      VALUES
        ('billing-cardinality', '00000000-0000-4000-8000-000000007101',
         '00000000-0000-4000-8000-000000007131'),
        ('billing-cardinality', '00000000-0000-4000-8000-000000007102',
         '00000000-0000-4000-8000-000000007131');
      INSERT INTO tenant_billing_request_links (tenant_id, request_id, act_id)
      VALUES
        ('billing-cardinality', '00000000-0000-4000-8000-000000007101',
         '00000000-0000-4000-8000-000000007141'),
        ('billing-cardinality', '00000000-0000-4000-8000-000000007102',
         '00000000-0000-4000-8000-000000007141');
    `);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("fails each ambiguous legacy target deterministically, then enforces zero-or-one", async () => {
    await expect(migrate(drizzle(pool), { migrationsFolder })).rejects.toThrow(
      /tenant_billing_request_link_target_ambiguity:offer/,
    );
    await deleteSecondLink(pool, "offer_id", "00000000-0000-4000-8000-000000007121");
    await expect(migrate(drizzle(pool), { migrationsFolder })).rejects.toThrow(
      /tenant_billing_request_link_target_ambiguity:invoice/,
    );
    await deleteSecondLink(pool, "invoice_id", "00000000-0000-4000-8000-000000007131");
    await expect(migrate(drizzle(pool), { migrationsFolder })).rejects.toThrow(
      /tenant_billing_request_link_target_ambiguity:act/,
    );
    await deleteSecondLink(pool, "act_id", "00000000-0000-4000-8000-000000007141");
    await migrate(drizzle(pool), { migrationsFolder });

    for (const [column, targetId] of [
      ["offer_id", "00000000-0000-4000-8000-000000007121"],
      ["invoice_id", "00000000-0000-4000-8000-000000007131"],
      ["act_id", "00000000-0000-4000-8000-000000007141"],
    ] as const) {
      await expect(
        pool.query(
          `INSERT INTO tenant_billing_request_links (tenant_id, request_id, ${column})
           VALUES ('billing-cardinality', '00000000-0000-4000-8000-000000007102', $1)`,
          [targetId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    }
    const statuses = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'offer_status' ORDER BY enumsortorder`,
    );
    expect(statuses.rows.map(({ enumlabel }) => enumlabel)).toContain("superseded");
  }, 120_000);
});

async function deleteSecondLink(pool: pg.Pool, column: string, targetId: string) {
  if (!new Set(["offer_id", "invoice_id", "act_id"]).has(column)) {
    throw new Error("unsafe link target column");
  }
  await pool.query(
    `DELETE FROM tenant_billing_request_links
     WHERE request_id = '00000000-0000-4000-8000-000000007102' AND ${column} = $1`,
    [targetId],
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
