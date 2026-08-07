import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 8: the per-shift `box_exceptions` audit trail (`GET
 * /box-exceptions?shiftId=`) -- a manager-only, read-only view of every
 * undo/clear/disassemble/reprint exception recorded by Tasks 4-7. Harness
 * copied from boxes.e2e.test.ts (this file's exact precedent): all fixtures
 * are built through the same `/station/scans` sync-batch endpoint
 * station-scans.e2e.test.ts's own "exceptions" describe block exercises
 * directly -- there is no other way to write a `box_exceptions` row -- so
 * this file never touches the database directly either.
 */
describe.skipIf(!ready)("box-exceptions e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let stationDeviceId: string;
  let shiftId: string;

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

    agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const station = await deviceKey(agent);
    stationKey = station.apiKey;
    stationDeviceId = station.deviceId;
    const productId = await createActiveProduct(agent);

    // One box with two live items, so each "undo" below has a real code to
    // release.
    shiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(shiftId, "aa", stationDeviceId, "2026-07-01T10:00:00.000Z", "b1"),
      scan(shiftId, "bb", stationDeviceId, "2026-07-01T10:00:01.000Z", "b1"),
    ]);

    // Two "undo" exceptions, each in its OWN sync batch so their
    // server-assigned `recordedAt` strictly increases -- this is what proves
    // the endpoint really orders by `recordedAt DESC` (newest first) rather
    // than by an insertion order that would otherwise happen to coincide
    // with it.
    await postExceptions(stationKey, [
      exception("undo", "b1", shiftId, codeHashFor("aa"), "2026-07-01T10:00:00.000Z"),
    ]);
    await postExceptions(stationKey, [
      exception("undo", "b1", shiftId, codeHashFor("bb"), "2026-07-01T10:00:01.000Z"),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function deviceKey(
    a: ReturnType<typeof request.agent>,
  ): Promise<{ apiKey: string; deviceId: string }> {
    return createTestStationDevice(app!, a, "Line 1");
  }

  // Same fixture as boxes.e2e.test.ts / conflicts.e2e.test.ts / station-scans.e2e.test.ts.
  const VALID_GTIN14 = "04006381333931";
  const codeHashFor = (label: string) => kmHash(canonicalizeKm(`01${VALID_GTIN14}21S-${label}`));

  async function createActiveProduct(a: ReturnType<typeof request.agent>): Promise<string> {
    const product = await a
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    return (product.body as { id: string }).id;
  }

  async function openShiftForProduct(
    a: ReturnType<typeof request.agent>,
    productId: string,
  ): Promise<string> {
    const shift = await a.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await a.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  function scan(
    shiftIdArg: string,
    codeLabel: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${codeLabel}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId: shiftIdArg,
      terminalId,
      raw,
      verdict: "ok",
      scannedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  interface ExceptionFixture {
    kind: "undo" | "clear" | "disassemble" | "reprint";
    boxId: string;
    codeHash: string | null;
    targetScannedAt: string | null;
    shiftId: string;
    terminalId: string | null;
    operatorId: string | null;
    reason: string | null;
    occurredAt: string;
  }

  // "undo" is reasonless (see box_exceptions' own schema comment in
  // packages/db/src/schema/platform.ts) -- always null here.
  function exception(
    kind: ExceptionFixture["kind"],
    boxId: string,
    shiftIdArg: string,
    codeHash: string | null,
    targetScannedAt: string | null = null,
  ): ExceptionFixture {
    return {
      kind,
      boxId,
      codeHash,
      targetScannedAt,
      shiftId: shiftIdArg,
      terminalId: stationDeviceId,
      operatorId: null,
      reason: null,
      occurredAt: new Date().toISOString(),
    };
  }

  async function postBatch(apiKey: string, items: ScanItemDto[]) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `box-exceptions-batch-${randomUUID()}`, items, boxes: [] })
      .expect(201);
  }

  async function postExceptions(apiKey: string, exceptions: ExceptionFixture[]) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: `box-exceptions-batch-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions,
      })
      .expect(201);
  }

  it("lists exceptions for a shift, newest first", async () => {
    const res = await agent.get(`/box-exceptions?shiftId=${shiftId}`).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].kind).toBeDefined();
    expect(res.body.items[0].kind).toBe("undo");
    // Newest first: "bb"'s undo was recorded in the LATER of the two
    // separate batches above, so it must sort ahead of "aa"'s.
    expect(res.body.items[0].codeHash).toBe(codeHashFor("bb"));
    expect(res.body.items[0].targetScannedAt).toBe("2026-07-01T10:00:01.000Z");
    expect(res.body.items[1].codeHash).toBe(codeHashFor("aa"));
    expect(res.body.items[1].targetScannedAt).toBe("2026-07-01T10:00:00.000Z");
  });

  it("rejects a station device api-key with 403", async () => {
    const { apiKey: key } = await deviceKey(agent);
    await request(app!.getHttpServer())
      .get(`/box-exceptions?shiftId=${shiftId}`)
      .set("x-api-key", key)
      .expect(403);
  });
});
