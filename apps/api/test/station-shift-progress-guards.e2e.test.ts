import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { AUTH } from "../src/auth/auth.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { mountPlatformAuth, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { createManagedSubscription } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.PLATFORM_AUTH_SECRET &&
  process.env.PLATFORM_AUTH_URL &&
  process.env.SAAS_ADMIN_ORIGIN,
);

/**
 * Missing-coverage tasks 3 (platform half) and 4 for `GET
 * /station/shifts/:id/progress`. Its guard set (`TenantGuard` +
 * `StationOnlyGuard` + `SubscriptionAccessGuard`) needs two kinds of app
 * wiring that station-shift-progress.e2e.test.ts's plain bootstrap does not
 * carry:
 *
 * - A mounted platform Better Auth instance, to prove a real platform
 *   principal's own session still isn't a station credential.
 *   `PlatformAuthGuard` is not in this route's guard set at all and is a
 *   no-op outside `/platform/*` paths anyway (see platform-auth.guard.ts's
 *   `isPlatformPath` short-circuit), so the refusal actually comes from
 *   `TenantGuard` never recognising a foreign Better Auth instance's
 *   session cookie -- the same mechanism as an anonymous caller, but worth
 *   pinning with a REAL platform session rather than just an absent header.
 * - `SUBSCRIPTION_ENFORCEMENT_MODE=all`, the only mode where an unmanaged
 *   tenant is ever refused (subscription-access.guard.ts: for `mode:
 *   "recovery"`, an unmanaged tenant is let through unconditionally under
 *   the default `managed_only`, which is why every other progress e2e test
 *   -- all fresh, unmanaged tenants -- already proves the "allowed" half
 *   without ever setting this env var). `subscription-access.guard.test.ts`'s
 *   "preserves managed-only rollout for unmanaged tenants and fails closed
 *   in all mode" exercises the identical branch this route's own
 *   `@AllowSubscriptionRecovery("station")` handler takes when unmanaged
 *   (kind "station" gets no special carve-out; only "replacement_readiness"
 *   does) -- 409 `{ code: "subscription_unmanaged" }`.
 *   device-grants-routes.test.ts's "keeps authenticated key recovery
 *   available after subscription expiry and denies new grants" is the
 *   sibling e2e precedent for the "allowed" half under a real HTTP call,
 *   including its own pattern of expiring an already-created fixture's
 *   subscription in place rather than starting unmanaged.
 *
 * Under `SUBSCRIPTION_ENFORCEMENT_MODE=all`, `POST /station-devices` (a
 * `RequireSubscriptionWrite` cabinet route) itself 409s for an unmanaged
 * tenant -- so the "refuses an unmanaged tenant" case cannot go through
 * `createTestStationDevice` (which depends on that route) at all; it seeds
 * the device row and its api-key directly, the same direct-insert technique
 * already used by device-grants-epoch.test.ts and many `stationDevices`
 * fixtures across this suite.
 *
 * Same reasoning as station-shift-progress-reprocessing.e2e.test.ts's own
 * doc comment: a different app wiring gets a separate file rather than
 * bending the shared one.
 */
describe.skipIf(!ready)("GET /station/shifts/:id/progress guard boundaries", () => {
  let app: INestApplication;
  let db: Db;
  let env: ReturnType<typeof loadEnv>;

  beforeAll(async () => {
    env = loadEnv({ ...process.env, SUBSCRIPTION_ENFORCEMENT_MODE: "all" });
    const setup = setupAuth(env);
    db = setup.db;
    const platformSetup = setupPlatformAuth(env, setup.db);
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...setup,
          platformAuth: platformSetup.platformAuth,
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(env));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    mountPlatformAuth(server, platformSetup.platformAuth, { allowTestSignUp: true });
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  // Same cookie-name convention as platform-tenants.e2e.test.ts /
  // billing-accounts.e2e.test.ts's own `requiredSetCookie`.
  function requiredSetCookie(response: request.Response): string {
    const values = response.headers["set-cookie"];
    const cookies = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
    const cookie = cookies.find((value) => value.startsWith("markiro-platform.session_token="));
    if (!cookie) throw new Error("Expected a platform session cookie");
    return cookie.split(";", 1)[0]!;
  }

  // Seeds a station device credential without going through
  // `POST /station-devices`, which is itself a `RequireSubscriptionWrite`
  // cabinet route -- unusable for a tenant this test needs to KEEP unmanaged.
  // Same `stationDevices` row + `auth.api.createApiKey` recipe
  // `createTestStationDevice` (test/support/auth.ts) uses internally, minus
  // the cabinet HTTP round trip.
  async function unmanagedStationDevice(
    tenantId: string,
    name: string,
  ): Promise<{ apiKey: string; deviceId: string }> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected test tenant to have a member");
    const deviceId = randomUUID();
    await db.insert(schema.stationDevices).values({ id: deviceId, tenantId, name });
    const auth = app.get<Auth>(AUTH);
    const key = await auth.api.createApiKey({
      body: {
        configId: "station",
        organizationId: tenantId,
        userId: member.userId,
        name,
        metadata: { kind: "station" },
      },
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: key.id, pairedAt: new Date(), revokedAt: null })
      .where(eq(schema.stationDevices.id, deviceId));
    return { apiKey: key.key, deviceId };
  }

  it("refuses a platform principal's own session", async () => {
    // Sign-up alone already returns a real, live platform session cookie
    // (platform-tenants.e2e.test.ts's `createPlatformAgent` reads it off this
    // same response) -- two-factor enrollment/verification is not needed
    // here since `PlatformAuthGuard` (the only consumer of a verified
    // `platformPrincipal`) never runs for this route at all.
    const password = randomBytes(24).toString("base64url");
    const signedUp = await request(app.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({ email: `platform-${randomUUID()}@example.invalid`, password, name: "Platform" })
      .expect(200);
    const cookie = requiredSetCookie(signedUp);

    await request(app.getHttpServer())
      .get(`/station/shifts/${randomUUID()}/progress`)
      .set("Cookie", cookie)
      .expect(401);
  });

  it("refuses an unmanaged tenant under strict subscription enforcement", async () => {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await unmanagedStationDevice(tenantId, "Line 1");

    await request(app.getHttpServer())
      .get(`/station/shifts/${randomUUID()}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(409, { code: "subscription_unmanaged" });
  });

  it("still allows station recovery for a managed tenant whose subscription already expired", async () => {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    // Attach an ACTIVE subscription before creating the device: under "all"
    // mode `POST /station-devices` itself needs a managed, non-read-only
    // tenant. Then expire the same row in place -- device-grants-routes
    // .test.ts's own "keeps authenticated key recovery available after
    // subscription expiry" precedent -- so the device existed under a valid
    // subscription and only the PROGRESS read happens after expiry.
    await createManagedSubscription(db, { tenantId });
    const station = await createTestStationDevice(app, agent, "Line 1");
    await db
      .update(schema.tenantSubscriptions)
      .set({ startsAt: new Date(Date.now() - 172_800_000), endsAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));

    // The guard's "recovery" mode allows any resolved (non-unmanaged)
    // subscription state unconditionally, expired included, so this reaches
    // the service -- which then legitimately 404s for a shift that was never
    // created. A 404 here (not 409/403) is exactly what proves the
    // subscription guard let the request through.
    await request(app.getHttpServer())
      .get(`/station/shifts/${randomUUID()}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(404);
  });
});
