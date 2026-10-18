import { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { describe, expect, it, vi } from "vitest";
import { PgBossService } from "../src/jobs/jobs.module";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { Test } from "@nestjs/testing";
import { createDb } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { MailTransportService } from "../src/modules/mail/mail-transport.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { createApplication } from "../src/main";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { DB, DB_POOL } from "../src/auth/auth.module";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { SupportChatJobsService } from "../src/modules/support-chat/support-chat-jobs.service";

// The disposable database is explicitly supplied; never load a shared .env.
describe.skipIf(!process.env.PLATFORM_PROFILE_TEST_DATABASE_URL)(
  "actual platform bootstrap",
  () => {
    it("starts only platform workers and leaves restored cloud schedules untouched", async () => {
      const env = loadEnv({
        ...PLATFORM_TEST_ENV,
        SERVER_PROFILE: "platform-only",
        DATABASE_URL: process.env.PLATFORM_PROFILE_TEST_DATABASE_URL,
      });
      const connection = createDb(env.DATABASE_URL);
      const module = await Test.createTestingModule({
        imports: [
          AppModule.forRoot({
            ...connection,
            ...setupPlatformAuth(env, connection.db),
            databaseUrl: env.DATABASE_URL,
            env,
          }),
        ],
      })
        .overrideProvider(MailRetentionService)
        .useValue({ prune: vi.fn(async () => undefined) })
        .overrideProvider(MailTransportService)
        .useValue({
          verify: vi.fn(async () => undefined),
          health: { status: "healthy" },
          send: vi.fn(),
        })
        .overrideProvider(ObjectStorageService)
        .useValue({ ensureBucket: vi.fn(async () => undefined) })
        .compile();
      const app = module.createNestApplication();
      try {
        await app.init();
        await listenOnLoopback(app);
        await module.get(PgBossService).checkReady();
        expect(module.get(MailRetentionService).prune).not.toHaveBeenCalled();
        const health = await request(app.getHttpServer()).get("/health/ready").expect(200);
        expect(health.body.status).toBe("ok");
        expect(Object.keys(health.body.checks).sort()).toEqual([
          "database",
          "jobs",
          "smtp",
          "storage",
        ]);
        expect(module.get(MailTransportService).verify).toHaveBeenCalledOnce();
        expect(module.get(ObjectStorageService).ensureBucket).toHaveBeenCalledOnce();
        const queues = await connection.pool.query(
          "select name from pgboss_platform.queue order by name",
        );
        expect(queues.rows.map((row: { name: string }) => row.name)).toEqual([
          "__pgboss__send-it",
          "dispatch-email-outbox",
          "materialize-subscription-statuses",
          "platform-report-repair",
          "platform-report-run",
          "prune-email-deliveries",
          "reconcile-email-deliveries",
          "send-email-delivery",
        ]);
      } finally {
        await app.close();
      }
    }, 60000);
  },
);

it.skipIf(!process.env.PLATFORM_PROFILE_TEST_DATABASE_URL)(
  "uses production bootstrap: no cabinet handler, real platform auth guard, historical cloud schedules survive",
  async () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      NODE_ENV: "test",
      SERVER_PROFILE: "platform-only",
      DATABASE_URL: process.env.PLATFORM_PROFILE_TEST_DATABASE_URL,
    });
    const oldBoss = new PgBoss(env.DATABASE_URL);
    await oldBoss.start();
    await oldBoss.createQueue("chz-signer-token-scheduler");
    await oldBoss.schedule("chz-signer-token-scheduler", "0 0 1 1 *");
    const oldJob = await oldBoss.send("chz-signer-token-scheduler", {});
    await oldBoss.stop();
    const app = await createApplication(env);
    try {
      await app.init();
      await listenOnLoopback(app);
      const http = request(app.getHttpServer());
      for (const path of [
        "/api/auth/get-session",
        "/station/operators",
        "/kiosk/bootstrap",
        "/products",
        "/public/v1/products",
        "/platform/operations/national-catalog/schemas",
      ])
        await http.get(path).expect(404);
      await http.post("/station/pair").send({}).expect(404);
      await http.post("/1c_exchange").send({}).expect(404);
      await http.get("/platform/tenants").expect(401);
      await http.get("/api/platform-auth/get-session").expect(200);
      await http.get("/health/live").expect(200);
      const document = await http.get("/openapi.json").expect(200);
      expect(Object.keys(document.body.components.securitySchemes)).toEqual(["platformSession"]);
      const signup = await http
        .post("/api/platform-auth/sign-up/email")
        .set("Origin", env.SAAS_ADMIN_ORIGIN)
        .send({
          name: "Admin",
          email: `profile-${randomUUID()}@example.invalid`,
          password: "isolated-profile-test-password",
        })
        .expect(200);
      const userId: string = signup.body.user.id;
      const cookie = signup.headers["set-cookie"]?.[0]?.split(";")[0];
      if (!cookie) throw new Error("Missing test platform session");
      const db = app.get<Db>(DB);
      await db
        .update(schema.platformUsers)
        .set({ status: "active", role: "platform_admin", twoFactorEnabled: true })
        .where(eq(schema.platformUsers.id, userId));
      await db.insert(schema.platformTwoFactors).values({
        id: randomUUID(),
        userId,
        verified: true,
        secret: "isolated-fixture",
        backupCodes: "isolated-fixture",
      });
      await http.get("/platform/tenants").set("Cookie", cookie).expect(200);
      await http.get("/platform/support-chat/episodes").set("Cookie", cookie).expect(200);
      const created = await http
        .post("/platform/tenants")
        .set("Cookie", cookie)
        .send({
          tenantName: "Offline customer",
          tenantSlug: `offline-${randomUUID()}`,
          cabinetAccess: "none",
        })
        .expect(201);
      expect(created.body).toMatchObject({ userId: null, memberId: null, deliveryId: null });
      const tenantId: string = created.body.tenantId;
      const forbidden = [
        [
          "/platform/catalog/lifecycle-policies",
          {
            policyKey: "disabled-cloud-policy",
            version: 1,
            offlineGrant: {
              version: 1,
              maxOfflineMs: 60000,
              maxCompletionMs: 60000,
              taskBounds: {},
            },
          },
        ],
        [
          `/platform/catalog/lifecycle-policies/${randomUUID()}/approve`,
          { decisionReference: "disabled" },
        ],
        [
          "/platform/tenants",
          {
            tenantName: "Disabled cabinet",
            tenantSlug: `disabled-${randomUUID()}`,
            email: "owner@example.invalid",
            cabinetAccess: "enabled",
          },
        ],
        [`/platform/tenants/${tenantId}/cabinet-access`, { email: "owner@example.invalid" }],
        [`/platform/tenants/${tenantId}/owner-activation/renew`, {}],
        [
          `/platform/support-chat/episodes/${randomUUID()}/proposals`,
          { title: "Old channel", summary: "No acceptance channel", idempotencyKey: randomUUID() },
        ],
      ] as const;
      for (const [path, body] of forbidden) {
        const result = await http.post(path).set("Cookie", cookie).send(body).expect(410);
        expect(JSON.stringify(result.body)).toContain("server_profile_disabled");
      }
      const pool = app.get<ReturnType<typeof createDb>["pool"]>(DB_POOL);
      const old = await pool.query("select state from pgboss.job where id = $1", [oldJob]);
      expect(old.rows).toEqual([{ state: "created" }]);
      const schedule = await pool.query(
        "select name from pgboss.schedule where name = 'chz-signer-token-scheduler'",
      );
      expect(schedule.rows).toHaveLength(1);
      await app.get(PgBossService).checkReady();
    } finally {
      await app.close();
    }
  },
  60000,
);

it.skipIf(!process.env.PLATFORM_PROFILE_TEST_DATABASE_URL)(
  "durably cancels recovered cabinet mail with one exact audit fact and cannot resend",
  async () => {
    const databaseUrl = process.env.PLATFORM_PROFILE_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("Missing isolated database");
    const { db, pool } = createDb(databaseUrl);
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
    const jobs = new MailJobsService(pool, crypto, transport, undefined, undefined, undefined, {
      profile: "platform-only",
      platformOrigin: "https://saas.example",
      platformAuthUrl: "https://api.example",
    });
    const tenantId = randomUUID();
    try {
      await db
        .insert(schema.organization)
        .values({ id: tenantId, name: "Recovered tenant", slug: tenantId, createdAt: new Date() });
      for (const kind of [
        "tenant-owner-activation",
        "organization-invitation",
        "password-reset",
        "email-verification",
        "tenant-billing-notification",
      ]) {
        const id = randomUUID();
        await db.insert(schema.emailDeliveries).values({
          id,
          tenantId,
          recipient: "cabinet@example.invalid",
          kind,
          sourceId: "historical-source",
          status: "queued",
          ...crypto.encrypt(id, {
            kind,
            recipientName: "Owner",
            actionUrl: "https://old.example/reset-password",
            expiresInMinutes: 60,
          }),
        });
        await jobs.processDelivery(id);
        await jobs.processDelivery(id);
        const [delivery] = await db
          .select()
          .from(schema.emailDeliveries)
          .where(eq(schema.emailDeliveries.id, id));
        expect(delivery).toMatchObject({
          id,
          tenantId,
          kind,
          sourceId: "historical-source",
          status: "canceled",
          errorCode: "server_profile_disabled",
          attemptCount: 1,
          encryptedPayload: null,
        });
        const audit = await db
          .select()
          .from(schema.platformAuditEvents)
          .where(eq(schema.platformAuditEvents.targetId, id));
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorPlatformUserId: null,
          actorRole: null,
          action: "mail.delivery.canceled",
          outcome: "success",
          tenantId,
          targetType: "email_delivery",
          targetId: id,
          reason: "server_profile_disabled",
          before: { status: "sending", kind },
          after: { status: "canceled", serverProfile: "platform-only" },
        });
        const send = vi.fn(async () => null);
        await jobs.reconcile({ send });
        expect(send).not.toHaveBeenCalledWith(
          expect.anything(),
          { deliveryId: id },
          expect.anything(),
        );
      }
      expect(transport.send).not.toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  },
  60000,
);

it.skipIf(!process.env.PLATFORM_PROFILE_TEST_DATABASE_URL)(
  "repairs only transcript imports and never wakes restored support sends or conversation reconciliation",
  async () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      NODE_ENV: "test",
      SERVER_PROFILE: "platform-only",
      DATABASE_URL: process.env.PLATFORM_PROFILE_TEST_DATABASE_URL,
      SUPPORT_CHAT_ENABLED: "true",
      SUPPORT_CHATWOOT_BASE_URL: "https://chatwoot.invalid",
      SUPPORT_CHATWOOT_ACCOUNT_ID: "1",
      SUPPORT_CHATWOOT_INBOX_ID: "1",
      SUPPORT_CHATWOOT_API_TOKEN: "isolated-token",
    });
    const connection = createDb(env.DATABASE_URL);
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...connection,
          ...setupPlatformAuth(env, connection.db),
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    })
      .overrideProvider(PgBossService)
      .useValue({ checkReady: async () => undefined })
      .compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      await listenOnLoopback(app);
      const tenantId = randomUUID();
      const userId = randomUUID();
      const ownerId = randomUUID();
      const episodeId = randomUUID();
      await connection.db.insert(schema.organization).values({
        id: tenantId,
        name: "Historical support",
        slug: tenantId,
        createdAt: new Date(),
      });
      await connection.db.insert(schema.user).values({
        id: userId,
        name: "Former owner",
        email: `${userId}@example.invalid`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await connection.db
        .insert(schema.supportChatOwners)
        .values({ id: ownerId, tenantId, userId });
      await connection.db
        .insert(schema.supportChatEpisodes)
        .values({ id: episodeId, tenantId, ownerId, creationKey: randomUUID() });
      const importId = randomUUID();
      const sendId = randomUUID();
      const reconcileId = randomUUID();
      await connection.db.insert(schema.supportChatJobs).values([
        { id: importId, tenantId, episodeId, kind: "import", nextAttemptAt: new Date(0) },
        { id: sendId, tenantId, episodeId, kind: "send", nextAttemptAt: new Date(0) },
        { id: reconcileId, tenantId, episodeId, kind: "reconcile", nextAttemptAt: new Date(0) },
      ]);
      const jobs = module.get(SupportChatJobsService);
      const woken: string[] = [];
      await jobs.repairAndWake(async (id) => {
        woken.push(id);
      });
      expect(woken).toContain(importId);
      expect(woken).not.toContain(sendId);
      expect(woken).not.toContain(reconcileId);
      expect(await jobs.run(sendId)).toBe(false);
      expect(await jobs.run(reconcileId)).toBe(false);
      const retained = await connection.db
        .select()
        .from(schema.supportChatJobs)
        .where(eq(schema.supportChatJobs.episodeId, episodeId));
      expect(retained.every((row) => row.state === "pending" && row.retryCount === 0)).toBe(true);
    } finally {
      await app.close();
    }
  },
  60000,
);
