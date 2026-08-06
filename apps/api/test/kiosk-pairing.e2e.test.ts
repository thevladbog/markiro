import * as nodeCrypto from "node:crypto";
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashPairingCode } from "../src/pickup/device-token";
import { PairAttemptsService } from "../src/modules/device-pairing/pair-attempts.service";
import { normalizePairSource } from "../src/modules/device-pairing/pair-source";
import {
  GLOBAL_PAIR_ATTEMPT_BUDGET,
  GLOBAL_PAIR_SOURCE,
  PAIR_ATTEMPT_BUDGET,
  PAIR_ATTEMPT_WINDOW_MS,
} from "../src/modules/device-pairing/pairing-policy";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { PairingService } from "../src/modules/kiosk/pairing.service";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";

// Only `randomInt` is ever mocked (F3 below, one call, one test) -- every
// other export (including `randomUUID`, used throughout this file) passes
// through to the real implementation unchanged.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

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
  let pairingCodePepper: string;

  /**
   * This suite's own stand-in for `PairingService`'s real `hashPairingCode`
   * call sites -- keyed by the SAME pepper the app under test loads from
   * `.env` (via `loadEnv()` in `beforeAll` below), so assertions against
   * `kiosk_pairing_codes.code_hash` exercise the real keyed digest rather
   * than a plain, unkeyed one that could pass even if the app silently
   * stopped keying the hash.
   */
  function codeHashOf(code: string): string {
    return hashPairingCode(code, pairingCodePepper);
  }

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    pairingCodePepper = env.PAIRING_CODE_PEPPER;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
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
    expect(rows.some((r) => r.codeHash === codeHashOf(res.body.code))).toBe(true);
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const first = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const [old] = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, codeHashOf(first.body.code)));
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
    const device = await createTestStationDevice(app!, agent, "Kiosk cabinet terminal");
    const apiKey = device.apiKey;

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

    expect(paired.body).toStrictEqual({
      device: {
        kioskId,
        kioskName: expect.any(String),
        place: null,
      },
      token: expect.any(String),
      nextDeviceSeq: 0,
      bootstrap: {
        generatedAt: expect.any(String),
        config: {
          dayLimitPerEmployee: expect.any(Number),
          showPrices: expect.any(Boolean),
        },
        badgeSalt: expect.any(String),
        reasons: expect.any(Array),
        products: expect.any(Array),
        employees: expect.any(Array),
        operators: expect.any(Array),
      },
    });
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

  it("allows exactly one winner when the same issued code is redeemed concurrently", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);

    const [first, second] = await Promise.all([
      request(app!.getHttpServer()).post("/kiosk/pair").send({ code: issued.body.code }),
      request(app!.getHttpServer()).post("/kiosk/pair").send({ code: issued.body.code }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 401]);
    const winner = [first, second].find((response) => response.status === 201);
    expect(winner?.body.device.kioskId).toBe(kioskId);
  });

  it("refunds persisted source and global attempts after a successful redemption", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(201);

    const currentWindow = pairAttemptWindowStart(Date.now());
    const previousWindow = new Date(currentWindow.getTime() - PAIR_ATTEMPT_WINDOW_MS);
    const rows = await db
      .select({
        source: schema.kioskPairAttempts.source,
        failures: schema.kioskPairAttempts.failures,
      })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          inArray(schema.kioskPairAttempts.source, [...LOOPBACK_PAIR_SOURCES, GLOBAL_PAIR_SOURCE]),
          inArray(schema.kioskPairAttempts.windowStartedAt, [currentWindow, previousWindow]),
        ),
      );

    expect(rows).toContainEqual({ source: GLOBAL_PAIR_SOURCE, failures: 0 });
    expect(rows.filter((row) => LOOPBACK_PAIR_SOURCES.includes(row.source))).toEqual([
      expect.objectContaining({ failures: 0 }),
    ]);
  });

  it("floors an unattributable source refund at zero", async () => {
    const pairAttemptsService = app!.get(PairAttemptsService);
    const windowStart = pairAttemptWindowStart(Date.now());
    await db.insert(schema.kioskPairAttempts).values({
      source: GLOBAL_PAIR_SOURCE,
      windowStartedAt: windowStart,
      failures: 0,
    });

    await pairAttemptsService.refundPairAttempt("", windowStart);

    const [row] = await db
      .select({ failures: schema.kioskPairAttempts.failures })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          eq(schema.kioskPairAttempts.source, GLOBAL_PAIR_SOURCE),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
    expect(row).toEqual({ failures: 0 });
  });

  it("charges an unattributable failed redemption only to the global limiter", async () => {
    const pairingService = app!.get(PairingService);
    await expect(pairingService.redeem("99999999", "")).rejects.toMatchObject({ status: 401 });

    const currentWindow = pairAttemptWindowStart(Date.now());
    const previousWindow = new Date(currentWindow.getTime() - PAIR_ATTEMPT_WINDOW_MS);
    const rows = await db
      .select({
        source: schema.kioskPairAttempts.source,
        failures: schema.kioskPairAttempts.failures,
      })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          inArray(schema.kioskPairAttempts.windowStartedAt, [currentWindow, previousWindow]),
          inArray(schema.kioskPairAttempts.source, [
            "",
            ...LOOPBACK_PAIR_SOURCES,
            GLOBAL_PAIR_SOURCE,
          ]),
        ),
      );

    expect(rows).toEqual([{ source: GLOBAL_PAIR_SOURCE, failures: 1 }]);
  });

  it("refuses an expired code", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    await db
      .update(schema.kioskPairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.codeHash, codeHashOf(issued.body.code)),
        ),
      );
    await request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code })
      .expect(401);
  });

  it("refuses a code whose attempt budget is exhausted", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const codeHash = codeHashOf(issued.body.code);
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

  // F1 regression: a previously-paired device can be past `KioskDeviceGuard`
  // and still mid-transaction, inserting its own order, when a replacement
  // pairs. This simulates that order transaction -- it takes the SAME
  // kiosk-row lock `insertOrderWithRetry` takes before its insert
  // (pickup-orders.service.ts), and holds it open deliberately -- concurrently
  // with a real re-pair, and asserts the two never interleave around the
  // MAX(device_seq) read: `attemptRedeem` now takes the same lock before that
  // read, so it can never land in between this order's start and its commit
  // and miss it -- which, since (tenant, kiosk, deviceSeq) is the order
  // idempotency key, would otherwise hand the new device a deviceSeq the
  // late order already used and silently discard its first genuine order as
  // a false replay of this one.
  it("does not let a re-pair's deviceSeq allocation miss an order still mid-transaction", async () => {
    const raceEmployeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: raceEmployeeId, tenantId, fullName: "Ночная смена" });

    const orderTxDone = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
        .for("update");
      await tx.insert(schema.pickupOrders).values({
        tenantId,
        orderNo: `ORD-RACE-${randomUUID().slice(0, 8)}`,
        kioskId,
        employeeId: raceEmployeeId,
        reason: "buy",
        status: "pending",
        itemCount: 0,
        deviceSeq: 7,
      });
      // Hold the lock open long enough to overlap with the re-pair below.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Give the in-flight order a head start so it takes the lock first.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const pairPromise = request(app!.getHttpServer())
      .post("/kiosk/pair")
      .send({ code: issued.body.code });

    const [, paired] = await Promise.all([orderTxDone, pairPromise]);
    expect(paired.status).toBe(201);
    // One past 7, not a stale value that would collide with it -- proves the
    // MAX read waited on the lock rather than racing the order's commit.
    expect(paired.body.nextDeviceSeq).toBe(8);
  });

  // F2 regression: once the global backstop is already exhausted, a request
  // from a source with no row of its own yet (standing in for an attacker
  // rotating source addresses) must be turned away WITHOUT allocating one --
  // otherwise the table grows without bound from sources that are, by
  // definition, never going to be let through anyway. End-to-end this can
  // only be asserted from the DB side (this suite has exactly one real
  // source -- see `LOOPBACK_PAIR_SOURCES` above), so this seeds the global
  // bucket directly and checks no per-source row appears.
  it("short-circuits an already-exhausted global budget without allocating a fresh per-source row", async () => {
    try {
      const windowStart = pairAttemptWindowStart(Date.now());
      await db.insert(schema.kioskPairAttempts).values({
        source: GLOBAL_PAIR_SOURCE,
        windowStartedAt: windowStart,
        failures: GLOBAL_PAIR_ATTEMPT_BUDGET + 1,
      });

      await request(app!.getHttpServer())
        .post("/kiosk/pair")
        .send({ code: "00000000" })
        .expect(401);

      const sourceRows = await db
        .select()
        .from(schema.kioskPairAttempts)
        .where(
          and(
            inArray(schema.kioskPairAttempts.source, LOOPBACK_PAIR_SOURCES),
            eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
          ),
        );
      expect(sourceRows).toHaveLength(0);

      const [globalRow] = await db
        .select()
        .from(schema.kioskPairAttempts)
        .where(
          and(
            eq(schema.kioskPairAttempts.source, GLOBAL_PAIR_SOURCE),
            eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
          ),
        );
      // The pre-check is read-only -- untouched by it, not incremented again.
      expect(globalRow!.failures).toBe(GLOBAL_PAIR_ATTEMPT_BUDGET + 1);
    } finally {
      await clearPairAttemptBudget(db);
    }
  });

  // F3 regression: `kiosk_pairing_codes_code_hash_live_uq` is the DB-enforced
  // backstop for `issueCode`'s SELECT-then-INSERT clash check, which only
  // ever considers a hash a clash when the existing row is BOTH unused AND
  // unexpired. An unused-but-EXPIRED row (never explicitly retired because
  // it belongs to a different kiosk, whose own `issueCode` never ran to
  // retire it) is invisible to that check yet still collides with the
  // constraint (partial on `used_at is null` only, matching
  // `kiosk_pairing_codes_one_live_uq`'s own pattern -- expiry can't appear in
  // a partial index predicate, since it isn't immutable). This seeds exactly
  // that row for a DIFFERENT kiosk, forces `issueCode`'s first random draw to
  // reproduce its hash, and asserts the mint retries instead of failing.
  it("re-mints instead of failing when a hash collides with an expired-but-unretired code (F3)", async () => {
    const otherKioskId = randomUUID();
    await db.insert(schema.kiosks).values({ id: otherKioskId, tenantId, name: "Другой киоск" });

    // Freshly drawn per run (rather than a fixed literal) so a row this test
    // leaves behind -- expired but never retired, by design -- can never
    // collide with a future run of this same test.
    const collidingCode = String(nodeCrypto.randomInt(10_000_000, 100_000_000));
    try {
      await db.insert(schema.kioskPairingCodes).values({
        tenantId,
        kioskId: otherKioskId,
        codeHash: codeHashOf(collidingCode),
        expiresAt: new Date(Date.now() - 60_000),
      });

      vi.mocked(nodeCrypto.randomInt).mockImplementationOnce(() => Number(collidingCode));

      const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
      expect(res.body.code).toMatch(/^\d{8}$/);
      expect(res.body.code).not.toBe(collidingCode);
    } finally {
      await db
        .delete(schema.kioskPairingCodes)
        .where(eq(schema.kioskPairingCodes.codeHash, codeHashOf(collidingCode)));
    }
  });

  // F4 regression: `now` is captured in `redeem` before `bootstrap()` runs,
  // which can take seconds on a large tenant (badge re-hashing). Simulates
  // that slowness directly on the shared `PickupOrdersService` singleton so
  // the code's TTL reliably lapses WHILE bootstrap is in flight -- after
  // `redeem`'s JS `now` was captured (so the pre-bootstrap checks still see
  // it as live) but before the claim's WHERE clause is evaluated in the DB.
  it("judges expiry against the DB's own clock rather than a stale JS timestamp (F4)", async () => {
    const pickupOrdersService = app!.get(PickupOrdersService);
    const originalBootstrap = pickupOrdersService.bootstrap.bind(pickupOrdersService);
    const bootstrapSpy = vi
      .spyOn(pickupOrdersService, "bootstrap")
      .mockImplementationOnce(async (tid: string, kid: string) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return originalBootstrap(tid, kid);
      });

    try {
      const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
      // Still live when `redeem` captures `now` (well after this UPDATE
      // commits), but expires long before the artificially slow bootstrap
      // above returns and the transaction's claim actually runs.
      await db
        .update(schema.kioskPairingCodes)
        .set({ expiresAt: new Date(Date.now() + 200) })
        .where(
          and(
            eq(schema.kioskPairingCodes.tenantId, tenantId),
            eq(schema.kioskPairingCodes.codeHash, codeHashOf(issued.body.code)),
          ),
        );

      await request(app!.getHttpServer())
        .post("/kiosk/pair")
        .send({ code: issued.body.code })
        .expect(401);
    } finally {
      bootstrapSpy.mockRestore();
    }
  });

  // F5 regression: issuance didn't check kiosk status, but redemption
  // requires `status = 'active'` -- an admin could be shown a code for an
  // archived kiosk that would always come back a generic, undiagnosable 401.
  it("404s issuing a pairing code for an archived kiosk (F5)", async () => {
    await agent.delete(`/kiosks/${kioskId}`).expect(204);
    await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(404);
  });

  // Pepper regression: proves `PAIRING_CODE_PEPPER` is actually load-bearing
  // end-to-end, not just accepted and ignored. Recomputes the digest for the
  // real issued code with a DIFFERENT pepper and asserts it does NOT match
  // what the running app actually persisted -- so a future refactor that
  // silently drops the key (e.g. reverting `hashPairingCode` to a plain,
  // unkeyed digest, or hardcoding a fixed pepper) fails this test, even
  // though every other assertion in this file (which all hash through this
  // same suite's OWN pepper via `codeHashOf`) would not by itself catch that.
  it("keys the pairing-code digest to the pepper -- a different pepper never matches what was persisted", async () => {
    const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
    const [row] = await db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, codeHashOf(issued.body.code)));
    expect(row).toBeDefined();

    const wrongPepperHash = hashPairingCode(issued.body.code, "a-completely-different-pepper!!");
    expect(wrongPepperHash).not.toBe(row!.codeHash);
  });
});
