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
// The DB has no runtime dependency on domain. Compare the migration fixture with its public build.
import { buildDuplicateLabelTemplate } from "../../domain/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const hash = "a".repeat(64);
const seedName = "Дубликат Data Matrix 58×40 (203 dpi)";
const fixture = (tenant: string) => ({
  tenant,
  product: randomUUID(),
  shift: randomUUID(),
  device: randomUUID(),
  operator: randomUUID(),
  template: randomUUID(),
  job: randomUUID(),
});
const a = fixture("a");
const b = fixture("b");
const fixtures = [a, b];

describe.skipIf(!databaseUrl)("product label migration", () => {
  const name = `markiro_product_labels_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  let legacy = "";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    legacy = await mkdtemp(join(tmpdir(), "markiro-product-label-upgrade-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 112,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    for (const f of fixtures) {
      await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
        f.tenant,
      ]);
      await pool.query(
        "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,$2,'04601234567893','Product')",
        [f.product, f.tenant],
      );
      // Deliberate colliding name: a legacy box must never be relabelled as a duplicate template.
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,spec) VALUES($1,$2,$3,'{\"custom\":true}')",
        [f.template, f.tenant, seedName],
      );
      await pool.query(
        "INSERT INTO org_profiles(tenant_id,default_box_label_template_id) VALUES($1,$2)",
        [f.tenant, f.template],
      );
      await pool.query(
        "INSERT INTO shifts(id,tenant_id,product_id,mode,number_month_key,number_seq) VALUES($1,$2,$3,'validation','SEP26',1)",
        [f.shift, f.tenant, f.product],
      );
      await pool.query("INSERT INTO station_devices(id,tenant_id,name) VALUES($1,$2,'Device')", [
        f.device,
        f.tenant,
      ]);
      await pool.query("INSERT INTO employees(id,tenant_id,full_name) VALUES($1,$2,'Operator')", [
        f.operator,
        f.tenant,
      ]);
    }
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (legacy) await rm(legacy, { recursive: true, force: true });
  });

  it("upgrades ordinary shifts without enabling print or changing box defaults", async () => {
    const shifts = await pool.query(
      "SELECT validation_print_mode, validation_print_verification, validation_print_template_id, validation_print_snapshot, validation_print_policy_revision FROM shifts ORDER BY tenant_id",
    );
    expect(shifts.rows).toEqual(
      fixtures.map(() => ({
        validation_print_mode: "none",
        validation_print_verification: "none",
        validation_print_template_id: null,
        validation_print_snapshot: null,
        validation_print_policy_revision: null,
      })),
    );
    for (const f of fixtures) {
      const templates = await pool.query(
        "SELECT id,purpose,spec FROM label_templates WHERE tenant_id=$1 AND name=$2 ORDER BY purpose",
        [f.tenant, seedName],
      );
      expect(templates.rows).toEqual([
        { id: f.template, purpose: "box", spec: { custom: true } },
        {
          id: expect.any(String),
          purpose: "product_duplicate",
          spec: buildDuplicateLabelTemplate(),
        },
      ]);
      const profiles = await pool.query(
        "SELECT default_box_label_template_id FROM org_profiles WHERE tenant_id=$1",
        [f.tenant],
      );
      expect(profiles.rows).toEqual([{ default_box_label_template_id: f.template }]);
    }
  });

  it("seeds each tenant idempotently and preserves customized duplicate templates", async () => {
    const sql = await readFile(join(migrationsFolder, "0113_validation_dm_duplicate.sql"), "utf8");
    const seed = sql
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes('INSERT INTO "label_templates"'));
    expect(seed).toBeDefined();
    if (!seed) throw new Error("Missing product duplicate backfill");
    await pool.query(
      "UPDATE label_templates SET spec='{\"customDuplicate\":true}', enabled=false WHERE tenant_id=$1 AND purpose='product_duplicate'",
      [a.tenant],
    );
    await pool.query(seed);
    await pool.query(seed);
    const rows = await pool.query(
      "SELECT tenant_id, spec, enabled FROM label_templates WHERE purpose='product_duplicate' ORDER BY tenant_id",
    );
    expect(rows.rows).toEqual([
      { tenant_id: a.tenant, spec: { customDuplicate: true }, enabled: false },
      { tenant_id: b.tenant, spec: buildDuplicateLabelTemplate(), enabled: true },
    ]);
  });

  it.each([
    "validation_print_mode='invalid'",
    "validation_print_verification='required'",
    "validation_print_mode='duplicate_dm'",
    "validation_print_snapshot='{}'::jsonb",
  ])("rejects incomplete/invalid policy: %s", async (update) => {
    await expect(
      pool.query(`UPDATE shifts SET ${update} WHERE id=$1`, [a.shift]),
    ).rejects.toMatchObject({ code: "23514", constraint: "shifts_validation_print_policy_check" });
  });

  it.each(["none", "required"])(
    "accepts complete validation print policy with %s verification",
    async (verification) => {
      await pool.query(
        "UPDATE shifts SET validation_print_mode='duplicate_dm',validation_print_verification=$2,validation_print_template_id=$3,validation_print_snapshot='{}',validation_print_policy_revision=$4 WHERE id=$1",
        [a.shift, verification, a.template, randomUUID()],
      );
      await expect(
        pool.query("UPDATE shifts SET mode='aggregation' WHERE id=$1", [a.shift]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE shifts SET validation_print_template_id=$2 WHERE id=$1", [
          a.shift,
          b.template,
        ]),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "shifts_tenant_validation_print_template_fk",
      });
    },
  );

  it("rejects unsupported template purposes", async () => {
    await expect(
      pool.query("UPDATE label_templates SET purpose='unknown' WHERE id=$1", [a.template]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  async function insertJob(
    tenant: string,
    device: string,
    shift: string,
    job = randomUUID(),
    seq = 1,
  ): Promise<void> {
    await pool.query(
      "INSERT INTO product_label_jobs(tenant_id,device_id,job_id,shift_id,code_hash,accepted_at,policy_revision,template_digest,payload_digest,latest_sequence,projection) VALUES($1,$2,$3,$4,$5,now(),$6,$5,$5,$7,'{}')",
      [tenant, device, job, shift, hash, randomUUID(), seq],
    );
  }
  async function insertEvent(
    device: string,
    operator: string,
    eventId: string,
    sequence: number,
  ): Promise<void> {
    await pool.query(
      "INSERT INTO product_label_events(tenant_id,device_id,job_id,event_id,sequence,operator_id,event,payload_digest,receive_status) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,'accepted')",
      [a.tenant, device, a.job, eventId, sequence, operator, hash],
    );
  }

  it("enforces tenant/device/shift ownership and safe sequence values", async () => {
    await expect(insertJob(a.tenant, b.device, a.shift)).rejects.toMatchObject({ code: "23503" });
    await expect(insertJob(a.tenant, a.device, b.shift)).rejects.toMatchObject({ code: "23503" });
    await expect(insertJob(a.tenant, a.device, a.shift, randomUUID(), 0)).rejects.toMatchObject({
      code: "23514",
    });
    await insertJob(a.tenant, a.device, a.shift, a.job, Number.MAX_SAFE_INTEGER);
    await expect(insertJob(a.tenant, a.device, a.shift, a.job)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("rejects foreign operators and enforces event identity and per-job order uniqueness", async () => {
    const eventId = randomUUID();
    await expect(insertEvent(a.device, b.operator, eventId, 1)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insertEvent(b.device, a.operator, eventId, 1)).rejects.toMatchObject({
      code: "23503",
    });
    await insertEvent(a.device, a.operator, eventId, Number.MAX_SAFE_INTEGER);
    await expect(insertEvent(a.device, a.operator, eventId, 2)).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      insertEvent(a.device, a.operator, randomUUID(), Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("retains a rejection receipt without a parent, once per owning device/event", async () => {
    const eventId = randomUUID();
    const insert = (device: string) =>
      pool.query(
        "INSERT INTO product_label_event_receipts(tenant_id,device_id,event_id,payload_digest,outcome,rejection_code) VALUES($1,$2,$3,$4,'quarantined','parent_missing')",
        [a.tenant, device, eventId, hash],
      );
    await expect(insert(b.device)).rejects.toMatchObject({ code: "23503" });
    await insert(a.device);
    await expect(insert(a.device)).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("UPDATE product_label_event_receipts SET outcome='accepted' WHERE event_id=$1", [
        eventId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE product_label_event_receipts SET rejection_code=NULL WHERE event_id=$1", [
        eventId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("retains the rejected physical fact in quarantine without a fake parent shift", async () => {
    await pool.query("INSERT INTO sync_batches(tenant_id,batch_id) VALUES($1,'print-quarantine')", [
      a.tenant,
    ]);
    const unknownShift = randomUUID();
    await pool.query(
      "INSERT INTO station_sync_quarantine(tenant_id,batch_id,terminal_id,payload_digest,record_kind,record_index,shift_id,reason,payload) VALUES($1,'print-quarantine',$2,$3,'product_label_event',0,$4,'parent_missing','{\"physicalFact\":true}')",
      [a.tenant, a.device, hash, unknownShift],
    );
    const rows = await pool.query(
      "SELECT shift_id,reason,payload FROM station_sync_quarantine WHERE tenant_id=$1",
      [a.tenant],
    );
    expect(rows.rows).toEqual([
      { shift_id: unknownShift, reason: "parent_missing", payload: { physicalFact: true } },
    ]);
  });
});
