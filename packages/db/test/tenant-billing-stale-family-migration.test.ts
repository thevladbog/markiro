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

describe("tenant billing stale-family migration metadata", () => {
  it("appends 0096 without rewriting 0095", async () => {
    const [previousText, currentText, journalText, sqlText] = await Promise.all([
      readFile(new URL("../migrations/meta/0095_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0096_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
      readFile(
        new URL("../migrations/0096_tenant_billing_stale_family_repair.sql", import.meta.url),
        "utf8",
      ),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find(({ idx }) => idx === 96)).toMatchObject({
      idx: 96,
      tag: "0096_tenant_billing_stale_family_repair",
    });
    expect(sqlText).toContain("commercial_offer_current_revision_ambiguous");
    expect(sqlText).toContain("billing_act_request_link_mismatch");
    expect(sqlText).toContain("superseded");
  });
});

describe.skipIf(!databaseUrl)("tenant billing stale-family upgrade", () => {
  const databaseName = `markiro_billing_stale_family_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-billing-stale-family-"));
    const migrationsThrough0094 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0094,
      lastIncludedIndex: 94,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0094 });

    await pool.query(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('stale-family', 'Stale family', 'stale-family', now());
      INSERT INTO platform_users (id, name, email, role, status)
      VALUES ('stale-family-actor', 'Actor', 'stale-family@example.invalid',
              'accountant', 'active');
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('stale-family-user', 'User', 'stale-family-user@example.invalid', true,
              now(), now());
      INSERT INTO tenant_billing_requests
        (id, tenant_id, number, type, status, description, responsible_side,
         idempotency_key, created_by_user_id)
      VALUES
        ('00000000-0000-4000-8000-000000007201', 'stale-family', 'BR-0072-1',
         'other', 'new', 'First', 'markiro', '00000000-0000-4000-8000-000000007211',
         'stale-family-user'),
        ('00000000-0000-4000-8000-000000007202', 'stale-family', 'BR-0072-2',
         'other', 'new', 'Second', 'markiro', '00000000-0000-4000-8000-000000007212',
         'stale-family-user');
      INSERT INTO commercial_offers
        (id, tenant_id, family_id, revision, status, number, total, published_at,
         published_by_platform_user_id, created_by_platform_user_id, paid_at)
      VALUES
        ('00000000-0000-4000-8000-000000007221', 'stale-family',
         '00000000-0000-4000-8000-000000007220', 1, 'published', 'KP-0072-P1', 100,
         '2026-08-01T00:00:00Z', 'stale-family-actor', 'stale-family-actor', NULL),
        ('00000000-0000-4000-8000-000000007222', 'stale-family',
         '00000000-0000-4000-8000-000000007220', 2, 'published', 'KP-0072-P2', 200,
         '2026-08-02T00:00:00Z', 'stale-family-actor', 'stale-family-actor', NULL),
        ('00000000-0000-4000-8000-000000007261', 'stale-family',
         '00000000-0000-4000-8000-000000007260', 1, 'published', 'KP-0072-OLD-P1', 100,
         '2026-08-01T00:00:00Z', 'stale-family-actor', 'stale-family-actor', NULL),
        ('00000000-0000-4000-8000-000000007262', 'stale-family',
         '00000000-0000-4000-8000-000000007260', 2, 'paid', 'KP-0072-PAID-P2', 200,
         '2026-08-02T00:00:00Z', 'stale-family-actor', 'stale-family-actor',
         '2026-08-03T00:00:00Z');
      INSERT INTO commercial_offer_decisions
        (tenant_id, offer_id, decision, message, actor_user_id, idempotency_key)
      VALUES
        ('stale-family', '00000000-0000-4000-8000-000000007221', 'changes_requested',
         'Replace stale terms', 'stale-family-user',
         '00000000-0000-4000-8000-000000007231'),
        ('stale-family', '00000000-0000-4000-8000-000000007222', 'accepted',
         NULL, 'stale-family-user', '00000000-0000-4000-8000-000000007232');
      INSERT INTO commercial_offer_print_snapshots
        (tenant_id, offer_id, revision, number, published_at, seller_snapshot, buyer_snapshot,
         lines_snapshot, subtotal, vat_total, total)
      VALUES
        ('stale-family', '00000000-0000-4000-8000-000000007221', 1, 'KP-0072-P1', now(),
         '{}', '{}', '[]', 100, 0, 100),
        ('stale-family', '00000000-0000-4000-8000-000000007222', 2, 'KP-0072-P2', now(),
         '{}', '{}', '[]', 200, 0, 200);
      INSERT INTO commercial_offer_documents
        (tenant_id, offer_id, revision, format, renderer_version)
      VALUES
        ('stale-family', '00000000-0000-4000-8000-000000007221', 1, 'pdf', 'legacy'),
        ('stale-family', '00000000-0000-4000-8000-000000007222', 2, 'pdf', 'legacy');
      INSERT INTO billing_acts
        (id, tenant_id, request_id, number, period_start, period_end,
         created_by_platform_user_id)
      VALUES
        ('00000000-0000-4000-8000-000000007241', 'stale-family',
         '00000000-0000-4000-8000-000000007201', 'ACT-0072-REPAIR',
         '2026-08-01', '2026-08-02', 'stale-family-actor'),
        ('00000000-0000-4000-8000-000000007242', 'stale-family',
         '00000000-0000-4000-8000-000000007201', 'ACT-0072-MISMATCH',
         '2026-08-01', '2026-08-02', 'stale-family-actor');
      INSERT INTO tenant_billing_request_links (tenant_id, request_id, act_id)
      VALUES ('stale-family', '00000000-0000-4000-8000-000000007202',
              '00000000-0000-4000-8000-000000007242');

      ALTER TABLE commercial_offers
        DROP CONSTRAINT commercial_offers_tenant_family_revision_uq;
      INSERT INTO commercial_offers
        (id, tenant_id, family_id, revision, status, number, published_at,
         published_by_platform_user_id, created_by_platform_user_id)
      VALUES
        ('00000000-0000-4000-8000-000000007251', 'stale-family',
         '00000000-0000-4000-8000-000000007250', 5, 'published', 'KP-0072-C1', now(),
         'stale-family-actor', 'stale-family-actor'),
        ('00000000-0000-4000-8000-000000007252', 'stale-family',
         '00000000-0000-4000-8000-000000007250', 5, 'published', 'KP-0072-C2', now(),
         'stale-family-actor', 'stale-family-actor');
    `);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("aborts corrupt ambiguity, repairs intrinsic links, and supersedes only older published rows", async () => {
    await expect(migrate(drizzle(pool), { migrationsFolder })).rejects.toThrow(
      /commercial_offer_current_revision_ambiguous/,
    );
    await pool.query(`
      ALTER TABLE commercial_offers DISABLE TRIGGER commercial_offers_immutable_published;
      DELETE FROM commercial_offers WHERE id = '00000000-0000-4000-8000-000000007252';
      ALTER TABLE commercial_offers ENABLE TRIGGER commercial_offers_immutable_published;
      ALTER TABLE commercial_offers ADD CONSTRAINT commercial_offers_tenant_family_revision_uq
        UNIQUE (tenant_id, family_id, revision);
    `);
    await expect(migrate(drizzle(pool), { migrationsFolder })).rejects.toThrow(
      /billing_act_request_link_mismatch/,
    );
    await pool.query(`
      DELETE FROM tenant_billing_request_links
      WHERE act_id = '00000000-0000-4000-8000-000000007242';
    `);
    await migrate(drizzle(pool), { migrationsFolder });

    const offers = await pool.query<{ id: string; status: string }>(`
      SELECT id, status FROM commercial_offers
      WHERE family_id = '00000000-0000-4000-8000-000000007220'
      ORDER BY revision
    `);
    expect(offers.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000007221", status: "superseded" },
      { id: "00000000-0000-4000-8000-000000007222", status: "published" },
    ]);
    const paidFamily = await pool.query<{ id: string; status: string }>(`
      SELECT id, status FROM commercial_offers
      WHERE family_id = '00000000-0000-4000-8000-000000007260'
      ORDER BY revision
    `);
    expect(paidFamily.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000007261", status: "superseded" },
      { id: "00000000-0000-4000-8000-000000007262", status: "paid" },
    ]);
    const preserved = await pool.query<{
      decisions: string;
      snapshots: string;
      documents: string;
    }>(`
      SELECT
        (SELECT count(*) FROM commercial_offer_decisions
         WHERE offer_id IN ('00000000-0000-4000-8000-000000007221',
                            '00000000-0000-4000-8000-000000007222')) AS decisions,
        (SELECT count(*) FROM commercial_offer_print_snapshots
         WHERE offer_id IN ('00000000-0000-4000-8000-000000007221',
                            '00000000-0000-4000-8000-000000007222')) AS snapshots,
        (SELECT count(*) FROM commercial_offer_documents
         WHERE offer_id IN ('00000000-0000-4000-8000-000000007221',
                            '00000000-0000-4000-8000-000000007222')) AS documents
    `);
    expect(preserved.rows).toEqual([{ decisions: "2", snapshots: "2", documents: "2" }]);
    const repaired = await pool.query<{ request_id: string; act_id: string }>(`
      SELECT request_id, act_id FROM tenant_billing_request_links
      WHERE act_id IN ('00000000-0000-4000-8000-000000007241',
                       '00000000-0000-4000-8000-000000007242')
      ORDER BY act_id
    `);
    expect(repaired.rows).toEqual([
      {
        request_id: "00000000-0000-4000-8000-000000007201",
        act_id: "00000000-0000-4000-8000-000000007241",
      },
      {
        request_id: "00000000-0000-4000-8000-000000007201",
        act_id: "00000000-0000-4000-8000-000000007242",
      },
    ]);
  }, 120_000);
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
