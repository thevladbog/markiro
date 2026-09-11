import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
describe.skipIf(!databaseUrl)("commercial terms additive migration", () => {
  const databaseName = `markiro_commercial_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const itemId = randomUUID(),
    versionId = randomUUID(),
    offerId = randomUUID(),
    lineId = randomUUID(),
    subscriptionId = randomUUID(),
    invoiceId = randomUUID(),
    invoiceLineId = randomUUID(),
    profileId = randomUUID(),
    agreementId = randomUUID();
  const baseline = new Map<string, unknown[]>();
  const tables = [
    "catalog_item_versions",
    "plan_entitlements",
    "commercial_offers",
    "commercial_offer_lines",
    "tenant_subscriptions",
    "operator_billing_profiles",
    "invoices",
    "invoice_lines",
    "platform_agreements",
  ];
  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-commercial-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 128,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('commercial-tenant','Tenant','commercial-tenant',now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id,name,email,role,status) VALUES ('commercial-admin','Admin','commercial-admin@example.invalid','platform_admin','active')",
    );
    await pool.query(
      "INSERT INTO platform_agreements (id,number,tenant_id,counterparty,contractor,terms,created_by_platform_user_id) VALUES ($1,'МКР-2026-0001','commercial-tenant',$2,$3,$4,'commercial-admin')",
      [
        agreementId,
        JSON.stringify({ kind: "legal_entity", name: "Existing client", literal: "  preserve  " }),
        JSON.stringify({ kind: "sole_proprietor", name: "Existing seller" }),
        JSON.stringify({ penaltyRatePercent: "0.1", penaltyCapPercent: "10" }),
      ],
    );
    await pool.query(
      "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1,'legacy-plan','plan','Тариф','Plan')",
      [itemId],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id,catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,unit_price,vat_included) VALUES ($1,$2,'plan',1,'Старый тариф','Old plan','year','recurring','month','1234.56',false)",
      [versionId, itemId],
    );
    await pool.query(
      "INSERT INTO plan_entitlements (catalog_version_id,max_lines,max_stations,max_kiosks,max_cabinet_users,demo_duration_days) VALUES ($1,null,2,null,3,14)",
      [versionId],
    );
    await pool.query(
      "INSERT INTO commercial_offers (id,tenant_id,family_id,revision,total,created_by_platform_user_id) VALUES ($1,'commercial-tenant',$1,1,'1234.56','commercial-admin')",
      [offerId],
    );
    await pool.query(
      "INSERT INTO commercial_offer_lines (id,tenant_id,offer_id,position,kind,catalog_version_id,name_ru,name_en,quantity,unit,agreed_unit_price,vat_included,activation_policy,line_total) VALUES ($1,'commercial-tenant',$2,1,'plan',$3,'Историческая лицензия','Legacy license',1,'year','1234.56',false,'immediately','1234.56')",
      [lineId, offerId, versionId],
    );
    await pool.query(
      "INSERT INTO tenant_subscriptions (id,tenant_id,plan_version_id,status,starts_at,ends_at,source,source_offer_line_id) VALUES ($1,'commercial-tenant',$2,'active','2026-01-31T09:00:00Z',null,'paid_offer_line',$3)",
      [subscriptionId, versionId, lineId],
    );
    await pool.query(
      "INSERT INTO operator_billing_profiles (id,revision,kind,full_name,display_name,address_raw,legal_address_raw,created_by_platform_user_id) VALUES ($1,1,'self_employed','Legacy seller','Seller','Москва','Москва','commercial-admin')",
      [profileId],
    );
    await pool.query(
      "INSERT INTO invoices (id,tenant_id,number,status,issue_date,seller_snapshot,buyer_snapshot,total,created_by_platform_user_id) VALUES ($1,'commercial-tenant','LEGACY-1','issued','2026-01-01T00:00:00Z',$2,$3,'1234.56','commercial-admin')",
      [
        invoiceId,
        JSON.stringify({ name: "Exact seller", vat: null, literal: "  preserve  " }),
        JSON.stringify({ name: "Exact buyer" }),
      ],
    );
    await pool.query(
      "INSERT INTO invoice_lines (id,tenant_id,invoice_id,position,kind,catalog_version_id,catalog_kind,name_ru,name_en,quantity,unit,agreed_unit_price,vat_included,line_subtotal,line_vat,line_total,activation_policy) VALUES ($1,'commercial-tenant',$2,1,'plan',$3,'plan','Историческая лицензия','Legacy license',1,'year','1234.56',false,'1234.56','0','1234.56','immediate')",
      [invoiceLineId, invoiceId, versionId],
    );
    for (const table of tables)
      baseline.set(
        table,
        (
          await pool.query(
            `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`.replace(
              "ORDER BY id",
              table === "plan_entitlements" ? "ORDER BY catalog_version_id" : "ORDER BY id",
            ),
          )
        ).rows,
      );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  it("preserves every legacy field including paid null-ended subscriptions and issued snapshots", async () => {
    const additions: Record<string, string[]> = {
      catalog_item_versions: [
        "document_name_ru",
        "document_name_en",
        "subject",
        "seller_policy_revision",
      ],
      commercial_offer_lines: ["commercial_terms"],
      tenant_subscriptions: ["commercial_period"],
      operator_billing_profiles: ["tax_policy"],
      invoice_lines: ["commercial_terms"],
    };
    for (const table of tables) {
      const fields = additions[table] ?? [];
      const result = await pool.query(
        `SELECT to_jsonb(t) - $1::text[] AS value FROM ${table} t ORDER BY ${table === "plan_entitlements" ? "catalog_version_id" : "id"}`,
        [fields],
      );
      expect(result.rows).toEqual(baseline.get(table));
      for (const field of fields)
        expect(
          (await pool.query(`SELECT ${field} AS value FROM ${table}`)).rows.every(
            (row) => row.value === null,
          ),
        ).toBe(true);
    }
  });
  it("accepts resource zero/null and rejects negative quotas and zero trials", async () => {
    await pool.query("UPDATE plan_entitlements SET max_kiosks=0 WHERE catalog_version_id=$1", [
      versionId,
    ]);
    expect(
      (
        await pool.query(
          "SELECT max_kiosks,max_lines FROM plan_entitlements WHERE catalog_version_id=$1",
          [versionId],
        )
      ).rows,
    ).toEqual([{ max_kiosks: 0, max_lines: null }]);
    await expect(
      pool.query("UPDATE plan_entitlements SET max_kiosks=-1 WHERE catalog_version_id=$1", [
        versionId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE plan_entitlements SET demo_duration_days=0 WHERE catalog_version_id=$1", [
        versionId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE plan_entitlements SET max_kiosks=$1 WHERE catalog_version_id=$2", [
        "2147483648",
        versionId,
      ]),
    ).rejects.toMatchObject({ code: "22003" });
  });
  it("rejects malformed metadata instead of allowing missing JSON fields through SQL null", async () => {
    await expect(
      pool.query("UPDATE catalog_item_versions SET subject='service' WHERE id=$1", [versionId]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const invalid of [
      {},
      { kind: "without_vat" },
      {
        kind: "vat",
        regime: "npd",
        allowedRatesBps: [2000],
        defaultRateBps: 2000,
        defaultIncluded: true,
      },
    ])
      await expect(
        pool.query("UPDATE operator_billing_profiles SET tax_policy=$1 WHERE id=$2", [
          JSON.stringify(invalid),
          profileId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    for (const table of ["invoice_lines", "commercial_offer_lines"])
      await expect(
        pool.query(`UPDATE ${table} SET commercial_terms='{}'::jsonb`),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE tenant_subscriptions SET commercial_period='{}'::jsonb"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("accepts exact new license snapshots and rejects mismatched subject and plan quantity", async () => {
    const terms = {
      version: 1,
      subject: "software_license",
      documentNameRu: "Лицензия",
      documentNameEn: null,
      sellerPolicyRevision: 1,
      billingPeriod: "year",
      billingTimezone: "Europe/Moscow",
      activationRule: "on_application",
    };
    await pool.query("UPDATE invoice_lines SET commercial_terms=$1 WHERE id=$2", [
      JSON.stringify(terms),
      invoiceLineId,
    ]);
    await expect(
      pool.query("UPDATE invoice_lines SET quantity=2 WHERE id=$1", [invoiceLineId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE invoice_lines SET commercial_terms=$1 WHERE id=$2", [
        JSON.stringify({ ...terms, subject: "service" }),
        invoiceLineId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("stores explicit tax policies and anchored periods without changing legacy date columns", async () => {
    const period = {
      billingPeriod: "month",
      billingTimezone: "Europe/Moscow",
      calendarPolicyVersion: 1,
      anchorAt: "2026-01-31T09:00:00.000Z",
      cycle: 0,
      startsAt: "2026-01-31T09:00:00.000Z",
      endsAt: "2026-02-28T09:00:00.000Z",
    };
    await pool.query("UPDATE tenant_subscriptions SET commercial_period=$1 WHERE id=$2", [
      JSON.stringify(period),
      subscriptionId,
    ]);
    expect(
      (
        await pool.query("SELECT commercial_period,ends_at FROM tenant_subscriptions WHERE id=$1", [
          subscriptionId,
        ])
      ).rows,
    ).toEqual([{ commercial_period: period, ends_at: null }]);
    for (const policy of [
      { kind: "without_vat", regime: "npd" },
      {
        kind: "vat",
        regime: "other",
        allowedRatesBps: [0, 2000],
        defaultRateBps: 2000,
        defaultIncluded: true,
      },
    ]) {
      await pool.query("UPDATE operator_billing_profiles SET tax_policy=$1 WHERE id=$2", [
        JSON.stringify(policy),
        profileId,
      ]);
      expect(
        (
          await pool.query("SELECT tax_policy FROM operator_billing_profiles WHERE id=$1", [
            profileId,
          ])
        ).rows,
      ).toEqual([{ tax_policy: policy }]);
    }
  });
});
