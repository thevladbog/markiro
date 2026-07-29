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

describe.skipIf(!ready)("sscc e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
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
    const productId = (product.body as { id: string }).id;

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

  it("allocates non-overlapping blocks under concurrency", async () => {
    const svc = app!.get(SsccService);
    const gln = "1111111111119";
    const deviceIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerDevice(`Concurrency device ${i}`)),
    );
    const blocks = await Promise.all(
      deviceIds.map((deviceId) => svc.allocate(tenantId, gln, 0, deviceId, 100)),
    );
    const sorted = [...blocks].sort((a, b) => a.fromSerial - b.fromSerial);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.fromSerial).toBeGreaterThan(sorted[i - 1]!.toSerial);
    }
    expect(new Set(blocks.map((b) => b.fromSerial)).size).toBe(8);
  });

  it("continues from the seeded starting serial", async () => {
    const gln = "2222222222218";
    const deviceId = await registerDevice("Seeded-counter device");
    await db
      .insert(schema.ssccCounters)
      .values({ tenantId, issuerGln: gln, extensionDigit: 0, nextSerial: 45_000 });
    const block = await app!.get(SsccService).allocate(tenantId, gln, 0, deviceId, 10);
    expect(block.fromSerial).toBe(45_000);
  });

  it("records which device received the block", async () => {
    const gln = "3333333333317";
    const deviceId = await registerDevice("Recorded device");
    const block = await app!.get(SsccService).allocate(tenantId, gln, 0, deviceId, 10);
    const rows = await db
      .select()
      .from(schema.ssccBlocks)
      .where(
        and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromSerial).toBe(block.fromSerial);
  });

  it("resolves a shift's issuer to the counterparty when one is set", async () => {
    const gln = await app!.get(SsccService).resolveIssuerGln(tenantId, shiftWithIssuerId);
    expect(gln).toBe(COUNTERPARTY_GLN);
  });

  it("resolves to the organisation's own GLN when the shift sets no issuer", async () => {
    expect(await app!.get(SsccService).resolveIssuerGln(tenantId, plainShiftId)).toBe(ORG_GLN);
  });
});
