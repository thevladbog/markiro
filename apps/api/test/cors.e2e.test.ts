import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";

/**
 * Requires a reachable Postgres with the Better Auth + platform schema
 * already migrated, mirroring the other e2e suites (see auth.e2e.test.ts).
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const FOREIGN_ORIGIN = "https://evil.example";

/**
 * Injected rather than read from `process.env.KIOSK_ORIGIN`: the variable is
 * optional (see src/env.ts) and unset in a plain dev shell, so reading it
 * would leave the kiosk cases below asserting nothing whenever it happens to
 * be absent. A literal also keeps it provably distinct from ADMIN_ORIGIN.
 */
const KIOSK_ORIGIN = "https://kiosk.markiro.test";
const STATION_ORIGIN = "https://station.markiro.test";

describe.skipIf(!ready)("cors e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let adminOrigin: string;

  beforeAll(async () => {
    const env = { ...loadEnv(), KIOSK_ORIGIN, STATION_ORIGIN };
    adminOrigin = env.ADMIN_ORIGIN;
    setup = setupAuth(env);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    // Mirrors main.ts bootstrap: CORS must be enabled before the auth
    // handler is mounted so preflight/actual responses on /api/auth/* also
    // carry the CORS headers (see main.ts for the full ordering rationale).
    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(env));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
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

  // The kiosk is the only cross-origin caller that CANNOT fall back to a
  // same-origin deployment: its pairing screen takes a server address, so an
  // on-prem install routinely serves the PWA and the API from different
  // hosts. The token-bearing calls (`/kiosk/bootstrap`, `/kiosk/orders`)
  // carry `x-kiosk-token`, which is not a safelisted request header, so this
  // preflight happens before *every* one of them -- not just once.
  it("OPTIONS preflight from KIOSK_ORIGIN on a /kiosk route is accepted", async () => {
    const res = await request(app!.getHttpServer())
      .options("/kiosk/bootstrap")
      .set("Origin", KIOSK_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "x-kiosk-token")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(KIOSK_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    // Echoed by `cors` because main.ts leaves `allowedHeaders` unset; without
    // it the browser drops the request even though the origin was allowed.
    expect(res.headers["access-control-allow-headers"]).toContain("x-kiosk-token");
  });

  it("OPTIONS preflight from an unlisted origin on a /kiosk route is refused", async () => {
    const res = await request(app!.getHttpServer())
      .options("/kiosk/bootstrap")
      .set("Origin", FOREIGN_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "x-kiosk-token")
      .expect(204);

    // ACAO's *absence* is the whole boundary. Do not also assert on
    // `access-control-allow-credentials`: `cors` emits it unconditionally
    // whenever `credentials: true` is configured, match or no match
    // (verified — it is present with value "true" on this very response).
    // That is harmless, because a browser rejects the response on the
    // missing ACAO before credentials are ever considered.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the admin origin stays allowed alongside the kiosk origin", async () => {
    const res = await request(app!.getHttpServer())
      .options("/kiosk/bootstrap")
      .set("Origin", adminOrigin)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(adminOrigin);
  });

  // `/kiosk/pair` is the one route with no `x-kiosk-token` -- the device has
  // no token until it succeeds -- but it is still preflighted, because its
  // `Content-Type: application/json` is not a CORS-safelisted value. So it
  // needs the kiosk origin allowed just as much as the guarded routes do.
  it("OPTIONS preflight from KIOSK_ORIGIN on the unauthenticated /kiosk/pair is accepted", async () => {
    const res = await request(app!.getHttpServer())
      .options("/kiosk/pair")
      .set("Origin", KIOSK_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(KIOSK_ORIGIN);
  });

  it("OPTIONS preflight from STATION_ORIGIN on unauthenticated /station/pair is accepted", async () => {
    const res = await request(app!.getHttpServer())
      .options("/station/pair")
      .set("Origin", STATION_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(STATION_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  /**
   * The kiosk origin is scoped to `/kiosk/*`, not granted globally.
   *
   * A global credentialed allowlist would make KIOSK_ORIGIN a reader of every
   * route's response. In the deployment this product ships -- kiosk and admin
   * as sibling subdomains of one site -- script on the kiosk origin could then
   * send an administrator's cookies with `credentials: "include"` and read
   * back whatever a session-guarded route returned. The kiosk calls no such
   * route (see apps/kiosk/src/api/client.ts), so scoping costs it nothing.
   */
  describe("the kiosk origin is scoped to /kiosk/*", () => {
    // Each pair below is the same origin against a kiosk and a non-kiosk
    // route: the "granted" half is what stops this from passing vacuously
    // (a blanket deny would satisfy the "refused" half on its own).
    it("is refused on a session-guarded route it never calls", async () => {
      const granted = await request(app!.getHttpServer())
        .options("/kiosk/orders")
        .set("Origin", KIOSK_ORIGIN)
        .set("Access-Control-Request-Method", "POST")
        .expect(204);
      expect(granted.headers["access-control-allow-origin"]).toBe(KIOSK_ORIGIN);

      const refused = await request(app!.getHttpServer())
        .options("/counterparties")
        .set("Origin", KIOSK_ORIGIN)
        .set("Access-Control-Request-Method", "GET")
        .expect(204);
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("is refused on /api/auth/*, which the CORS middleware also fronts", async () => {
      const res = await request(app!.getHttpServer())
        .options("/api/auth/sign-in/email")
        .set("Origin", KIOSK_ORIGIN)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type")
        .expect(204);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("is refused on an actual (non-preflight) response from a session-guarded route", async () => {
      // Preflight is not the only place the boundary has to hold: a simple
      // GET is sent without one, and it is the ACAO on THIS response that
      // decides whether the caller may read the body.
      const res = await request(app!.getHttpServer())
        .get("/counterparties")
        .set("Origin", KIOSK_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("does not leak onto /kiosks, the session-guarded cabinet route", async () => {
      // `/kiosks` shares a prefix with `/kiosk` but is an admin route behind
      // a session — a `startsWith("/kiosk")` scope test would have let the
      // kiosk origin read it.
      const res = await request(app!.getHttpServer())
        .options("/kiosks")
        .set("Origin", KIOSK_ORIGIN)
        .set("Access-Control-Request-Method", "GET")
        .expect(204);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("leaves the admin origin allowed on both surfaces, exactly as before", async () => {
      for (const path of ["/counterparties", "/kiosk/bootstrap", "/api/auth/sign-in/email"]) {
        const res = await request(app!.getHttpServer())
          .options(path)
          .set("Origin", adminOrigin)
          .set("Access-Control-Request-Method", "POST")
          .expect(204);
        expect({ path, acao: res.headers["access-control-allow-origin"] }).toEqual({
          path,
          acao: adminOrigin,
        });
      }
    });
  });

  describe("the station origin is scoped to its exact method/path surface", () => {
    it("accepts a preflight for every documented station request", async () => {
      for (const [method, path] of [
        ["POST", "/station/pair"],
        ["GET", "/station/identity"],
        ["GET", "/station/operators"],
        ["POST", "/station/scans"],
        ["GET", "/shifts"],
        ["POST", "/shifts"],
        ["GET", "/shifts/shift-1/bundle"],
        ["POST", "/shifts/shift-1/open"],
        ["GET", "/products?search=04600000000000"],
        ["POST", "/products/gtin-check/"],
      ] as const) {
        const granted = await request(app!.getHttpServer())
          .options(path)
          .set("Origin", STATION_ORIGIN)
          .set("Access-Control-Request-Method", method)
          .expect(204);
        expect({ method, path, acao: granted.headers["access-control-allow-origin"] }).toEqual({
          method,
          path,
          acao: STATION_ORIGIN,
        });
      }
    });

    it("refuses adjacent methods, cabinet paths, kiosk/auth paths, and unknown routes", async () => {
      for (const [method, path] of [
        ["GET", "/station/pair"],
        ["POST", "/station/identity"],
        ["POST", "/station/operators"],
        ["GET", "/station/scans"],
        ["PATCH", "/shifts"],
        ["GET", "/shifts/shift-1"],
        ["POST", "/shifts/shift-1/close"],
        ["POST", "/products"],
        ["GET", "/products/product-1"],
        ["POST", "/products/gtin-check/extra"],
        ["GET", "/kiosk/bootstrap"],
        ["GET", "/counterparties"],
        ["POST", "/api/auth/sign-in/email"],
        ["GET", "/stations"],
        ["GET", "/station-devices"],
        ["GET", "/unknown"],
      ] as const) {
        const refused = await request(app!.getHttpServer())
          .options(path)
          .set("Origin", STATION_ORIGIN)
          .set("Access-Control-Request-Method", method)
          .expect(204);
        expect({ method, path, acao: refused.headers["access-control-allow-origin"] }).toEqual({
          method,
          path,
          acao: undefined,
        });
      }
    });

    it("refuses OPTIONS without an Access-Control-Request-Method", async () => {
      const refused = await request(app!.getHttpServer())
        .options("/station/scans")
        .set("Origin", STATION_ORIGIN)
        .expect(204);
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // better-auth's own origin check is a separate layer from the CORS headers
  // above, and it is fed `sessionAllowedOrigins` -- which excludes the kiosk.
  // Asserting on the configured value rather than on a request, because
  // better-auth disables the check outright under a test runner (see the long
  // note on the sign-up cases below), so no HTTP call here could observe it.
  it("the kiosk origin is not one of better-auth's trustedOrigins", () => {
    const trusted = setup.auth.options.trustedOrigins;
    expect(trusted).toEqual([adminOrigin]);
    expect(trusted).not.toContain(KIOSK_ORIGIN);
  });

  it("sign-up POST with Origin: ADMIN_ORIGIN succeeds", async () => {
    const email = `t-${randomUUID()}@example.com`;
    const res = await request(app!.getHttpServer())
      .post("/api/auth/sign-up/email")
      .set("Origin", adminOrigin)
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
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
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    expect(res.body.user).toBeTruthy();
    // The HTTP-layer CORS boundary (enforced by our own `cors` middleware,
    // unrelated to better-auth's origin-check) still holds: no ACAO header
    // for the foreign origin, so a real browser couldn't read this response.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
