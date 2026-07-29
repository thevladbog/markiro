import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Same fixture as conflicts.e2e.test.ts / products.e2e.test.ts.
const VALID_GTIN14 = "04006381333931";

// Three distinct, check-digit-valid GLNs -- kept apart so a service bug that
// swapped the organisation's own GLN with the counterparty's (or vice versa)
// shows up as a wrong value rather than an accidental match.
const ORG_GLN = "4601112222005";
const COUNTERPARTY_GLN = "4609876543008";

// Two distinct, check-digit-valid GLNs sharing the 9-digit prefix
// "460123400" -- the same example the correction's own background uses: one
// GS1 member holding two GLNs (e.g. two locations) that differ only in the
// digits after the prefix. Two counters keyed on the full GLN would each
// hand out serial 0 independently and buildSscc would turn both into the
// SAME SSCC -- the exact collision the prefix-keyed counter prevents.
const SHARED_PREFIX = "460123400";
const GLN_SHARING_PREFIX_A = "4601234000017";
const GLN_SHARING_PREFIX_B = "4601234000024";

describe.skipIf(!ready)("sscc e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let productId: string;
  let shiftWithIssuerId: string;
  let plainShiftId: string;

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

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    await agent.put("/org/profile").send({ gln: ORG_GLN }).expect(200);

    const counterparty = await agent
      .post("/counterparties")
      .send({ name: "Client Co", gln: COUNTERPARTY_GLN })
      .expect(201);
    const counterpartyId = (counterparty.body as { id: string }).id;

    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    productId = (product.body as { id: string }).id;

    // The CreateShiftDto has no field for ssccIssuerCounterpartyId (Task 3
    // only landed the column; no route sets it yet), so it's assigned
    // directly here, same as sccc counters/blocks are inserted directly in
    // the tests below.
    const shiftWithIssuer = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    shiftWithIssuerId = (shiftWithIssuer.body as { id: string }).id;
    await db
      .update(schema.shifts)
      .set({ ssccIssuerCounterpartyId: counterpartyId })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftWithIssuerId)));

    const plainShift = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    plainShiftId = (plainShift.body as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Registers a real station_devices row -- sscc_blocks.device_id carries a real FK to it. */
  async function registerDevice(name: string): Promise<string> {
    const device = await agent.post("/station-devices").send({ name }).expect(201);
    return (device.body as { deviceId: string }).deviceId;
  }

  /** Creates a counterparty + shift pointing at it as the sscc issuer, returning the shift id. */
  async function shiftIssuedBy(name: string, gln: string): Promise<string> {
    const counterparty = await agent.post("/counterparties").send({ name, gln }).expect(201);
    const counterpartyId = (counterparty.body as { id: string }).id;
    const shift = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await db
      .update(schema.shifts)
      .set({ ssccIssuerCounterpartyId: counterpartyId })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    return shiftId;
  }

  it("allocates non-overlapping blocks under concurrency", async () => {
    const svc = app!.get(SsccService);
    const prefix = "111111111";
    const deviceIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerDevice(`Concurrency device ${i}`)),
    );
    const blocks = await Promise.all(
      deviceIds.map((deviceId) => svc.allocate(tenantId, prefix, 0, deviceId, 100)),
    );
    const sorted = [...blocks].sort((a, b) => a.fromSerial - b.fromSerial);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.fromSerial).toBeGreaterThan(sorted[i - 1]!.toSerial);
    }
    expect(new Set(blocks.map((b) => b.fromSerial)).size).toBe(8);
  });

  it("continues from the seeded starting serial", async () => {
    const prefix = "222222222";
    const deviceId = await registerDevice("Seeded-counter device");
    await db
      .insert(schema.ssccCounters)
      .values({ tenantId, issuerPrefix: prefix, extensionDigit: 0, nextSerial: 45_000 });
    const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 10);
    expect(block.fromSerial).toBe(45_000);
  });

  it("records which device received the block", async () => {
    const prefix = "333333333";
    const deviceId = await registerDevice("Recorded device");
    const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 10);
    const rows = await db
      .select()
      .from(schema.ssccBlocks)
      .where(
        and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromSerial).toBe(block.fromSerial);
  });

  it("resolves a shift's issuer to the counterparty's issuer prefix when one is set", async () => {
    const prefix = await app!.get(SsccService).resolveIssuerPrefix(tenantId, shiftWithIssuerId);
    expect(prefix).toBe(COUNTERPARTY_GLN.slice(0, 9));
  });

  it("resolves to the organisation's own issuer prefix when the shift sets no issuer", async () => {
    expect(await app!.get(SsccService).resolveIssuerPrefix(tenantId, plainShiftId)).toBe(
      ORG_GLN.slice(0, 9),
    );
  });

  it("draws from the SAME counter for two different GLNs sharing a 9-digit prefix", async () => {
    const svc = app!.get(SsccService);
    const shiftA = await shiftIssuedBy("Location A", GLN_SHARING_PREFIX_A);
    const shiftB = await shiftIssuedBy("Location B", GLN_SHARING_PREFIX_B);

    const prefixA = await svc.resolveIssuerPrefix(tenantId, shiftA);
    const prefixB = await svc.resolveIssuerPrefix(tenantId, shiftB);
    // Both GLNs resolve to the same prefix -- this is the number space's
    // real identity, not the GLN itself.
    expect(prefixA).toBe(SHARED_PREFIX);
    expect(prefixB).toBe(SHARED_PREFIX);

    const deviceA = await registerDevice("Shared-prefix device A");
    const deviceB = await registerDevice("Shared-prefix device B");
    const blockA = await svc.allocate(tenantId, prefixA, 0, deviceA, 50);
    const blockB = await svc.allocate(tenantId, prefixB, 0, deviceB, 50);
    // Contiguous ranges prove ONE shared counter advanced twice, rather than
    // two independent counters (keyed on the full GLN) each starting at 0 --
    // the bug this correction fixes, which would make blockB.fromSerial 0
    // instead of continuing from blockA's range.
    expect(blockB.fromSerial).toBe(blockA.toSerial + 1);
  });

  it("rolls back the counter when the block insert fails (unknown device)", async () => {
    const svc = app!.get(SsccService);
    const prefix = "444444444";
    const unknownDeviceId = "00000000-0000-4000-8000-000000000000";

    await expect(svc.allocate(tenantId, prefix, 0, unknownDeviceId, 10)).rejects.toThrow();

    const rows = await db
      .select()
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, prefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    // No row at all -- had the counter upsert and the failing block insert
    // not been wrapped in one transaction, the counter's insert would have
    // survived on its own, burning the range with no sscc_blocks row
    // recording who (attempted to receive) it.
    expect(rows).toHaveLength(0);
  });

  it("keeps extension digit 1 from disturbing extension digit 0 under the same prefix", async () => {
    const svc = app!.get(SsccService);
    const prefix = "555555555";
    const device0 = await registerDevice("Ext-digit-0 device");
    const device1 = await registerDevice("Ext-digit-1 device");

    const block0First = await svc.allocate(tenantId, prefix, 0, device0, 20);
    const block1 = await svc.allocate(tenantId, prefix, 1, device1, 30);
    // A hardcoded extensionDigit: 0 inside allocate()'s .values() calls would
    // route this ext-1 request onto ext-0's counter, making it continue from
    // block0First's range instead of starting fresh.
    expect(block1.fromSerial).toBe(0);

    const block0Second = await svc.allocate(tenantId, prefix, 0, device0, 5);
    // ext-0's own counter must be exactly where block0First left it --
    // undisturbed by the ext-1 allocation in between.
    expect(block0Second.fromSerial).toBe(block0First.toSerial + 1);
  });
});
