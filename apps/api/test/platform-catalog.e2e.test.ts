import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { ConflictException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, desc, eq } from "drizzle-orm";
import { schema, type PlatformRole } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import type { CreateCatalogVersionDto } from "../src/modules/platform-catalog/dto";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import {
  mountPlatformAuth,
  setupPlatformAuth,
  type PlatformAuthSetup,
} from "../src/platform-auth/platform-auth.setup";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.PLATFORM_AUTH_SECRET &&
  process.env.PLATFORM_AUTH_URL &&
  process.env.SAAS_ADMIN_ORIGIN,
);

function requiredSetCookie(response: request.Response): string {
  const values = response.headers["set-cookie"];
  const cookies = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const cookie = cookies.find((value) => value.startsWith("markiro-platform.session_token="));
  if (!cookie) throw new Error("Expected a platform session cookie");
  return cookie.split(";", 1)[0]!;
}

function currentTotp(uri: string): string {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded) throw new Error("Expected a TOTP enrollment URI");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replaceAll("=", "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid TOTP enrollment URI");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

describe.skipIf(!ready)("platform catalog", () => {
  let app: INestApplication | undefined;
  let catalog: PlatformCatalogService;
  let audit: PlatformAuditService;
  let setup: AuthSetup;
  let platformSetup: PlatformAuthSetup;
  let env: ReturnType<typeof loadEnv>;
  let admin: ReturnType<typeof request.agent>;
  let accountant: ReturnType<typeof request.agent>;
  let support: ReturnType<typeof request.agent>;
  let accountantId = "";
  let adminId = "";
  let barriersInstalled = false;

  async function createPlatformAgent(role: PlatformRole) {
    const password = randomBytes(24).toString("base64url");
    const signedUp = await request(app!.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({
        email: `${role}-${randomUUID()}@example.invalid`,
        password,
        name: role,
      })
      .expect(200);
    const userId = (signedUp.body as { user: { id: string } }).user.id;
    let cookie = requiredSetCookie(signedUp);
    await setup.db
      .update(schema.platformUsers)
      .set({ status: "active", role })
      .where(eq(schema.platformUsers.id, userId));
    const enrollment = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/enable")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .set("Cookie", cookie)
      .send({ password })
      .expect(200);
    const verified = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/verify-totp")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .set("Cookie", cookie)
      .send({
        code: currentTotp((enrollment.body as { totpURI: string }).totpURI),
        trustDevice: false,
      })
      .expect(200);
    cookie = requiredSetCookie(verified);
    return { agent: request.agent(app!.getHttpServer()).set("Cookie", cookie), userId };
  }

  const basicPlan: CreateCatalogVersionDto = {
    nameRu: "Базовый",
    nameEn: "Basic",
    unit: "month",
    billingMode: "recurring",
    billingPeriod: "month",
    unitPrice: "15000.00",
    vatRateBps: 2000,
    vatIncluded: true,
    plan: {
      maxLines: 2,
      maxStations: 3,
      maxKiosks: 1,
      maxCabinetUsers: 5,
      labelEditorEnabled: true,
      publicApiEnabled: false,
      palletsEnabled: false,
      demoDurationDays: 14,
    },
  };

  beforeAll(async () => {
    env = loadEnv();
    setup = setupAuth(env);
    platformSetup = setupPlatformAuth(env, setup.db);
    const ref = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...setup,
          platformAuth: platformSetup.platformAuth,
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    }).compile();
    catalog = ref.get(PlatformCatalogService);
    audit = ref.get(PlatformAuditService);
    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(env));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    mountPlatformAuth(server, platformSetup.platformAuth, { allowTestSignUp: true });
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    const createdAdmin = await createPlatformAgent("platform_admin");
    admin = createdAdmin.agent;
    adminId = createdAdmin.userId;
    const createdAccountant = await createPlatformAgent("accountant");
    accountant = createdAccountant.agent;
    accountantId = createdAccountant.userId;
    support = (await createPlatformAgent("support")).agent;
  }, 120_000);

  afterAll(async () => {
    try {
      if (barriersInstalled) {
        await setup.pool.query(
          "DROP TRIGGER IF EXISTS platform_catalog_version_barrier ON catalog_item_versions",
        );
        await setup.pool.query(
          "DROP TRIGGER IF EXISTS platform_catalog_item_barrier ON catalog_items",
        );
        await setup.pool.query(
          "DROP TRIGGER IF EXISTS platform_catalog_setting_barrier ON platform_settings",
        );
        await setup.pool.query("DROP FUNCTION IF EXISTS wait_for_platform_catalog_test_barrier()");
        await setup.pool.query("DROP TABLE IF EXISTS platform_catalog_test_barriers");
      }
    } finally {
      await app?.close();
    }
  });

  function principal(userId = adminId): Parameters<PlatformCatalogService["createVersion"]>[0] {
    return {
      userId,
      role: "platform_admin",
      capabilities: ["catalog.read", "catalog.write"],
      twoFactorReady: true,
    };
  }

  async function installBarriers(): Promise<void> {
    if (barriersInstalled) return;
    await setup.pool.query(
      "CREATE TABLE platform_catalog_test_barriers (name text primary key, lock_key text not null)",
    );
    await setup.pool.query(`
      CREATE FUNCTION wait_for_platform_catalog_test_barrier() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE current_key text;
      BEGIN
        SELECT lock_key INTO current_key FROM platform_catalog_test_barriers WHERE name = TG_ARGV[0];
        IF current_key IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(hashtextextended(current_key, 0));
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await setup.pool.query(`
      CREATE TRIGGER platform_catalog_version_barrier
      BEFORE UPDATE ON catalog_item_versions
      FOR EACH ROW WHEN (OLD.status = 'published' AND NEW.status = 'retired')
      EXECUTE FUNCTION wait_for_platform_catalog_test_barrier('version')
    `);
    await setup.pool.query(`
      CREATE TRIGGER platform_catalog_item_barrier
      BEFORE UPDATE ON catalog_items
      FOR EACH ROW WHEN (NEW.status = 'archived')
      EXECUTE FUNCTION wait_for_platform_catalog_test_barrier('item')
    `);
    await setup.pool.query(`
      CREATE TRIGGER platform_catalog_setting_barrier
      BEFORE UPDATE ON platform_settings
      FOR EACH ROW EXECUTE FUNCTION wait_for_platform_catalog_test_barrier('setting')
    `);
    barriersInstalled = true;
  }

  async function holdBarrier(name: "version" | "item" | "setting"): Promise<() => Promise<void>> {
    await installBarriers();
    const lockKey = `platform-catalog-test-barrier:${name}:${randomUUID()}`;
    await setup.pool.query("DELETE FROM platform_catalog_test_barriers WHERE name = $1", [name]);
    await setup.pool.query(
      "INSERT INTO platform_catalog_test_barriers (name, lock_key) VALUES ($1, $2)",
      [name, lockKey],
    );
    const client = await setup.pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } finally {
        try {
          await setup.pool.query("DELETE FROM platform_catalog_test_barriers WHERE name = $1", [
            name,
          ]);
        } finally {
          client.release();
        }
      }
    };
  }

  async function waitForBarrier(name: "version" | "item" | "setting"): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await setup.pool.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM pg_locks
        WHERE locktype = 'advisory' AND granted = false
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      if ((result.rows[0]?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${name} barrier`);
  }

  async function waitForBlockedCatalogVersionQuery(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await setup.pool.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%catalog_item_versions%'
      `);
      if ((result.rows[0]?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for a blocked catalog version query");
  }

  it("wires the catalog service to the shared platform audit provider through AppModule", () => {
    expect(catalog).toBeInstanceOf(PlatformCatalogService);
    expect(audit).toBeInstanceOf(PlatformAuditService);
    expect(Reflect.get(catalog, "audit")).toBe(audit);
  });

  it("publishes an exact plan version, redacts finance for support, and audits the immutable transition", async () => {
    const draft = await admin
      .post("/platform/catalog/items/plan-basic/versions")
      .send(basicPlan)
      .expect(201);
    const versionPath = `/platform/catalog/items/plan-basic/versions/${draft.body.id}`;
    expect(draft.body.unitPrice).toBe("15000.00");
    expect(draft.body.vatRateBps).toBe(2000);
    expect(await accountant.post(`${versionPath}/publish`).send({})).toHaveProperty("status", 200);
    const immutable = await accountant.patch(versionPath).send({ unitPrice: "1.00" }).expect(409);
    expect(immutable.body).toEqual(expect.objectContaining({ code: "catalog_version_immutable" }));
    const redacted = await support.get(versionPath).expect(200);
    expect(redacted.body).not.toHaveProperty("unitPrice");
    expect(redacted.body).not.toHaveProperty("vatRateBps");

    const [audit] = await setup.db
      .select({
        actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
        action: schema.platformAuditEvents.action,
        targetId: schema.platformAuditEvents.targetId,
        outcome: schema.platformAuditEvents.outcome,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.action, "catalog.version.published"),
          eq(schema.platformAuditEvents.targetId, draft.body.id),
        ),
      )
      .orderBy(desc(schema.platformAuditEvents.createdAt), desc(schema.platformAuditEvents.id))
      .limit(1);
    expect(audit).toEqual({
      actorPlatformUserId: accountantId,
      action: "catalog.version.published",
      targetId: draft.body.id,
      outcome: "success",
    });
  });

  it("accepts only the entitlement shape for each catalog kind", async () => {
    await admin
      .post(`/platform/catalog/items/invalid-${randomUUID()}/versions`)
      .send({ ...basicPlan, service: {}, plan: basicPlan.plan })
      .expect(400);
    await admin
      .post(`/platform/catalog/items/addon-negative-${randomUUID()}/versions`)
      .send({
        ...basicPlan,
        plan: undefined,
        addon: { effects: [{ key: "lines", quotaIncrement: -1 }] },
      })
      .expect(400);
    await admin
      .post(`/platform/catalog/items/service-effects-${randomUUID()}/versions`)
      .send({
        ...basicPlan,
        billingMode: "one_time",
        billingPeriod: null,
        plan: undefined,
        service: { effects: [{ key: "lines", quotaIncrement: 1 }] },
      })
      .expect(400);
    const service = await admin
      .post(`/platform/catalog/items/service-${randomUUID()}/versions`)
      .send({
        ...basicPlan,
        nameRu: "Внедрение",
        nameEn: "Implementation",
        unit: "project",
        billingMode: "one_time",
        billingPeriod: null,
        plan: undefined,
        service: {},
      })
      .expect(201);
    expect(service.body).toEqual(expect.objectContaining({ kind: "service", service: {} }));
    expect(service.body).not.toHaveProperty("plan");
    expect(service.body).not.toHaveProperty("addon");
  });

  it("requires retirement before archive and refuses to retire the current default demo", async () => {
    const draft = await admin
      .post(`/platform/catalog/items/plan-demo-${randomUUID()}/versions`)
      .send(basicPlan)
      .expect(201);
    const versionPath = `/platform/catalog/items/${draft.body.catalogItemCode}/versions/${draft.body.id}`;
    await accountant.post(`${versionPath}/publish`).send({}).expect(200);
    await admin
      .post(`/platform/catalog/items/${draft.body.catalogItemCode}/archive`)
      .send({})
      .expect(409);
    await admin
      .patch("/platform/settings/demo-plan")
      .send({ catalogVersionId: draft.body.id })
      .expect(200);
    await accountant.post(`${versionPath}/retire`).send({}).expect(409);

    const replacement = await admin
      .post(`/platform/catalog/items/plan-demo-replacement-${randomUUID()}/versions`)
      .send(basicPlan)
      .expect(201);
    const replacementPath = `/platform/catalog/items/${replacement.body.catalogItemCode}/versions/${replacement.body.id}`;
    await accountant.post(`${replacementPath}/publish`).send({}).expect(200);
    await admin
      .patch("/platform/settings/demo-plan")
      .send({ catalogVersionId: replacement.body.id })
      .expect(200);
    await accountant.post(`${versionPath}/retire`).send({}).expect(200);
    await admin
      .post(`/platform/catalog/items/${draft.body.catalogItemCode}/archive`)
      .send({})
      .expect(200);
  });

  it("rejects malformed catalog path parameters before they reach SQL", async () => {
    const oversized = "a".repeat(65);
    for (const code of ["invalid_code!", oversized]) {
      const response = await admin
        .post(`/platform/catalog/items/${code}/versions`)
        .send(basicPlan)
        .expect(400);
      expect(response.text).not.toMatch(/22P02|invalid input syntax/i);
    }
    const response = await support
      .get("/platform/catalog/items/plan-basic/versions/not-a-uuid")
      .expect(400);
    expect(response.text).not.toMatch(/22P02|invalid input syntax/i);
  });

  it("serializes default selection ahead of retiring that exact version", async () => {
    const initial = await catalog.createVersion(
      principal(),
      `plan-race-initial-${randomUUID()}`,
      basicPlan,
    );
    await catalog.publish(principal(), initial.catalogItemCode, initial.id);
    const candidate = await catalog.createVersion(
      principal(),
      `plan-race-candidate-${randomUUID()}`,
      basicPlan,
    );
    await catalog.publish(principal(), candidate.catalogItemCode, candidate.id);
    await catalog.setDefaultDemo(principal(), { catalogVersionId: initial.id });

    const release = await holdBarrier("setting");
    try {
      const selecting = catalog.setDefaultDemo(principal(accountantId), {
        catalogVersionId: candidate.id,
      });
      await waitForBarrier("setting");
      const retiring = catalog.retire(principal(), candidate.catalogItemCode, candidate.id).then(
        () => null,
        (reason: unknown) => reason,
      );
      await release();
      await selecting;
      const error = await retiring;
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: "catalog_default_demo_in_use",
      });
    } finally {
      await release();
    }
  });

  it("keeps retire behind a selection that holds the candidate version before the setting", async () => {
    const initial = await catalog.createVersion(
      principal(),
      `plan-inversion-initial-${randomUUID()}`,
      basicPlan,
    );
    await catalog.publish(principal(), initial.catalogItemCode, initial.id);
    const candidate = await catalog.createVersion(
      principal(),
      `plan-inversion-candidate-${randomUUID()}`,
      basicPlan,
    );
    await catalog.publish(principal(), candidate.catalogItemCode, candidate.id);
    await catalog.setDefaultDemo(principal(), { catalogVersionId: initial.id });

    type CatalogInternals = {
      lockDefaultDemoSetting(tx: unknown): Promise<unknown>;
    };
    const internals = catalog as unknown as CatalogInternals;
    const original = internals.lockDefaultDemoSetting.bind(catalog);
    let releaseSelection!: () => void;
    const selectionCanContinue = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    let selectionAtSetting!: () => void;
    const selectionReachedSetting = new Promise<void>((resolve) => {
      selectionAtSetting = resolve;
    });
    let firstSettingRead = true;
    const settingSpy = vi
      .spyOn(internals, "lockDefaultDemoSetting")
      .mockImplementation(async (tx) => {
        if (firstSettingRead) {
          firstSettingRead = false;
          selectionAtSetting();
          await selectionCanContinue;
        }
        return original(tx);
      });

    const selecting = catalog.setDefaultDemo(principal(accountantId), {
      catalogVersionId: candidate.id,
    });
    try {
      await selectionReachedSetting;
      const retiring = catalog.retire(principal(), candidate.catalogItemCode, candidate.id).then(
        () => null,
        (reason: unknown) => reason,
      );
      await waitForBlockedCatalogVersionQuery();
      releaseSelection();
      await expect(selecting).resolves.toEqual({ catalogVersionId: candidate.id });
      const error = await retiring;
      expect(String(error)).not.toMatch(/40P01|deadlock/i);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: "catalog_default_demo_in_use",
      });
    } finally {
      releaseSelection();
      settingSpy.mockRestore();
    }
  });

  it("does not create a new version after an archive has acquired the item lock", async () => {
    const code = `plan-archive-race-${randomUUID()}`;
    const published = await catalog.createVersion(principal(), code, basicPlan);
    await catalog.publish(principal(), code, published.id);
    await catalog.retire(principal(), code, published.id);

    const release = await holdBarrier("item");
    try {
      const archiving = catalog.archive(principal(), code);
      await waitForBarrier("item");
      const creating = catalog.createVersion(principal(), code, basicPlan);
      await release();
      await archiving;
      const error = await creating.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: "catalog_item_archived",
      });
      const versions = await setup.db
        .select({ status: schema.catalogItemVersions.status })
        .from(schema.catalogItemVersions)
        .innerJoin(
          schema.catalogItems,
          eq(schema.catalogItems.id, schema.catalogItemVersions.catalogItemId),
        )
        .where(eq(schema.catalogItems.code, code));
      expect(versions).toEqual([{ status: "retired" }]);
    } finally {
      await release();
    }
  });

  it("records the committed prior default for concurrent default changes", async () => {
    const first = await catalog.createVersion(
      principal(),
      `plan-audit-first-${randomUUID()}`,
      basicPlan,
    );
    const second = await catalog.createVersion(
      principal(),
      `plan-audit-second-${randomUUID()}`,
      basicPlan,
    );
    const third = await catalog.createVersion(
      principal(),
      `plan-audit-third-${randomUUID()}`,
      basicPlan,
    );
    for (const version of [first, second, third]) {
      await catalog.publish(principal(), version.catalogItemCode, version.id);
    }
    await catalog.setDefaultDemo(principal(), { catalogVersionId: first.id });

    const release = await holdBarrier("setting");
    try {
      const selectingSecond = catalog.setDefaultDemo(principal(), { catalogVersionId: second.id });
      await waitForBarrier("setting");
      const selectingThird = catalog.setDefaultDemo(principal(accountantId), {
        catalogVersionId: third.id,
      });
      await release();
      await Promise.all([selectingSecond, selectingThird]);

      const rows = await setup.db
        .select({
          before: schema.platformAuditEvents.before,
          after: schema.platformAuditEvents.after,
        })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.action, "catalog.default_demo.changed"))
        .orderBy(desc(schema.platformAuditEvents.createdAt), desc(schema.platformAuditEvents.id));
      const thirdChange = rows.find(
        (row) => (row.after as { catalogVersionId?: string } | null)?.catalogVersionId === third.id,
      );
      expect(thirdChange?.before).toEqual({ catalogVersionId: second.id });
    } finally {
      await release();
    }
  });
});
