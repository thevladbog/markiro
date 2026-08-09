import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { schema, type PlatformRole } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { TenantProvisioningService } from "../src/modules/platform-tenants/tenant-provisioning.service";
import { mountPlatformAuth, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
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
  let adminId = "";
  let tenantId = "";
  let tenantSlug = "";
  let demoVersionId = "";
  let paidPlanVersionId = "";
  let scheduledPlanOneId = "";
  let scheduledPlanTwoId = "";
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
    addonVersionId = await createPublishedAddon();
    await setup.db
      .insert(schema.platformSettings)
      .values({ key: "default", defaultDemoCatalogVersionId: demoVersionId })
      .onConflictDoUpdate({
        target: schema.platformSettings.key,
        set: { defaultDemoCatalogVersionId: demoVersionId, updatedAt: new Date() },
      });
  }, 120_000);

  afterAll(async () => {
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
    await app?.close();
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
    expect([scheduledPlanOneId, scheduledPlanTwoId]).toContain(scheduled!.planVersionId);

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
        subscriptionId: scheduled!.id,
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
