import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
describe.skipIf(!databaseUrl)("P1 additive migrations and transactional revisions", () => {
  const databaseName = `markiro_p1_migration_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const planId = randomUUID(),
    addonId = randomUUID(),
    subscriptionA = randomUUID(),
    subscriptionB = randomUUID();
  const effects = [{ key: "chzIntegration", featureEnabled: true }];
  const operations = ["nk.lookup.v1"];
  let legacyPlan: unknown, legacyVersion: unknown;
  async function revision(tenant = "p1-a") {
    const result = await pool.query<{ revision: string; usage_revision: string }>(
      "SELECT revision,usage_revision FROM entitlement_revisions WHERE tenant_id=$1",
      [tenant],
    );
    return {
      revision: BigInt(result.rows[0]?.revision ?? "0"),
      usage: BigInt(result.rows[0]?.usage_revision ?? "0"),
    };
  }
  async function insertSource(
    overrides: {
      tenant?: string;
      subscription?: string;
      kind?: string;
      end?: string | null;
      start?: string;
      request?: string;
      version?: number;
      effect?: unknown;
      decision?: string;
    } = {},
  ) {
    return pool.query(
      "INSERT INTO entitlement_sources (tenant_id,subscription_id,kind,version,effects,operation_ids,starts_at,ends_at,reason,decision_reference,request_id,created_by_platform_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Approved test scope',$10,$9,'p1-admin') RETURNING *",
      [
        overrides.tenant ?? "p1-a",
        overrides.subscription ?? subscriptionA,
        overrides.kind ?? "temporary",
        overrides.version ?? 1,
        JSON.stringify(overrides.effect ?? effects),
        JSON.stringify(operations),
        overrides.start ?? "2026-09-11T00:00:00Z",
        overrides.end === undefined ? "2026-09-12T00:00:00Z" : overrides.end,
        overrides.request ?? randomUUID(),
        overrides.decision ?? "fixture-only",
      ],
    );
  }
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-p1-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 129,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('p1-a','A','p1-a',now()),('p1-b','B','p1-b',now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id,name,email,role,status) VALUES ('p1-admin','Admin','p1-admin@example.invalid','platform_admin','active')",
    );
    for (const [id, kind] of [
      [planId, "plan"],
      [addonId, "addon"],
    ]) {
      await pool.query(
        "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1::uuid,$1::text,$2,'История','History')",
        [id, kind],
      );
      await pool.query(
        "INSERT INTO catalog_item_versions (id,catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,unit_price,vat_included) VALUES ($1,$1,$2,1,'История','History','month','recurring','month','12.34',false)",
        [id, kind],
      );
    }
    await pool.query(
      "INSERT INTO plan_entitlements (catalog_version_id,max_lines,max_stations,max_kiosks,max_cabinet_users,label_editor_enabled) VALUES ($1,0,null,2,3,true)",
      [planId],
    );
    for (const [tenant, subscription] of [
      ["p1-a", subscriptionA],
      ["p1-b", subscriptionB],
    ])
      await pool.query(
        "INSERT INTO tenant_subscriptions (id,tenant_id,plan_version_id,status,source,starts_at,ends_at) VALUES ($1,$2,$3,'active','manual','2026-01-01',null)",
        [subscription, tenant, planId],
      );
    legacyPlan = (
      await pool.query(
        "SELECT to_jsonb(t) AS value FROM plan_entitlements t WHERE catalog_version_id=$1",
        [planId],
      )
    ).rows[0]?.value;
    legacyVersion = (
      await pool.query("SELECT to_jsonb(t) AS value FROM catalog_item_versions t WHERE id=$1", [
        planId,
      ])
    ).rows[0]?.value;
    const applied = await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(applied.packaged).toContain("0130_entitlements_p1a");
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  it("preserves legacy null/zero/unlimited and every existing catalog field without approved seeds", async () => {
    const columns = [
      "chz_integration_enabled",
      "inventory_enabled",
      "commerce_ml_enabled",
      "handheld_enabled",
    ];
    const plan = (
      await pool.query(
        "SELECT to_jsonb(t) AS value FROM plan_entitlements t WHERE catalog_version_id=$1",
        [planId],
      )
    ).rows[0]?.value;
    for (const column of columns) expect(plan[column]).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t)-$2::text[] AS value FROM plan_entitlements t WHERE catalog_version_id=$1",
          [planId, columns],
        )
      ).rows[0]?.value,
    ).toEqual(legacyPlan);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t)-'lifecycle_policy_id' AS value,lifecycle_policy_id FROM catalog_item_versions t WHERE id=$1",
          [planId],
        )
      ).rows[0],
    ).toEqual({ value: legacyVersion, lifecycle_policy_id: null });
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM entitlement_lifecycle_policies"))
        .rows[0]?.count,
    ).toBe(0);
  });
  it("accepts each new enum feature after the transactional migration and rejects quota-shaped features", async () => {
    for (const key of ["chzIntegration", "inventory", "commerceMl", "handheld"]) {
      await pool.query(
        "INSERT INTO addon_entitlements (catalog_version_id,entitlement_key,feature_enabled) VALUES ($1,$2,true)",
        [addonId, key],
      );
      await expect(
        pool.query(
          "UPDATE addon_entitlements SET quota_increment=1,feature_enabled=false WHERE catalog_version_id=$1 AND entitlement_key=$2",
          [addonId, key],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it("enforces source tenant scope, finite temporary intervals, positive versions and request uniqueness", async () => {
    await expect(insertSource({ tenant: "p1-b" })).rejects.toMatchObject({ code: "23503" });
    for (const invalid of [
      { end: null },
      { end: "2026-09-11T00:00:00Z" },
      { end: "infinity" },
      { start: "-infinity" },
      { version: 0 },
      { effect: [] },
      { effect: {} },
      { kind: "compatibility", effect: [{ key: "lines", quotaIncrement: 1 }] },
    ])
      await expect(insertSource(invalid)).rejects.toMatchObject({ code: "23514" });
    const request = randomUUID();
    await insertSource({ request });
    await expect(insertSource({ request })).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM entitlement_sources WHERE tenant_id='p1-a' AND request_id=$1",
          [request],
        )
      ).rows[0]?.count,
    ).toBe(1);
    await insertSource({ kind: "compatibility", end: null });
  });
  it("retains immutable source payload and complete irreversible revocation facts", async () => {
    const source = (await insertSource()).rows[0];
    await expect(
      pool.query("UPDATE entitlement_sources SET reason='rewrite' WHERE id=$1", [source.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE entitlement_sources SET revoked_at=now() WHERE id=$1", [source.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const before = await revision();
    await pool.query(
      "UPDATE entitlement_sources SET revoked_at=now(),revoked_by_platform_user_id='p1-admin',revocation_reason='Fixture revoke',revocation_decision_reference='fixture-only',revocation_request_id=$2 WHERE id=$1",
      [source.id, randomUUID()],
    );
    expect((await revision()).revision).toBeGreaterThan(before.revision);
    await expect(
      pool.query("UPDATE entitlement_sources SET revocation_reason='rewrite' WHERE id=$1", [
        source.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE entitlement_sources SET revoked_at=null,revoked_by_platform_user_id=null,revocation_reason=null,revocation_decision_reference=null,revocation_request_id=null WHERE id=$1",
        [source.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await pool.query("SELECT effects,reason FROM entitlement_sources WHERE id=$1", [source.id]))
        .rows[0],
    ).toEqual({ effects, reason: source.reason });
  });
  it("bumps terms revision for subscriptions, add-ons and sources, with rollback and delete coverage", async () => {
    let before = await revision();
    await pool.query("UPDATE tenant_subscriptions SET ends_at='2027-01-01' WHERE id=$1", [
      subscriptionA,
    ]);
    expect(await revision()).toEqual({ revision: before.revision + 1n, usage: before.usage });
    before = await revision();
    const addon = (
      await pool.query(
        "INSERT INTO subscription_addons (tenant_id,subscription_id,addon_version_id,quantity,status,source) VALUES ('p1-a',$1,$2,1,'active','manual') RETURNING id",
        [subscriptionA, addonId],
      )
    ).rows[0];
    await pool.query("UPDATE subscription_addons SET quantity=2 WHERE id=$1", [addon.id]);
    await pool.query("DELETE FROM subscription_addons WHERE id=$1", [addon.id]);
    expect((await revision()).revision).toBe(before.revision + 3n);
    before = await revision();
    const source = (await insertSource()).rows[0];
    await pool.query("DELETE FROM entitlement_sources WHERE id=$1", [source.id]);
    expect((await revision()).revision).toBe(before.revision + 2n);
    const client = await pool.connect();
    before = await revision();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE tenant_subscriptions SET ends_at='2028-01-01' WHERE id=$1", [
        subscriptionA,
      ]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await revision()).toEqual(before);
  });
  it("tracks insert/update/delete and old/new tenants independently for all occupied-capacity tables", async () => {
    await pool.query(
      "INSERT INTO \"user\" (id,name,email,email_verified,created_at,updated_at) VALUES ('p1-user','User','p1-user@example.invalid',true,now(),now())",
    );
    for (const [table, column, insert] of [
      ["lines", "tenant_id", "INSERT INTO lines (id,tenant_id,name) VALUES ($1,'p1-a','Line')"],
      [
        "station_devices",
        "tenant_id",
        "INSERT INTO station_devices (id,tenant_id,name,kind) VALUES ($1,'p1-a','Device','handheld')",
      ],
      ["kiosks", "tenant_id", "INSERT INTO kiosks (id,tenant_id,name) VALUES ($1,'p1-a','Kiosk')"],
      [
        "member",
        "organization_id",
        "INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,'p1-a','p1-user','member',now())",
      ],
      [
        "invitation",
        "organization_id",
        "INSERT INTO invitation (id,organization_id,email,status,expires_at,inviter_id) VALUES ($1,'p1-a','invite@example.invalid','pending','2027-01-01','p1-user')",
      ],
    ] as const) {
      const id = randomUUID();
      const beforeA = await revision(),
        beforeB = await revision("p1-b");
      await pool.query(insert, [id]);
      expect(await revision()).toEqual({ revision: beforeA.revision, usage: beforeA.usage + 1n });
      await pool.query(`UPDATE ${table} SET ${column}='p1-b' WHERE id=$1`, [id]);
      expect((await revision()).usage).toBe(beforeA.usage + 2n);
      expect((await revision("p1-b")).usage).toBe(beforeB.usage + 1n);
      await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
      expect((await revision("p1-b")).usage).toBe(beforeB.usage + 2n);
    }
  });
  it("ignores heartbeat and display updates while tracking device revocation and invitation state", async () => {
    const device = randomUUID(),
      line = randomUUID(),
      kiosk = randomUUID();
    await pool.query("INSERT INTO lines (id,tenant_id,name) VALUES ($1,'p1-a','Line')", [line]);
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name) VALUES ($1,'p1-a','Device')",
      [device],
    );
    await pool.query("INSERT INTO kiosks (id,tenant_id,name) VALUES ($1,'p1-a','Kiosk')", [kiosk]);
    await pool.query(
      "INSERT INTO invitation (id,organization_id,email,status,expires_at,inviter_id) VALUES ('p1-state-invite','p1-a','state@example.invalid','pending','2027-01-01','p1-user')",
    );
    const before = await revision();
    await pool.query("UPDATE station_devices SET last_seen_at=now(),name='Renamed' WHERE id=$1", [
      device,
    ]);
    await pool.query("UPDATE kiosks SET last_seen_at=now(),name='Renamed' WHERE id=$1", [kiosk]);
    await pool.query("UPDATE lines SET name='Renamed' WHERE id=$1", [line]);
    expect(await revision()).toEqual(before);
    await pool.query("UPDATE station_devices SET revoked_at=now() WHERE id=$1", [device]);
    await pool.query("UPDATE kiosks SET status='archived' WHERE id=$1", [kiosk]);
    await pool.query(
      "UPDATE invitation SET status='accepted',expires_at='2027-02-01' WHERE id='p1-state-invite'",
    );
    expect((await revision()).usage).toBe(before.usage + 3n);
  });
  it("pins approved policy facts and rejects partial approval or later rewriting", async () => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO entitlement_lifecycle_policies (id,policy_key,version,payload,payload_hash,created_by_platform_user_id) VALUES ($1,'test-only',1,'{}',$2,'p1-admin')",
      [id, "a".repeat(64)],
    );
    await expect(
      pool.query("UPDATE entitlement_lifecycle_policies SET status='approved' WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE entitlement_lifecycle_policies SET status='approved',decision_reference='test-only-approved',approved_at=now(),approved_by_platform_user_id='p1-admin' WHERE id=$1",
      [id],
    );
    await pool.query("UPDATE catalog_item_versions SET lifecycle_policy_id=$1 WHERE id=$2", [
      id,
      addonId,
    ]);
    await expect(
      pool.query(
        "UPDATE entitlement_lifecycle_policies SET payload='{\"offlineHours\":24}' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE entitlement_lifecycle_policies SET approved_at=now() WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM entitlement_lifecycle_policies WHERE id=$1", [id]),
    ).rejects.toThrow();
  });
  it("stores an immutable coherent preview and one tenant-scoped confirmation result for exact replay", async () => {
    const source = (await insertSource()).rows[0];
    const foreignSource = (await insertSource({ tenant: "p1-b", subscription: subscriptionB }))
      .rows[0];
    const id = randomUUID(),
      request = randomUUID();
    await pool.query(
      "INSERT INTO entitlement_source_previews (id,tenant_id,subscription_id,intent,request_id,created_by_platform_user_id,payload,payload_hash,revision,usage_revision,usage_fingerprint,registry_version,lifecycle_policy_fingerprint,before_snapshot,after_snapshot,expires_at) VALUES ($1,'p1-a',$2,'prepare',$3,'p1-admin','{}',$4,9007199254740993,2,$4,'p1a.v1',$4,'{}','{}',now()+interval '5 minutes')",
      [id, subscriptionA, request, "a".repeat(64)],
    );
    await expect(
      pool.query(
        "UPDATE entitlement_source_previews SET payload='{\"changed\":true}' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE entitlement_source_previews SET confirmed_at=now(),result_source_id=$2 WHERE id=$1",
        [id, foreignSource.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      "UPDATE entitlement_source_previews SET confirmed_at=now(),result_source_id=$2 WHERE id=$1",
      [id, source.id],
    );
    const confirmed = (
      await pool.query("SELECT * FROM entitlement_source_previews WHERE id=$1", [id])
    ).rows[0];
    expect(confirmed.revision).toBe("9007199254740993");
    expect(confirmed.result_source_id).toBe(source.id);
    await expect(
      pool.query(
        "UPDATE entitlement_source_previews SET confirmed_at=null,result_source_id=null WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE entitlement_source_previews SET request_id=$2 WHERE id=$1", [
        id,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("accepts the exact 1000-character decision-reference contract boundary", async () => {
    await insertSource({ decision: "x".repeat(1000) });
  });
  it("preserves monotonic revisions and affected tenants on subscription and add-on moves/deletes", async () => {
    const subscription = randomUUID();
    const beforeA = await revision(),
      beforeB = await revision("p1-b");
    await pool.query(
      "INSERT INTO tenant_subscriptions (id,tenant_id,plan_version_id,status,source) VALUES ($1,'p1-a',$2,'cancelled','manual')",
      [subscription, planId],
    );
    await pool.query("UPDATE tenant_subscriptions SET tenant_id='p1-b' WHERE id=$1", [
      subscription,
    ]);
    await pool.query("DELETE FROM tenant_subscriptions WHERE id=$1", [subscription]);
    expect((await revision()).revision).toBe(beforeA.revision + 2n);
    expect((await revision("p1-b")).revision).toBe(beforeB.revision + 2n);
    const addon = (
      await pool.query(
        "INSERT INTO subscription_addons (tenant_id,subscription_id,addon_version_id,quantity,status,source) VALUES ('p1-a',$1,$2,1,'active','manual') RETURNING id",
        [subscriptionA, addonId],
      )
    ).rows[0];
    const middleA = await revision(),
      middleB = await revision("p1-b");
    await pool.query(
      "UPDATE subscription_addons SET tenant_id='p1-b',subscription_id=$2 WHERE id=$1",
      [addon.id, subscriptionB],
    );
    expect((await revision()).revision).toBe(middleA.revision + 1n);
    expect((await revision("p1-b")).revision).toBe(middleB.revision + 1n);
    await expect(
      pool.query("UPDATE entitlement_revisions SET revision=0 WHERE tenant_id='p1-a'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM entitlement_revisions WHERE tenant_id='p1-a'"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("serializes opposite tenant moves without lost increments or statement-order inversions", async () => {
    const first = randomUUID(),
      second = randomUUID();
    await pool.query(
      "INSERT INTO lines (id,tenant_id,name) VALUES ($1,'p1-a','A'),($2,'p1-b','B')",
      [first, second],
    );
    const beforeA = await revision(),
      beforeB = await revision("p1-b");
    await Promise.all([
      pool.query("UPDATE lines SET tenant_id='p1-b' WHERE id=$1", [first]),
      pool.query("UPDATE lines SET tenant_id='p1-a' WHERE id=$1", [second]),
    ]);
    expect((await revision()).usage).toBe(beforeA.usage + 2n);
    expect((await revision("p1-b")).usage).toBe(beforeB.usage + 2n);
  });
  it("rejects a stale repeatable-read terms mutation after waiting for a concurrent capacity commit", async () => {
    const writer = await pool.connect(),
      reader = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO lines (tenant_id,name) VALUES ('p1-a','Concurrent capacity')",
      );
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await reader.query("SET LOCAL statement_timeout='5s'");
      await reader.query(
        "SELECT revision,usage_revision FROM entitlement_revisions WHERE tenant_id='p1-a'",
      );
      const pid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      const mutation = reader.query(
        "UPDATE tenant_subscriptions SET updated_at=clock_timestamp() WHERE id=$1",
        [subscriptionA],
      );
      const rejected = expect(mutation).rejects.toMatchObject({ code: "40001" });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked =
          (
            await pool.query<{ blocked: boolean }>(
              "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
              [pid],
            )
          ).rows[0]?.blocked === true;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await writer.query("COMMIT");
      await rejected;
    } finally {
      await writer.query("ROLLBACK");
      await reader.query("ROLLBACK");
      writer.release();
      reader.release();
    }
  });
  it("does not resurrect revision rows or block existing organization/user cascades", async () => {
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('p1-cascade','Cascade','p1-cascade',now())",
    );
    await pool.query(
      "INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('p1-cascade-member','p1-cascade','p1-user','member',now())",
    );
    await pool.query(
      "INSERT INTO invitation (id,organization_id,email,status,expires_at,inviter_id) VALUES ('p1-cascade-invite','p1-cascade','cascade@example.invalid','pending','2027-01-01','p1-user')",
    );
    await pool.query("DELETE FROM organization WHERE id='p1-cascade'");
    expect(
      (await pool.query("SELECT * FROM entitlement_revisions WHERE tenant_id='p1-cascade'")).rows,
    ).toEqual([]);
  });
});
