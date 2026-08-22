import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("SaaS migration behavior", () => {
  const databaseName = `markiro_saas_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  let legacyHasDefaultBoxLabelTemplateColumn = false;
  let upgradedHasDefaultBoxLabelTemplateColumn = false;

  function quoteIdentifier(identifier: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
      throw new Error("Unsafe temporary database identifier");
    }
    return `"${identifier}"`;
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-saas-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0030_saas_catalog_subscriptions.sql"));
    await rm(join(legacyMigrations, "0031_platform_auth_runtime_fields.sql"));
    await rm(join(legacyMigrations, "0032_cute_frank_castle.sql"));
    await rm(join(legacyMigrations, "0033_common_magdalene.sql"));
    await rm(join(legacyMigrations, "0034_overconfident_harrier.sql"));
    await rm(join(legacyMigrations, "0035_stormy_ser_duncan.sql"));
    await rm(join(legacyMigrations, "0036_neat_quasar.sql"));
    await rm(join(legacyMigrations, "0037_kiosk_pickup_policy.sql"));
    await rm(join(legacyMigrations, "0038_organization_branding.sql"));
    await rm(join(legacyMigrations, "0039_kiosk_sscc_orders.sql"));
    await rm(join(legacyMigrations, "0040_sscc_counter_start_one.sql"));
    await rm(join(legacyMigrations, "0041_product_images.sql"));
    await rm(join(legacyMigrations, "0042_default_box_label_template.sql"));
    await rm(join(legacyMigrations, "0043_station_shift_close_presence.sql"));
    await rm(join(legacyMigrations, "0044_landing_demo_email.sql"));
    await rm(join(legacyMigrations, "0045_flawless_overlord.sql"));
    await rm(join(legacyMigrations, "0046_yummy_morph.sql"));
    await rm(join(legacyMigrations, "0047_late_blue_blade.sql"));
    await rm(join(legacyMigrations, "0048_product_shelf_life_days.sql"));
    await rm(join(legacyMigrations, "0049_default_label_templates.sql"));
    await rm(join(legacyMigrations, "0050_reseed_default_label_templates.sql"));
    await rm(join(legacyMigrations, "0051_glorious_hydra.sql"));
    await rm(join(legacyMigrations, "0052_center_sscc_and_fit_label_templates.sql"));
    await rm(join(legacyMigrations, "0053_date_free_label_templates.sql"));
    await rm(join(legacyMigrations, "0054_shift_production_date.sql"));
    await rm(join(legacyMigrations, "0055_brief_mole_man.sql"));
    await rm(join(legacyMigrations, "0056_align_dated_label_quantity.sql"));
    await rm(join(legacyMigrations, "0057_product_print_name.sql"));
    await rm(join(legacyMigrations, "0058_remarkable_pyro.sql"));
    await rm(join(legacyMigrations, "0059_print_name_label_templates.sql"));
    await rm(join(legacyMigrations, "0060_saas_legal_profiles.sql"));
    await rm(join(legacyMigrations, "0061_saas_bank_accounts.sql"));
    await rm(join(legacyMigrations, "0062_document_account_snapshots.sql"));
    await rm(join(legacyMigrations, "0063_payment_account_evidence.sql"));
    await rm(join(legacyMigrations, "0064_normalize_operator_billing_profile_kind.sql"));
    await rm(join(legacyMigrations, "0065_saas_party_actual_addresses.sql"));
    await rm(join(legacyMigrations, "meta", "0030_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0031_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0032_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0033_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0034_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0035_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0036_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0037_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0038_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0039_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0040_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0041_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0042_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0043_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0044_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0045_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0046_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0047_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0048_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0049_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0050_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0051_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0052_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0053_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0054_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0055_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0056_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0057_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0058_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0059_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0060_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0061_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0064_snapshot.json"));
    await rm(join(legacyMigrations, "meta", "0065_snapshot.json"));
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0030_saas_catalog_subscriptions" &&
        entry.tag !== "0031_platform_auth_runtime_fields" &&
        entry.tag !== "0032_cute_frank_castle" &&
        entry.tag !== "0033_common_magdalene" &&
        entry.tag !== "0034_overconfident_harrier" &&
        entry.tag !== "0035_stormy_ser_duncan" &&
        entry.tag !== "0036_neat_quasar" &&
        entry.tag !== "0037_kiosk_pickup_policy" &&
        entry.tag !== "0038_organization_branding" &&
        entry.tag !== "0039_kiosk_sscc_orders" &&
        entry.tag !== "0040_sscc_counter_start_one" &&
        entry.tag !== "0041_product_images" &&
        entry.tag !== "0042_default_box_label_template" &&
        entry.tag !== "0043_station_shift_close_presence" &&
        entry.tag !== "0044_landing_demo_email" &&
        entry.tag !== "0045_flawless_overlord" &&
        entry.tag !== "0046_yummy_morph" &&
        entry.tag !== "0047_late_blue_blade" &&
        entry.tag !== "0048_product_shelf_life_days" &&
        entry.tag !== "0049_default_label_templates" &&
        entry.tag !== "0050_reseed_default_label_templates" &&
        entry.tag !== "0051_glorious_hydra" &&
        entry.tag !== "0052_center_sscc_and_fit_label_templates" &&
        entry.tag !== "0053_date_free_label_templates" &&
        entry.tag !== "0054_shift_production_date" &&
        entry.tag !== "0055_brief_mole_man" &&
        entry.tag !== "0056_align_dated_label_quantity" &&
        entry.tag !== "0057_product_print_name" &&
        entry.tag !== "0058_remarkable_pyro" &&
        entry.tag !== "0059_print_name_label_templates" &&
        entry.tag !== "0060_saas_legal_profiles" &&
        entry.tag !== "0061_saas_bank_accounts" &&
        entry.tag !== "0062_document_account_snapshots" &&
        entry.tag !== "0063_payment_account_evidence" &&
        entry.tag !== "0064_normalize_operator_billing_profile_kind" &&
        entry.tag !== "0065_saas_party_actual_addresses",
    );
    expect(journal.entries.at(-1)?.tag).toBe("0029_loving_triathlon");
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    const legacyDefaultColumn = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_profiles'
         AND column_name = 'default_box_label_template_id'`,
    );
    legacyHasDefaultBoxLabelTemplateColumn = legacyDefaultColumn.rows[0]?.count === 1;
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, $4)",
      ["existing-unmanaged", "Existing unmanaged", "existing-unmanaged", new Date()],
    );
    await pool.query("INSERT INTO kiosks (tenant_id, name) VALUES ($1, $2)", [
      "existing-unmanaged",
      "Legacy kiosk",
    ]);
    const legacyDeviceId = "00000000-0000-4000-8000-000000000036";
    await pool.query("INSERT INTO station_devices (id, tenant_id, name) VALUES ($1, $2, $3)", [
      legacyDeviceId,
      "existing-unmanaged",
      "Legacy SSCC device",
    ]);
    await pool.query(
      `INSERT INTO sscc_counters (tenant_id, issuer_prefix, extension_digit, next_serial)
       VALUES
         ('existing-unmanaged', '460000001', 0, 0),
         ('existing-unmanaged', '460000001', 1, 0),
         ('existing-unmanaged', '460000002', 0, 0),
         ('existing-unmanaged', '460000003', 0, 7)`,
    );
    await pool.query(
      `INSERT INTO sscc_blocks (tenant_id, issuer_prefix, extension_digit, device_id, from_serial, to_serial)
       VALUES ('existing-unmanaged', '460000002', 0, $1, 0, 9)`,
      [legacyDeviceId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
    const upgradedDefaultColumn = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_profiles'
         AND column_name = 'default_box_label_template_id'`,
    );
    upgradedHasDefaultBoxLabelTemplateColumn = upgradedDefaultColumn.rows[0]?.count === 1;
    await pool.query(
      "INSERT INTO platform_users (id, name, email, role, status) VALUES ($1, $2, $3, 'platform_admin', 'active')",
      ["migration-test-admin", "Migration test admin", "migration-test-admin@example.invalid"],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) {
      await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    }
    await maintenancePool.end();
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing organizations as unmanaged tenants", async () => {
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM tenant_subscriptions WHERE tenant_id = $1",
      ["existing-unmanaged"],
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("upgrades from a schema older than the default box label contract", () => {
    expect(legacyHasDefaultBoxLabelTemplateColumn).toBe(false);
    expect(upgradedHasDefaultBoxLabelTemplateColumn).toBe(true);
  });

  it("disables employee QR printing for an existing kiosk during upgrade", async () => {
    const result = await pool.query(
      `SELECT print_employee_qr_on_slip
       FROM kiosks
       WHERE tenant_id = $1 AND name = $2`,
      ["existing-unmanaged", "Legacy kiosk"],
    );
    expect(result.rows).toEqual([{ print_employee_qr_on_slip: false }]);

    const column = await pool.query(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'kiosks'
         AND column_name = 'print_employee_qr_on_slip'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "NO", column_default: "false" }]);
  });

  it("moves only untouched box counters from zero to one", async () => {
    const result = await pool.query(
      `SELECT issuer_prefix, extension_digit, next_serial::int
       FROM sscc_counters
       WHERE tenant_id = 'existing-unmanaged'
       ORDER BY issuer_prefix, extension_digit`,
    );

    expect(result.rows).toEqual([
      { issuer_prefix: "460000001", extension_digit: 0, next_serial: 1 },
      { issuer_prefix: "460000001", extension_digit: 1, next_serial: 0 },
      { issuer_prefix: "460000002", extension_digit: 0, next_serial: 0 },
      { issuer_prefix: "460000003", extension_digit: 0, next_serial: 7 },
    ]);
  });

  it("applies Better Auth two-factor defaults required by the platform plugin", async () => {
    const id = `two-factor-${randomUUID()}`;
    await pool.query(
      "INSERT INTO platform_two_factors (id, secret, backup_codes, user_id) VALUES ($1, 'encrypted-secret', 'encrypted-codes', 'migration-test-admin')",
      [id],
    );

    const result = await pool.query(
      "SELECT verified, failed_verification_count, locked_until FROM platform_two_factors WHERE id = $1",
      [id],
    );
    expect(result.rows[0]).toEqual({
      verified: true,
      failed_verification_count: 0,
      locked_until: null,
    });
  });

  it("accepts only one platform, customer-user, or tenant delivery scope", async () => {
    const platformDeliveryId = randomUUID();
    await expect(
      pool.query(
        "INSERT INTO email_deliveries (id, platform_user_id, recipient, kind) VALUES ($1, 'migration-test-admin', 'platform@example.invalid', 'platform-user-activation')",
        [platformDeliveryId],
      ),
    ).resolves.toBeDefined();

    await expect(
      pool.query(
        "INSERT INTO email_deliveries (id, recipient, kind) VALUES ($1, 'missing@example.invalid', 'platform-user-activation')",
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO email_deliveries (id, tenant_id, platform_user_id, recipient, kind) VALUES ($1, 'existing-unmanaged', 'migration-test-admin', 'multiple@example.invalid', 'platform-user-activation')",
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it("rejects update and deletion of a published catalog version", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'service')",
      [catalogItemId, `service-${catalogItemId}`, "Услуга", "Service"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, unit_price, vat_included, published_at) VALUES ($1, $2, 'service', 1, 'published', $3, $4, 'service', 'one_time', '100.00', true, now())",
      [versionId, catalogItemId, "Услуга", "Service"],
    );

    await expect(
      pool.query("UPDATE catalog_item_versions SET name_en = 'Changed' WHERE id = $1", [versionId]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM catalog_item_versions WHERE id = $1", [versionId]),
    ).rejects.toThrow();
  });

  it("rejects a second current subscription for one tenant", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'plan')",
      [catalogItemId, `plan-${catalogItemId}`, "План", "Plan"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included, published_at) VALUES ($1, $2, 'plan', 1, 'published', $3, $4, 'subscription', 'recurring', 'month', '100.00', true, now())",
      [versionId, catalogItemId, "План", "Plan"],
    );
    await pool.query(
      "INSERT INTO tenant_subscriptions (tenant_id, plan_version_id, status, source) VALUES ($1, $2, 'active', 'manual')",
      ["existing-unmanaged", versionId],
    );

    await expect(
      pool.query(
        "INSERT INTO tenant_subscriptions (tenant_id, plan_version_id, status, source) VALUES ($1, $2, 'trial', 'demo')",
        ["existing-unmanaged", versionId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a negative add-on effect", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'addon')",
      [catalogItemId, `addon-${catalogItemId}`, "Дополнение", "Add-on"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included) VALUES ($1, $2, 'addon', 1, 'draft', $3, $4, 'unit', 'recurring', 'month', '100.00', true)",
      [versionId, catalogItemId, "Дополнение", "Add-on"],
    );

    await expect(
      pool.query(
        "INSERT INTO addon_entitlements (catalog_version_id, entitlement_key, quota_increment, feature_enabled) VALUES ($1, 'lines', -1, false)",
        [versionId],
      ),
    ).rejects.toThrow();
  });

  it("rejects moving a published plan entitlement to a draft version", async () => {
    const catalogItemId = randomUUID();
    const publishedVersionId = randomUUID();
    const draftVersionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'План', 'Plan', 'plan')",
      [catalogItemId, `plan-reparent-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included) VALUES ($1, $3, 'plan', 1, 'draft', 'План 1', 'Plan 1', 'subscription', 'recurring', 'month', '100.00', true), ($2, $3, 'plan', 2, 'draft', 'План 2', 'Plan 2', 'subscription', 'recurring', 'month', '100.00', true)",
      [publishedVersionId, draftVersionId, catalogItemId],
    );
    await pool.query(
      "INSERT INTO plan_entitlements (catalog_version_id, max_lines) VALUES ($1, 1)",
      [publishedVersionId],
    );
    await pool.query(
      "UPDATE catalog_item_versions SET status = 'published', published_at = now() WHERE id = $1",
      [publishedVersionId],
    );

    await expect(
      pool.query("UPDATE plan_entitlements SET max_lines = 2 WHERE catalog_version_id = $1", [
        publishedVersionId,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE plan_entitlements SET catalog_version_id = $1 WHERE catalog_version_id = $2",
        [draftVersionId, publishedVersionId],
      ),
    ).rejects.toThrow();
  });

  it("rejects moving a published add-on effect to a draft version", async () => {
    const catalogItemId = randomUUID();
    const publishedVersionId = randomUUID();
    const draftVersionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'Дополнение', 'Add-on', 'addon')",
      [catalogItemId, `addon-reparent-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included) VALUES ($1, $3, 'addon', 1, 'draft', 'Дополнение 1', 'Add-on 1', 'unit', 'recurring', 'month', '100.00', true), ($2, $3, 'addon', 2, 'draft', 'Дополнение 2', 'Add-on 2', 'unit', 'recurring', 'month', '100.00', true)",
      [publishedVersionId, draftVersionId, catalogItemId],
    );
    await pool.query(
      "INSERT INTO addon_entitlements (catalog_version_id, entitlement_key, quota_increment) VALUES ($1, 'lines', 1)",
      [publishedVersionId],
    );
    await pool.query(
      "UPDATE catalog_item_versions SET status = 'published', published_at = now() WHERE id = $1",
      [publishedVersionId],
    );

    await expect(
      pool.query(
        "UPDATE addon_entitlements SET quota_increment = 2 WHERE catalog_version_id = $1",
        [publishedVersionId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE addon_entitlements SET catalog_version_id = $1 WHERE catalog_version_id = $2",
        [draftVersionId, publishedVersionId],
      ),
    ).rejects.toThrow();
  });

  it("rejects mutation and reparenting of a published offer line", async () => {
    const tenantId = `offer-tenant-${randomUUID()}`;
    const publishedOfferId = randomUUID();
    const draftOfferId = randomUUID();
    const lineId = randomUUID();
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Offer tenant', $2, now())",
      [tenantId, tenantId],
    );
    await pool.query(
      "INSERT INTO commercial_offers (id, tenant_id, family_id, revision, status, total) VALUES ($1, $3, $1, 1, 'draft', '100.00'), ($2, $3, $2, 1, 'draft', '100.00')",
      [publishedOfferId, draftOfferId, tenantId],
    );
    await pool.query(
      "INSERT INTO commercial_offer_lines (id, tenant_id, offer_id, position, kind, name_ru, name_en, quantity, unit, agreed_unit_price, vat_included, line_total) VALUES ($1, $2, $3, 1, 'service', 'Услуга', 'Service', 1, 'service', '100.00', true, '100.00')",
      [lineId, tenantId, publishedOfferId],
    );
    await pool.query(
      "UPDATE commercial_offers SET status = 'published', published_at = now() WHERE id = $1",
      [publishedOfferId],
    );

    await expect(
      pool.query("UPDATE commercial_offer_lines SET name_en = 'Changed' WHERE id = $1", [lineId]),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE commercial_offer_lines SET offer_id = $1 WHERE id = $2", [
        draftOfferId,
        lineId,
      ]),
    ).rejects.toThrow();
  });

  it("allows only a status-only published-to-retired catalog transition", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'Услуга', 'Service', 'service')",
      [catalogItemId, `retire-service-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, unit_price, vat_included, published_at) VALUES ($1, $2, 'service', 1, 'published', 'Услуга', 'Service', 'service', 'one_time', '100.00', true, now())",
      [versionId, catalogItemId],
    );

    await expect(
      pool.query(
        "UPDATE catalog_item_versions SET status = 'retired', name_en = 'Changed' WHERE id = $1",
        [versionId],
      ),
    ).rejects.toThrow();
    const retired = await pool.query(
      "UPDATE catalog_item_versions SET status = 'retired', updated_at = now() WHERE id = $1 RETURNING status",
      [versionId],
    );
    expect(retired.rows[0]?.status).toBe("retired");
    await expect(
      pool.query("UPDATE catalog_item_versions SET name_en = 'Changed' WHERE id = $1", [versionId]),
    ).rejects.toThrow();
  });

  it("rejects retiring the configured default demo version", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'Демо', 'Demo', 'plan')",
      [catalogItemId, `default-demo-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included) VALUES ($1, $2, 'plan', 1, 'draft', 'Демо', 'Demo', 'subscription', 'recurring', 'month', '0.00', true)",
      [versionId, catalogItemId],
    );
    await pool.query(
      "INSERT INTO plan_entitlements (catalog_version_id, demo_duration_days) VALUES ($1, 14)",
      [versionId],
    );
    await pool.query(
      "UPDATE catalog_item_versions SET status = 'published', published_at = now() WHERE id = $1",
      [versionId],
    );
    await pool.query(
      "INSERT INTO platform_settings (key, default_demo_catalog_version_id) VALUES ('default', $1)",
      [versionId],
    );

    await expect(
      pool.query("UPDATE catalog_item_versions SET status = 'retired' WHERE id = $1", [versionId]),
    ).rejects.toThrow();
  });

  it("keeps payment, fulfilment, subscription-event, and platform-audit facts append-only", async () => {
    const tenantId = `facts-tenant-${randomUUID()}`;
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    const offerId = randomUUID();
    const lineId = randomUUID();
    const paymentId = randomUUID();
    const subscriptionId = randomUUID();
    const fulfilmentId = randomUUID();
    const eventId = randomUUID();
    const auditId = randomUUID();
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Facts tenant', $2, now())",
      [tenantId, tenantId],
    );
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'План', 'Plan', 'plan')",
      [catalogItemId, `facts-plan-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included, published_at) VALUES ($1, $2, 'plan', 1, 'published', 'План', 'Plan', 'subscription', 'recurring', 'month', '100.00', true, now())",
      [versionId, catalogItemId],
    );
    await pool.query(
      "INSERT INTO commercial_offers (id, tenant_id, family_id, revision, status, total) VALUES ($1, $2, $1, 1, 'draft', '100.00')",
      [offerId, tenantId],
    );
    await pool.query(
      "INSERT INTO commercial_offer_lines (id, tenant_id, offer_id, position, kind, catalog_version_id, name_ru, name_en, quantity, unit, catalog_unit_price, agreed_unit_price, vat_included, activation_policy, line_total) VALUES ($1, $2, $3, 1, 'plan', $4, 'План', 'Plan', 1, 'subscription', '100.00', '100.00', true, 'immediately', '100.00')",
      [lineId, tenantId, offerId, versionId],
    );
    await pool.query("UPDATE commercial_offers SET status = 'published' WHERE id = $1", [offerId]);
    await pool.query(
      "INSERT INTO payments (id, tenant_id, offer_id, paid_at, amount, bank_reference, platform_user_id, idempotency_key) VALUES ($1, $2, $3, now(), '100.00', 'bank-1', 'migration-test-admin', $4)",
      [paymentId, tenantId, offerId, `payment-${paymentId}`],
    );
    await pool.query(
      "INSERT INTO tenant_subscriptions (id, tenant_id, plan_version_id, status, source, source_offer_line_id) VALUES ($1, $2, $3, 'active', 'paid_offer_line', $4)",
      [subscriptionId, tenantId, versionId, lineId],
    );
    await pool.query(
      "INSERT INTO offer_line_fulfilments (id, tenant_id, offer_line_id, payment_id, kind, tenant_subscription_id, fulfilled_at) VALUES ($1, $2, $3, $4, 'subscription', $5, now())",
      [fulfilmentId, tenantId, lineId, paymentId, subscriptionId],
    );
    await pool.query(
      "INSERT INTO subscription_events (id, tenant_id, subscription_id, event_kind, effective_at, source) VALUES ($1, $2, $3, 'activated', now(), 'payment')",
      [eventId, tenantId, subscriptionId],
    );
    await pool.query(
      "INSERT INTO platform_audit_events (id, actor_platform_user_id, actor_role, action, outcome, tenant_id, target_type, target_id) VALUES ($1, 'migration-test-admin', 'platform_admin', 'payment.recorded', 'success', $2, 'payment', $3)",
      [auditId, tenantId, paymentId],
    );

    await expect(
      pool.query("UPDATE payments SET bank_reference = 'changed' WHERE id = $1", [paymentId]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM offer_line_fulfilments WHERE id = $1", [fulfilmentId]),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE subscription_events SET reason = 'changed' WHERE id = $1", [eventId]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM platform_audit_events WHERE id = $1", [auditId]),
    ).rejects.toThrow();
  });

  it("keeps ordered-service facts append-only", async () => {
    const tenantId = `service-facts-tenant-${randomUUID()}`;
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    const offerId = randomUUID();
    const lineId = randomUUID();
    const paymentId = randomUUID();
    const orderedServiceId = randomUUID();
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Service facts tenant', $2, now())",
      [tenantId, tenantId],
    );
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, 'Обучение', 'Training', 'service')",
      [catalogItemId, `service-facts-${catalogItemId}`],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, unit_price, vat_included, published_at) VALUES ($1, $2, 'service', 1, 'published', 'Обучение', 'Training', 'service', 'one_time', '100.00', true, now())",
      [versionId, catalogItemId],
    );
    await pool.query(
      "INSERT INTO commercial_offers (id, tenant_id, family_id, revision, status, total) VALUES ($1, $2, $1, 1, 'draft', '100.00')",
      [offerId, tenantId],
    );
    await pool.query(
      "INSERT INTO commercial_offer_lines (id, tenant_id, offer_id, position, kind, catalog_version_id, name_ru, name_en, quantity, unit, catalog_unit_price, agreed_unit_price, vat_included, line_total) VALUES ($1, $2, $3, 1, 'service', $4, 'Обучение', 'Training', 1, 'service', '100.00', '100.00', true, '100.00')",
      [lineId, tenantId, offerId, versionId],
    );
    await pool.query("UPDATE commercial_offers SET status = 'published' WHERE id = $1", [offerId]);
    await pool.query(
      "INSERT INTO payments (id, tenant_id, offer_id, paid_at, amount, bank_reference, platform_user_id, idempotency_key) VALUES ($1, $2, $3, now(), '100.00', 'bank-service-1', 'migration-test-admin', $4)",
      [paymentId, tenantId, offerId, `service-payment-${paymentId}`],
    );
    await pool.query(
      "INSERT INTO ordered_services (id, tenant_id, offer_line_id, payment_id, catalog_version_id, name_ru, name_en, quantity, unit, ordered_at) VALUES ($1, $2, $3, $4, $5, 'Обучение', 'Training', 1, 'service', now())",
      [orderedServiceId, tenantId, lineId, paymentId, versionId],
    );

    await expect(
      pool.query("UPDATE ordered_services SET status = 'in_progress' WHERE id = $1", [
        orderedServiceId,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM ordered_services WHERE id = $1", [orderedServiceId]),
    ).rejects.toThrow();
  });
});
