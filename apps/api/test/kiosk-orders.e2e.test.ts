import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { verifyPhc } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { schema, type Db } from "@markiro/db";

/**
 * GTIN test vectors (check-digit VALID — computed with node + gs1CheckDigit,
 * see packages/domain/src/gs1/check-digit.ts). The plan/prototype's
 * "04650075195923" has an INVALID check digit and would make every scan
 * fail classification as `not_km` before it even reaches product
 * resolution — do not reuse it here.
 *   - GTIN            "04600682000013" — the allowlisted product on the main kiosk.
 *   - GTIN_NOT_ALLOWED "04600682000020" — a real product for this tenant, but never
 *                      added to the main kiosk's allowlist -> "not_allowed".
 *   - GTIN_UNKNOWN     "04600682000037" — no product row for this tenant at all -> "unknown_product".
 */
const GTIN = "04600682000013";
const GTIN_NOT_ALLOWED = "04600682000020";
const GTIN_UNKNOWN = "04600682000037";

/** GS (ASCII 0x1D) — the KM segment separator. Renders invisibly in prose/plans; use the real byte in fixtures. */
const GS = String.fromCharCode(0x1d);

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("kiosk orders e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let employeeId: string;
  let productId: string;
  let kioskId: string;
  const TOKEN = `kiosk-token-${randomUUID()}`;
  const BADGE = `badge-${randomUUID()}`;

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

    const agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId, fullName: "Иван Иванов", role: "оператор" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "99.90" });
    // A real product for this tenant that is deliberately NOT allowlisted on the main kiosk (-> not_allowed).
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId,
      gtin14: GTIN_NOT_ALLOWED,
      name: "Другой товар",
    });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск А", dayLimitPerEmployee: 5 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
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

  it("creates a pending order from valid KM scans and echoes the order number", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 1,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21KYC9X7MQ${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.orderNo).toMatch(/^ORD-\d{2}-\d{4,}$/);
    expect(res.body.status).toBe("pending");
    expect(res.body.itemCount).toBe(1);
    expect(res.body.conflicts).toHaveLength(0);
  });

  it("is idempotent on (kiosk, deviceSeq)", async () => {
    const body = {
      deviceSeq: 7,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: `01${GTIN}21ZZZ1${GS}93Abcd` }],
    };
    const a = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body)
      .expect(201);
    const b = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send(body)
      .expect(201);
    expect(b.body.orderNo).toBe(a.body.orderNo);
    expect(b.body.itemCount).toBe(a.body.itemCount);
  });

  it("flags a code whose GTIN has no product at all for this tenant as unknown_product", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 2,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN_UNKNOWN}21S1${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].reason).toMatch(/unknown_product|not_allowed/);
    expect(res.body.conflicts[0].reason).toBe("unknown_product");
  });

  it("flags a code for a real product that isn't on this kiosk's allowlist as not_allowed", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 9,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN_NOT_ALLOWED}21S2${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].reason).toBe("not_allowed");
  });

  it("rejects an unknown badge", async () => {
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 3, badgeCode: "NOPE", reason: "buy", items: [] })
      .expect(401);
  });

  it("rejects a non-revoked badge belonging to an archived employee", async () => {
    const archivedEmployeeId = randomUUID();
    const archivedBadge = `badge-archived-${randomUUID()}`;
    await db
      .insert(schema.employees)
      .values({ id: archivedEmployeeId, tenantId, fullName: "Архивов А." });
    await db
      .insert(schema.employeeBadges)
      .values({ tenantId, employeeId: archivedEmployeeId, badgeCode: archivedBadge });

    // Sanity: the badge works while the employee is still active.
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 11, badgeCode: archivedBadge, reason: "buy", items: [] })
      .expect(201);

    await db
      .update(schema.employees)
      .set({ status: "archived" })
      .where(eq(schema.employees.id, archivedEmployeeId));

    // The badge itself is still not revoked, but the employee behind it is archived -> unknown badge (401).
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 12, badgeCode: archivedBadge, reason: "buy", items: [] })
      .expect(401);
  });

  it("flags a not-a-KM scan and a KM missing its crypto tail (dropped GS) distinctly", async () => {
    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 8,
        badgeCode: BADGE,
        reason: "buy",
        items: [
          { rawKm: "not-a-valid-code-at-all" },
          { rawKm: `01${GTIN}21INCOMP1` }, // no GS, no trailing AI 91/92/93 -> incomplete
        ],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toEqual([
      { rawKm: "not-a-valid-code-at-all", reason: "not_km" },
      { rawKm: `01${GTIN}21INCOMP1`, reason: "incomplete" },
    ]);
  });

  it("requires a non-archived writeoffReasonId of this tenant for reason=writeoff", async () => {
    const missing = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 4, badgeCode: BADGE, reason: "writeoff", items: [] })
      .expect(400);
    expect(missing.body.message).toBeDefined();

    const archivedReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: archivedReasonId,
      tenantId,
      name: "Просрочка",
      sortOrder: 0,
      archived: true,
    });
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 4,
        badgeCode: BADGE,
        reason: "writeoff",
        writeoffReasonId: archivedReasonId,
        items: [],
      })
      .expect(400);

    const activeReasonId = randomUUID();
    await db.insert(schema.pickupOrderReasons).values({
      id: activeReasonId,
      tenantId,
      name: "Брак",
      sortOrder: 0,
      archived: false,
    });
    const ok = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 4,
        badgeCode: BADGE,
        reason: "writeoff",
        writeoffReasonId: activeReasonId,
        items: [{ rawKm: `01${GTIN}21WRITEOFF1${GS}93Abcd` }],
      })
      .expect(201);
    expect(ok.body.itemCount).toBe(1);
    expect(ok.body.conflicts).toHaveLength(0);
  });

  it("converts a race against an already-open code (23505) into a duplicate conflict", async () => {
    // Seed a second, unrelated order that already holds this kmKey as an open item —
    // simulates a concurrent request winning the race on the DB's partial unique index.
    const seedOrderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: seedOrderId,
      tenantId,
      orderNo: `SEED-DUP-${randomUUID().slice(0, 8)}`,
      kioskId,
      employeeId,
      reason: "buy",
      status: "pending",
      itemCount: 1,
      deviceSeq: null,
    });
    await db.insert(schema.pickupOrderItems).values({
      id: randomUUID(),
      tenantId,
      orderId: seedOrderId,
      productId,
      gtin14: GTIN,
      serial: "DUPKEY1",
      rawKm: "seed-duplicate",
      kmKey: `01${GTIN}21DUPKEY1`,
      voided: false,
      scannedAt: new Date(),
    });

    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({
        deviceSeq: 10,
        badgeCode: BADGE,
        reason: "buy",
        items: [{ rawKm: `01${GTIN}21DUPKEY1${GS}93Abcd` }],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(0);
    expect(res.body.conflicts).toEqual([
      { rawKm: `01${GTIN}21DUPKEY1${GS}93Abcd`, reason: "duplicate" },
    ]);
  });

  it("resolves two truly-concurrent POSTs with the same deviceSeq into a single order (no 500)", async () => {
    const body = {
      deviceSeq: 20,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: `01${GTIN}21CONC1${GS}93Abcd` }],
    };
    const [a, b] = await Promise.all([
      request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body),
      request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", TOKEN).send(body),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.orderNo).toBe(b.body.orderNo);

    const orders = await db
      .select()
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.kioskId, kioskId),
          eq(schema.pickupOrders.deviceSeq, 20),
        ),
      );
    expect(orders).toHaveLength(1);
  });

  // F1 regression (the other side of the fix -- see kiosk-pairing.e2e.test.ts
  // for the pairing side): `insertOrderWithRetry` takes an explicit
  // `SELECT ... FOR UPDATE` on the kiosk row before it inserts, the SAME lock
  // a re-pair takes before computing `nextDeviceSeq`, so the two paths can
  // never interleave around either read. (In practice `pickup_orders`' own
  // FK to `kiosks` already makes the INSERT statement take an implicit lock
  // on that row too -- this explicit lock makes the invariant load-bearing
  // and self-documenting instead of an incidental side effect of the FK,
  // which a future schema change could silently weaken.) Proven here by
  // timing: a concurrent holder of that lock (standing in for a re-pair in
  // progress) must make an in-flight order visibly wait, not proceed
  // immediately. Calls `PickupOrdersService.createFromKiosk` directly rather
  // than through `POST /kiosk/orders`, deliberately bypassing
  // `KioskDeviceGuard` -- its own per-request `last_seen_at` UPDATE also
  // touches the kiosk row and would otherwise block on the same holder for
  // an unrelated reason, making the timing measure the guard instead of the
  // lock this test actually targets.
  it("insertOrderWithRetry's kiosk-row lock blocks a concurrent holder", async () => {
    const pickupOrdersService = app!.get(PickupOrdersService);
    const HOLD_MS = 250;
    let lockAcquired!: () => void;
    const holderOwnsLock = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const holderDone = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
        .for("update");
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    });

    // Deterministic handoff: start the order only once the holder actually
    // owns the row lock. A fixed head-start delay would be a race -- on a
    // slow or contended run the order could begin first, sail through
    // unblocked, and fail the timing assertion below for a reason that has
    // nothing to do with the lock this test exists to prove.
    await holderOwnsLock;

    const start = Date.now();
    const result = await pickupOrdersService.createFromKiosk(tenantId, kioskId, {
      deviceSeq: 40,
      badgeCode: BADGE,
      reason: "buy",
      items: [],
    });
    const elapsed = Date.now() - start;

    await holderDone;
    expect(result.orderNo).toMatch(/^ORD-/);
    // Generous margin below HOLD_MS: proves the insert was blocked on the
    // lock rather than served immediately, without being a flaky exact-time
    // assertion.
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS - 100);
  });

  it("day-limit accepts up to dayLimitPerEmployee and marks the overflow over_limit", async () => {
    const limitKioskId = randomUUID();
    const limitBadge = `badge-limit-${randomUUID()}`;
    const limitEmployeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: limitEmployeeId, tenantId, fullName: "Лимитов Л." });
    await db
      .insert(schema.employeeBadges)
      .values({ tenantId, employeeId: limitEmployeeId, badgeCode: limitBadge });
    await db
      .insert(schema.kiosks)
      .values({ id: limitKioskId, tenantId, name: "Киоск-лимит", dayLimitPerEmployee: 2 });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId: limitKioskId, productId });
    const limitToken = `kiosk-token-limit-${randomUUID()}`;
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(limitToken) })
      .where(eq(schema.kiosks.id, limitKioskId));

    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", limitToken)
      .send({
        deviceSeq: 1,
        badgeCode: limitBadge,
        reason: "buy",
        items: [
          { rawKm: `01${GTIN}21LIM1${GS}93Abcd` },
          { rawKm: `01${GTIN}21LIM2${GS}93Abcd` },
          { rawKm: `01${GTIN}21LIM3${GS}93Abcd` },
        ],
      })
      .expect(201);
    expect(res.body.itemCount).toBe(2);
    expect(res.body.conflicts).toEqual([
      { rawKm: `01${GTIN}21LIM3${GS}93Abcd`, reason: "over_limit" },
    ]);
  });

  /**
   * The device's `createdAt` decides which UTC day an order's items count
   * against, so an unbounded one turns the day limit over to the least
   * trustworthy clock in the system: roll an unattended tablet's date forward
   * and its worker gets a fresh allowance, again and again, online or not.
   * The server therefore honours the value only within a plausible window and
   * otherwise files the order under its own clock.
   *
   * Each case gets its own kiosk (`dayLimitPerEmployee: 1`) and its own
   * employee, so the counts below are exact rather than "whatever else this
   * suite happened to leave behind for the shared badge".
   */
  describe("client-supplied createdAt", () => {
    let clockKioskId: string;
    let clockToken: string;
    let seq = 0;

    /** Distinct kmKey per call — an open duplicate would conflict for an unrelated reason. */
    function scan(): string {
      return `01${GTIN}21CLK${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}${GS}93Abcd`;
    }

    async function newEmployeeBadge(): Promise<string> {
      const id = randomUUID();
      const badge = `badge-clock-${randomUUID()}`;
      await db.insert(schema.employees).values({ id, tenantId, fullName: "Часов Ч." });
      await db.insert(schema.employeeBadges).values({ tenantId, employeeId: id, badgeCode: badge });
      return badge;
    }

    async function post(badgeCode: string, createdAt?: string) {
      seq += 1;
      return request(app!.getHttpServer())
        .post("/kiosk/orders")
        .set("x-kiosk-token", clockToken)
        .send({
          deviceSeq: seq,
          badgeCode,
          reason: "buy",
          items: [{ rawKm: scan() }],
          ...(createdAt ? { createdAt } : {}),
        })
        .expect(201);
    }

    async function orderCreatedAt(orderNo: string): Promise<Date> {
      const [row] = await db
        .select({ createdAt: schema.pickupOrders.createdAt })
        .from(schema.pickupOrders)
        .where(
          and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.orderNo, orderNo)),
        );
      return row!.createdAt;
    }

    beforeAll(async () => {
      clockKioskId = randomUUID();
      clockToken = `kiosk-token-clock-${randomUUID()}`;
      await db
        .insert(schema.kiosks)
        .values({ id: clockKioskId, tenantId, name: "Киоск-часы", dayLimitPerEmployee: 1 });
      await db.insert(schema.kioskProducts).values({ tenantId, kioskId: clockKioskId, productId });
      await db
        .update(schema.kiosks)
        .set({ deviceTokenHash: hashDeviceToken(clockToken) })
        .where(eq(schema.kiosks.id, clockKioskId));
    });

    it("honours a plausible past createdAt, and counts that order against the day it names", async () => {
      const badge = await newEmployeeBadge();
      // 26h back: a genuine offline replay, comfortably inside the 7-day
      // window and always a different UTC day from "now", whatever the hour.
      const backdated = new Date(Date.now() - 26 * 60 * 60_000).toISOString();

      const replayed = await post(badge, backdated);
      expect(replayed.body.itemCount).toBe(1);
      expect(await orderCreatedAt(replayed.body.orderNo)).toEqual(new Date(backdated));

      // The teeth: today's allowance must still be untouched. If the server
      // had silently overwritten the replayed order with its own clock, this
      // second item would be the day's *second* and come back over_limit.
      const today = await post(badge);
      expect(today.body.itemCount).toBe(1);
      expect(today.body.conflicts).toEqual([]);

      // And the limit really is 1 — so the assertion above is not passing
      // because everything is accepted.
      const overflow = await post(badge);
      expect(overflow.body.itemCount).toBe(0);
      expect(overflow.body.conflicts).toEqual([
        { rawKm: expect.stringContaining(`01${GTIN}21CLK`), reason: "over_limit" },
      ]);
    });

    it("honours a small forward drift, which an unsynced tablet has normally", async () => {
      const badge = await newEmployeeBadge();
      const slightlyAhead = new Date(Date.now() + 60_000).toISOString();

      const res = await post(badge, slightlyAhead);
      expect(res.body.itemCount).toBe(1);
      expect(await orderCreatedAt(res.body.orderNo)).toEqual(new Date(slightlyAhead));
    });

    it("refuses a far-future createdAt, so a rolled-forward clock cannot mint a fresh day allowance", async () => {
      const badge = await newEmployeeBadge();

      // Spend today's single-item allowance honestly.
      const honest = await post(badge);
      expect(honest.body.itemCount).toBe(1);

      // Now the attack: the same device claims a scan two days from now. If
      // the server believed it, this would be day N+2's first item and would
      // be accepted — a fresh allowance on demand, repeatable forever.
      const rolledForward = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString();
      const attempt = await post(badge, rolledForward);
      expect(attempt.body.itemCount).toBe(0);
      expect(attempt.body.conflicts).toEqual([
        { rawKm: expect.stringContaining(`01${GTIN}21CLK`), reason: "over_limit" },
      ]);

      // Nothing from this device landed in the future either: the refused
      // value is replaced everywhere `when` is used, including the row's own
      // createdAt (and the year in its order number).
      const rows = await db
        .select({ createdAt: schema.pickupOrders.createdAt })
        .from(schema.pickupOrders)
        .where(
          and(
            eq(schema.pickupOrders.tenantId, tenantId),
            eq(schema.pickupOrders.kioskId, clockKioskId),
          ),
        );
      const horizon = Date.now() + 10 * 60_000;
      expect(rows.every((r) => r.createdAt.getTime() < horizon)).toBe(true);
    });

    it("refuses a createdAt older than a device could honestly have queued", async () => {
      const badge = await newEmployeeBadge();
      // 30 days back. The device blocks itself after 7 days without a
      // successful bootstrap, so it cannot have a backlog this old; a
      // timestamp like this is a broken clock, and burying an order a month
      // deep in the свод hides it from the operators who must resolve it.
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();

      const res = await post(badge, ancient);
      expect(res.body.itemCount).toBe(1);
      const stored = await orderCreatedAt(res.body.orderNo);
      expect(stored.getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);
    });
  });

  it("does not persist an empty order when a non-empty scan yields only conflicts", async () => {
    const rawKm = `01${GTIN_UNKNOWN}21NOORDER1${GS}93Abcd`;
    const ordersBefore = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)),
      );

    const res = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", TOKEN)
      .send({ deviceSeq: 30, badgeCode: BADGE, reason: "buy", items: [{ rawKm }] })
      .expect(201);
    // The conflict is reported, but no order number is minted and no row lands
    // in the свод.
    expect(res.body.itemCount).toBe(0);
    expect(res.body.orderNo).toBe("");
    expect(res.body.conflicts).toEqual([{ rawKm, reason: "unknown_product" }]);

    const ordersAfter = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)),
      );
    expect(ordersAfter.length).toBe(ordersBefore.length);
  });

  it("bootstrap returns config, reasons, allowlist products and employees with badge hashes", async () => {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);
    expect(res.body.config.dayLimitPerEmployee).toBeGreaterThan(0);
    expect(res.body.config.showPrices).toBe(true);
    expect(res.body.products.some((p: { gtin14: string }) => p.gtin14 === GTIN)).toBe(true);
    expect(res.body.products.every((p: { gtin14: string }) => p.gtin14 !== GTIN_NOT_ALLOWED)).toBe(
      true,
    );
    const employee = res.body.employees.find((e: { id: string }) => e.id === employeeId);
    // Task 4: the payload carries a PBKDF2 verifier, never the plaintext badge code.
    expect(employee.badgeCodes).toBeUndefined();
    expect(typeof employee.badgeHash).toBe("string");
    await expect(verifyPhc(BADGE, employee.badgeHash)).resolves.toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(BADGE);
  });

  it("401s a kiosk token that is missing entirely", async () => {
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", "not-a-real-token")
      .expect(401);
  });

  it("archived kiosk -> 401, even with a previously-valid token (locks the guard's active-status filter)", async () => {
    const archivedKioskId = randomUUID();
    const archivedToken = `kiosk-token-archived-${randomUUID()}`;
    await db.insert(schema.kiosks).values({ id: archivedKioskId, tenantId, name: "Киоск-архив" });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(archivedToken) })
      .where(eq(schema.kiosks.id, archivedKioskId));

    // Sanity: the token works while the kiosk is active.
    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", archivedToken)
      .expect(200);

    await db
      .update(schema.kiosks)
      .set({ status: "archived" })
      .where(eq(schema.kiosks.id, archivedKioskId));

    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", archivedToken)
      .expect(401);
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", archivedToken)
      .send({ deviceSeq: 1, badgeCode: BADGE, reason: "buy", items: [] })
      .expect(401);
  });
});
