import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, desc, eq } from "drizzle-orm";
import { schema, type PlatformRole } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import {
  mountPlatformAuth,
  setupPlatformAuth,
  type PlatformAuthSetup,
} from "../src/platform-auth/platform-auth.setup";
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
  let setup: AuthSetup;
  let platformSetup: PlatformAuthSetup;
  let env: ReturnType<typeof loadEnv>;
  let admin: ReturnType<typeof request.agent>;
  let accountant: ReturnType<typeof request.agent>;
  let support: ReturnType<typeof request.agent>;
  let accountantId = "";

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

  const basicPlan = {
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
    const createdAccountant = await createPlatformAgent("accountant");
    accountant = createdAccountant.agent;
    accountantId = createdAccountant.userId;
    support = (await createPlatformAgent("support")).agent;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
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
        addon: { effects: [{ key: "lines", quotaIncrement: -1 }] },
      })
      .expect(400);
    await admin
      .post(`/platform/catalog/items/service-effects-${randomUUID()}/versions`)
      .send({
        ...basicPlan,
        billingMode: "one_time",
        billingPeriod: null,
        service: {},
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
});
