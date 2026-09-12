import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

interface LineWire {
  id: string;
  ssccInput: string;
  sscc: string | null;
  boxId: string | null;
  palletId: string | null;
  status: string;
  productId: string | null;
  codeCount: number;
}

interface DocumentDetailWire {
  id: string;
  status: string;
  reasonName: string | null;
  lines: LineWire[];
}

/**
 * Task 21 (06d): disaggregating a PALLET from the cabinet. Taking a pallet
 * apart takes boxes off a stack; it does NOT open them -- so applying a
 * pallet line retires the pallet (`disassembledAt` + a `pallet_exceptions`
 * row attributed to the DOCUMENT, not an operator) and leaves every member
 * box closed with `boxes.pallet_id` still set. A user who also wants a
 * member box opened adds it as its own line of the same document (last test
 * below).
 *
 * Every `pallets`/`boxes`/`box_items` row is built through `/station/scans`,
 * the same ingest path `pallets.e2e.test.ts` and
 * `disaggregation-apply.e2e.test.ts` use -- there is no other way to create
 * one. SSCCs are real, checksum-valid values built with `buildSscc` (the
 * cabinet's `POST /disaggregation/:id/lines` parses input through
 * `parseScannedSscc`, which validates the GS1 check digit, so an
 * arbitrary-but-well-shaped literal would silently resolve to `not_found`).
 */
describe.skipIf(!ready)("disaggregation pallets e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let tenantId: string;
  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let productId: string;
  let operatorId: string;
  let reasonId: string;

  const VALID_GTIN14 = "04006381333931";
  const SSCC_PREFIX = "123456789"; // 9 digits, matching other e2e fixtures' shape
  let ssccSerial = 0;
  let codeLabelSeq = 0;

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
    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    const station = await createTestStationDevice(app!, agent, "Pallet line");
    stationKey = station.apiKey;

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
    productId = (product.body as { id: string }).id;

    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    operatorId = (operatorRes.body as { id: string }).id;

    const reasonRes = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Расформирование паллеты" })
      .expect(201);
    reasonId = (reasonRes.body as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A genuine, checksum-valid 18-digit SSCC, distinct on every call. */
  function nextSscc(): string {
    return buildSscc(0, SSCC_PREFIX, ssccSerial++);
  }

  function scanItem(
    shiftId: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    const label = `pallet-${codeLabelSeq++}`;
    const raw = `01${VALID_GTIN14}21S-${label}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId,
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
      .send({ batchId: `dsg-pallet-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

  async function openShift(): Promise<string> {
    const shift = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  interface PalletFixture {
    palletSscc: string;
    box1Sscc: string;
    box2Sscc: string;
  }

  /**
   * A closed pallet with two closed boxes on it (default 20 + 15 items --
   * matching the brief's "codeCount 35" example), its shift also closed.
   * Every call opens a fresh shift, so "b1"/"b2"/"p1"/"t1" device-local ids
   * are safe to reuse across calls.
   */
  async function createClosedPallet(box1Count = 20, box2Count = 15): Promise<PalletFixture> {
    const shiftId = await openShift();
    const base = Date.parse("2026-09-11T07:00:00.000Z");

    const box1Items = Array.from({ length: box1Count }, (_, i) =>
      scanItem(shiftId, "t1", new Date(base + i * 1000).toISOString(), "b1"),
    );
    const box2Items = Array.from({ length: box2Count }, (_, i) =>
      scanItem(shiftId, "t1", new Date(base + (1000 + i) * 1000).toISOString(), "b2"),
    );
    await postBatch({ items: box1Items });
    await postBatch({ items: box2Items });

    const box1Sscc = nextSscc();
    const box2Sscc = nextSscc();
    await postBatch({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: box1Sscc,
          closedAt: "2026-09-11T07:30:00.000Z",
          operatorId,
          devicePalletId: "p1",
        },
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: box2Sscc,
          closedAt: "2026-09-11T07:30:01.000Z",
          operatorId,
          devicePalletId: "p1",
        },
      ],
    });

    const palletSscc = nextSscc();
    await postBatch({
      pallets: [
        {
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          sscc: palletSscc,
          closedAt: "2026-09-11T08:00:00.000Z",
          operatorId,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });

    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);
    return { palletSscc, box1Sscc, box2Sscc };
  }

  /**
   * SSCCs are built from a counter that restarts at 0 in every process run,
   * so re-running this suite against the same shared dev database can leave
   * an earlier run's tenant with an identical bare SSCC value (legal: the
   * DB's uniqueness on `sscc` is per-tenant). Every lookup below scopes by
   * `tenantId` for that reason -- an unscoped `where(eq(sscc, ...))` would
   * risk resolving to a stale row from a completely different test run.
   */
  async function findPalletBySscc(sscc: string) {
    const [pallet] = await db
      .select()
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, sscc)));
    if (!pallet) throw new Error(`Expected a pallet with sscc ${sscc}`);
    return pallet;
  }

  async function findBoxBySscc(sscc: string) {
    const [box] = await db
      .select()
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)));
    if (!box) throw new Error(`Expected a box with sscc ${sscc}`);
    return box;
  }

  function ai00(sscc: string): string {
    return `(00)${sscc}`;
  }

  async function createDocument(opts: { lines: string[] }): Promise<DocumentDetailWire> {
    const created = await agent.post("/disaggregation").send({}).expect(201);
    const id = (created.body as { id: string }).id;
    await agent.patch(`/disaggregation/${id}`).send({ reasonId }).expect(200);
    await agent.post(`/disaggregation/${id}/lines`).send({ ssccs: opts.lines }).expect(201);
    return (await agent.get(`/disaggregation/${id}`).expect(200)).body as DocumentDetailWire;
  }

  async function applyDocument(doc: { id: string }): Promise<DocumentDetailWire> {
    const applied = await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);
    return applied.body as DocumentDetailWire;
  }

  it("resolves a line naming a pallet", async () => {
    const { palletSscc } = await createClosedPallet();
    const pallet = await findPalletBySscc(palletSscc);

    const doc = await createDocument({ lines: [ai00(palletSscc)] });

    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      status: "ok",
      boxId: null,
      palletId: pallet.id,
    });
  });

  it("counts a pallet line's codes across its boxes", async () => {
    const { palletSscc } = await createClosedPallet(20, 15);
    const doc = await createDocument({ lines: [ai00(palletSscc)] });
    expect(doc.lines[0]!.codeCount).toBe(35);
  });

  it("refuses a pallet that is already disassembled", async () => {
    const { palletSscc } = await createClosedPallet();
    await applyDocument(await createDocument({ lines: [ai00(palletSscc)] }));

    const again = await createDocument({ lines: [ai00(palletSscc)] });
    expect(again.lines[0]!.status).toBe("already_disassembled");
  });

  it("retires the pallet and leaves its boxes closed and attached", async () => {
    const { palletSscc } = await createClosedPallet();
    await applyDocument(await createDocument({ lines: [ai00(palletSscc)] }));

    const pallet = await findPalletBySscc(palletSscc);
    expect(pallet.disassembledAt).not.toBeNull();

    const boxes = await db
      .select()
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, pallet.id)));
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.disassembledAt === null)).toBe(true);
    expect(boxes.every((b) => b.palletId === pallet.id)).toBe(true);
  });

  it("audits the disassembly against the document, not an operator", async () => {
    const { palletSscc } = await createClosedPallet();
    const doc = await createDocument({ lines: [ai00(palletSscc)] });
    const applied = await applyDocument(doc);

    const pallet = await findPalletBySscc(palletSscc);
    const [ex] = await db
      .select()
      .from(schema.palletExceptions)
      .where(
        and(
          eq(schema.palletExceptions.tenantId, tenantId),
          eq(schema.palletExceptions.palletId, pallet.id),
        ),
      );

    expect(ex).toMatchObject({
      tenantId,
      kind: "disassemble",
      palletId: pallet.id,
      shiftId: pallet.shiftId,
      terminalId: pallet.terminalId,
      disaggregationDocumentId: applied.id,
      operatorId: null,
    });
    expect(ex!.reason).toBe(applied.reasonName);
  });

  it("takes a pallet and one of its boxes as two independent lines", async () => {
    const { palletSscc, box1Sscc } = await createClosedPallet();
    const doc = await createDocument({ lines: [ai00(palletSscc), ai00(box1Sscc)] });
    expect(doc.lines.every((line) => line.status === "ok")).toBe(true);

    await applyDocument(doc);

    const pallet = await findPalletBySscc(palletSscc);
    expect(pallet.disassembledAt).not.toBeNull();

    const box = await findBoxBySscc(box1Sscc);
    expect(box.disassembledAt).not.toBeNull(); // explicitly opened as its own line
    expect(box.palletId).toBe(pallet.id); // membership record persists regardless

    const [boxException] = await db
      .select()
      .from(schema.boxExceptions)
      .where(
        and(eq(schema.boxExceptions.tenantId, tenantId), eq(schema.boxExceptions.boxId, box.id)),
      );
    expect(boxException).toMatchObject({
      kind: "disassemble",
      disaggregationDocumentId: doc.id,
      operatorId: null,
    });
  });
});
