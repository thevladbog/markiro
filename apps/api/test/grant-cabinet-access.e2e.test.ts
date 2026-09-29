import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type PlatformRole } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { mountPlatformAuth, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
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

const GRANTED_PREFIX = "granted-";

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

const grantedEmail = () => `${GRANTED_PREFIX}${randomUUID()}@example.com`;

describe.skipIf(!ready)("POST /platform/tenants/:id/cabinet-access", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let env: ReturnType<typeof loadEnv>;
  let admin: ReturnType<typeof request.agent>;
  let adminId = "";
  let support: ReturnType<typeof request.agent>;
  let supportId = "";
  let accountant: ReturnType<typeof request.agent>;
  let defaultDemo: DefaultDemoSettingFixture;
  let demoVersionId = "";
  let planVersionId = "";

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
    return { userId, agent: request.agent(app!.getHttpServer()).set("Cookie", cookie) };
  }

  async function createPublishedPlan(demoDurationDays: number | null): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    const code = `plan-${randomUUID()}`;
    await setup.db
      .insert(schema.catalogItems)
      .values({ id: itemId, code, nameRu: code, nameEn: code, kind: "plan" });
    await setup.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: code,
      nameEn: code,
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1200.00",
      vatRate: "20.00",
      vatIncluded: true,
    });
    await setup.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 2,
      maxStations: 3,
      maxKiosks: 1,
      maxCabinetUsers: 5,
      labelEditorEnabled: true,
      demoDurationDays,
    });
    await setup.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    return versionId;
  }

  async function createNoneTenant(): Promise<string> {
    const created = await admin
      .post("/platform/tenants")
      .send({
        tenantName: "Без кабинета",
        tenantSlug: `grant-none-${randomUUID()}`,
        cabinetAccess: "none",
      })
      .expect(201);
    return (created.body as { tenantId: string }).tenantId;
  }

  async function createEnabledTenant(email: string): Promise<string> {
    const created = await admin
      .post("/platform/tenants")
      .send({ tenantName: "С кабинетом", tenantSlug: `grant-enabled-${randomUUID()}`, email })
      .expect(201);
    return (created.body as { tenantId: string }).tenantId;
  }

  async function tenantState(tenantId: string) {
    const [organization] = await setup.db
      .select({ cabinetAccess: schema.organization.cabinetAccess })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId));
    const members = await setup.db
      .select({
        organizationId: schema.member.organizationId,
        userId: schema.member.userId,
        role: schema.member.role,
      })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const deliveries = await setup.db
      .select({
        id: schema.emailDeliveries.id,
        kind: schema.emailDeliveries.kind,
        sourceId: schema.emailDeliveries.sourceId,
        userId: schema.emailDeliveries.userId,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, `tenant-owner:${tenantId}`));
    const [subscriptions] = await setup.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    const grantAudits = await setup.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, tenantId),
          eq(schema.platformAuditEvents.action, "platform.tenant.cabinet_access.granted"),
        ),
      );
    const ownerAudits = await setup.db
      .select({
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "tenant.owner.provisioned"),
        ),
      );
    return {
      cabinetAccess: organization?.cabinetAccess,
      members,
      deliveries,
      subscriptionCount: subscriptions?.count ?? 0,
      grantAudits,
      ownerAudits,
    };
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
    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(env));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    mountPlatformAuth(server, platformSetup.platformAuth, { allowTestSignUp: true });
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    ({ userId: adminId, agent: admin } = await createPlatformAgent("platform_admin"));
    ({ userId: supportId, agent: support } = await createPlatformAgent("support"));
    ({ agent: accountant } = await createPlatformAgent("accountant"));
    demoVersionId = await createPublishedPlan(14);
    planVersionId = await createPublishedPlan(null);
    await defaultDemo.install(demoVersionId);
  }, 120_000);

  afterAll(async () => {
    try {
      const deliveries = await setup.db
        .select({ id: schema.emailDeliveries.id })
        .from(schema.emailDeliveries)
        .where(like(schema.emailDeliveries.recipient, `${GRANTED_PREFIX}%@example.com`));
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

  it("grants the cabinet, provisions the owner and audits exactly, without a demo", async () => {
    const id = await createNoneTenant();
    const email = grantedEmail();
    const response = await admin
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email })
      .expect(201);
    const body = response.body as {
      tenantId: string;
      userId: string;
      memberId: string;
      deliveryId: string;
    };
    expect(body).toEqual({
      tenantId: id,
      userId: expect.any(String),
      memberId: expect.any(String),
      deliveryId: expect.any(String),
    });

    const state = await tenantState(id);
    expect(state.cabinetAccess).toBe("enabled");
    expect(state.members).toEqual([{ organizationId: id, userId: body.userId, role: "owner" }]);
    expect(state.deliveries).toEqual([
      {
        id: body.deliveryId,
        kind: "tenant-owner-activation",
        sourceId: `tenant-owner:${id}`,
        userId: body.userId,
      },
    ]);
    expect(state.subscriptionCount).toBe(0);
    expect(state.grantAudits).toHaveLength(1);
    expect(state.grantAudits[0]).toMatchObject({
      actorPlatformUserId: adminId,
      actorRole: "platform_admin",
      action: "platform.tenant.cabinet_access.granted",
      outcome: "success",
      tenantId: id,
      targetType: "member",
      targetId: body.memberId,
      reason: null,
      before: { cabinetAccess: "none" },
      after: { cabinetAccess: "enabled", ownerUserId: body.userId, deliveryId: body.deliveryId },
    });
    expect(state.ownerAudits).toEqual([
      {
        actorUserId: null,
        action: "tenant.owner.provisioned",
        outcome: "success",
        targetType: "member",
        targetId: body.memberId,
      },
    ]);
    const [user] = await setup.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, body.userId));
    expect(user).toEqual({ email });
  });

  it("shows the tenant as enabled with an owner activation and allows renewal", async () => {
    const id = await createNoneTenant();
    const email = grantedEmail();
    await admin.post(`/platform/tenants/${id}/cabinet-access`).send({ email }).expect(201);
    const detail = await admin
      .get(`/platform/tenants/${id}`)
      .set("X-Markiro-Commercial-Version", "3")
      .expect(200);
    expect(detail.body.tenant).toMatchObject({ cabinetAccess: "enabled" });
    expect(detail.body.ownerActivation).toMatchObject({ ownerEmail: email, status: "queued" });
    const renewed = await admin
      .post(`/platform/tenants/${id}/owner-activation/renew`)
      .send({})
      .expect(200);
    expect(renewed.body).toEqual({ deliveryId: expect.any(String) });
  });

  it("refuses a tenant that already has a cabinet with 409", async () => {
    const enabledId = await createEnabledTenant(grantedEmail());
    const originally = await admin
      .post(`/platform/tenants/${enabledId}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(409);
    expect(originally.body.code).toBe("cabinet_access_already_enabled");

    const id = await createNoneTenant();
    await admin
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(201);
    const second = await admin
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(409);
    expect(second.body.code).toBe("cabinet_access_already_enabled");
    const state = await tenantState(id);
    expect(state.members).toHaveLength(1);
    expect(state.grantAudits).toHaveLength(1);
  });

  it("returns tenant_not_found for an unknown tenant", async () => {
    const response = await admin
      .post(`/platform/tenants/${randomUUID()}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(404);
    expect(response.body.code).toBe("tenant_not_found");
  });

  it("denies the accountant like tenant creation and lets support grant", async () => {
    const id = await createNoneTenant();
    await accountant
      .post("/platform/tenants")
      .send({ tenantName: "Нет", tenantSlug: `denied-${randomUUID()}`, cabinetAccess: "none" })
      .expect(403);
    await accountant
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(403);
    const unchanged = await tenantState(id);
    expect(unchanged).toMatchObject({
      cabinetAccess: "none",
      members: [],
      deliveries: [],
      grantAudits: [],
      ownerAudits: [],
    });

    // Support holds tenants.write and may create tenants, so it may also grant.
    const granted = await support
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email: grantedEmail() })
      .expect(201);
    const state = await tenantState(id);
    expect(state.grantAudits).toHaveLength(1);
    expect(state.grantAudits[0]).toMatchObject({
      actorPlatformUserId: supportId,
      actorRole: "support",
      targetId: (granted.body as { memberId: string }).memberId,
    });
  });

  it("rejects an invalid body with 400 and changes nothing", async () => {
    const id = await createNoneTenant();
    for (const body of [{}, { email: "not-an-email" }, { email: grantedEmail(), extra: true }]) {
      await admin.post(`/platform/tenants/${id}/cabinet-access`).send(body).expect(400);
    }
    expect((await tenantState(id)).cabinetAccess).toBe("none");
  });

  it("reuses an account that already owns another tenant, as provisioning does", async () => {
    const email = grantedEmail();
    const enabledId = await createEnabledTenant(email);
    const id = await createNoneTenant();
    const granted = await admin
      .post(`/platform/tenants/${id}/cabinet-access`)
      .send({ email })
      .expect(201);
    const [existingOwner] = await setup.db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, enabledId));
    expect((granted.body as { userId: string }).userId).toBe(existingOwner?.userId);
    const state = await tenantState(id);
    expect(state.members).toEqual([
      { organizationId: id, userId: existingOwner?.userId, role: "owner" },
    ]);
    expect(state.deliveries).toHaveLength(1);
  });

  it("lets exactly one of two concurrent grants win", async () => {
    const id = await createNoneTenant();
    const responses = await Promise.all([
      admin.post(`/platform/tenants/${id}/cabinet-access`).send({ email: grantedEmail() }),
      admin.post(`/platform/tenants/${id}/cabinet-access`).send({ email: grantedEmail() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(loser?.body.code).toBe("cabinet_access_already_enabled");
    const state = await tenantState(id);
    expect(state.members).toHaveLength(1);
    expect(state.members[0]?.role).toBe("owner");
    expect(state.deliveries).toHaveLength(1);
    expect(state.grantAudits).toHaveLength(1);
  });

  it("serializes a grant with a concurrent plan assignment without deadlocking", async () => {
    const id = await createNoneTenant();
    const [grant, plan] = await Promise.all([
      admin.post(`/platform/tenants/${id}/cabinet-access`).send({ email: grantedEmail() }),
      admin
        .post(`/platform/tenants/${id}/subscription/plan`)
        .set("X-Markiro-Commercial-Version", "2")
        .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "race" }),
    ]);
    expect(grant.status).toBe(201);
    // Whichever took the tenant timeline lock first decides: before the grant
    // the licence is refused, after it the licence is assigned. Never a 500.
    if (plan.status === 409) {
      expect(plan.body.code).toBe("catalog_kind_not_allowed_for_offline_tenant");
      expect((await tenantState(id)).subscriptionCount).toBe(0);
    } else {
      expect(plan.status).toBe(201);
      expect((await tenantState(id)).subscriptionCount).toBe(1);
    }
    expect((await tenantState(id)).cabinetAccess).toBe("enabled");
  });
});
