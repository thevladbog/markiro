import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { PALLET_EXTENSION_DIGIT, SsccService } from "../src/modules/sscc/sscc.service";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 10 (06d): the per-shift pallet list in the cabinet (`GET /pallets`).
 * Every `pallets`/`boxes`/`box_items` row is built through the same
 * `/station/scans` ingest path Task 9's own suite exercises directly
 * (station-scans-pallets.e2e.test.ts) -- there is no other way to create
 * one -- so this file never touches the database directly.
 *
 * Unlike boxes.e2e.test.ts's shared, READ-ONLY fixtures, the tests below
 * deliberately mutate ONE shared pallet in sequence -- displacing and
 * removing items, then disassembling one of its two boxes -- because that is
 * exactly the shape of the task brief's own three assertions (counts right
 * after closing, then after an item exception, then after a box
 * disassembly). Each `it` therefore depends on the previous one having run;
 * they are ordered deliberately and are not safe to reorder or run in
 * isolation.
 */
describe.skipIf(!ready)("pallets e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let stationDeviceId: string;
  let shiftId: string;
  let operatorId: string;
  let palletSscc: string;
  /** box1: 20 items, none ever touched until the exception test below. */
  const BOX1_ITEM_COUNT = 20;
  /** box2: 15 items -- the brief's "short box". Disassembled in the last test. */
  const BOX2_ITEM_COUNT = 15;
  /** The exact code displaced by an earlier rival scan in the exception test. */
  let displaceLabel: string;
  let displaceScannedAt: string;
  /** The exact code released by an operator "undo" in the exception test. */
  let removeLabel: string;
  let removeScannedAt: string;

  const VALID_GTIN14 = "04006381333931";
  // Nine digits, so `ssccSerialCapacity` leaves a seven-digit serial -- same
  // fixture shape as station-scans-pallets.e2e.test.ts.
  const ISSUER_PREFIX = "034600682";
  const ITEM_BASE = Date.parse("2026-09-11T07:00:00.000Z");
  const BOX_CLOSED_AT = "2026-09-11T07:30:00.000Z";
  const PALLET_CLOSED_AT = "2026-09-11T08:00:00.000Z";

  /**
   * Describe-scoped rather than local to `beforeAll`: the fixtures below are
   * built with them, and the box-list test also needs to add one box AFTER
   * the shared pallet exists.
   */
  function item(label: string, boxId: string | null, scannedAt: string): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${label}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId: "t1",
      raw,
      verdict: "ok",
      scannedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  async function postBatch(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({ batchId: `pallet-e2e-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

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
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Pallet line");
    stationKey = station.apiKey;
    stationDeviceId = station.deviceId;

    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const productId = (product.body as { id: string }).id;

    const shift = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    // `pallets.operator_id` carries a composite tenant FK to `employees`.
    const employee = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
    operatorId = (employee.body as { id: string }).id;

    // A real block from the pallet serial space, so the closure's sscc is a
    // genuine one rather than a placeholder string the FK/constraints happen
    // to accept.
    const block = await app!
      .get(SsccService)
      .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 5);
    palletSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);

    const box1Items = Array.from({ length: BOX1_ITEM_COUNT }, (_, i) =>
      item(`b1-${i}`, "b1", new Date(ITEM_BASE + i * 1000).toISOString()),
    );
    const box2Items = Array.from({ length: BOX2_ITEM_COUNT }, (_, i) =>
      item(`b2-${i}`, "b2", new Date(ITEM_BASE + (100 + i) * 1000).toISOString()),
    );
    displaceLabel = "b1-0";
    displaceScannedAt = box1Items[0]!.scannedAt;
    removeLabel = "b1-1";
    removeScannedAt = box1Items[1]!.scannedAt;

    await postBatch({ items: box1Items });
    await postBatch({ items: box2Items });
    await postBatch({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: "123460682000000101",
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p1",
        },
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: "123460682000000102",
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p1",
        },
      ],
    });
    await postBatch({
      pallets: [
        {
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          sscc: palletSscc,
          closedAt: PALLET_CLOSED_AT,
          operatorId,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("lists a shift's pallets with their box and unit counts", async () => {
    const res = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    expect(res.body.items).toHaveLength(1);
    const pallet = res.body.items[0];
    expect(pallet.sscc).toBe(`00${palletSscc}`);
    expect(pallet.terminalId).toBe(stationDeviceId);
    expect(pallet.operatorId).toBe(operatorId);
    expect(pallet.boxCount).toBe(2);
    expect(pallet.unitCount).toBe(BOX1_ITEM_COUNT + BOX2_ITEM_COUNT);
    expect(pallet.closedAt).toBe(PALLET_CLOSED_AT);
    expect(pallet.contentsChangedAfterClose).toBe(false);
    expect(pallet.disassembledAt).toBeNull();
  });

  /**
   * The box list's own «Паллета» column (06d review finding A). `b3` is
   * closed WITHOUT a `devicePalletId`, so it is a box on no pallet at all --
   * and because it carries no `palletId` it contributes to neither
   * `boxCount` nor `unitCount` of the shared pallet the later tests assert.
   */
  it("reports each box's pallet SSCC in the shift's box list, null for a box on no pallet", async () => {
    await postBatch({ items: [item("b3-0", "b3", new Date(ITEM_BASE + 500_000).toISOString())] });
    await postBatch({
      boxes: [
        {
          boxId: "b3",
          shiftId,
          terminalId: "t1",
          sscc: "123460682000000103",
          closedAt: BOX_CLOSED_AT,
          operatorId,
        },
      ],
    });

    const res = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    const bySscc = new Map<string, { palletSscc: string | null }>(
      (res.body.items as { sscc: string; palletSscc: string | null }[]).map((box) => [
        box.sscc,
        box,
      ]),
    );
    expect(bySscc.get("00123460682000000101")?.palletSscc).toBe(`00${palletSscc}`);
    expect(bySscc.get("00123460682000000102")?.palletSscc).toBe(`00${palletSscc}`);
    // Present in the list, explicitly on no pallet -- not absent, not "".
    expect(bySscc.has("00123460682000000103")).toBe(true);
    expect(bySscc.get("00123460682000000103")?.palletSscc).toBeNull();
  });

  it("excludes displaced and operator-removed items from the unit count", async () => {
    const displaceRaw = `01${VALID_GTIN14}21S-${displaceLabel}`;
    const displaceKm = canonicalizeKm(displaceRaw);
    // A rival scan of the SAME code, with an EARLIER scannedAt, posted after
    // b1 already closed -- 06b's ownership race retroactively displaces the
    // box's own item (see boxes.e2e.test.ts's identical "displacedShiftId"
    // fixture). `boxId: null`: this scan does not itself join any box.
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({
        batchId: `pallet-e2e-${randomUUID()}`,
        items: [
          {
            shiftId,
            terminalId: "t2",
            raw: displaceRaw,
            verdict: "ok",
            scannedAt: new Date(Date.parse(displaceScannedAt) - 60_000).toISOString(),
            code: {
              codeHash: kmHash(displaceKm),
              gtin14: displaceKm.gtin14,
              serial: displaceKm.serial,
            },
            boxId: null,
            operatorId: null,
          },
        ],
      })
      .expect(201);

    const removeRaw = `01${VALID_GTIN14}21S-${removeLabel}`;
    const removeKm = canonicalizeKm(removeRaw);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({
        batchId: `pallet-e2e-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions: [
          {
            kind: "undo",
            boxId: "b1",
            codeHash: kmHash(removeKm),
            targetScannedAt: removeScannedAt,
            shiftId,
            terminalId: "t1",
            operatorId: null,
            reason: null,
            occurredAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);

    const res = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    const pallet = res.body.items[0];
    expect(pallet.boxCount).toBe(2);
    expect(pallet.unitCount).toBe(BOX1_ITEM_COUNT + BOX2_ITEM_COUNT - 2);
  });

  it("counts a disassembled box out of the pallet but flags the change", async () => {
    // Captured fresh rather than derived from `BOX1_ITEM_COUNT` minus the
    // previous test's own exclusions: this `it` and the "excludes displaced
    // and operator-removed items" one above are SIBLINGS, not a single test
    // -- vitest runs a file's tests in declared order, but a failure (or a
    // timeout under a loaded full-suite run) in one sibling does not stop
    // the next from executing. An absolute expectation baked from assuming
    // the previous test's two exceptions had already landed would then fail
    // HERE, misattributing an upstream flake to this test's own disassembly
    // logic -- exactly the failure this file's own docstring warns about.
    // Asserting the DELTA this test itself produces keeps this test's
    // pass/fail meaning tied only to the mutation it performs.
    const before = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    const beforePallet = before.body.items[0];

    // `contentsChangedAfterClose` compares this box exception's DEVICE-supplied
    // `occurredAt` against the pallet's SERVER-assigned `closureReceivedAt`
    // (`now()`, captured in `beforeAll` when the pallet closed) -- two
    // independent clock reads, exactly as production compares a device's own
    // clock against the server's. A bare `new Date()` here is NOT safe: this
    // repo's dev/test Postgres runs in a Docker container, which on macOS gets
    // its own virtualized clock that can drift from the host process running
    // this test, and the drift measurably widens under the CPU load a full
    // `pnpm turbo test` run puts on the machine. Reproduced directly: a full
    // gate run recorded `boxes.disassembled_at` (this test's `new Date()`)
    // landing 8.9ms BEFORE `pallets.closure_received_at` (Postgres's `now()`
    // for the SAME pallet's earlier closure), flipping this exact assertion to
    // `false`, even though the disassembly happened several HTTP round trips
    // -- and therefore strictly later in real, causal, application-level time
    // -- after the closure. A generous forward buffer keeps this test
    // asserting the comparison's LOGIC rather than betting on sub-second
    // agreement between two different machines' clocks.
    const occurredAt = new Date(Date.now() + 60_000).toISOString();

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({
        batchId: `pallet-e2e-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions: [
          {
            kind: "disassemble",
            boxId: "b2",
            codeHash: null,
            shiftId,
            terminalId: "t1",
            operatorId: null,
            reason: "переставлен на другой поддон",
            occurredAt,
          },
        ],
      })
      .expect(201);

    const res = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    const pallet = res.body.items[0];
    // Disassembling b2 takes exactly one box and exactly its own 15 items
    // off the pallet's counts, regardless of what b1's own count was going
    // in (that number is the sibling test's own assertion to make).
    expect(pallet.boxCount).toBe(beforePallet.boxCount - 1);
    expect(pallet.unitCount).toBe(beforePallet.unitCount - BOX2_ITEM_COUNT);
    expect(pallet.contentsChangedAfterClose).toBe(true);
  });

  it("rejects a station api-key", async () => {
    await request(app!.getHttpServer())
      .get(`/pallets?shiftId=${shiftId}`)
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("404s for a shift that does not belong to the caller's tenant", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const otherProduct = await other
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const otherShift = await other
      .post("/shifts")
      .send({ productId: (otherProduct.body as { id: string }).id, mode: "validation" })
      .expect(201);
    const otherShiftId = (otherShift.body as { id: string }).id;
    await other.post(`/shifts/${otherShiftId}/open`).expect(200);

    await agent.get(`/pallets?shiftId=${otherShiftId}`).expect(404);
  });

  it("rejects a request without a shift", async () => {
    await agent.get("/pallets").expect(400);
  });
});
