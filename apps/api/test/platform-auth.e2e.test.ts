import { createHmac, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@markiro/db";
import { platformErrorSchema } from "@markiro/platform-contracts";
import { and, desc, eq, sql } from "drizzle-orm";
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
import { PlatformActivationController } from "../src/platform-auth/platform-activation.controller";
import { PlatformAuditController } from "../src/platform-auth/platform-audit.controller";
import { PlatformMeController } from "../src/platform-auth/platform-me.controller";
import { PlatformTeamController } from "../src/platform-auth/platform-team.controller";

@Controller("platform/unclassified-test")
class UnclassifiedPlatformController {
  @Get()
  read() {
    return { exposed: true };
  }
}

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.PLATFORM_AUTH_SECRET &&
  process.env.PLATFORM_AUTH_URL &&
  process.env.SAAS_ADMIN_ORIGIN,
);

describe("platform identity response boundaries", () => {
  it("rejects a malformed principal before returning it", () => {
    const controller = new PlatformMeController();

    expect(() =>
      controller.me({
        platformPrincipal: {
          userId: "platform-user-1",
          role: "support",
          capabilities: ["billing.write"],
          twoFactorReady: true,
        },
      } as never),
    ).toThrow();
  });

  it("normalizes the team list and parses every team mutation success", async () => {
    const controller = new PlatformTeamController({
      list: async () => [
        {
          id: "platform-user-2",
          name: "Support Operator",
          email: "support@example.invalid",
          role: "support",
          status: "invited",
          twoFactorReady: false,
          createdAt: new Date("2026-08-11T18:08:42.158Z"),
        },
      ],
      invite: async () => ({
        userId: "platform-user-2",
        deliveryId: "11111111-1111-4111-8111-111111111111",
      }),
      changeRole: async () => undefined,
      suspend: async () => undefined,
      renewActivation: async () => ({
        userId: "platform-user-2",
        deliveryId: "21111111-1111-4111-8111-111111111111",
      }),
      recoverTwoFactor: async () => undefined,
    } as never);
    const request = {
      platformPrincipal: {
        userId: "platform-admin-1",
        role: "platform_admin",
        capabilities: [
          "tenants.read",
          "tenants.write",
          "catalog.read",
          "catalog.write",
          "billing.read",
          "billing.write",
          "platformTeam.write",
          "audit.read",
        ],
        twoFactorReady: true,
      },
    } as never;

    await expect(controller.list()).resolves.toEqual([
      expect.objectContaining({ createdAt: "2026-08-11T18:08:42.158Z" }),
    ]);
    await expect(
      controller.invite(request, { email: "support@example.invalid", role: "support" }),
    ).resolves.toMatchObject({ userId: "platform-user-2" });
    await expect(
      controller.changeRole(request, { id: "platform-user-2" }, { role: "accountant" }),
    ).resolves.toEqual({ status: true });
    await expect(controller.suspend(request, { id: "platform-user-2" })).resolves.toEqual({
      status: true,
    });
    await expect(
      controller.renewActivation(request, { id: "platform-user-2" }),
    ).resolves.toMatchObject({
      userId: "platform-user-2",
    });
    await expect(controller.recoverTwoFactor(request, { id: "platform-user-2" })).resolves.toEqual({
      status: true,
    });
  });

  it.each([
    [
      "invite",
      { deliveryId: "11111111-1111-4111-8111-111111111111" },
      (controller: PlatformTeamController, platformRequest: never) =>
        controller.invite(platformRequest, {
          email: "support@example.invalid",
          role: "support",
        }),
    ],
    [
      "renew activation",
      { userId: "platform-user-2" },
      (controller: PlatformTeamController, platformRequest: never) =>
        controller.renewActivation(platformRequest, { id: "platform-user-2" }),
    ],
    [
      "change role acknowledgement",
      { status: false },
      (controller: PlatformTeamController, platformRequest: never) =>
        controller.changeRole(platformRequest, { id: "platform-user-2" }, { role: "accountant" }),
    ],
    [
      "suspend acknowledgement",
      { status: "ok" },
      (controller: PlatformTeamController, platformRequest: never) =>
        controller.suspend(platformRequest, { id: "platform-user-2" }),
    ],
    [
      "recover 2FA acknowledgement",
      {},
      (controller: PlatformTeamController, platformRequest: never) =>
        controller.recoverTwoFactor(platformRequest, { id: "platform-user-2" }),
    ],
  ] as const)("rejects a malformed %s service success", async (_name, malformed, invoke) => {
    const controller = new PlatformTeamController({
      list: async () => [],
      invite: async () => malformed,
      changeRole: async () => malformed,
      suspend: async () => malformed,
      renewActivation: async () => malformed,
      recoverTwoFactor: async () => malformed,
    } as never);
    const platformRequest = {
      platformPrincipal: {
        userId: "platform-admin-1",
        role: "platform_admin",
        capabilities: [
          "tenants.read",
          "tenants.write",
          "catalog.read",
          "catalog.write",
          "billing.read",
          "billing.write",
          "platformTeam.write",
          "audit.read",
        ],
        twoFactorReady: true,
      },
    } as never;

    await expect(invoke(controller, platformRequest)).rejects.toThrow();
  });

  it("normalizes audit timestamps and rejects a malformed activation success", async () => {
    const rows = [
      {
        id: "31111111-1111-4111-8111-111111111111",
        actorPlatformUserId: null,
        actorRole: null,
        action: "platform.activation.denied",
        outcome: "denied",
        tenantId: null,
        targetType: "platform_user",
        targetId: null,
        reason: "activation_unavailable",
        before: null,
        after: null,
        requestId: null,
        createdAt: new Date("2026-08-11T18:08:42.158Z"),
      },
    ];
    const query = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({ offset: async () => rows }),
            }),
          }),
        }),
      }),
    };
    const audit = new PlatformAuditController(query as never);
    const response = await audit.list(
      {
        platformPrincipal: {
          role: "platform_admin",
        },
      } as never,
      { limit: 50, offset: 0 } as never,
    );
    expect(response.items[0]?.createdAt).toBe("2026-08-11T18:08:42.158Z");

    const activation = new PlatformActivationController({
      completePublicRequest: async () => ({ twoFactorEnrollmentRequired: false }),
    } as never);
    await expect(
      activation.complete({
        token: "activation-token-with-enough-entropy",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow();
  });
});

function requiredSetCookie(response: request.Response, prefix: string): string {
  const values = response.headers["set-cookie"];
  const cookies = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const selected = cookies.find((cookie) => cookie.startsWith(prefix));
  if (!selected) {
    throw new Error(
      `Expected authentication cookie; received names: ${cookies
        .map((cookie) => cookie.split("=", 1)[0])
        .join(", ")}`,
    );
  }
  return selected;
}

function currentTotp(uri: string): string {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded) throw new Error("Expected TOTP enrollment URI");
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
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

describe.skipIf(!ready)("platform authentication isolation", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let platformSetup: PlatformAuthSetup;
  let platformUserId = "";
  let platformCookie = "";
  let platformSetCookie = "";
  let customerCookie = "";
  let platformPassword = "";
  let env: ReturnType<typeof loadEnv>;

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
      controllers: [UnclassifiedPlatformController],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(env));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    mountPlatformAuth(server, platformSetup.platformAuth, { allowTestSignUp: true });
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    platformPassword = randomBytes(24).toString("base64url");
    const platformResponse = await request(app.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({
        email: `platform-${randomUUID()}@example.invalid`,
        password: platformPassword,
        name: "Platform user",
      })
      .expect(200);
    platformUserId = (platformResponse.body as { user: { id: string } }).user.id;
    platformSetCookie = requiredSetCookie(platformResponse, "markiro-platform.session_token=");
    platformCookie = platformSetCookie.split(";", 1)[0]!;
    await setup.db
      .update(schema.platformUsers)
      .set({ status: "active" })
      .where(eq(schema.platformUsers.id, platformUserId));

    const customerResponse = await request(app.getHttpServer())
      .post("/api/auth/sign-up/email")
      .set("Origin", env.ADMIN_ORIGIN)
      .send({
        email: `customer-${randomUUID()}@example.invalid`,
        password: randomBytes(24).toString("base64url"),
        name: "Customer user",
      })
      .expect(200);
    customerCookie = requiredSetCookie(customerResponse, "better-auth.session_token=").split(
      ";",
      1,
    )[0]!;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("does not let a customer session authenticate the platform surface", async () => {
    await request(app!.getHttpServer())
      .get("/platform/me")
      .set("Cookie", customerCookie)
      .expect(401);
  });

  it("rejects an unclassified platform controller through the module boundary", async () => {
    await request(app!.getHttpServer()).get("/platform/unclassified-test").expect(403);
  });

  it("keeps token activation explicitly public while auditing an unavailable token", async () => {
    const response = await request(app!.getHttpServer())
      .post("/platform/activation/complete")
      .send({
        token: randomBytes(24).toString("base64url"),
        password: randomBytes(24).toString("base64url"),
      })
      .expect(404);
    expect(response.headers["set-cookie"]).toBeUndefined();

    const [denial] = await setup.db
      .select({
        action: schema.platformAuditEvents.action,
        outcome: schema.platformAuditEvents.outcome,
        reason: schema.platformAuditEvents.reason,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.action, "platform.activation.denied"))
      .orderBy(schema.platformAuditEvents.createdAt);
    expect(denial).toEqual({
      action: "platform.activation.denied",
      outcome: "denied",
      reason: "activation_unavailable",
      before: null,
      after: null,
    });
  });

  it("audits malformed public activation payloads exactly once without credential metadata", async () => {
    const attempts = [
      {
        token: randomBytes(4).toString("base64url"),
        password: randomBytes(24).toString("base64url"),
      },
      {
        token: randomBytes(24).toString("base64url"),
        password: randomBytes(4).toString("base64url"),
      },
    ];

    for (const attempt of attempts) {
      const beforeCountRows = await setup.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.action, "platform.activation.denied"),
            eq(schema.platformAuditEvents.reason, "malformed_request"),
          ),
        );
      const beforeCount = beforeCountRows[0]?.count ?? 0;

      const response = await request(app!.getHttpServer())
        .post("/platform/activation/complete")
        .send(attempt)
        .expect(404);
      const error = platformErrorSchema.parse(response.body);
      expect(error).toMatchObject({
        code: "activation_unavailable",
        message: "The requested platform resource was not found.",
      });
      expect(error.requestId).toBe(response.headers["x-request-id"]);

      const afterCountRows = await setup.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.action, "platform.activation.denied"),
            eq(schema.platformAuditEvents.reason, "malformed_request"),
          ),
        );
      const afterCount = afterCountRows[0]?.count ?? 0;
      expect(afterCount).toBe(beforeCount + 1);

      const [denial] = await setup.db
        .select({
          action: schema.platformAuditEvents.action,
          outcome: schema.platformAuditEvents.outcome,
          targetId: schema.platformAuditEvents.targetId,
          reason: schema.platformAuditEvents.reason,
          before: schema.platformAuditEvents.before,
          after: schema.platformAuditEvents.after,
        })
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.action, "platform.activation.denied"),
            eq(schema.platformAuditEvents.reason, "malformed_request"),
          ),
        )
        .orderBy(desc(schema.platformAuditEvents.createdAt), desc(schema.platformAuditEvents.id))
        .limit(1);
      expect(denial).toEqual({
        action: "platform.activation.denied",
        outcome: "denied",
        targetId: null,
        reason: "malformed_request",
        before: null,
        after: null,
      });
      const serializedDenial = JSON.stringify(denial);
      expect(
        [attempt.token, attempt.password].some((credential) =>
          serializedDenial.includes(credential),
        ),
      ).toBe(false);
    }
  });

  it("requires verified platform TOTP before returning the platform principal", async () => {
    await request(app!.getHttpServer())
      .get("/platform/me")
      .set("Cookie", platformCookie)
      .expect(403);

    const enrollment = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/enable")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .set("Cookie", platformCookie)
      .send({ password: platformPassword })
      .expect(200);
    const code = currentTotp((enrollment.body as { totpURI: string }).totpURI);
    const verified = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/verify-totp")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .set("Cookie", platformCookie)
      .send({ code, trustDevice: false })
      .expect(200);
    const replacementCookies = verified.headers["set-cookie"];
    if (replacementCookies) {
      platformSetCookie = requiredSetCookie(verified, "markiro-platform.session_token=");
      platformCookie = platformSetCookie.split(";", 1)[0]!;
    }

    const response = await request(app!.getHttpServer())
      .get("/platform/me")
      .set("Cookie", platformCookie)
      .expect(200);
    expect(response.body).toEqual({
      userId: platformUserId,
      role: "support",
      capabilities: ["tenants.read", "tenants.write", "catalog.read", "audit.read"],
      twoFactorReady: true,
    });
    expect(response.text).not.toMatch(/secret|backup|session|token/i);
  });

  it("reloads role and suspension state from the database on every request", async () => {
    await setup.db
      .update(schema.platformUsers)
      .set({ role: "accountant" })
      .where(eq(schema.platformUsers.id, platformUserId));
    const reloaded = await request(app!.getHttpServer())
      .get("/platform/me")
      .set("Cookie", platformCookie)
      .expect(200);
    expect(reloaded.body.role).toBe("accountant");
    expect(reloaded.body.capabilities).toContain("billing.write");
    expect(reloaded.body.capabilities).not.toContain("tenants.write");

    await setup.db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, platformUserId));
    await request(app!.getHttpServer())
      .get("/platform/me")
      .set("Cookie", platformCookie)
      .expect(403);
    await setup.db
      .update(schema.platformUsers)
      .set({ status: "active", role: "platform_admin" })
      .where(eq(schema.platformUsers.id, platformUserId));
  });

  it("does not let a platform cookie authenticate customer routes", async () => {
    await request(app!.getHttpServer())
      .get("/counterparties")
      .set("Cookie", platformCookie)
      .expect(401);
  });

  it("does not let support mutate the platform team", async () => {
    await setup.db
      .update(schema.platformUsers)
      .set({ role: "support", status: "active", twoFactorEnabled: true })
      .where(eq(schema.platformUsers.id, platformUserId));
    await request(app!.getHttpServer())
      .post("/platform/team")
      .set("Cookie", platformCookie)
      .send({ email: `denied-${randomUUID()}@example.invalid`, role: "accountant" })
      .expect(403);
  });

  it("filters bounded audit queries by the reloaded platform role and redacts secret metadata", async () => {
    const tenantId = `platform-audit-${randomUUID()}`;
    await setup.db.insert(schema.organization).values({
      id: tenantId,
      name: "Platform audit tenant",
      slug: tenantId,
      createdAt: new Date(),
    });
    await setup.db.insert(schema.platformAuditEvents).values([
      {
        actorPlatformUserId: platformUserId,
        actorRole: "platform_admin",
        action: "platform.tenant.created",
        outcome: "success",
        tenantId,
        targetType: "tenant",
        targetId: tenantId,
        after: {
          status: "active",
          amount: "support-must-not-see-amount",
          price: "support-must-not-see-price",
          offer: { name: "support-must-not-see-offer" },
          payment: { state: "support-must-not-see-payment" },
        },
      },
      {
        actorPlatformUserId: platformUserId,
        actorRole: "platform_admin",
        action: "payment.recorded",
        outcome: "success",
        tenantId,
        targetType: "payment",
        targetId: randomUUID(),
        after: { amount: "100.00", activationToken: "must-not-return" },
      },
      {
        actorPlatformUserId: platformUserId,
        actorRole: "platform_admin",
        action: "platform.team.role_changed",
        outcome: "success",
        targetType: "platform_user",
        targetId: platformUserId,
      },
    ]);

    await setup.db
      .update(schema.platformUsers)
      .set({ role: "support" })
      .where(eq(schema.platformUsers.id, platformUserId));
    const support = await request(app!.getHttpServer())
      .get("/platform/audit?limit=100")
      .set("Cookie", platformCookie)
      .expect(200);
    expect(support.body.items.length).toBeGreaterThan(0);
    expect(
      support.body.items.every((item: { action: string }) =>
        item.action.startsWith("platform.tenant."),
      ),
    ).toBe(true);
    const supportTenantEvent = support.body.items.find(
      (item: { targetId: string }) => item.targetId === tenantId,
    );
    expect(supportTenantEvent.after).toEqual({ status: "active" });

    await setup.db
      .update(schema.platformUsers)
      .set({ role: "accountant" })
      .where(eq(schema.platformUsers.id, platformUserId));
    const accountant = await request(app!.getHttpServer())
      .get("/platform/audit?limit=100")
      .set("Cookie", platformCookie)
      .expect(200);
    expect(
      accountant.body.items.some((item: { action: string }) => item.action === "payment.recorded"),
    ).toBe(true);
    expect(
      accountant.body.items.every((item: { action: string }) =>
        ["payment.", "billing.", "catalog.", "offer.", "subscription."].some((prefix) =>
          item.action.startsWith(prefix),
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(accountant.body)).not.toContain("must-not-return");

    await setup.db
      .update(schema.platformUsers)
      .set({ role: "platform_admin" })
      .where(eq(schema.platformUsers.id, platformUserId));
    const administratorTenant = await request(app!.getHttpServer())
      .get(`/platform/audit?action=platform.tenant.created&tenantId=${tenantId}&limit=10`)
      .set("Cookie", platformCookie)
      .expect(200);
    expect(administratorTenant.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: tenantId,
          after: expect.objectContaining({
            amount: "support-must-not-see-amount",
            price: "support-must-not-see-price",
          }),
        }),
      ]),
    );
    const administrator = await request(app!.getHttpServer())
      .get("/platform/audit?action=platform.team.role_changed&limit=10")
      .set("Cookie", platformCookie)
      .expect(200);
    expect(administrator.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "platform.team.role_changed" })]),
    );
  });

  it("disables public platform sign-up and keeps cookie attributes platform-specific", async () => {
    const lockedServer = express();
    mountPlatformAuth(lockedServer, platformSetup.platformAuth, { allowTestSignUp: false });
    await request(lockedServer)
      .post("/api/platform-auth/sign-up/email")
      .send({ email: "blocked@example.invalid", password: "not-used", name: "Blocked" })
      .expect(404);

    const response = await request(app!.getHttpServer())
      .post("/api/platform-auth/sign-in/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({ email: "unknown@example.invalid", password: "not-used" });
    expect(response.headers["set-cookie"]).toBeUndefined();

    const storedCookie = platformSetCookie.replace(/=([^;]+)/, "=<redacted>");
    expect(storedCookie).toContain("markiro-platform.session_token=<redacted>");
    expect(storedCookie).toContain("Path=/");
    expect(storedCookie).toContain("HttpOnly");
    expect(storedCookie).toContain("Secure");
    expect(storedCookie).toContain("SameSite=Lax");
    expect(storedCookie).not.toContain("Domain=");
  });

  it("allows only the exact SaaS origin on platform routes and preflight", async () => {
    const accepted = await request(app!.getHttpServer())
      .options("/platform/me")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);
    expect(accepted.headers["access-control-allow-origin"]).toBe(env.SAAS_ADMIN_ORIGIN);
    expect(accepted.headers["access-control-allow-credentials"]).toBe("true");

    const platformOrigin = new URL(env.SAAS_ADMIN_ORIGIN);
    const suffixOrigin = `${platformOrigin.protocol}//${platformOrigin.hostname}.evil.test${
      platformOrigin.port ? `:${platformOrigin.port}` : ""
    }`;
    const siblingOrigin = `${platformOrigin.protocol}//sibling.${platformOrigin.hostname}${
      platformOrigin.port ? `:${platformOrigin.port}` : ""
    }`;
    for (const rejectedOrigin of [env.ADMIN_ORIGIN, suffixOrigin, siblingOrigin]) {
      const rejected = await request(app!.getHttpServer())
        .options("/platform/me")
        .set("Origin", rejectedOrigin)
        .set("Access-Control-Request-Method", "GET")
        .expect(204);
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("does not issue platform credentials to the customer origin", async () => {
    const response = await request(app!.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.ADMIN_ORIGIN)
      .send({
        email: `cross-origin-${randomUUID()}@example.invalid`,
        password: randomBytes(24).toString("base64url"),
        name: "Rejected",
      })
      .expect(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
