import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq, inArray, like, sql } from "drizzle-orm";
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

const OFFLINE_CODE = "catalog_kind_not_allowed_for_offline_tenant";

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

describe.skipIf(!ready)("licences are refused for tenants without a cabinet", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let env: ReturnType<typeof loadEnv>;
  let admin: ReturnType<typeof request.agent>;
  let defaultDemo: DefaultDemoSettingFixture;
  let demoVersionId = "";
  let planVersionId = "";
  let addonVersionId = "";
  let serviceVersionId = "";

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
    return request.agent(app!.getHttpServer()).set("Cookie", cookie);
  }

  async function createPublishedVersion(
    kind: "plan" | "addon" | "service",
    demoDurationDays: number | null = null,
  ): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    const code = `${kind}-${randomUUID()}`;
    await setup.db
      .insert(schema.catalogItems)
      .values({ id: itemId, code, nameRu: code, nameEn: code, kind });
    await setup.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind,
      version: 1,
      nameRu: code,
      nameEn: code,
      unit: kind === "service" ? "project" : "month",
      billingMode: kind === "service" ? "one_time" : "recurring",
      ...(kind === "service" ? {} : { billingPeriod: "month" as const }),
      unitPrice: "1200.00",
      vatRate: "20.00",
      vatIncluded: true,
    });
    if (kind === "plan") {
      await setup.db.insert(schema.planEntitlements).values({
        catalogVersionId: versionId,
        maxLines: 2,
        maxStations: 3,
        maxKiosks: 1,
        maxCabinetUsers: 5,
        labelEditorEnabled: true,
        demoDurationDays,
      });
    }
    if (kind === "addon") {
      await setup.db.insert(schema.addonEntitlements).values({
        catalogVersionId: versionId,
        entitlementKey: "lines",
        quotaIncrement: 1,
      });
    }
    await setup.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    return versionId;
  }

  async function createOfflineTenant(): Promise<string> {
    const id = randomUUID();
    await setup.db.insert(schema.organization).values({
      id,
      name: "Offline",
      slug: `offline-${id}`,
      createdAt: new Date(),
      cabinetAccess: "none",
    });
    return id;
  }

  async function subscriptionCount(tenantId: string): Promise<number> {
    const [row] = await setup.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    return row?.count ?? 0;
  }

  const offerLine = (kind: "plan" | "service", catalogVersionId: string | null) => ({
    kind,
    catalogVersionId,
    nameRu: "Строка",
    nameEn: "Line",
    quantity: 1,
    unit: kind === "plan" ? "month" : "project",
    agreedUnitPrice: "1200.00",
    vatRateBps: null,
    vatIncluded: false,
    activationPolicy: kind === "plan" ? ("immediately" as const) : null,
  });

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

    admin = await createPlatformAgent("platform_admin");
    demoVersionId = await createPublishedVersion("plan", 14);
    planVersionId = await createPublishedVersion("plan");
    addonVersionId = await createPublishedVersion("addon");
    serviceVersionId = await createPublishedVersion("service");
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

  it("assign plan to a none tenant is refused with 409", async () => {
    const id = await createOfflineTenant();
    const response = await admin
      .post(`/platform/tenants/${id}/subscription/plan`)
      .set("X-Markiro-Commercial-Version", "2")
      .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "x" });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe(OFFLINE_CODE);
  });

  it("assign add-on to a none tenant is refused before the subscription lookup", async () => {
    const id = await createOfflineTenant();
    const response = await admin
      .post(`/platform/tenants/${id}/subscription/addons`)
      .set("X-Markiro-Commercial-Version", "2")
      .send({
        catalogVersionId: addonVersionId,
        activationPolicy: "immediate",
        quantity: 1,
        reason: "x",
        expectedSubscriptionId: randomUUID(),
      });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe(OFFLINE_CODE);
  });

  it("offer with a plan line for a none tenant is refused", async () => {
    const id = await createOfflineTenant();
    const response = await admin
      .post("/platform/offers")
      .set("X-Markiro-Commercial-Version", "2")
      .send({ tenantId: id, lines: [offerLine("plan", planVersionId)] });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe(OFFLINE_CODE);
  });

  it("offer with only a service line for a none tenant is created", async () => {
    const id = await createOfflineTenant();
    await admin
      .post("/platform/offers")
      .set("X-Markiro-Commercial-Version", "2")
      .send({ tenantId: id, lines: [offerLine("service", null)] })
      .expect(201);
  });

  it("invoice with a plan line for a none tenant is refused; a service line is created", async () => {
    const id = await createOfflineTenant();
    const line = (kind: "plan" | "service", catalogVersionId: string) => ({
      kind,
      catalogVersionId,
      quantity: 1,
      agreedUnitPrice: "1200.00",
      vatIncluded: false,
      activationPolicy: kind === "plan" ? ("immediate" as const) : null,
    });
    const refused = await admin
      .post("/platform/invoices")
      .set("X-Markiro-Commercial-Version", "2")
      .send({ tenantId: id, applicationMode: "manual", lines: [line("plan", planVersionId)] });
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe(OFFLINE_CODE);
    await admin
      .post("/platform/invoices")
      .set("X-Markiro-Commercial-Version", "2")
      .send({ tenantId: id, applicationMode: "manual", lines: [line("service", serviceVersionId)] })
      .expect(201);
  });

  it("the same plan assignment for an enabled tenant is unaffected", async () => {
    const created = await admin
      .post("/platform/tenants")
      .send({
        tenantName: "Enabled tenant",
        tenantSlug: `enabled-${randomUUID()}`,
        email: `platform-owner-${randomUUID()}@example.com`,
      })
      .expect(201);
    const enabledId = (created.body as { tenantId: string }).tenantId;
    await admin
      .post(`/platform/tenants/${enabledId}/subscription/plan`)
      .set("X-Markiro-Commercial-Version", "2")
      .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "x" })
      .expect(201);
  });

  it("a refusal creates no subscription rows and leaves other tenants untouched", async () => {
    const offline = await createOfflineTenant();
    const created = await admin
      .post("/platform/tenants")
      .send({
        tenantName: "Bystander",
        tenantSlug: `bystander-${randomUUID()}`,
        email: `platform-owner-${randomUUID()}@example.com`,
      })
      .expect(201);
    const other = (created.body as { tenantId: string }).tenantId;
    const before = await subscriptionCount(other);
    await admin
      .post(`/platform/tenants/${offline}/subscription/plan`)
      .set("X-Markiro-Commercial-Version", "2")
      .send({ catalogVersionId: planVersionId, activationPolicy: "immediate", reason: "x" })
      .expect(409);
    expect(await subscriptionCount(offline)).toBe(0);
    expect(await subscriptionCount(other)).toBe(before);
  });
});
