import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDuplicateLabelTemplates,
  buildPreviousDuplicateLabelTemplates,
  productLabelValueDigest,
} from "@markiro/domain";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const family = "Дубликат Data Matrix 58×40";
const shortName = `${family} [Краткое наименование]`;
const fullName = `${family} [Полное наименование]`;

describe.skipIf(!databaseUrl)("duplicate label full-width name migration", () => {
  const name = `markiro_duplicate_width_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
  });

  it("upgrades untouched stock in place and leaves edits, foreign names and snapshots alone", async () => {
    const previous = buildPreviousDuplicateLabelTemplates();
    const previousShort = previous.find((row) => row.name === shortName)?.spec;
    const previousFull = previous.find((row) => row.name === fullName)?.spec;
    if (!previousShort || !previousFull) throw new Error("Missing previous duplicate presets");

    const tenants = { stock: randomUUID(), edited: randomUUID() };
    for (const id of Object.values(tenants))
      await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$2,$3,now())", [
        id,
        `Tenant ${id.slice(0, 8)}`,
        id,
      ]);

    const ids = {
      short: randomUUID(),
      full: randomUUID(),
      disabled: randomUUID(),
      edited: randomUUID(),
      editedUnderStockName: randomUUID(),
      renamed: randomUUID(),
    };
    const entries = [
      // Untouched stock, both variants: the rows this migration exists for.
      { id: ids.short, tenant: tenants.stock, name: shortName, spec: previousShort, enabled: true },
      { id: ids.full, tenant: tenants.stock, name: fullName, spec: previousFull, enabled: true },
      // Untouched but switched off. The layout still moves; the switch does not.
      {
        id: ids.disabled,
        tenant: tenants.edited,
        name: shortName,
        spec: previousShort,
        enabled: false,
      },
      // Edited by the tenant: one changed number is enough to make it theirs.
      {
        id: ids.edited,
        tenant: tenants.edited,
        name: fullName,
        spec: { ...previousFull, widthMm: 60 },
        enabled: true,
      },
      // The case the `spec` guard exists for, and the easiest to lose: a
      // tenant edited the stock template and never renamed it, so only the
      // bytes say it is theirs. Matching on the name alone would overwrite it.
      {
        id: ids.editedUnderStockName,
        tenant: tenants.stock,
        name: shortName,
        spec: { ...previousShort, heightMm: 45 },
        enabled: true,
      },
      // The stock bytes under a name the tenant chose. Not ours to rewrite.
      {
        id: ids.renamed,
        tenant: tenants.stock,
        name: "Мой дубликат",
        spec: previousShort,
        enabled: true,
      },
    ];
    for (const entry of entries)
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,'product_duplicate',$4::jsonb,$5)",
        [entry.id, entry.tenant, entry.name, JSON.stringify(entry.spec), entry.enabled],
      );

    // A shift that already printed with the old layout. Its snapshot is a
    // record of what went on paper, so the migration must not touch it.
    const product = randomUUID();
    const shift = randomUUID();
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,$2,'04600000000015','Product')",
      [product, tenants.stock],
    );
    const content = { id: ids.short, name: shortName, spec: previousShort };
    const snapshot = { ...content, digest: productLabelValueDigest(content) };
    await pool.query(
      "INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,opened_at,validation_print_mode,validation_print_verification,validation_print_template_id,validation_print_snapshot,validation_print_policy_revision) VALUES($1,$2,$3,'validation','active','SEP26',1,now(),'duplicate_dm','required',$4,$5::jsonb,$6)",
      [shift, tenants.stock, product, ids.short, JSON.stringify(snapshot), randomUUID()],
    );

    const sql = await readFile(
      new URL("../migrations/0141_duplicate_label_full_width_name.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);

    const rows = (
      await pool.query<{ id: string; name: string; enabled: boolean; spec: unknown }>(
        "SELECT id,name,enabled,spec FROM label_templates",
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const current = buildDuplicateLabelTemplates();
    const nextShort = current.find((row) => row.name === shortName)?.spec;
    const nextFull = current.find((row) => row.name === fullName)?.spec;

    expect(byId.get(ids.short)).toMatchObject({ spec: nextShort, enabled: true, name: shortName });
    expect(byId.get(ids.full)).toMatchObject({ spec: nextFull, enabled: true, name: fullName });
    // Disabled rows are upgraded too, and stay disabled.
    expect(byId.get(ids.disabled)).toMatchObject({ spec: nextShort, enabled: false });
    // Untouched: an edit and a tenant-chosen name both opt out.
    expect(byId.get(ids.edited)?.spec).toEqual({ ...previousFull, widthMm: 60 });
    expect(byId.get(ids.editedUnderStockName)?.spec).toEqual({ ...previousShort, heightMm: 45 });
    expect(byId.get(ids.renamed)?.spec).toEqual(previousShort);

    const snapshotRow = (
      await pool.query<{ validation_print_snapshot: { spec: unknown; digest: string } }>(
        "SELECT validation_print_snapshot FROM shifts WHERE id=$1",
        [shift],
      )
    ).rows[0];
    expect(snapshotRow?.validation_print_snapshot.spec).toEqual(previousShort);
    expect(snapshotRow?.validation_print_snapshot.digest).toBe(snapshot.digest);

    // Idempotent: a second application finds nothing left to match.
    await pool.query(sql);
    const after = (
      await pool.query<{ id: string; spec: unknown }>("SELECT id,spec FROM label_templates")
    ).rows;
    expect(new Map(after.map((row) => [row.id, row.spec])).get(ids.short)).toEqual(nextShort);
  });
});
