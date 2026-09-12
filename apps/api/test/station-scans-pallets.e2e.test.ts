import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import { Logger, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildSscc,
  canonicalizeKm,
  kmHash,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
} from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { schema, type Db } from "@markiro/db";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import {
  BOX_EXTENSION_DIGIT,
  PALLET_EXTENSION_DIGIT,
  SsccService,
} from "../src/modules/sscc/sscc.service";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 9 (06d): pallet ingest through `/station/scans`.
 *
 * A fresh tenant/device/shift per test: several of these post the SAME
 * device-local pallet id ("p1") and the same device-local box id ("b1"), and
 * `pallets_device_pallet_uq` deliberately scopes those strings to
 * (tenant, shift, terminal) -- sharing state across tests would let an
 * earlier test's pallet be silently reused by a later one and hide exactly
 * the bugs these assertions exist to catch.
 */
describe.skipIf(!ready)("station-scans pallet ingest (06d Task 9)", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

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
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Captures what the ingest actually logged. Spied on the prototype rather
   * than on one service instance because the closure loop logs through
   * `StationScansService`'s own logger, which the module owns.
   */
  function captureWarnings(): () => string[] {
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    return () =>
      spy.mock.calls.map(([message]) => (typeof message === "string" ? message : String(message)));
  }

  // Same fixture as station-scans.e2e.test.ts: a genuinely valid GTIN-14,
  // because POST /products validates the GS1 check digit.
  const VALID_GTIN14 = "04006381333931";
  // Nine digits, so `ssccSerialCapacity` leaves a seven-digit serial.
  const ISSUER_PREFIX = "034600682";
  const ISO = "2026-09-11T08:00:00.000Z";

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let apiKey: string;
  let deviceId: string;
  let shiftId: string;
  let operatorId: string;
  let palletBlockFrom: number;
  // `boxes_tenant_sscc_uq` forbids reusing one SSCC across two boxes, so every
  // fixture closure burns its own serial.
  let nextBoxSerial = 1;

  async function createActiveProduct(forAgent: ReturnType<typeof request.agent>): Promise<string> {
    const product = await forAgent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    return (product.body as { id: string }).id;
  }

  async function openShift(forAgent: ReturnType<typeof request.agent>): Promise<string> {
    const productId = await createActiveProduct(forAgent);
    const shift = await forAgent
      .post("/shifts")
      .send({ productId, mode: "validation" })
      .expect(201);
    const id = (shift.body as { id: string }).id;
    await forAgent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  beforeEach(async () => {
    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    const device = await createTestStationDevice(app!, agent, "Pallet line");
    apiKey = device.apiKey;
    deviceId = device.deviceId;
    shiftId = await openShift(agent);

    // A real employees row: pallets.operator_id and pallet_exceptions
    // .operator_id both carry a composite tenant FK to employees, so a
    // non-null operatorId that does not resolve to one would 23503 the batch.
    const employee = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
    operatorId = (employee.body as { id: string }).id;
    nextBoxSerial = 1;

    // Pallets take their own extension digit, so a pallet serial can never
    // collide with a box serial from the same issuer prefix.
    const block = await app!
      .get(SsccService)
      .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, deviceId, 50);
    palletBlockFrom = block.fromSerial;
  });

  const palletSscc = (offset: number): string =>
    buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, palletBlockFrom + offset);
  const nextBoxSscc = (): string => buildSscc(BOX_EXTENSION_DIGIT, ISSUER_PREFIX, nextBoxSerial++);

  function item(label: string, boxId: string | null): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${label}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId: "t1",
      raw,
      verdict: "ok",
      scannedAt: "2026-09-11T07:00:00.000Z",
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  interface BoxClosureFixture {
    boxId: string;
    shiftId: string;
    terminalId: string | null;
    sscc: string;
    closedAt: string;
    operatorId: string | null;
    devicePalletId?: string | null;
  }

  function boxClosure(
    boxId: string,
    overrides: Partial<BoxClosureFixture> = {},
  ): BoxClosureFixture {
    return {
      boxId,
      shiftId,
      terminalId: "t1",
      sscc: nextBoxSscc(),
      closedAt: ISO,
      operatorId: null,
      ...overrides,
    };
  }

  interface PalletClosureFixture {
    palletId: string;
    shiftId: string;
    terminalId: string | null;
    sscc: string;
    closedAt: string;
    operatorId: string | null;
    printVerifiedAt?: string | null;
    printSkippedAt?: string | null;
  }

  function palletClosure(
    palletId: string,
    overrides: Partial<PalletClosureFixture> = {},
  ): PalletClosureFixture {
    return {
      palletId,
      shiftId,
      terminalId: "t1",
      sscc: palletSscc(0),
      closedAt: ISO,
      operatorId,
      ...overrides,
    };
  }

  async function postRaw(body: Record<string, unknown>, status = 201, key = apiKey) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", key)
      .send(body)
      .expect(status);
  }

  async function postBatch(body: Record<string, unknown>) {
    // `items` has no schema default, so every batch spells it out.
    return postRaw({ batchId: `pallet-batch-${randomUUID()}`, items: [], ...body });
  }

  const palletRows = () =>
    db.select().from(schema.pallets).where(eq(schema.pallets.tenantId, tenantId));
  const boxRows = () => db.select().from(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
  const exceptionRows = () =>
    db.select().from(schema.palletExceptions).where(eq(schema.palletExceptions.tenantId, tenantId));

  /** Fills p1 with one closed box and then closes the pallet itself. */
  async function closePalletWith(devicePalletId: string, sscc: string): Promise<void> {
    await postBatch({
      items: [item(devicePalletId, `b-${devicePalletId}`)],
      boxes: [boxClosure(`b-${devicePalletId}`, { devicePalletId })],
    });
    await postBatch({ pallets: [palletClosure(devicePalletId, { sscc })] });
  }

  it("creates the pallet from the first box closure that names it", async () => {
    await postBatch({ items: [item("km1", "b1")] });
    await postBatch({ boxes: [boxClosure("b1", { devicePalletId: "p1" })] });

    const pallets = await palletRows();
    expect(pallets).toHaveLength(1);
    const pallet = pallets[0]!;
    expect(pallet.devicePalletId).toBe("p1");
    expect(pallet.shiftId).toBe(shiftId);
    // Identity only. Everything else about a pallet arrives with its closure.
    expect(pallet.sscc).toBeNull();
    expect(pallet.closedAt).toBeNull();
    expect(pallet.closureReceivedAt).toBeNull();

    const boxes = await boxRows();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.palletId).toBe(pallet.id);
    expect(boxes[0]!.closedAt).not.toBeNull();
  });

  it("accepts a box closure from a station that knows nothing about pallets", async () => {
    await postBatch({ items: [item("km1", "b1")] });
    // No `devicePalletId` key at all -- the exact payload a pre-06d station
    // build sends. Its box simply is not on a pallet.
    const legacy = boxClosure("b1");
    await postBatch({ boxes: [legacy] });

    const boxes = await boxRows();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.palletId).toBeNull();
    expect(boxes[0]!.closedAt).not.toBeNull();
    expect(boxes[0]!.sscc).toBe(legacy.sscc);
    expect(await palletRows()).toHaveLength(0);
  });

  it("keeps the payload digest of a pallet-free batch byte-identical to the pre-06d one", async () => {
    // The wedge this pins: `payloadDigest` hashes the whole body, and a
    // station that already sent batch X before this deployment retries it
    // afterwards. If the two empty pallet channels entered the hash, that
    // retry would mismatch the stored digest and 409 forever.
    const batchId = `pallet-digest-${randomUUID()}`;
    await postRaw({ batchId, items: [], boxes: [], exceptions: [] });

    const legacyCanonical = `{"batchId":${JSON.stringify(batchId)},"boxes":[],"exceptions":[],"items":[]}`;
    const [row] = await db
      .select({ payloadDigest: schema.syncBatches.payloadDigest })
      .from(schema.syncBatches)
      .where(
        and(eq(schema.syncBatches.tenantId, tenantId), eq(schema.syncBatches.batchId, batchId)),
      );
    expect(row!.payloadDigest).toBe(createHash("sha256").update(legacyCanonical).digest("hex"));

    // And the retry itself is acknowledged rather than rejected.
    const replay = await postRaw({ batchId, items: [], boxes: [], exceptions: [] });
    expect((replay.body as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
  });

  it("keeps the payload digest of a pre-06d BOX CLOSURE byte-identical", async () => {
    // The test above uses `boxes: []`, which cannot catch this: an empty
    // array carries no closure for a new key to appear inside. The actual
    // wedge lives one level down. `devicePalletId` carries a zod
    // `.default(null)`, and a zod default ADDS THE KEY to the parsed object
    // -- `parse({boxId:"b1"})` yields `{boxId:"b1",devicePalletId:null}`.
    // `payloadDigest` hashes `boxes`, so the SAME wire payload that hashed to
    // D before this slice would hash to D' after it.
    //
    // The failure is the ordinary offline-first case, not an edge one: a
    // terminal holding a pinned, unacked batch carrying a box closure when
    // the link is down at deploy time retries that identical payload
    // afterwards, is answered `station_batch_mismatch` (409), and -- because
    // both drains treat every non-401 as retryable and never drop data --
    // resends it forever. Scans, box closures, pallets and label events from
    // that terminal stop permanently.
    const batchId = `pallet-digest-boxes-${randomUUID()}`;
    await postBatch({ items: [item("km1", "b1")] });

    const sscc = nextBoxSscc();
    // Byte-for-byte what a pre-06d station puts on the wire: print outcomes
    // (06c) spelled out, and no `devicePalletId` key at all.
    const legacyClosure = {
      boxId: "b1",
      shiftId,
      terminalId: "t1",
      sscc,
      closedAt: ISO,
      operatorId: null,
      printVerifiedAt: ISO,
      printSkippedAt: null,
    };
    await postRaw({ batchId, items: [], boxes: [legacyClosure], exceptions: [] });

    // Keys sorted the way `canonicalJson` sorts them, `terminalId` replaced
    // by the authenticated device id exactly as the ingest replaces it, and
    // no `devicePalletId` member -- the pre-06d bytes.
    const legacyCanonicalBox = [
      `{"boxId":"b1"`,
      `"closedAt":${JSON.stringify(ISO)}`,
      `"operatorId":null`,
      `"printSkippedAt":null`,
      `"printVerifiedAt":${JSON.stringify(ISO)}`,
      `"shiftId":${JSON.stringify(shiftId)}`,
      `"sscc":${JSON.stringify(sscc)}`,
      `"terminalId":${JSON.stringify(deviceId)}}`,
    ].join(",");
    const legacyCanonical = `{"batchId":${JSON.stringify(batchId)},"boxes":[${legacyCanonicalBox}],"exceptions":[],"items":[]}`;
    const [row] = await db
      .select({ payloadDigest: schema.syncBatches.payloadDigest })
      .from(schema.syncBatches)
      .where(
        and(eq(schema.syncBatches.tenantId, tenantId), eq(schema.syncBatches.batchId, batchId)),
      );
    expect(row!.payloadDigest).toBe(createHash("sha256").update(legacyCanonical).digest("hex"));

    // And the retry of that same pinned payload is acknowledged, not 409ed.
    const replay = await postRaw({ batchId, items: [], boxes: [legacyClosure], exceptions: [] });
    expect((replay.body as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
  });

  it("folds devicePalletId into the digest when the box does stand on a pallet", async () => {
    // The other half of C1's rule: omitting the key unconditionally would
    // make two DIFFERENT payloads -- the same box closed onto a pallet and
    // off one -- share a digest, so a genuinely different batch replayed
    // under a pinned id would be silently acknowledged instead of rejected.
    const batchId = `pallet-digest-on-pallet-${randomUUID()}`;
    await postBatch({ items: [item("km1", "b1")] });

    const sscc = nextBoxSscc();
    const offPallet = {
      boxId: "b1",
      shiftId,
      terminalId: "t1",
      sscc,
      closedAt: ISO,
      operatorId: null,
      printVerifiedAt: ISO,
      printSkippedAt: null,
    };
    const onPallet = { ...offPallet, devicePalletId: "p1" };
    await postRaw({ batchId, items: [], boxes: [onPallet], exceptions: [] });

    const canonicalBox = [
      `{"boxId":"b1"`,
      `"closedAt":${JSON.stringify(ISO)}`,
      `"devicePalletId":"p1"`,
      `"operatorId":null`,
      `"printSkippedAt":null`,
      `"printVerifiedAt":${JSON.stringify(ISO)}`,
      `"shiftId":${JSON.stringify(shiftId)}`,
      `"sscc":${JSON.stringify(sscc)}`,
      `"terminalId":${JSON.stringify(deviceId)}}`,
    ].join(",");
    const canonical = `{"batchId":${JSON.stringify(batchId)},"boxes":[${canonicalBox}],"exceptions":[],"items":[]}`;
    const [row] = await db
      .select({ payloadDigest: schema.syncBatches.payloadDigest })
      .from(schema.syncBatches)
      .where(
        and(eq(schema.syncBatches.tenantId, tenantId), eq(schema.syncBatches.batchId, batchId)),
      );
    expect(row!.payloadDigest).toBe(createHash("sha256").update(canonical).digest("hex"));

    // Same batch id, same box, but now claimed to be off the pallet: a
    // different payload, and the ingest must refuse to acknowledge it.
    await postRaw({ batchId, items: [], boxes: [offPallet], exceptions: [] }, 409);
  });

  it("closes the pallet and records the consumed pallet serial", async () => {
    const sscc = palletSscc(4);
    await postBatch({
      items: [item("km1", "b1")],
      boxes: [boxClosure("b1", { devicePalletId: "p1" })],
    });
    await postBatch({ pallets: [palletClosure("p1", { sscc })] });

    const pallets = await palletRows();
    expect(pallets).toHaveLength(1);
    const pallet = pallets[0]!;
    expect(pallet.sscc).toBe(sscc);
    expect(pallet.closedAt?.toISOString()).toBe(ISO);
    expect(pallet.closureReceivedAt).not.toBeNull();
    expect(pallet.operatorId).toBe(operatorId);
    expect(pallet.disassembledAt).toBeNull();

    const [block] = await db
      .select({ consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.extensionDigit, PALLET_EXTENSION_DIGIT),
        ),
      );
    expect(block!.consumedThroughSerial).toBe(palletBlockFrom + 4);
  });

  it("is a no-op when the same pallet closure arrives twice under a new batch id", async () => {
    const sscc = palletSscc(1);
    await postBatch({
      items: [item("km1", "b1")],
      boxes: [boxClosure("b1", { devicePalletId: "p1" })],
    });
    const closure = palletClosure("p1", { sscc });
    await postBatch({ pallets: [closure] });
    const [first] = await palletRows();

    await postBatch({ pallets: [closure] });

    const rows = await palletRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sscc).toBe(sscc);
    // Server receipt is preserved, not restamped by the redelivery.
    expect(rows[0]!.closureReceivedAt?.toISOString()).toBe(first!.closureReceivedAt?.toISOString());
  });

  it("refuses a pallet SSCC already used in the tenant", async () => {
    // KNOWN WEDGE, pinned deliberately: the device's drain retries every
    // non-401 forever, so this 409 stops all scan, box and pallet delivery
    // from that terminal until someone edits its local database by hand. It is
    // kept only because the box path behaves the same way (its
    // `boxes_tenant_sscc_uq` violation merely renders as a 500 instead);
    // changing it is a product decision about both paths at once.
    const sscc = palletSscc(2);
    await closePalletWith("p1", sscc);
    await postRaw(
      {
        batchId: `pallet-batch-${randomUUID()}`,
        items: [],
        pallets: [palletClosure("p2", { sscc })],
      },
      409,
    );

    // The rejected batch rolled back whole: p2 never even got its identity row.
    const rows = await palletRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.devicePalletId).toBe("p1");
  });

  it("does not open a second pallet row when two batches name the same pallet", async () => {
    await postBatch({
      items: [item("km1", "b1")],
      boxes: [boxClosure("b1", { devicePalletId: "p1" })],
    });
    await postBatch({
      items: [item("km2", "b2")],
      boxes: [boxClosure("b2", { devicePalletId: "p1" })],
    });

    const pallets = await palletRows();
    expect(pallets).toHaveLength(1);
    const boxes = await boxRows();
    expect(boxes).toHaveLength(2);
    expect(new Set(boxes.map((box) => box.palletId))).toEqual(new Set([pallets[0]!.id]));
  });

  it("creates the row for a pallet that closed with no boxes", async () => {
    const sscc = palletSscc(3);
    await postBatch({ pallets: [palletClosure("p9", { sscc })] });

    const pallets = await palletRows();
    expect(pallets).toHaveLength(1);
    expect(pallets[0]!.devicePalletId).toBe("p9");
    expect(pallets[0]!.closedAt).not.toBeNull();
    expect(pallets[0]!.sscc).toBe(sscc);
  });

  it("lands a print-verification outcome resolved after the closure was already acked", async () => {
    const sscc = palletSscc(5);
    await postBatch({ pallets: [palletClosure("p1", { sscc })] });
    expect((await palletRows())[0]!.printVerifiedAt).toBeNull();

    await postBatch({
      pallets: [palletClosure("p1", { sscc, printVerifiedAt: "2026-09-11T08:05:00.000Z" })],
    });

    const rows = await palletRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.printVerifiedAt?.toISOString()).toBe("2026-09-11T08:05:00.000Z");
    expect(rows[0]!.printSkippedAt).toBeNull();
  });

  it("records a pallet disassembly with exact attribution", async () => {
    const sscc = palletSscc(6);
    await closePalletWith("p1", sscc);
    await postBatch({
      palletExceptions: [
        {
          kind: "disassemble",
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          operatorId,
          reason: "повреждён поддон",
          occurredAt: "2026-09-11T09:00:00.000Z",
        },
      ],
    });

    const pallets = await palletRows();
    expect(pallets).toHaveLength(1);
    const pallet = pallets[0]!;
    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      tenantId,
      kind: "disassemble",
      palletId: pallet.id,
      shiftId,
      // Server-assigned, never the client's wire field.
      terminalId: deviceId,
      operatorId,
      reason: "повреждён поддон",
      disaggregationDocumentId: null,
    });
    expect(exceptions[0]!.occurredAt.toISOString()).toBe("2026-09-11T09:00:00.000Z");
    expect(pallet.disassembledAt).not.toBeNull();

    // The boxes are NOT opened and keep their membership.
    const boxes = await boxRows();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.palletId).toBe(pallet.id);
    expect(boxes[0]!.disassembledAt).toBeNull();
    expect(boxes[0]!.closedAt).not.toBeNull();
  });

  it("records a pallet reprint without retiring the pallet", async () => {
    const sscc = palletSscc(7);
    await closePalletWith("p1", sscc);
    await postBatch({
      palletExceptions: [
        {
          kind: "reprint",
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          operatorId: null,
          reason: "этикетка смазана",
          occurredAt: "2026-09-11T09:30:00.000Z",
        },
      ],
    });

    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ kind: "reprint", operatorId: null });
    expect((await palletRows())[0]!.disassembledAt).toBeNull();
  });

  it("logs the closure that matches no open pallet row instead of failing silently", async () => {
    // The scenario that makes the silence expensive: a device restores an old
    // local database, reopens "p1" inside the SAME still-open shift and closes
    // it with a NEW serial. `closed_at IS NULL` correctly refuses to rewrite
    // the old closed row, the sscc-scoped late-print write matches nothing --
    // and the new serial is still marked consumed, so it is standing on a
    // physical pallet that no row references.
    const first = palletSscc(20);
    const second = palletSscc(21);
    await closePalletWith("p1", first);

    const warnings = captureWarnings();
    await postBatch({ pallets: [palletClosure("p1", { sscc: second })] });

    const noOpWarnings = warnings().filter((message) => message.includes("matched no open pallet"));
    expect(noOpWarnings).toHaveLength(1);
    // Enough detail to find the pallet by hand, exactly as the box-closure
    // loop's own no-op log carries.
    expect(noOpWarnings[0]).toContain("p1");
    expect(noOpWarnings[0]).toContain(tenantId);
    expect(noOpWarnings[0]).toContain(shiftId);
    expect(noOpWarnings[0]).toContain(second);

    // The guard itself is correct and stays: the old row keeps the serial
    // physically printed on it.
    const rows = await palletRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sscc).toBe(first);
  });

  it("warns when a pallet closure carries a serial from the box space", async () => {
    // Nothing rejects this: a 400 would wedge the device's queue forever,
    // which is worse than the mis-attribution. But the two serial spaces must
    // never interleave silently.
    const boxSpaceSscc = nextBoxSscc();
    const warnings = captureWarnings();
    await postBatch({ pallets: [palletClosure("p1", { sscc: boxSpaceSscc })] });

    const digitWarnings = warnings().filter((message) => message.includes("extension digit"));
    expect(digitWarnings).toHaveLength(1);
    expect(digitWarnings[0]).toContain("p1");
    expect(digitWarnings[0]).toContain(tenantId);
    expect(digitWarnings[0]).toContain(shiftId);
    expect(digitWarnings[0]).toContain(boxSpaceSscc);

    // Accepted, and the pallet block is untouched -- which is precisely the
    // mis-attribution the warning exists to make findable.
    const rows = await palletRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sscc).toBe(boxSpaceSscc);
    const [block] = await db
      .select({ consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.extensionDigit, PALLET_EXTENSION_DIGIT),
        ),
      );
    expect(block!.consumedThroughSerial).toBeNull();
  });

  it("keeps an ordinary pallet closure out of both warning paths", async () => {
    const warnings = captureWarnings();
    await postBatch({ pallets: [palletClosure("p1", { sscc: palletSscc(22) })] });
    expect(warnings().filter((message) => message.includes("Pallet closure"))).toEqual([]);
  });

  it("refuses a batch carrying more pallet closures than the shared limit", async () => {
    const tooMany = Array.from({ length: MAX_PALLET_CLOSURES_PER_SYNC_BATCH + 1 }, (_, i) =>
      palletClosure(`p${i}`, { sscc: palletSscc(i + 10) }),
    );
    await postRaw({ batchId: `pallet-batch-${randomUUID()}`, items: [], pallets: tooMany }, 400);
    expect(await palletRows()).toHaveLength(0);
  });

  it("refuses a pallet closure naming another tenant's shift", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const foreignShift = await openShift(other);

    const res = await postRaw(
      {
        batchId: `pallet-batch-${randomUUID()}`,
        items: [],
        pallets: [palletClosure("p1", { shiftId: foreignShift, sscc: palletSscc(8) })],
      },
      400,
    );
    expect((res.body as { message: string }).message).toBe("Unknown shift in batch");
    expect(await palletRows()).toHaveLength(0);
  });

  it("refuses a pallet exception naming another tenant's shift", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const foreignShift = await openShift(other);

    await postRaw(
      {
        batchId: `pallet-batch-${randomUUID()}`,
        items: [],
        palletExceptions: [
          {
            kind: "disassemble",
            palletId: "p1",
            shiftId: foreignShift,
            terminalId: "t1",
            operatorId: null,
            reason: "чужая смена",
            occurredAt: "2026-09-11T09:00:00.000Z",
          },
        ],
      },
      400,
    );
    expect(await exceptionRows()).toHaveLength(0);
    expect(await palletRows()).toHaveLength(0);
  });
});
