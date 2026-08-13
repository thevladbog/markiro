import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";
import { hashDeviceToken } from "../src/pickup/device-token";
import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";

/**
 * Same env-gating as auth.e2e.test.ts -- requires a reachable Postgres with
 * migrations applied (including 0004_org_profiles) plus Better Auth env.
 * See that file's comment for the CI setup this assumes.
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("org profile e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let failPut = false;
  let failDelete = false;
  const storage = {
    ensureBucket: async () => undefined,
    put: async (key: string, body: Buffer, contentType: string) => {
      if (failPut) throw new Error("test upload failure");
      objects.set(key, { body, contentType });
    },
    get: async (key: string) => {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return object;
    },
    delete: async (key: string) => {
      if (failDelete) throw new Error("test delete failure");
      objects.delete(key);
    },
    presignRead: async () => "unused",
  };

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Signs up a fresh user and creates an org for them, WITHOUT activating it
   * (`keepCurrentActiveOrganization: true` -- better-auth's
   * organization/create otherwise auto-activates the new org, which would
   * make the guarded-route-before-set-active assertion below vacuous).
   * Returns the created org id; `agent` accumulates the session cookie.
   */
  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    const orgId = org.body.id as string;
    await setup.db
      .insert(schema.pickupTenantPolicies)
      .values({ tenantId: orgId, limitsEnabled: true })
      .onConflictDoNothing();
    return orgId;
  }

  it("GET /org/profile is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/org/profile").expect(401);
  });

  it("guarded route 403s until set-active, then 200s with defaults", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);

    // Session exists but has no active organization yet -- this is the
    // Plan-02 handoff assertion: TenantGuard must 403 here, not 200.
    await agent.get("/org/profile").expect(403);

    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const res = await agent.get("/org/profile").expect(200);
    expect(res.body).toEqual({
      gln: null,
      gs1Prefixes: [],
      inn: null,
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });
  });

  it("PUT /org/profile upserts and roundtrips through GET", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const put = await agent
      .put("/org/profile")
      .send({ gln: "6291041500213", gs1Prefixes: ["4600000", "4600001"], inn: "7701234567" })
      .expect(200);
    expect(put.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: ["4600000", "4600001"],
      inn: "7701234567",
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });

    const get = await agent.get("/org/profile").expect(200);
    expect(get.body).toEqual(put.body);
  });

  it("PUT /org/profile preserves untouched fields on a partial update", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "6291041500213", inn: "7701234567" }).expect(200);

    const put2 = await agent.put("/org/profile").send({ inn: "7709876543" }).expect(200);
    expect(put2.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7709876543",
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });
  });

  it("PUT /org/profile rejects an invalid GLN format with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "not-a-gln" }).expect(400);
  });

  it("PUT /org/profile rejects GLN with invalid check digit with 400", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent.put("/org/profile").send({ gln: "6291041500214" }).expect(400);
  });

  it("PUT /org/profile merges fields atomically (no lost-update race)", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    // PUT gln first
    await agent.put("/org/profile").send({ gln: "6291041500213" }).expect(200);

    // PUT inn only (should not lose gln)
    const result = await agent.put("/org/profile").send({ inn: "7701234567" }).expect(200);
    expect(result.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7701234567",
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });

    // Verify GET sees the merged state
    const get = await agent.get("/org/profile").expect(200);
    expect(get.body).toEqual({
      gln: "6291041500213",
      gs1Prefixes: [],
      inn: "7701234567",
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });
  });

  it("tenant isolation: a second organization sees its own empty profile", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpWithInactiveOrg(agent1);
    await agent1
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org1 })
      .expect(200);
    await agent1.put("/org/profile").send({ gln: "6291041500213" }).expect(200);

    const agent2 = request.agent(app!.getHttpServer());
    const org2 = await signUpWithInactiveOrg(agent2);
    await agent2
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org2 })
      .expect(200);

    const res = await agent2.get("/org/profile").expect(200);
    expect(res.body).toEqual({
      gln: null,
      gs1Prefixes: [],
      inn: null,
      pickupLimitsEnabled: true,
      logoUrl: null,
      logoRevision: null,
    });
  });

  it("updates the tenant pickup limit switch and audits exact before/after", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const [owner] = await setup.db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (!owner) throw new Error(`Expected owner for organization ${orgId}`);

    const updated = await agent
      .put("/org/profile")
      .send({ pickupLimitsEnabled: false })
      .expect(200);
    expect(updated.body).toEqual({
      gln: null,
      gs1Prefixes: [],
      inn: null,
      pickupLimitsEnabled: false,
      logoUrl: null,
      logoRevision: null,
    });

    const [audit] = await setup.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, orgId),
          eq(schema.tenantAuditEvents.action, "tenant.pickup_policy.updated"),
          eq(schema.tenantAuditEvents.targetId, orgId),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt))
      .limit(1);
    expect(audit).toMatchObject({
      organizationId: orgId,
      actorUserId: owner.userId,
      action: "tenant.pickup_policy.updated",
      outcome: "success",
      targetType: "tenant",
      targetId: orgId,
      before: { limitsEnabled: true },
      after: { limitsEnabled: false },
    });
  });

  // Routes carry no global prefix -- only Better Auth's own `/api/auth/*`
  // mount does -- so these are `/station-devices` and `/org/profile`,
  // matching the existing suites (see employees.e2e.test.ts).
  it("rejects a station api-key: org profile is cabinet-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    const apiKey = device.apiKey;

    await request(app!.getHttpServer()).get("/org/profile").set("x-api-key", apiKey).expect(403);
  });

  it("still serves org profile to a signed-in cabinet user", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const profile = await agent.get("/org/profile").expect(200);
    expect(profile.body).toMatchObject({ logoUrl: null, logoRevision: null });
  });

  it("normalizes, activates, audits, streams, and idempotently deletes a tenant logo", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const [owner] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (!owner) throw new Error(`Expected owner for organization ${orgId}`);

    const source = await sharp({
      create: { width: 1800, height: 720, channels: 3, background: "#2463eb" },
    })
      .png()
      .toBuffer();
    const upload = await agent
      .post("/org/profile/logo")
      .attach("logo", source, { filename: "plant.png", contentType: "image/png" })
      .expect(201);
    expect(upload.body.logoRevision).toMatch(/^[0-9a-f-]{36}$/);
    expect(upload.body.logoUrl).toBe(`/org/profile/logo/${upload.body.logoRevision}`);

    const profile = await agent.get("/org/profile").expect(200);
    expect(profile.body).toMatchObject({
      logoRevision: upload.body.logoRevision,
      logoUrl: `/org/profile/logo/${upload.body.logoRevision}`,
    });
    await agent
      .get(`/org/profile/logo/${upload.body.logoRevision}`)
      .expect("content-type", /image\/webp/)
      .expect(200);

    const [asset] = await db
      .select()
      .from(schema.organizationLogoAssets)
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, orgId),
          eq(schema.organizationLogoAssets.id, upload.body.logoRevision),
        ),
      );
    expect(asset).toMatchObject({
      tenantId: orgId,
      objectKey: `tenants/${orgId}/branding/${upload.body.logoRevision}.webp`,
      contentType: "image/webp",
      status: "active",
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, orgId),
          eq(schema.tenantAuditEvents.action, "organization.logo.updated"),
          eq(schema.tenantAuditEvents.targetId, orgId),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt))
      .limit(1);
    expect(audit).toMatchObject({
      organizationId: orgId,
      actorUserId: owner.userId,
      action: "organization.logo.updated",
      outcome: "success",
      targetType: "organization",
      targetId: orgId,
    });
    expect(audit?.before).toEqual({ logoRevision: null });
    expect(audit?.after).toEqual({ logoRevision: upload.body.logoRevision });

    const kioskToken = `logo-kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: randomUUID(),
      tenantId: orgId,
      name: "Logo kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    await request(app!.getHttpServer())
      .get(`/kiosk/branding/logo/${upload.body.logoRevision}`)
      .set("x-kiosk-token", kioskToken)
      .expect("content-type", /image\/webp/)
      .expect(200);

    await agent.delete("/org/profile/logo").expect(204);
    await agent.delete("/org/profile/logo").expect(204);
    const logoAudits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, orgId),
          eq(schema.tenantAuditEvents.action, "organization.logo.updated"),
          eq(schema.tenantAuditEvents.targetId, orgId),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt));
    expect(logoAudits).toHaveLength(2);
    const deleteAudit = logoAudits[0];
    expect(deleteAudit).toMatchObject({
      organizationId: orgId,
      actorUserId: owner.userId,
      action: "organization.logo.updated",
      outcome: "success",
      targetType: "organization",
      targetId: orgId,
    });
    expect(deleteAudit?.before).toEqual({ logoRevision: upload.body.logoRevision });
    expect(deleteAudit?.after).toEqual({ logoRevision: null });
    await request(app!.getHttpServer())
      .get(`/kiosk/branding/logo/${upload.body.logoRevision}`)
      .set("x-kiosk-token", kioskToken)
      .expect(404);
  });

  it("rejects malformed and animated logos before persistence", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    await agent
      .post("/org/profile/logo")
      .attach("logo", Buffer.from("<svg><script>alert(1)</script></svg>"), {
        filename: "logo.svg",
        contentType: "image/svg+xml",
      })
      .expect(400);

    const frameSize = 64 * 64 * 3;
    const animated = await sharp(
      Buffer.concat([Buffer.alloc(frameSize), Buffer.alloc(frameSize, 255)]),
      {
        raw: { width: 64, height: 128, pageHeight: 64, channels: 3 },
      },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    await agent
      .post("/org/profile/logo")
      .attach("logo", animated, { filename: "animated.webp", contentType: "image/webp" })
      .expect(400);
  });

  it("never exposes another tenant revision and returns 404 for a missing active object", async () => {
    const first = request.agent(app!.getHttpServer());
    const firstOrg = await signUpWithInactiveOrg(first);
    await first
      .post("/api/auth/organization/set-active")
      .send({ organizationId: firstOrg })
      .expect(200);
    const second = request.agent(app!.getHttpServer());
    const secondOrg = await signUpWithInactiveOrg(second);
    await second
      .post("/api/auth/organization/set-active")
      .send({ organizationId: secondOrg })
      .expect(200);
    const source = await sharp({
      create: { width: 320, height: 120, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    const foreignUpload = await second
      .post("/org/profile/logo")
      .attach("logo", source, { filename: "foreign.png", contentType: "image/png" })
      .expect(201);
    const ownUpload = await first
      .post("/org/profile/logo")
      .attach("logo", source, { filename: "own.png", contentType: "image/png" })
      .expect(201);
    const kioskToken = `isolated-kiosk-${randomUUID()}`;
    await db.insert(schema.kiosks).values({
      id: randomUUID(),
      tenantId: firstOrg,
      name: "Isolated kiosk",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });

    await request(app!.getHttpServer())
      .get(`/kiosk/branding/logo/${foreignUpload.body.logoRevision}`)
      .set("x-kiosk-token", kioskToken)
      .expect(404);
    await first.get(`/org/profile/logo/${foreignUpload.body.logoRevision}`).expect(404);
    await second.get(`/org/profile/logo/${ownUpload.body.logoRevision}`).expect(404);
    objects.delete(`tenants/${firstOrg}/branding/${ownUpload.body.logoRevision}.webp`);
    await request(app!.getHttpServer())
      .get(`/kiosk/branding/logo/${ownUpload.body.logoRevision}`)
      .set("x-kiosk-token", kioskToken)
      .expect(404);
  });

  it("leaves failed uploads durable for reconciler cleanup without changing the active profile", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const source = await sharp({
      create: { width: 320, height: 120, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();

    failPut = true;
    try {
      await agent
        .post("/org/profile/logo")
        .attach("logo", source, { filename: "unavailable.png", contentType: "image/png" })
        .expect(503);
    } finally {
      failPut = false;
    }
    const [profile] = await db
      .select({ logoAssetId: schema.orgProfiles.logoAssetId })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, orgId));
    expect(profile?.logoAssetId ?? null).toBeNull();
    const [staging] = await db
      .select()
      .from(schema.organizationLogoAssets)
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, orgId),
          eq(schema.organizationLogoAssets.status, "staging"),
        ),
      );
    expect(staging).toBeDefined();
    await db
      .update(schema.organizationLogoAssets)
      .set({ updatedAt: new Date("2026-08-13T00:00:00.000Z") })
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, orgId),
          eq(schema.organizationLogoAssets.id, staging!.id),
        ),
      );
    await app!.get(OrgProfileService).reconcileLogoAssets(new Date("2026-08-13T01:00:00.000Z"));
    const [remaining] = await db
      .select({ id: schema.organizationLogoAssets.id })
      .from(schema.organizationLogoAssets)
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, orgId),
          eq(schema.organizationLogoAssets.id, staging!.id),
        ),
      );
    expect(remaining).toBeUndefined();
  });

  it("defers failed old-object deletion without rolling back the new active logo", async () => {
    const agent = request.agent(app!.getHttpServer());
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const source = await sharp({
      create: { width: 320, height: 120, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    const first = await agent
      .post("/org/profile/logo")
      .attach("logo", source, { filename: "first.png", contentType: "image/png" })
      .expect(201);
    failDelete = true;
    let second: request.Response;
    try {
      second = await agent
        .post("/org/profile/logo")
        .attach("logo", source, { filename: "second.png", contentType: "image/png" })
        .expect(201);
    } finally {
      failDelete = false;
    }
    const [profile] = await db
      .select({ logoAssetId: schema.orgProfiles.logoAssetId })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, orgId));
    expect(profile?.logoAssetId).toBe(second.body.logoRevision);
    const [old] = await db
      .select({ status: schema.organizationLogoAssets.status })
      .from(schema.organizationLogoAssets)
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, orgId),
          eq(schema.organizationLogoAssets.id, first.body.logoRevision),
        ),
      );
    expect(old?.status).toBe("deleting");
  });
});
