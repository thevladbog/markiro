import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { schema } from "@markiro/db";
import { and, eq, inArray } from "drizzle-orm";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

/**
 * Requires a reachable Postgres with the Better Auth + platform schema
 * already migrated: `pnpm --filter @markiro/db db:migrate`, plus the env
 * loadEnv() needs. Skipped unless all three are set, mirroring
 * packages/db/test/partitions.test.ts. CI applies migrations in the
 * workflow (see .github/workflows/ci.yml) before running this suite
 * against the postgres service container.
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("auth e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    // Mirrors main.ts bootstrap: Better Auth needs the raw body, so the Nest
    // body parser is disabled and express.json() installed after mounting it.
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  // app.close() runs Nest's onModuleDestroy lifecycle, which now closes
  // setup.pool itself (see AuthModule's AuthPoolCloser) -- closing it again
  // here would throw "Called end on pool more than once". Guard with `?.`
  // since beforeAll may never have run (e.g. it threw before assigning
  // `app`), in which case there's nothing to close.
  afterAll(async () => {
    await app?.close();
  });

  it("sign-up -> session cookie -> organization create", async () => {
    const email = `t-${randomUUID()}@example.com`;
    const agent = request.agent(app!.getHttpServer());

    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Test Plant", slug: `plant-${randomUUID()}` })
      .expect(200);

    expect(org.body.id).toBeTruthy();
  });

  it("blocks ordinary public signup outside the explicit test bootstrap", async () => {
    const lockedServer = express();
    mountAuth(lockedServer, setup.auth, { allowTestSignUp: false });
    await request(lockedServer)
      .post("/api/auth/sign-up/email")
      .send({ email: `blocked-${randomUUID()}@example.com`, password: "not-used", name: "Blocked" })
      .expect(404);
  });

  it("organization create without a session is unauthorized", async () => {
    await request(app!.getHttpServer())
      .post("/api/auth/organization/create")
      .send({ name: "No Session", slug: `no-session-${randomUUID()}` })
      .expect(401);
  });

  it("does not expose Better Auth's generic API-key management endpoint", async () => {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(agent);

    await agent
      .post("/api/auth/api-key/create")
      .send({ configId: "station", organizationId, name: "bypass" })
      .expect(404);
  });

  it("does not expose raw organization membership mutations beside Team API", async () => {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(agent);
    const mutationPaths = [
      "invite-member",
      "cancel-invitation",
      "accept-invitation",
      "reject-invitation",
      "remove-member",
      "update-member-role",
    ];

    for (const path of mutationPaths) {
      await agent.post(`/api/auth/organization/${path}`).send({ organizationId }).expect(404);
      await agent.post(`/api/auth/organization/${path}/`).send({ organizationId }).expect(404);
    }
  });

  it("queues password-reset and verification emails without SMTP in the request", async () => {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(agent);
    const [member] = await setup.db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, organizationId));
    const [user] = await setup.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, member!.userId));

    await agent
      .post("/api/auth/request-password-reset")
      .send({ email: user!.email, redirectTo: "http://localhost:5173/reset-password" })
      .expect(200);
    await agent
      .post("/api/auth/send-verification-email")
      .send({ email: user!.email, callbackURL: "http://localhost:5173/profile" })
      .expect(200);

    const deliveries = await setup.db
      .select({ kind: schema.emailDeliveries.kind, userId: schema.emailDeliveries.userId })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.userId, member!.userId),
          inArray(schema.emailDeliveries.kind, ["password-reset", "email-verification"]),
        ),
      );
    expect(new Set(deliveries.map((delivery) => delivery.kind))).toEqual(
      new Set(["password-reset", "email-verification"]),
    );
  });
});
