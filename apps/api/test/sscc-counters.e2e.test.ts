import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc, gs1CheckDigit } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import {
  BOX_EXTENSION_DIGIT,
  PALLET_EXTENSION_DIGIT,
  SsccService,
} from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { findCounter } from "./support/sscc-counters";

/**
 * Task 11: `GET /org/profile/sscc` and `GET /counterparties/:id/sscc` now
 * return `{ counters: SsccCounterStateDto[] }` -- one entry per extension
 * digit (box at `BOX_EXTENSION_DIGIT` = 0, pallet at `PALLET_EXTENSION_DIGIT`
 * = 1) -- instead of a single box-only object. Same env-gating as
 * sscc.e2e.test.ts / sscc-settings.e2e.test.ts.
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("sscc counter list e2e (Task 11)", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

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

  // A fresh, check-digit-valid 13-digit GLN per tenant, in a namespace
  // ("51...") not used by any other sscc test file, so a real sscc_blocks
  // row cut under one test's prefix can never collide with another's.
  let glnCounter = 0;
  function freshGln(): string {
    glnCounter += 1;
    const body = `51${String(glnCounter).padStart(7, "0")}000`;
    return body + String(gs1CheckDigit(body));
  }

  /**
   * A fresh tenant with its own GLN, an active station device, and a
   * counterparty with its own (different) GLN -- everything a test needs to
   * exercise both `getSscc` call sites (org-profile's own counter and a
   * counterparty's) without sharing state with any other test.
   */
  async function setupTenant(): Promise<{
    agent: ReturnType<typeof request.agent>;
    tenantId: string;
    prefix: string;
    counterpartyId: string;
    counterpartyPrefix: string;
    deviceId: string;
  }> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const gln = freshGln();
    await agent.put("/org/profile").send({ gln }).expect(200);

    const counterpartyGln = freshGln();
    const counterparty = await agent
      .post("/counterparties")
      .send({ name: "Task 11 counterparty", gln: counterpartyGln })
      .expect(201);
    const counterpartyId = (counterparty.body as { id: string }).id;

    const device = await createTestStationDevice(app!, agent, "Task 11 terminal");

    return {
      agent,
      tenantId,
      prefix: gln.slice(0, 9),
      counterpartyId,
      counterpartyPrefix: counterpartyGln.slice(0, 9),
      deviceId: device.deviceId,
    };
  }

  it("reports a counter for boxes and one for pallets, in that order, for the tenant's own GLN", async () => {
    const { agent } = await setupTenant();

    const res = await agent.get("/org/profile/sscc").expect(200);
    const counters = (res.body as { counters: Array<{ extensionDigit: number }> }).counters;
    expect(counters.map((c) => c.extensionDigit)).toEqual([
      BOX_EXTENSION_DIGIT,
      PALLET_EXTENSION_DIGIT,
    ]);

    // Fresh defaults: digit 0 (box) starts numbering at 1, every other digit
    // (pallet) starts at 0 -- see org-profile/dto.ts:87-89 and
    // SsccService.counterState's own firstSerial rule.
    expect(findCounter(res, BOX_EXTENSION_DIGIT)).toMatchObject({
      extensionDigit: BOX_EXTENSION_DIGIT,
      nextSerial: 1,
      minSerial: 1,
      blockedBy: null,
    });
    expect(findCounter(res, PALLET_EXTENSION_DIGIT)).toMatchObject({
      extensionDigit: PALLET_EXTENSION_DIGIT,
      nextSerial: 0,
      minSerial: 0,
      blockedBy: null,
    });
  });

  it("reports a counter for boxes and one for pallets for a counterparty's GLN", async () => {
    const { agent, counterpartyId } = await setupTenant();

    const res = await agent.get(`/counterparties/${counterpartyId}/sscc`).expect(200);
    const counters = (res.body as { counters: Array<{ extensionDigit: number }> }).counters;
    expect(counters.map((c) => c.extensionDigit)).toEqual([
      BOX_EXTENSION_DIGIT,
      PALLET_EXTENSION_DIGIT,
    ]);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).nextSerial).toBe(0);
  });

  it("seeds the tenant's own pallet counter without touching its box counter", async () => {
    const { agent } = await setupTenant();

    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: 5000 })
      .expect(200);

    const res = await agent.get("/org/profile/sscc").expect(200);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).nextSerial).toBe(5000);
    // The box counter, never touched by this PUT, must still read its own
    // untouched default -- not 5000, and not 0.
    expect(findCounter(res, BOX_EXTENSION_DIGIT).nextSerial).toBe(1);
  });

  it("seeds a counterparty's pallet counter without touching its box counter", async () => {
    const { agent, counterpartyId } = await setupTenant();

    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: 3000 })
      .expect(200);

    const res = await agent.get(`/counterparties/${counterpartyId}/sscc`).expect(200);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).nextSerial).toBe(3000);
    expect(findCounter(res, BOX_EXTENSION_DIGIT).nextSerial).toBe(1);
  });

  it("keeps extension-digit order stable even when the pallet counter is seeded before the box counter ever is", async () => {
    const { agent } = await setupTenant();

    // Only the pallet row exists in sscc_counters at this point -- the box
    // row has never been written. If getSscc's order depended on DB
    // insertion/row order rather than iterating a fixed digit list, this
    // would come back as [1] alone, or [1, 0].
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: 42 })
      .expect(200);

    const res = await agent.get("/org/profile/sscc").expect(200);
    const counters = (res.body as { counters: Array<{ extensionDigit: number }> }).counters;
    expect(counters.map((c) => c.extensionDigit)).toEqual([
      BOX_EXTENSION_DIGIT,
      PALLET_EXTENSION_DIGIT,
    ]);
  });

  it("allows serial 0 for the pallet counter and refuses it for the box counter", async () => {
    const { agent } = await setupTenant();

    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: 0 })
      .expect(200);
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: BOX_EXTENSION_DIGIT, nextSerial: 0 })
      .expect(400);

    const res = await agent.get("/org/profile/sscc").expect(200);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).nextSerial).toBe(0);
  });

  it("refuses to seed the pallet counter below a serial already printed on a pallet, but allows seeding at or above that floor", async () => {
    const { agent, tenantId, prefix, deviceId } = await setupTenant();
    const service = app!.get(SsccService);

    // Cuts a real sscc_blocks row under the pallet extension digit -- the
    // same one-statement path a shift bundle uses -- then reports one of its
    // serials as actually printed. The floor tracks PRINTED serials
    // (`consumedThroughSerial`), matching the box path's own "putSscc floor"
    // suite in sscc-settings.e2e.test.ts.
    const block = await service.allocate(tenantId, prefix, PALLET_EXTENSION_DIGIT, deviceId, 50);
    await service.recordConsumedSerial(
      tenantId,
      buildSscc(PALLET_EXTENSION_DIGIT, prefix, block.fromSerial + 9),
    );
    const floor = block.fromSerial + 10;

    const rejected = await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: floor - 1 })
      .expect(400);
    expect(rejected.body).toMatchObject({ code: "sscc_seed_below_floor", minSerial: floor });

    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: floor })
      .expect(200);
    const res = await agent.get("/org/profile/sscc").expect(200);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).nextSerial).toBe(floor);
    expect(findCounter(res, PALLET_EXTENSION_DIGIT).minSerial).toBe(floor);
    // The box counter's own floor is independent -- nothing was ever
    // allocated or printed under BOX_EXTENSION_DIGIT for this tenant.
    expect(findCounter(res, BOX_EXTENSION_DIGIT).minSerial).toBe(1);
  });

  it("refuses to seed a counterparty's pallet counter below a serial already printed on a pallet", async () => {
    const { agent, tenantId, counterpartyId, counterpartyPrefix, deviceId } = await setupTenant();
    const service = app!.get(SsccService);

    const block = await service.allocate(
      tenantId,
      counterpartyPrefix,
      PALLET_EXTENSION_DIGIT,
      deviceId,
      50,
    );
    await service.recordConsumedSerial(
      tenantId,
      buildSscc(PALLET_EXTENSION_DIGIT, counterpartyPrefix, block.fromSerial + 4),
    );
    const floor = block.fromSerial + 5;

    const rejected = await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: floor - 1 })
      .expect(400);
    expect(rejected.body).toMatchObject({ code: "sscc_seed_below_floor", minSerial: floor });

    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: floor })
      .expect(200);
    expect(
      findCounter(
        await agent.get(`/counterparties/${counterpartyId}/sscc`).expect(200),
        PALLET_EXTENSION_DIGIT,
      ).nextSerial,
    ).toBe(floor);
  });

  it("tenant isolation: a second organization's counter list starts fresh, independent of another tenant's pallet seed", async () => {
    const { agent } = await setupTenant();
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: PALLET_EXTENSION_DIGIT, nextSerial: 9000 })
      .expect(200);

    const { agent: agent2 } = await setupTenant();
    const res2 = await agent2.get("/org/profile/sscc").expect(200);
    expect(findCounter(res2, PALLET_EXTENSION_DIGIT).nextSerial).toBe(0);

    const res1 = await agent.get("/org/profile/sscc").expect(200);
    expect(findCounter(res1, PALLET_EXTENSION_DIGIT).nextSerial).toBe(9000);
  });
});
