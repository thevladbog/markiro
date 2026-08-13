import { randomUUID } from "node:crypto";
import { createServer, request as rawHttpRequest, type Server } from "node:http";
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

async function listenExpressOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requireTestServer(server: Server | undefined): Server {
  if (!server) throw new Error("Expected the locked auth test server to be listening");
  return server;
}

async function postRawPath(
  server: Server,
  path: string,
  cookie: string | string[],
): Promise<{ status: number; body: string }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  const payload = JSON.stringify({ name: "Bypass tenant", slug: `bypass-${randomUUID()}` });
  const cookieHeader = Array.isArray(cookie)
    ? cookie.map((value) => value.split(";", 1)[0]).join("; ")
    : cookie;

  return await new Promise((resolve, reject) => {
    const outgoing = rawHttpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

describe.skipIf(!ready)("auth e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let lockedServer: Server | undefined;

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

    const lockedApp = express();
    mountAuth(lockedApp, setup.auth, { allowTestSignUp: false });
    const lockedHttpServer = createServer(lockedApp);
    await listenExpressOnLoopback(lockedHttpServer);
    lockedServer = lockedHttpServer;
  });

  // app.close() runs Nest's onModuleDestroy lifecycle, which now closes
  // setup.pool itself (see AuthModule's AuthPoolCloser) -- closing it again
  // here would throw "Called end on pool more than once". Guard with `?.`
  // since beforeAll may never have run (e.g. it threw before assigning
  // `app`), in which case there's nothing to close.
  afterAll(async () => {
    await closeServer(lockedServer);
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
    await request(requireTestServer(lockedServer))
      .post("/api/auth/sign-up/email")
      .send({ email: `blocked-${randomUUID()}@example.com`, password: "not-used", name: "Blocked" })
      .expect(404);
  });

  it("does not expose canonical aliases of raw organization creation outside test bootstrap", async () => {
    const signedUp = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .send({
        email: `raw-org-${randomUUID()}@example.com`,
        password: `Pw-${randomUUID()}!Aa1`,
        name: "Raw org probe",
      })
      .expect(200);
    const cookie = signedUp.headers["set-cookie"];
    if (!cookie) throw new Error("Expected the test signup to issue a session cookie");

    const blockedPaths = [
      "/api/auth/organization/create",
      "/api/auth/organization/create/",
      "/api/auth/organization/ignored/../create",
      "/api/auth/organization/%2e/create",
      "/api/auth/organization/ignored/%2e%2e/create",
      "/api/auth/organization/ignored/%2E%2E/create",
      "/api/auth/organization/ignored/.%2e/create",
      "/api/auth/organization/ignored/%2E./create",
      "/api/auth/organization/ignored\\..\\create",
      "/api/auth/organization/create?source=raw-probe",
      "/api/auth/organization/create#raw-probe",
    ];

    for (const path of blockedPaths) {
      const response = await postRawPath(requireTestServer(lockedServer), path, cookie);
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain('"id"');
    }
  });

  it("fails closed on ambiguous organization paths without decoding twice", async () => {
    const signedUp = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .send({
        email: `raw-org-ambiguous-${randomUUID()}@example.com`,
        password: `Pw-${randomUUID()}!Aa1`,
        name: "Raw org ambiguity probe",
      })
      .expect(200);
    const cookie = signedUp.headers["set-cookie"];
    if (!cookie) throw new Error("Expected the test signup to issue a session cookie");

    const rejectedPaths = [
      "/api/auth/organization/ignored/%252e%252e/create",
      "/api/auth/organization/ignored/%2f..%2fcreate",
      "/api/auth/organization/ignored/%5c..%5ccreate",
      "/api/auth/organization/ignored//../create",
      "/api/auth/organization/ignored/%/create",
      "/api/auth/organization/ignored/%2/create",
      "/api/auth/organization/ignored/%GG/create",
    ];

    for (const path of rejectedPaths) {
      const response = await postRawPath(requireTestServer(lockedServer), path, cookie);
      expect([400, 404], path).toContain(response.status);
      expect(response.body, path).not.toContain('"id"');
    }
  });

  it("keeps unrelated organization routes available outside test bootstrap", async () => {
    const signedUp = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .send({
        email: `raw-org-unrelated-${randomUUID()}@example.com`,
        password: `Pw-${randomUUID()}!Aa1`,
        name: "Unrelated org route probe",
      })
      .expect(200);
    const cookie = signedUp.headers["set-cookie"];
    if (!cookie) throw new Error("Expected the test signup to issue a session cookie");

    await request(requireTestServer(lockedServer))
      .get("/api/auth/organization/list?source=raw-probe")
      .set("cookie", cookie)
      .expect(200);
    await request(requireTestServer(lockedServer))
      .post("/api/auth/organization/check-slug")
      .set("cookie", cookie)
      .send({ slug: `available-${randomUUID()}` })
      .expect(200);
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
