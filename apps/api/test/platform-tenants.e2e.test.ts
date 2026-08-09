import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { createDb, schema, type PlatformRole } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { TenantProvisioningService } from "../src/modules/platform-tenants/tenant-provisioning.service";
import { mountPlatformAuth, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { DefaultDemoSettingFixture } from "./support/default-demo-setting";
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

describe.skipIf(!ready)("platform tenant management", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let env: ReturnType<typeof loadEnv>;
  let admin: ReturnType<typeof request.agent>;
  let support: ReturnType<typeof request.agent>;
  let accountant: ReturnType<typeof request.agent>;
  let defaultDemo: DefaultDemoSettingFixture;
  let adminId = "";
  let tenantId = "";
  let tenantSlug = "";
  let demoVersionId = "";
  let paidPlanVersionId = "";
  let scheduledPlanOneId = "";
  let scheduledPlanTwoId = "";
  let replacementPlanVersionId = "";
  let addonVersionId = "";

  async function createPlatformAgent(role: PlatformRole) {
    const password = randomBytes(24).toString("base64url");
    const signedUp = await request(app!.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({ email: `${role}-${randomUUID()}@example.invalid`, password, name: role })
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

  async function createPublishedPlan(input: {
    code: string;
    price: string;
    demoDurationDays: number | null;
    maxLines: number;
  }): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await setup.db.insert(schema.catalogItems).values({
      id: itemId,
      code: input.code,
      nameRu: input.code,
      nameEn: input.code,
      kind: "plan",
    });
    await setup.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: input.code,
      nameEn: input.code,
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: input.price,
      vatRate: "20.00",
      vatIncluded: true,
    });
    await setup.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: input.maxLines,
      maxStations: 3,
      maxKiosks: 1,
      maxCabinetUsers: 5,
      labelEditorEnabled: true,
      demoDurationDays: input.demoDurationDays,
    });
    await setup.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    return versionId;
  }

  async function createPublishedAddon(status: "draft" | "published" = "published") {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await setup.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `addon-lines-${randomUUID()}`,
      nameRu: "Дополнительная линия",
      nameEn: "Extra line",
      kind: "addon",
    });
    await setup.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "addon",
      version: 1,
      nameRu: "Дополнительная линия",
      nameEn: "Extra line",
      unit: "line",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1200.00",
      vatRate: "20.00",
      vatIncluded: true,
    });
    await setup.db.insert(schema.addonEntitlements).values({
      catalogVersionId: versionId,
      entitlementKey: "lines",
      quotaIncrement: 1,
    });
    if (status === "published") {
      await setup.db
        .update(schema.catalogItemVersions)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(schema.catalogItemVersions.id, versionId));
    }
    return versionId;
  }

  beforeAll(async () => {
    env = loadEnv();
    setup = setupAuth(env);
    defaultDemo = new DefaultDemoSettingFixture(setup.db);
    await defaultDemo.capture();
    const platformSetup = setupPlatformAuth(env, setup.db);
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
    expect(ref.get(TenantProvisioningService)).toBeInstanceOf(TenantProvisioningService);
    expect(ref.get(SubscriptionLifecycleService)).toBeInstanceOf(SubscriptionLifecycleService);
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
    support = (await createPlatformAgent("support")).agent;
    accountant = (await createPlatformAgent("accountant")).agent;
    demoVersionId = await createPublishedPlan({
      code: `demo-${randomUUID()}`,
      price: "0.00",
      demoDurationDays: 14,
      maxLines: 1,
    });
    paidPlanVersionId = await createPublishedPlan({
      code: `paid-${randomUUID()}`,
      price: "15000.00",
      demoDurationDays: null,
      maxLines: 2,
    });
    scheduledPlanOneId = await createPublishedPlan({
      code: `scheduled-one-${randomUUID()}`,
      price: "20000.00",
      demoDurationDays: null,
      maxLines: 3,
    });
    scheduledPlanTwoId = await createPublishedPlan({
      code: `scheduled-two-${randomUUID()}`,
      price: "25000.00",
      demoDurationDays: null,
      maxLines: 4,
    });
    replacementPlanVersionId = await createPublishedPlan({
      code: `replacement-${randomUUID()}`,
      price: "30000.00",
      demoDurationDays: null,
      maxLines: 5,
    });
    addonVersionId = await createPublishedAddon();
    await defaultDemo.install(demoVersionId);
  }, 120_000);

  afterAll(async () => {
    try {
      const deliveries = await setup.db
        .select({ id: schema.emailDeliveries.id })
        .from(schema.emailDeliveries)
        .where(like(schema.emailDeliveries.recipient, "platform-owner-%@example.com"));
      if (deliveries.length > 0) {
        await setup.db.delete(schema.emailOutbox).where(
          inArray(
            schema.emailOutbox.deliveryId,
            deliveries.map((delivery) => delivery.id),
          ),
        );
      }
    } finally {
      try {
        await defaultDemo.restore();
      } finally {
        await app?.close();
      }
    }
  });

  async function ensureTenant(): Promise<void> {
    if (tenantId) return;
    tenantSlug = `platform-tenant-${randomUUID()}`;
    const created = await admin
      .post("/platform/tenants")
      .send({
        tenantName: "Platform tenant",
        tenantSlug,
        email: `platform-owner-${randomUUID()}@example.com`,
      })
      .expect(201);
    tenantId = (created.body as { tenantId: string }).tenantId;
  }

  async function createActiveTenant(
    prefix: string,
    parentEndsAt: Date | null = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  ): Promise<string> {
    const created = await admin
      .post("/platform/tenants")
      .send({
        tenantName: `${prefix} tenant`,
        tenantSlug: `${prefix}-${randomUUID()}`,
        email: `platform-owner-${randomUUID()}@example.com`,
      })
      .expect(201);
    const createdTenantId = (created.body as { tenantId: string }).tenantId;
    await admin
      .post(`/platform/tenants/${createdTenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        ...(parentEndsAt ? { endsAt: parentEndsAt.toISOString() } : {}),
        reason: `${prefix} initial active plan`,
      })
      .expect(201);
    return createdTenantId;
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await setup.pool.query<{ waiting: boolean }>(
        `select exists (
          select 1
          from pg_stat_activity
          where application_name = $1 and wait_event_type = 'Lock'
        ) as waiting`,
        [applicationName],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on the database lock`);
  }

  it("creates one pending demo, lists bounded states, and redacts financial fields for support", async () => {
    await accountant
      .post("/platform/tenants")
      .send({
        tenantName: "Forbidden tenant",
        tenantSlug: `forbidden-${randomUUID()}`,
        email: `forbidden-${randomUUID()}@example.com`,
      })
      .expect(403);
    await admin
      .post("/platform/tenants")
      .send({
        tenantName: "Browser bypass",
        tenantSlug: `browser-bypass-${randomUUID()}`,
        email: `browser-bypass-${randomUUID()}@example.com`,
        allowUnmanagedWithoutDemo: true,
      })
      .expect(400);

    await ensureTenant();
    const [subscription] = await setup.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    expect(subscription).toEqual(
      expect.objectContaining({
        planVersionId: demoVersionId,
        status: "pending_activation",
        startsAt: null,
        endsAt: null,
      }),
    );

    const listed = await support
      .get("/platform/tenants")
      .query({ status: "pending_activation", page: 1, limit: 1 })
      .expect(200);
    expect(listed.body).toEqual(
      expect.objectContaining({ page: 1, limit: 1, total: expect.any(Number) }),
    );
    expect(listed.body.items).toHaveLength(1);
    const supportDetail = await support.get(`/platform/tenants/${tenantId}`).expect(200);
    expect(supportDetail.body).toEqual(
      expect.objectContaining({
        tenant: expect.objectContaining({ id: tenantId, slug: tenantSlug }),
        ownerActivation: expect.objectContaining({ status: "queued" }),
        currentSubscription: expect.objectContaining({
          planVersion: expect.objectContaining({ id: demoVersionId }),
        }),
        usage: { cabinetUsers: 1, kiosks: 0, lines: 0, stations: 0 },
      }),
    );
    expect(JSON.stringify(supportDetail.body)).not.toMatch(
      /unitPrice|vatRate|encryptedPayload|payloadNonce|payloadTag|verification|actionUrl|token/i,
    );
    const adminDetail = await admin.get(`/platform/tenants/${tenantId}`).expect(200);
    expect(adminDetail.body.currentSubscription.planVersion.unitPrice).toBe("0.00");
    await request(app!.getHttpServer()).get(`/platform/tenants/${tenantId}`).expect(401);
  });

  it("counts only tenant-scoped unexpired pending invitations as reserved cabinet seats", async () => {
    await ensureTenant();
    const [owner] = await setup.db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.role, "owner")));
    expect(owner).toBeDefined();
    if (!owner) throw new Error("Expected the provisioned tenant owner");
    const otherTenantId = randomUUID();
    await setup.db.insert(schema.organization).values({
      id: otherTenantId,
      name: "Invitation usage other tenant",
      slug: `invitation-usage-other-${randomUUID()}`,
      createdAt: new Date(),
    });
    const invitationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [pendingId, expiredId, acceptedId, otherId] = invitationIds;
    if (!pendingId || !expiredId || !acceptedId || !otherId) {
      throw new Error("Expected four invitation identifiers");
    }
    await setup.db.insert(schema.invitation).values([
      {
        id: pendingId,
        organizationId: tenantId,
        email: `pending-${randomUUID()}@example.invalid`,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      },
      {
        id: expiredId,
        organizationId: tenantId,
        email: `expired-${randomUUID()}@example.invalid`,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() - 60_000),
        inviterId: owner.userId,
      },
      {
        id: acceptedId,
        organizationId: tenantId,
        email: `accepted-${randomUUID()}@example.invalid`,
        role: "member",
        status: "accepted",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      },
      {
        id: otherId,
        organizationId: otherTenantId,
        email: `other-${randomUUID()}@example.invalid`,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      },
    ]);

    const detail = await support.get(`/platform/tenants/${tenantId}`).expect(200);
    expect(detail.body.usage.cabinetUsers).toBe(2);

    await setup.db.delete(schema.invitation).where(inArray(schema.invitation.id, invitationIds));
    await setup.db.delete(schema.organization).where(eq(schema.organization.id, otherTenantId));
  });

  it("lets support renew owner activation while accountant remains read-only", async () => {
    await ensureTenant();
    await accountant
      .post(`/platform/tenants/${tenantId}/owner-activation/renew`)
      .send({})
      .expect(403);
    const renewed = await support
      .post(`/platform/tenants/${tenantId}/owner-activation/renew`)
      .send({})
      .expect(200);
    expect(renewed.body).toEqual({ deliveryId: expect.any(String) });
    const deliveries = await setup.db
      .select({ status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, `tenant-owner:${tenantId}`));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.status).sort()).toEqual(["canceled", "queued"]);
    const [pending] = await setup.db
      .select({
        status: schema.tenantSubscriptions.status,
        startsAt: schema.tenantSubscriptions.startsAt,
        endsAt: schema.tenantSubscriptions.endsAt,
      })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    expect(pending).toEqual({ status: "pending_activation", startsAt: null, endsAt: null });
  });

  it("assigns exact published versions, serializes schedules, and preserves reasoned history", async () => {
    await ensureTenant();
    const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await support
      .post(`/platform/tenants/${tenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        endsAt,
        reason: "support must not bypass billing",
      })
      .expect(403);
    await accountant
      .post(`/platform/tenants/${tenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        endsAt,
        reason: "accountant must use paid fulfilment",
      })
      .expect(403);
    const assigned = await admin
      .post(`/platform/tenants/${tenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        endsAt,
        reason: "approved migration reconciliation",
      })
      .expect(201);
    expect(assigned.body).toEqual(
      expect.objectContaining({ planVersionId: paidPlanVersionId, status: "active" }),
    );

    const scheduleBodies = [scheduledPlanOneId, scheduledPlanTwoId].map((catalogVersionId) => ({
      catalogVersionId,
      activationPolicy: "after_current",
      reason: `approved successor ${catalogVersionId}`,
    }));
    const scheduledResponses = await Promise.all(
      scheduleBodies.map((body) =>
        admin.post(`/platform/tenants/${tenantId}/subscription/plan`).send(body),
      ),
    );
    expect(scheduledResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    const [scheduled] = await setup.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "scheduled"),
        ),
      );
    if (!scheduled) throw new Error("Expected one scheduled successor");
    expect([scheduledPlanOneId, scheduledPlanTwoId]).toContain(scheduled.planVersionId);

    const addon = await admin
      .post(`/platform/tenants/${tenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 2,
        activationPolicy: "immediate",
        reason: "temporary line expansion",
      })
      .expect(201);
    expect(addon.body).toEqual(
      expect.objectContaining({
        addonVersionId,
        quantity: 2,
        status: "active",
        subscriptionId: assigned.body.id,
      }),
    );
    const scheduledAddon = await admin
      .post(`/platform/tenants/${tenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "after_current",
        reason: "expand the scheduled successor",
      })
      .expect(201);
    expect(scheduledAddon.body).toEqual(
      expect.objectContaining({
        addonVersionId,
        quantity: 1,
        status: "scheduled",
        subscriptionId: scheduled.id,
      }),
    );
    await accountant
      .post(`/platform/tenants/${tenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "immediate",
        reason: "accountant bypass",
      })
      .expect(403);
    const draftAddonId = await createPublishedAddon("draft");
    await admin
      .post(`/platform/tenants/${tenantId}/subscription/addons`)
      .send({
        catalogVersionId: draftAddonId,
        quantity: 1,
        activationPolicy: "immediate",
        reason: "draft must not grant access",
      })
      .expect(409);

    const [audit] = await setup.db
      .select({
        actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
        action: schema.platformAuditEvents.action,
        reason: schema.platformAuditEvents.reason,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, tenantId),
          eq(schema.platformAuditEvents.action, "platform.tenant.subscription.plan_assigned"),
        ),
      )
      .orderBy(desc(schema.platformAuditEvents.createdAt))
      .limit(1);
    expect(audit).toEqual({
      actorPlatformUserId: adminId,
      action: "platform.tenant.subscription.plan_assigned",
      reason: "approved migration reconciliation",
      before: expect.objectContaining({ planVersionId: demoVersionId }),
      after: expect.objectContaining({ planVersionId: paidPlanVersionId, status: "active" }),
    });
    const detail = await admin.get(`/platform/tenants/${tenantId}`).expect(200);
    expect(detail.body.currentSubscription.planVersion.id).toBe(paidPlanVersionId);
    expect([scheduledPlanOneId, scheduledPlanTwoId]).toContain(
      detail.body.scheduledSubscription.planVersion.id,
    );
    expect(detail.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "plan.assigned",
          reason: "approved migration reconciliation",
        }),
        expect.objectContaining({
          eventKind: "addon.activated",
          reason: "temporary line expansion",
        }),
      ]),
    );

    const otherTenantId = randomUUID();
    await setup.db.insert(schema.organization).values({
      id: otherTenantId,
      name: "Other tenant",
      slug: `other-${randomUUID()}`,
      createdAt: new Date(),
    });
    await admin
      .post(`/platform/tenants/${otherTenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "immediate",
        reason: "must not use another tenant subscription",
      })
      .expect(409);
    expect(
      await setup.db
        .select({ id: schema.subscriptionAddons.id })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, otherTenantId)),
    ).toEqual([]);
    await setup.db.delete(schema.organization).where(eq(schema.organization.id, otherTenantId));
  });

  it("retires active and scheduled add-ons with exact history when replacing their parent plans", async () => {
    await ensureTenant();
    const [current] = await setup.db
      .select({ id: schema.tenantSubscriptions.id })
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "active"),
        ),
      );
    const [scheduled] = await setup.db
      .select({ id: schema.tenantSubscriptions.id })
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "scheduled"),
        ),
      );
    expect(current).toBeDefined();
    expect(scheduled).toBeDefined();
    if (!current || !scheduled) throw new Error("Expected current and scheduled subscriptions");
    const existingAddons = await setup.db
      .select({ id: schema.subscriptionAddons.id, status: schema.subscriptionAddons.status })
      .from(schema.subscriptionAddons)
      .where(eq(schema.subscriptionAddons.tenantId, tenantId));
    const liveActive = existingAddons.find((addon) => addon.status === "active");
    const scheduledAddon = existingAddons.find((addon) => addon.status === "scheduled");
    expect(liveActive).toBeDefined();
    expect(scheduledAddon).toBeDefined();
    if (!liveActive || !scheduledAddon) throw new Error("Expected active and scheduled add-ons");
    const endedAddonId = randomUUID();
    const endedAt = new Date(Date.now() - 60_000);
    await setup.db.insert(schema.subscriptionAddons).values({
      id: endedAddonId,
      tenantId,
      subscriptionId: current.id,
      addonVersionId,
      quantity: 1,
      startsAt: new Date(endedAt.getTime() - 60_000),
      endsAt: endedAt,
      status: "active",
      source: "manual",
      createdByPlatformUserId: adminId,
    });

    await admin
      .post(`/platform/tenants/${tenantId}/subscription/plan`)
      .send({
        catalogVersionId: replacementPlanVersionId,
        activationPolicy: "immediate",
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        reason: "replace parents and retire add-ons",
      })
      .expect(201);

    const retired = await setup.db
      .select({ id: schema.subscriptionAddons.id, status: schema.subscriptionAddons.status })
      .from(schema.subscriptionAddons)
      .where(
        inArray(schema.subscriptionAddons.id, [liveActive.id, scheduledAddon.id, endedAddonId]),
      );
    expect(new Map(retired.map((addon) => [addon.id, addon.status]))).toEqual(
      new Map([
        [liveActive.id, "revoked"],
        [scheduledAddon.id, "revoked"],
        [endedAddonId, "expired"],
      ]),
    );
    const lifecycleEvents = await setup.db
      .select({
        kind: schema.subscriptionEvents.eventKind,
        reason: schema.subscriptionEvents.reason,
        before: schema.subscriptionEvents.before,
        after: schema.subscriptionEvents.after,
      })
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.tenantId, tenantId),
          inArray(schema.subscriptionEvents.eventKind, ["addon.revoked", "addon.expired"]),
        ),
      );
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "addon.revoked",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: liveActive.id, status: "active" }),
          after: expect.objectContaining({ id: liveActive.id, status: "revoked" }),
        }),
        expect.objectContaining({
          kind: "addon.revoked",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: scheduledAddon.id, status: "scheduled" }),
          after: expect.objectContaining({ id: scheduledAddon.id, status: "revoked" }),
        }),
        expect.objectContaining({
          kind: "addon.expired",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: endedAddonId, status: "active" }),
          after: expect.objectContaining({ id: endedAddonId, status: "expired" }),
        }),
      ]),
    );
    const lifecycleAudits = await setup.db
      .select({
        action: schema.platformAuditEvents.action,
        reason: schema.platformAuditEvents.reason,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, tenantId),
          inArray(schema.platformAuditEvents.targetId, [
            liveActive.id,
            scheduledAddon.id,
            endedAddonId,
          ]),
        ),
      );
    expect(lifecycleAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "platform.tenant.subscription.addon_revoked",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: liveActive.id, status: "active" }),
          after: expect.objectContaining({ id: liveActive.id, status: "revoked" }),
        }),
        expect.objectContaining({
          action: "platform.tenant.subscription.addon_revoked",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: scheduledAddon.id, status: "scheduled" }),
          after: expect.objectContaining({ id: scheduledAddon.id, status: "revoked" }),
        }),
        expect.objectContaining({
          action: "platform.tenant.subscription.addon_expired",
          reason: "replace parents and retire add-ons",
          before: expect.objectContaining({ id: endedAddonId, status: "active" }),
          after: expect.objectContaining({ id: endedAddonId, status: "expired" }),
        }),
      ]),
    );
    await setup.db
      .update(schema.subscriptionAddons)
      .set({ status: "active" })
      .where(eq(schema.subscriptionAddons.id, liveActive.id));
    await setup.db
      .update(schema.subscriptionAddons)
      .set({ status: "scheduled" })
      .where(eq(schema.subscriptionAddons.id, scheduledAddon.id));
    const detail = await admin.get(`/platform/tenants/${tenantId}`).expect(200);
    expect(detail.body.activeAddons).toEqual([]);
    expect(detail.body.scheduledAddons).toEqual([]);
    await setup.db
      .update(schema.subscriptionAddons)
      .set({ status: "revoked" })
      .where(inArray(schema.subscriptionAddons.id, [liveActive.id, scheduledAddon.id]));
  });

  it("rejects an already-ended immediate plan term without mutating the tenant timeline", async () => {
    const boundaryTenantId = await createActiveTenant("ended-plan-boundary");
    const beforeSubscriptions = await setup.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, boundaryTenantId));
    const beforeEvents = await setup.db
      .select({ id: schema.subscriptionEvents.id })
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId));
    const beforeAudits = await setup.db
      .select({ id: schema.platformAuditEvents.id })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId));
    const now = Date.now();

    await admin
      .post(`/platform/tenants/${boundaryTenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        effectiveAt: new Date(now - 120_000).toISOString(),
        endsAt: new Date(now - 60_000).toISOString(),
        reason: "ended terms must not mutate",
      })
      .expect(400);

    expect(
      await setup.db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, boundaryTenantId)),
    ).toEqual(beforeSubscriptions);
    expect(
      await setup.db
        .select({ id: schema.subscriptionEvents.id })
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeEvents);
    expect(
      await setup.db
        .select({ id: schema.platformAuditEvents.id })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeAudits);
  });

  it("rejects an already-ended immediate add-on term without inserting history or access", async () => {
    const boundaryTenantId = await createActiveTenant("ended-addon-boundary");
    const beforeAddons = await setup.db
      .select()
      .from(schema.subscriptionAddons)
      .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId));
    const beforeEvents = await setup.db
      .select({ id: schema.subscriptionEvents.id })
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId));
    const beforeAudits = await setup.db
      .select({ id: schema.platformAuditEvents.id })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId));
    const now = Date.now();

    await admin
      .post(`/platform/tenants/${boundaryTenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "immediate",
        effectiveAt: new Date(now - 120_000).toISOString(),
        endsAt: new Date(now - 60_000).toISOString(),
        reason: "ended add-on terms must not mutate",
      })
      .expect(400);

    expect(
      await setup.db
        .select()
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId)),
    ).toEqual(beforeAddons);
    expect(
      await setup.db
        .select({ id: schema.subscriptionEvents.id })
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeEvents);
    expect(
      await setup.db
        .select({ id: schema.platformAuditEvents.id })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeAudits);
  });

  it("rejects backdated immediate add-ons for finite and open-ended parent terms without mutation", async () => {
    const finiteTenantId = await createActiveTenant("backdated-addon-finite");
    const openTenantId = await createActiveTenant("backdated-addon-open", null);

    for (const boundaryTenantId of [finiteTenantId, openTenantId]) {
      const [parent] = await setup.db
        .select({ startsAt: schema.tenantSubscriptions.startsAt })
        .from(schema.tenantSubscriptions)
        .where(
          and(
            eq(schema.tenantSubscriptions.tenantId, boundaryTenantId),
            eq(schema.tenantSubscriptions.status, "active"),
          ),
        );
      if (!parent?.startsAt) throw new Error("Expected an active parent start boundary");
      const beforeAddons = await setup.db
        .select({ id: schema.subscriptionAddons.id })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId));
      const beforeEvents = await setup.db
        .select({ id: schema.subscriptionEvents.id })
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId));
      const beforeAudits = await setup.db
        .select({ id: schema.platformAuditEvents.id })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId));

      await admin
        .post(`/platform/tenants/${boundaryTenantId}/subscription/addons`)
        .send({
          catalogVersionId: addonVersionId,
          quantity: 1,
          activationPolicy: "immediate",
          effectiveAt: new Date(parent.startsAt.getTime() - 60_000).toISOString(),
          reason: "add-on cannot predate parent",
        })
        .expect(400);

      expect(
        await setup.db
          .select({ id: schema.subscriptionAddons.id })
          .from(schema.subscriptionAddons)
          .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId)),
      ).toEqual(beforeAddons);
      expect(
        await setup.db
          .select({ id: schema.subscriptionEvents.id })
          .from(schema.subscriptionEvents)
          .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId)),
      ).toEqual(beforeEvents);
      expect(
        await setup.db
          .select({ id: schema.platformAuditEvents.id })
          .from(schema.platformAuditEvents)
          .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId)),
      ).toEqual(beforeAudits);
    }
  });

  it("rejects an immediate add-on when an active parent has no start boundary", async () => {
    const boundaryTenantId = await createActiveTenant("null-start-addon-parent", null);
    await setup.db
      .update(schema.tenantSubscriptions)
      .set({ startsAt: null })
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, boundaryTenantId),
          eq(schema.tenantSubscriptions.status, "active"),
        ),
      );
    const beforeAddons = await setup.db
      .select({ id: schema.subscriptionAddons.id })
      .from(schema.subscriptionAddons)
      .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId));
    const beforeEvents = await setup.db
      .select({ id: schema.subscriptionEvents.id })
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId));
    const beforeAudits = await setup.db
      .select({ id: schema.platformAuditEvents.id })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId));

    await admin
      .post(`/platform/tenants/${boundaryTenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "immediate",
        reason: "parent start boundary is required",
      })
      .expect(409);

    expect(
      await setup.db
        .select({ id: schema.subscriptionAddons.id })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, boundaryTenantId)),
    ).toEqual(beforeAddons);
    expect(
      await setup.db
        .select({ id: schema.subscriptionEvents.id })
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeEvents);
    expect(
      await setup.db
        .select({ id: schema.platformAuditEvents.id })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, boundaryTenantId)),
    ).toEqual(beforeAudits);
  });

  it("clamps clock-skewed future immediate starts to one truthful server activation time", async () => {
    const clockSkewTenantId = await createActiveTenant("clock-skew-boundary");
    const planRequestStartedAt = Date.now();
    const futurePlanStart = new Date(planRequestStartedAt + 60_000);
    const plan = await admin
      .post(`/platform/tenants/${clockSkewTenantId}/subscription/plan`)
      .send({
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        effectiveAt: futurePlanStart.toISOString(),
        endsAt: new Date(planRequestStartedAt + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        reason: "normalize client clock skew",
      })
      .expect(201);
    const planCompletedAt = Date.now();
    expect(plan.body.status).toBe("active");
    expect(new Date(plan.body.startsAt).getTime()).toBeGreaterThanOrEqual(planRequestStartedAt);
    expect(new Date(plan.body.startsAt).getTime()).toBeLessThanOrEqual(planCompletedAt);

    const addonRequestStartedAt = Date.now();
    const futureAddonStart = new Date(addonRequestStartedAt + 60_000);
    const addon = await admin
      .post(`/platform/tenants/${clockSkewTenantId}/subscription/addons`)
      .send({
        catalogVersionId: addonVersionId,
        quantity: 1,
        activationPolicy: "immediate",
        effectiveAt: futureAddonStart.toISOString(),
        endsAt: new Date(addonRequestStartedAt + 24 * 60 * 60 * 1_000).toISOString(),
        reason: "normalize add-on clock skew",
      })
      .expect(201);
    const addonCompletedAt = Date.now();
    expect(addon.body.status).toBe("active");
    expect(new Date(addon.body.startsAt).getTime()).toBeGreaterThanOrEqual(addonRequestStartedAt);
    expect(new Date(addon.body.startsAt).getTime()).toBeLessThanOrEqual(addonCompletedAt);
  });

  it("captures a direct assignment timestamp only after entering the tenant timeline", async () => {
    const timestampTenantId = await createActiveTenant("assignment-time-boundary");
    const applicationName = `task5-assignment-time-${randomUUID()}`;
    const assignmentUrl = new URL(env.DATABASE_URL);
    assignmentUrl.searchParams.set("application_name", applicationName);
    const assignmentConnection = createDb(assignmentUrl.toString());
    const service = new SubscriptionLifecycleService(
      assignmentConnection.db,
      new PlatformAuditService(),
    );
    const actor: PlatformPrincipal = {
      userId: adminId,
      role: "platform_admin",
      capabilities: platformCapabilitiesForRole("platform_admin"),
      twoFactorReady: true,
    };
    const blocker = await setup.pool.connect();
    let blockerOpen = false;
    let releasedAtMs: number | undefined;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `tenant-subscription:${timestampTenantId}`,
      ]);
      const assignmentAttempt = service.assignPlan(actor, timestampTenantId, {
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        reason: "serialize direct assignment timestamp",
      });
      await waitForDatabaseLock(applicationName);
      releasedAtMs = Date.now();
      await blocker.query("commit");
      blockerOpen = false;
      const assignment = await assignmentAttempt;
      if (releasedAtMs === undefined) throw new Error("Expected a recorded timeline release");
      expect(assignment.startsAt?.getTime()).toBeGreaterThanOrEqual(releasedAtMs);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      blocker.release();
      await assignmentConnection.pool.end();
    }
  }, 30_000);

  it("reports legacy organizations as unmanaged through the bounded list filter", async () => {
    const unmanagedId = randomUUID();
    const unmanagedSlug = `legacy-unmanaged-${randomUUID()}`;
    await setup.db.insert(schema.organization).values({
      id: unmanagedId,
      name: "Legacy unmanaged",
      slug: unmanagedSlug,
      createdAt: new Date(),
    });
    const response = await support
      .get("/platform/tenants")
      .query({ status: "unmanaged", page: 1, limit: 100 })
      .expect(200);
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unmanagedId,
          slug: unmanagedSlug,
          subscriptionStatus: "unmanaged",
        }),
      ]),
    );
    await setup.db.delete(schema.organization).where(eq(schema.organization.id, unmanagedId));
  });
});
