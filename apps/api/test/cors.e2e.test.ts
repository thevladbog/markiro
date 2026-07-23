import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

/**
 * Requires a reachable Postgres with the Better Auth + platform schema
 * already migrated, mirroring the other e2e suites (see auth.e2e.test.ts).
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const FOREIGN_ORIGIN = "https://evil.example";

describe.skipIf(!ready)("cors e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let adminOrigin: string;

  beforeAll(async () => {
    const env = loadEnv();
    adminOrigin = env.ADMIN_ORIGIN;
    setup = setupAuth(env);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    // Mirrors main.ts bootstrap: CORS must be enabled before the auth
    // handler is mounted so preflight/actual responses on /api/auth/* also
    // carry the CORS headers (see main.ts for the full ordering rationale).
    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors({ origin: [adminOrigin], credentials: true });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("OPTIONS preflight from ADMIN_ORIGIN gets ACAO echoed + credentials true", async () => {
    const res = await request(app!.getHttpServer())
      .options("/counterparties")
      .set("Origin", adminOrigin)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(adminOrigin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("OPTIONS preflight from a foreign origin gets no access-control-allow-origin header", async () => {
    const res = await request(app!.getHttpServer())
      .options("/counterparties")
      .set("Origin", FOREIGN_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sign-up POST with Origin: ADMIN_ORIGIN succeeds", async () => {
    const email = `t-${randomUUID()}@example.com`;
    const res = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .set("Origin", adminOrigin)
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);

    expect(res.body.user).toBeTruthy();
  });

  // Pinning ACTUAL better-auth behavior for a foreign-origin auth POST. This
  // is more subtle than "just 403" -- documenting it here because it's easy
  // to get wrong:
  //
  // In a real (non-test) runtime, better-auth's origin-check middleware
  // (validateFormCsrf -> validateOrigin, in api/middlewares/origin-check.mjs)
  // DOES reject a POST whose Origin header isn't in trustedOrigins, via
  // `APIError.from("FORBIDDEN", BASE_ERROR_CODES.INVALID_ORIGIN)` --
  // better-call maps "FORBIDDEN" to HTTP 403. Verified directly (outside
  // vitest, calling `auth.handler()` with NODE_ENV unset) with:
  //   status 403, body {"message":"Invalid origin","code":"INVALID_ORIGIN"}
  //
  // But better-auth ALSO ships a test-runner convenience default: its
  // context init sets `skipOriginCheck = isTest() ? true : false` whenever
  // `advanced.disableOriginCheck` isn't explicitly configured (see
  // @better-auth/core's `isTest()`: NODE_ENV === "test" or a truthy `TEST`
  // env var). Vitest sets both, so under *this* e2e suite the origin check
  // is a deliberate no-op and the request below actually succeeds (200) --
  // confirmed with the same standalone script, run with NODE_ENV=test.
  //
  // We do NOT override `advanced.disableOriginCheck` in buildAuth to force
  // this on under test: buildAuth's opts are intentionally kept to exactly
  // `{ secret, baseURL, trustedOrigins? }`, and forcing the check on here
  // would also flip it on for every other e2e suite's already-passing
  // cookie-bearing `/api/auth/organization/*` calls (auth/counterparties/
  // org-profile/products/shifts .e2e.test.ts), none of which set an Origin
  // header today -- a much larger, out-of-scope change. Production is
  // unaffected either way: it never runs with NODE_ENV=test.
  it("sign-up POST with a foreign Origin: better-auth's own test-runner bypass lets it through (200) under vitest", async () => {
    const email = `t-${randomUUID()}@example.com`;
    const res = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .set("Origin", FOREIGN_ORIGIN)
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);

    expect(res.body.user).toBeTruthy();
    // The HTTP-layer CORS boundary (enforced by our own `cors` middleware,
    // unrelated to better-auth's origin-check) still holds: no ACAO header
    // for the foreign origin, so a real browser couldn't read this response.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
