import { sql } from "drizzle-orm";
import { createDb, type Db } from "@markiro/db";
import { loadEnv } from "../env";

const categoryNames = [
  "annualUnitMonthlyPeriod",
  "missingDocumentNameRu",
  "missingDocumentNameEn",
  "missingCatalogReview",
  "missingSellerPolicy",
  "nullEndedPaidSubscriptions",
  "legacyUnrepresentablePlans",
  "legacyLicenseInvoiceLines",
  "legacyLicenseOfferLines",
  "frozenOfferAmountMismatch",
  "frozenOfferTaxReview",
] as const;
type Category = (typeof categoryNames)[number];
export interface CommercialP0ImpactReport {
  version: 1;
  categories: Record<Category, { count: number; ids: string[] }>;
}

/** Consistent read-only inventory; no app bootstrap, jobs, correction or term inference. */
export async function reportCommercialP0Impact(db: Db): Promise<CommercialP0ImpactReport> {
  return db.transaction(
    async (tx) => {
      const result = await tx.execute<{ category: Category; id: string }>(sql`
      select 'annualUnitMonthlyPeriod' as category, id::text from catalog_item_versions
      where billing_period = 'month' and lower(btrim(unit)) in ('year', 'annual', 'yearly', 'год', 'года', 'лет', 'г.')
      union all select 'missingDocumentNameRu', id::text from catalog_item_versions where document_name_ru is null
      union all select 'missingDocumentNameEn', id::text from catalog_item_versions where document_name_en is null
      union all select 'missingCatalogReview', id::text from catalog_item_versions where subject is null or seller_policy_revision is null
      union all select 'missingSellerPolicy', id::text from operator_billing_profiles where tax_policy is null
      union all select 'nullEndedPaidSubscriptions', id::text from tenant_subscriptions
        where source in ('paid_offer_line', 'paid_invoice_line') and ends_at is null
      union all select 'legacyUnrepresentablePlans', catalog_version_id::text from plan_entitlements
        where max_lines = 0 or max_stations = 0 or max_kiosks = 0 or max_cabinet_users = 0
      union all select 'legacyLicenseInvoiceLines', id::text from invoice_lines where kind in ('plan','addon') and commercial_terms is null
      union all select 'legacyLicenseOfferLines', id::text from commercial_offer_lines where kind in ('plan','addon') and commercial_terms is null
      union all select 'frozenOfferAmountMismatch', s.id::text from commercial_offer_print_snapshots s
        where subtotal + vat_total <> total or (
          jsonb_typeof(lines_snapshot) = 'array' and
          (select bool_and(coalesce((line->>'lineTotal') ~ '^[0-9]+([.][0-9]{1,2})?$', false)) and
            sum(case when (line->>'lineTotal') ~ '^[0-9]+([.][0-9]{1,2})?$' then (line->>'lineTotal')::numeric end) <> s.total
           from jsonb_array_elements(case when jsonb_typeof(lines_snapshot) = 'array' then lines_snapshot else '[]'::jsonb end) line)
        )
      union all select 'frozenOfferTaxReview', id::text from commercial_offer_print_snapshots
        where jsonb_typeof(lines_snapshot) <> 'array' or exists (
          select 1 from jsonb_array_elements(case when jsonb_typeof(lines_snapshot) = 'array' then lines_snapshot else '[]'::jsonb end) line
          where line->>'vatRate' is not null and (line->>'lineVat' is null or line->>'lineSubtotal' is null)
        )
      order by category, id
    `);
      const categories = Object.fromEntries(
        categoryNames.map((name) => [name, { count: 0, ids: [] as string[] }]),
      ) as CommercialP0ImpactReport["categories"];
      for (const row of result.rows) categories[row.category].ids.push(row.id);
      for (const category of Object.values(categories)) category.count = category.ids.length;
      return { version: 1, categories };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

interface CliStream {
  write(value: string): unknown;
}
export async function runReportCommercialP0ImpactCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    if (options.argv.length > 0) throw new Error("Invalid arguments");
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const report = await reportCommercialP0Impact(db);
      (options.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
    } finally {
      await pool.end();
    }
    return 0;
  } catch {
    // Driver/env error messages can contain connection strings or row payloads.
    (options.stderr ?? process.stderr).write(
      "Commercial P0 impact report failed; verify arguments, schema and database access.\n",
    );
    return 1;
  }
}
if (require.main === module) {
  void runReportCommercialP0ImpactCli({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
