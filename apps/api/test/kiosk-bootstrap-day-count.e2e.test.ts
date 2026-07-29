import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

/** Check-digit valid; nothing here classifies a KM, but a plausible one keeps
 * the fixtures readable next to the other pickup specs. */
const GTIN = "04600682000013";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * `employees[].takenTodayElsewhere` — the half of the day limit a kiosk cannot
 * see for itself.
 *
 * The device counts its OWN contribution from its own journal and queue
 * (`session/day-count.ts`), so this payload must carry the rest and NOTHING of
 * this kiosk's own, or the two halves overlap and a worker is refused product
 * they are entitled to. That is why every assertion below pins the exclusion
 * as hard as it pins the inclusion.
 */
describe.skipIf(!ready)("kiosk bootstrap: what an employee took at OTHER kiosks today", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let productId: string;
  /** The kiosk asking — whose own orders must never appear in the number. */
  let thisKioskId: string;
  let otherKioskId: string;
  const TOKEN = `kiosk-token-${randomUUID()}`;

  /** Took product at the other kiosk AND at this one. */
  let commuter: string;
  /** Took product at this kiosk only. */
  let homebody: string;
  /** Took nothing anywhere. */
  let newcomer: string;
  /** Elsewhere, but on an order that was cancelled. */
  let cancelled: string;
  /** Elsewhere, but every item voided. */
  let voided: string;
  /** Elsewhere, but yesterday. */
  let yesterday: string;

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
    await listenOnLoopback(app);

    const agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Товар", unitPrice: "10.00" });

    thisKioskId = randomUUID();
    otherKioskId = randomUUID();
    await db.insert(schema.kiosks).values([
      { id: thisKioskId, tenantId, name: "Киоск, который спрашивает", dayLimitPerEmployee: 5 },
      { id: otherKioskId, tenantId, name: "Киоск на другой проходной", dayLimitPerEmployee: 5 },
    ]);
    await db.insert(schema.kioskProducts).values([
      { tenantId, kioskId: thisKioskId, productId },
      { tenantId, kioskId: otherKioskId, productId },
    ]);
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, thisKioskId));

    commuter = await newEmployee("Ходов Х.");
    homebody = await newEmployee("Домов Д.");
    newcomer = await newEmployee("Новиков Н.");
    cancelled = await newEmployee("Отменов О.");
    voided = await newEmployee("Списов С.");
    yesterday = await newEmployee("Вчеров В.");

    // The one worker whose allowance is genuinely split across two gates.
    await fileOrder({ kioskId: otherKioskId, employeeId: commuter, items: 2 });
    await fileOrder({ kioskId: thisKioskId, employeeId: commuter, items: 3 });

    // Everything this kiosk filed itself — the device already counts these off
    // its own journal, so counting them here too would charge them twice.
    await fileOrder({ kioskId: thisKioskId, employeeId: homebody, items: 3 });

    // The three predicates `applyDayLimit` applies, one employee each, so a
    // missing one names itself in the failure rather than hiding in a sum.
    await fileOrder({
      kioskId: otherKioskId,
      employeeId: cancelled,
      items: 2,
      status: "cancelled",
    });
    await fileOrder({ kioskId: otherKioskId, employeeId: voided, items: 2, voided: true });
    await fileOrder({
      kioskId: otherKioskId,
      employeeId: yesterday,
      items: 2,
      // 26h back is a different UTC calendar date whatever the hour, and stays
      // comfortably inside a week of retention.
      createdAt: new Date(Date.now() - 26 * 60 * 60_000),
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  async function newEmployee(fullName: string): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.employees).values({ id, tenantId, fullName });
    await db
      .insert(schema.employeeBadges)
      .values({ tenantId, employeeId: id, badgeCode: `badge-${randomUUID()}` });
    return id;
  }

  /** An order as the свод holds it, written straight to the tables so each of
   * `applyDayLimit`'s predicates can be exercised on its own. */
  async function fileOrder(opts: {
    kioskId: string;
    employeeId: string;
    items: number;
    createdAt?: Date;
    status?: "pending" | "cancelled";
    voided?: boolean;
  }): Promise<void> {
    const orderId = randomUUID();
    const when = opts.createdAt ?? new Date();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-T-${randomUUID().slice(0, 8)}`,
      kioskId: opts.kioskId,
      employeeId: opts.employeeId,
      reason: "buy",
      status: opts.status ?? "pending",
      itemCount: opts.items,
      createdAt: when,
    });
    await db.insert(schema.pickupOrderItems).values(
      Array.from({ length: opts.items }, () => {
        const serial = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
        return {
          tenantId,
          orderId,
          productId,
          gtin14: GTIN,
          serial,
          rawKm: `01${GTIN}21${serial}`,
          kmKey: `01${GTIN}21${serial}`,
          voided: opts.voided ?? false,
          scannedAt: when,
        };
      }),
    );
  }

  /** The roster as the device receives it, by employee id. */
  async function roster(): Promise<Map<string, { takenTodayElsewhere: number }>> {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);
    return new Map(
      (res.body.employees as { id: string; takenTodayElsewhere: number }[]).map((e) => [e.id, e]),
    );
  }

  it("reports the other kiosk's items and NEVER this kiosk's own", async () => {
    const employees = await roster();
    // Two elsewhere, three here. A total would say five, and the device — which
    // counts those same three off its own journal — would then refuse this
    // worker at eight instead of five.
    expect(employees.get(commuter)?.takenTodayElsewhere).toBe(2);
    expect(employees.get(homebody)?.takenTodayElsewhere).toBe(0);
  });

  it("answers for the whole roster, zero included, in one bootstrap", async () => {
    const employees = await roster();
    // Present and numeric for an employee with no orders at all: the device
    // reads this field per employee, and `undefined` there is a different
    // failure from `0`.
    expect(employees.get(newcomer)?.takenTodayElsewhere).toBe(0);
    for (const employee of employees.values()) {
      expect(typeof employee.takenTodayElsewhere).toBe("number");
    }
  });

  it("mirrors applyDayLimit: no cancelled orders, no voided items, today only", async () => {
    const employees = await roster();
    expect(employees.get(cancelled)?.takenTodayElsewhere).toBe(0);
    expect(employees.get(voided)?.takenTodayElsewhere).toBe(0);
    expect(employees.get(yesterday)?.takenTodayElsewhere).toBe(0);
  });
});
