import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { normalizePairSource } from "../src/modules/kiosk/pair-source";
import {
  GLOBAL_PAIR_SOURCE,
  PAIR_ATTEMPT_BUDGET,
  PAIR_ATTEMPT_WINDOW_MS,
} from "../src/modules/kiosk/pairing.service";
import { schema, type Db } from "@markiro/db";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Every request in this file resolves through the same local loopback
// socket -- this suite never sets TRUST_PROXY_HOPS, so it defaults to 0 and
// Express `trust proxy` stays disabled, meaning `@Ip()` always reports the
// test client's own connecting address, never a header. Depending on
// whether the app's HTTP server bound dual-stack or IPv4-only, that address
// is one of a small, known set of loopback forms. `normalizePairSource` --
// the same function `PairingService` writes through -- folds each down to
// the key actually persisted, so this is the exhaustive, deterministic set
// of per-source keys this file's own requests can ever produce.
const LOOPBACK_PAIR_SOURCES = Array.from(
  new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"].map(normalizePairSource)),
);

function pairAttemptWindowStart(now: number): Date {
  return new Date(Math.floor(now / PAIR_ATTEMPT_WINDOW_MS) * PAIR_ATTEMPT_WINDOW_MS);
}

/**
 * Clears this file's own kiosk-pairing rate-limiter budget for the current
 * AND previous fixed window, so every test starts with a clean slate no
 * matter how many attempts earlier tests in this file burned (several
 * non-limiter tests call `POST /kiosk/pair`, and every attempt now consumes
 * budget -- see `PairingService.recordPairAttempt`). Scoped to the finite
 * set of sources this file's own requests can produce (`LOOPBACK_PAIR_SOURCES`
 * plus the global `"*"` backstop) rather than to every source in the
 * window, so it never clears a concurrent run's rows on the shared Postgres
 * instance. The window is re-derived from `Date.now()` on every call rather
 * than reused from a value captured earlier, so a cleanup running near a
 * window boundary still targets the row it actually wrote to.
 */
async function clearPairAttemptBudget(db: Db): Promise<void> {
  const currentWindowStart = pairAttemptWindowStart(Date.now());
  const previousWindowStart = new Date(currentWindowStart.getTime() - PAIR_ATTEMPT_WINDOW_MS);
  await db
    .delete(schema.kioskPairAttempts)
    .where(
      and(
        inArray(schema.kioskPairAttempts.source, [...LOOPBACK_PAIR_SOURCES, GLOBAL_PAIR_SOURCE]),
        inArray(schema.kioskPairAttempts.windowStartedAt, [
          currentWindowStart,
          previousWindowStart,
        ]),
      ),
    );
}

/**
 * Seeds `kiosk_pair_attempts` directly with `failures` for every loopback
 * source this file's requests can produce, in the CURRENT fixed window.
 * Deterministic and exact, unlike driving a loop of real requests: a loop
 * can straddle a 15-minute window boundary (~0.05% of runs), splitting
 * attempts across two counters so neither trips the budget and a wrong-guess
 * loop's final assertion fails. Seeding removes the wall clock from the test
 * entirely. Scoped to `LOOPBACK_PAIR_SOURCES` only (not the global `"*"`
 * bucket), matching what a real run of attempts from this file's own client
 * would have written through the per-source path.
 */
async function seedPairAttemptFailures(db: Db, failures: number): Promise<void> {
  const windowStart = pairAttemptWindowStart(Date.now());
  for (const source of LOOPBACK_PAIR_SOURCES) {
    await db
      .insert(schema.kioskPairAttempts)
      .values({ source, windowStartedAt: windowStart, failures })
      .onConflictDoUpdate({
        target: [schema.kioskPairAttempts.source, schema.kioskPairAttempts.windowStartedAt],
        set: { failures },
      });
  }
}

describe.skipIf(!ready)("kiosk pairing e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let kioskId: string;
  let seededOrder: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  // Fresh tenant + kiosk per test, per repo convention -- this Postgres is
  // shared across concurrent test runs, so every test scopes its own rows.
  beforeEach(async () => {
    // Every POST /kiosk/pair call in this file (including from tests that
    // aren't "about" the limiter) consumes budget against the SAME
    // loopback source and the global "*" backstop. Without resetting here,
    // attempts accumulate across this file's own tests within the same
    // 15-minute window and could push a later test past either budget.
    await clearPairAttemptBudget(db);

    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    const kiosk = await agent
      .post("/kiosks")
      .send({ name: `Киоск ${randomUUID()}` })
      .expect(201);
    kioskId = kiosk.body.id as string;

    // A product on the kiosk's allowlist, so the paired bundle's dataset is
    // non-empty (the pairing screen needs a real product to scan).
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600682000013",
      name: "Товар",
      unitPrice: "99.90",
    });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });

    // An order that already existed before pairing, with no deviceSeq (as an
    // admin-created row would have -- see schema comment on
    // pickup_orders_kiosk_device_seq_uq). Its NULL deviceSeq must not affect
    // the "no orders yet" case; tests that care about continuation give it a
    // real deviceSeq explicitly.
    const employeeId = randomUUID();
    await db.insert(schema.employees).values({ id: employeeId, tenantId, fullName: "Сотрудник" });
    seededOrder = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: seededOrder,
      tenantId,
      orderNo: `ORD-SEED-${randomUUID().slice(0, 8)}`,
      kioskId,
      employeeId,
      reason: "buy",
      status: "pending",
      itemCount: 1,
      deviceSeq: null,
    });

    otherAgent = request.agent(app!.getHttpServer());
    await signUpAndActivate(otherAgent);
  });

  it("issues an 8-digit code that expires in 15 minutes", async () => {
    const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    expect(res.body.code).toMatch(/^\d{8}$/);
    const ttlMs = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(13 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("stores only the hash, never the plaintext code", async () => {
    const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const rows = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.kioskId, kioskId));
    expect(rows.some((r) => r.codeHash === res.body.code)).toBe(false);
    expect(rows.some((r) => r.codeHash === hashDeviceToken(res.body.code))).toBe(true);
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const first = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const [old] = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, hashDeviceToken(first.body.code)));
    expect(old!.usedAt).not.toBeNull();
  });

  it("404s for a kiosk of another tenant", async () => {
    await otherAgent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(404);
  });

  // Regression guard: TenantGuard alone would accept a station's own
  // x-api-key for tenant resolution, but a stolen/compromised station device
  // must never be able to mint a kiosk pairing code -- SessionOnlyGuard is
  // what actually blocks it.
  it("rejects a station device api-key even though TenantGuard would accept it", async () => {
    const device = await agent
      .post("/station-devices")
      .send({ name: "Kiosk cabinet terminal" })
      .expect(201);
    const apiKey = (device.body as { apiKey: string }).apiKey;

    await request(app!.getHttpServer())
      .post(`/kiosks/${kioskId}/pairing-code`)
      .set("x-api-key", apiKey)
      .send({})
      .expect(403);
  });

  it("leaves at most one live code when two issue requests race", async () => {
    const [a, b] = await Promise.all([
      agent.post(`/kiosks/${kioskId}/pairing-code`).send({}),
      agent.post(`/kiosks/${kioskId}/pairing-code`).send({}),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);

    const live = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.kioskId, kioskId),
          isNull(schema.kioskPairingCodes.usedAt),
        ),
      );
    expect(live).toHaveLength(1);
  });

  it("exchanges a code for a working token and the initial dataset", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);

    const paired = await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(201);

    expect(paired.body.device.kioskId).toBe(kioskId);
    expect(paired.body.nextDeviceSeq).toBe(0);
    expect(paired.body.bootstrap.products.length).toBeGreaterThan(0);

    // the token works straight away
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", paired.body.token)
      .expect(200);
  });

  it("refuses a second redemption of the same code", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(401);
  });

  it("refuses an expired code", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await db
      .update(schema.kioskPairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.codeHash, hashDeviceToken(issued.body.code)),
        ),
      );
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(401);
  });

  it("refuses a code whose attempt budget is exhausted", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const codeHash = hashDeviceToken(issued.body.code);
    await db
      .update(schema.kioskPairingCodes)
      .set({ attempts: 5 })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.codeHash, codeHash),
        ),
      );
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(401);
  });

  it("401s an unknown, never-issued code", async () => {
    await request(app!.getHttpServer()).post("/kiosk/pair").send({ code: "99999999" }).expect(401);
  });

  it("400s a malformed code", async () => {
    await request(app!.getHttpServer()).post("/kiosk/pair").send({ code: "1234" }).expect(400);
  });

  // TRUST_PROXY_HOPS defaults to 0 and this suite never sets it, so Express
  // `trust proxy` stays disabled and `@Ip()` reports the test client's real
  // socket address for every request in this file regardless of any forged
  // X-Forwarded-For header -- there is no way to fake a distinct source from
  // here. These two tests seed `kiosk_pair_attempts` directly (via
  // `seedPairAttemptFailures`) rather than driving a loop of real requests,
  // so they're exact and can't straddle a window boundary; see that
  // function's comment for why the old loop-based version was flaky.
  it("keeps a per-source limiter that a valid code cannot bypass", async () => {
    try {
      await seedPairAttemptFailures(db, PAIR_ATTEMPT_BUDGET);

      const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
      await request(app!.getHttpServer())
        .post("/kiosk/pair")
        .send({ code: issued.body.code })
        .expect(401);
    } finally {
      await clearPairAttemptBudget(db);
    }
  });

  // Pins the limiter's `>` (not `>=`) comparison: with the budget one short
  // of tripped, the next attempt through this route must still be processed
  // rather than refused -- a valid code presented here redeems successfully.
  it("still processes one more attempt exactly at the budget boundary", async () => {
    try {
      await seedPairAttemptFailures(db, PAIR_ATTEMPT_BUDGET - 1);

      const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
      await request(app!.getHttpServer())
        .post("/kiosk/pair")
        .send({ code: issued.body.code })
        .expect(201);
    } finally {
      await clearPairAttemptBudget(db);
    }
  });

  it("continues deviceSeq after a re-pair so the first order is not mistaken for a replay", async () => {
    await db
      .update(schema.pickupOrders)
      .set({ deviceSeq: 7 })
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, seededOrder)),
      );
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const paired = await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(201);
    expect(paired.body.nextDeviceSeq).toBe(8);
  });
});
