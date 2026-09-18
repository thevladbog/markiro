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
import { PALLET_EXTENSION_DIGIT, SsccService } from "../src/modules/sscc/sscc.service";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * 06d review finding A/B: the box↔pallet linkage in code search --
 * `GET /code-search/boxes/:boxId`'s `pallet` field and the new pallet card
 * `GET /code-search/pallets/:palletId`.
 *
 * Every `pallets`/`boxes`/`box_items` row is built through `/station/scans`,
 * the only path that creates one, exactly as `pallets.e2e.test.ts` does; this
 * file never writes to the database directly.
 *
 * The fixture is built ONCE and read by most tests; the two tests that mutate
 * it (a member box's disassembly, then the pallet's own) are ordered last and
 * say so. They are not safe to reorder.
 */
describe.skipIf(!ready)("code search pallet card e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let stationKey: string;
  let stationDeviceId: string;
  let shiftId: string;
  let shiftNumber: string;
  let operatorId: string;
  let productId: string;
  let palletSscc: string;
  /** Server ids, resolved from the box list once the fixture is built. */
  let palletId: string;
  let box1Id: string;
  let box2Id: string;
  let looseBoxId: string;

  const BOX1_ITEM_COUNT = 4;
  const BOX2_ITEM_COUNT = 3;
  const LOOSE_ITEM_COUNT = 2;

  const VALID_GTIN14 = "04006381333931";
  const ISSUER_PREFIX = "034600682";
  const ITEM_BASE = Date.parse("2026-09-11T07:00:00.000Z");
  const BOX_CLOSED_AT = "2026-09-11T07:30:00.000Z";
  const PALLET_CLOSED_AT = "2026-09-11T08:00:00.000Z";
  const BOX1_SSCC = "123460682000000201";
  const BOX2_SSCC = "123460682000000202";
  const LOOSE_SSCC = "123460682000000203";

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
      .send({ batchId: `code-search-pallet-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

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
    const station = await createTestStationDevice(app!, agent, "Pallet card line");
    stationKey = station.apiKey;
    stationDeviceId = station.deviceId;

    // The card resolves its line through the station device, so the device
    // has to actually be assigned to one for that join to be proven.
    const line = await agent.post("/lines").send({ name: "Линия паллет № 2" }).expect(201);
    await agent
      .patch(`/station-devices/${stationDeviceId}`)
      .send({ lineId: (line.body as { id: string }).id })
      .expect(200);

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

    const shift = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    shiftId = (shift.body as { id: string; number: string }).id;
    shiftNumber = (shift.body as { id: string; number: string }).number;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    const employee = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
    operatorId = (employee.body as { id: string }).id;

    const block = await app!
      .get(SsccService)
      .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 5);
    palletSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);

    await postBatch({
      items: Array.from({ length: BOX1_ITEM_COUNT }, (_, i) =>
        item(`c1-${i}`, "b1", new Date(ITEM_BASE + i * 1000).toISOString()),
      ),
    });
    await postBatch({
      items: Array.from({ length: BOX2_ITEM_COUNT }, (_, i) =>
        item(`c2-${i}`, "b2", new Date(ITEM_BASE + (100 + i) * 1000).toISOString()),
      ),
    });
    await postBatch({
      items: Array.from({ length: LOOSE_ITEM_COUNT }, (_, i) =>
        item(`c3-${i}`, "b3", new Date(ITEM_BASE + (200 + i) * 1000).toISOString()),
      ),
    });
    await postBatch({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: BOX1_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p1",
        },
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: BOX2_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p1",
        },
        // No `devicePalletId`: a closed box that never stood on a pallet.
        {
          boxId: "b3",
          shiftId,
          terminalId: "t1",
          sscc: LOOSE_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId,
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

    const boxes = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    const bySscc = new Map(
      (boxes.body.items as { id: string; sscc: string }[]).map((box) => [box.sscc, box.id]),
    );
    box1Id = bySscc.get(`00${BOX1_SSCC}`)!;
    box2Id = bySscc.get(`00${BOX2_SSCC}`)!;
    looseBoxId = bySscc.get(`00${LOOSE_SSCC}`)!;

    const pallets = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
    palletId = (pallets.body.items as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("links a box card to the pallet it stands on", async () => {
    const res = await agent.get(`/code-search/boxes/${box1Id}`).expect(200);
    expect(res.body.pallet).toEqual({ id: palletId, sscc: `00${palletSscc}` });
  });

  it("reports no pallet for a box that never stood on one", async () => {
    const res = await agent.get(`/code-search/boxes/${looseBoxId}`).expect(200);
    // Explicitly null, and explicitly PRESENT: a missing key would read as an
    // older server to a client that branches on the field.
    expect(res.body).toHaveProperty("pallet", null);
  });

  it("returns the pallet with its shift, line and member boxes", async () => {
    const res = await agent.get(`/code-search/pallets/${palletId}`).expect(200);
    expect(res.body).toMatchObject({
      id: palletId,
      sscc: `00${palletSscc}`,
      status: "closed",
      shiftId,
      shiftNumber,
      productName: "Cola",
      terminalId: stationDeviceId,
      lineName: "Линия паллет № 2",
      operatorId,
      closedAt: PALLET_CLOSED_AT,
      disassembledAt: null,
      exceptions: [],
    });

    const boxes = res.body.boxes as {
      id: string;
      sscc: string;
      itemCount: number;
      disassembledAt: string | null;
    }[];
    expect(boxes.map((box) => box.id).sort()).toEqual([box1Id, box2Id].sort());
    const byId = new Map(boxes.map((box) => [box.id, box]));
    expect(byId.get(box1Id)).toMatchObject({
      sscc: `00${BOX1_SSCC}`,
      itemCount: BOX1_ITEM_COUNT,
      disassembledAt: null,
    });
    expect(byId.get(box2Id)?.itemCount).toBe(BOX2_ITEM_COUNT);
    // The loose box is a member of nothing; it must not leak into this stack.
    expect(byId.has(looseBoxId)).toBe(false);
  });

  it("rejects a station api-key", async () => {
    await request(app!.getHttpServer())
      .get(`/code-search/pallets/${palletId}`)
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("404s for a pallet that belongs to another tenant", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    // The other tenant cannot see this pallet at all -- and the denial is a
    // plain 404, indistinguishable from an id that never existed.
    await other.get(`/code-search/pallets/${palletId}`).expect(404);
    // Nor can it reach the pallet through the box that stands on it.
    await other.get(`/code-search/boxes/${box1Id}`).expect(404);
  });

  it("404s for an unknown pallet id and 400s for a malformed one", async () => {
    await agent.get(`/code-search/pallets/${randomUUID()}`).expect(404);
    await agent.get("/code-search/pallets/not-a-uuid").expect(400);
  });

  describe("printed contents form", () => {
    it("renders the pallet with its member boxes", async () => {
      const res = await agent
        .get(`/code-search/pallets/${palletId}/report`)
        .query({ timeZone: "Europe/Moscow" })
        .expect(200)
        .expect("Content-Type", /text\/html/);
      expect(res.text).toContain("Состав паллеты");
      // Its own SSCC, and both member boxes underneath.
      expect(res.text).toContain("(00)");
      expect(res.text.match(/<tr class="rep-code-row">/g)?.length).toBe(2);
      // The sum across boxes, not one box's figure.
      expect(res.text).toContain("коробов — 2");
    });

    it("is denied to a station api-key and across tenants", async () => {
      await request(app!.getHttpServer())
        .get(`/code-search/pallets/${palletId}/report`)
        .set("x-api-key", stationKey)
        .expect(403);
      const other = request.agent(app!.getHttpServer());
      await signUpAndActivate(other);
      await other.get(`/code-search/pallets/${palletId}/report`).expect(404);
    });

    it("404s for an unknown pallet and 400s for a malformed id", async () => {
      await agent.get(`/code-search/pallets/${randomUUID()}/report`).expect(404);
      await agent.get("/code-search/pallets/not-a-uuid/report").expect(400);
    });
  });

  describe("printed placard", () => {
    it("renders the A4 placard by default and the A5 one on request", async () => {
      const a4 = await agent
        .get(`/code-search/pallets/${palletId}/placard`)
        .expect(200)
        .expect("Content-Type", /text\/html/);
      expect(a4.text).toContain("@page { size: A4;");
      expect(a4.text).toContain("ПАЛЛЕТА");
      expect(a4.text).toContain(`(00)${palletSscc}`);
      expect(a4.text).toContain("Cola");
      expect(a4.text).toContain(VALID_GTIN14);
      // Two live boxes, seven units, one production date.
      expect(a4.text).toMatch(/pl-figure-value">2</);
      expect(a4.text).toMatch(/pl-figure-value">7</);
      const a5 = await agent
        .get(`/code-search/pallets/${palletId}/placard`)
        .query({ format: "a5" })
        .expect(200);
      expect(a5.text).toContain("@page { size: A5;");
    });

    it("refuses an open pallet with PALLET_NOT_CLOSED", async () => {
      // A box that names a pallet the device never closed leaves an OPEN
      // pallet row behind -- the ingest creates it on first mention.
      await postBatch({
        items: [item("c4-0", "b4", new Date(ITEM_BASE + 300_000).toISOString())],
      });
      await postBatch({
        boxes: [
          {
            boxId: "b4",
            shiftId,
            terminalId: "t1",
            sscc: "123460682000000204",
            closedAt: BOX_CLOSED_AT,
            operatorId,
            devicePalletId: "p-open",
          },
        ],
      });
      const pallets = await agent.get(`/pallets?shiftId=${shiftId}`).expect(200);
      const open = (pallets.body.items as { id: string; closedAt: string | null }[]).find(
        (p) => p.closedAt === null,
      );
      expect(open).toBeDefined();
      const res = await agent.get(`/code-search/pallets/${open!.id}/placard`).expect(409);
      expect(res.body).toMatchObject({ code: "PALLET_NOT_CLOSED" });
    });

    it("validates the format, is denied to a station key and across tenants", async () => {
      await agent
        .get(`/code-search/pallets/${palletId}/placard`)
        .query({ format: "a3" })
        .expect(400);
      await request(app!.getHttpServer())
        .get(`/code-search/pallets/${palletId}/placard`)
        .set("x-api-key", stationKey)
        .expect(403);
      const other = request.agent(app!.getHttpServer());
      await signUpAndActivate(other);
      await other.get(`/code-search/pallets/${palletId}/placard`).expect(404);
      await agent.get(`/code-search/pallets/${randomUUID()}/placard`).expect(404);
    });
  });

  /**
   * A WAREHOUSE pallet has `shift_id IS NULL` and its own `product_id`, so the
   * report/placard product join must resolve it through
   * `coalesce(pallets.product_id, shifts.product_id)` rather than only a
   * shift join. Built independently of the shared fixture above (its own
   * pallet, no member boxes needed) so it does not disturb the ordered
   * mutation tests that follow.
   */
  describe("a warehouse pallet's product resolution", () => {
    let warehousePalletId: string;

    beforeAll(async () => {
      const block = await app!
        .get(SsccService)
        .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 1);
      const warehouseSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);

      await postBatch({
        pallets: [
          {
            palletId: "wp1",
            kind: "warehouse",
            shiftId: null,
            productId,
            terminalId: null,
            sscc: warehouseSscc,
            closedAt: "2026-09-11T09:00:00.000Z",
            operatorId,
            printVerifiedAt: null,
            printSkippedAt: null,
          },
        ],
      });

      const [pallet] = await db
        .select({ id: schema.pallets.id })
        .from(schema.pallets)
        .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, warehouseSscc)));
      if (!pallet) throw new Error("The warehouse pallet fixture was not persisted");
      warehousePalletId = pallet.id;
    });

    it("names the product on the contents report", async () => {
      const res = await agent
        .get(`/code-search/pallets/${warehousePalletId}/report`)
        .query({ timeZone: "Europe/Moscow" })
        .expect(200)
        .expect("Content-Type", /text\/html/);
      expect(res.text).toContain("Cola");
    });

    it("names the product and its GTIN on the placard", async () => {
      const res = await agent
        .get(`/code-search/pallets/${warehousePalletId}/placard`)
        .expect(200)
        .expect("Content-Type", /text\/html/);
      expect(res.text).toContain("Cola");
      expect(res.text).toContain(VALID_GTIN14);
    });
  });

  describe("printed placards of a whole shift", () => {
    it("prints one page per closed pallet of the shift, skipping the open one", async () => {
      const res = await agent
        .get(`/code-search/shifts/${shiftId}/placards`)
        .query({ format: "a5" })
        .expect(200)
        .expect("Content-Type", /text\/html/);
      expect(res.text).toContain("@page { size: A5;");
      expect(res.text).toContain(`Ярлыки паллет смены ${shiftNumber}`);
      // p1 is closed; p-open (see "refuses an open pallet") never closed and
      // the warehouse pallet belongs to no shift -- exactly one page.
      const pages = res.text.match(/data-placard-sscc="(\d{20})"/g) ?? [];
      expect(pages).toEqual([`data-placard-sscc="00${palletSscc}"`]);
      expect(res.text).toContain("Cola");
    });

    it("answers 409 for a shift with nothing to print, 404 across tenants and for an unknown shift", async () => {
      const bare = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
      const empty = await agent
        .get(`/code-search/shifts/${(bare.body as { id: string }).id}/placards`)
        .expect(409);
      expect(empty.body).toMatchObject({ code: "SHIFT_HAS_NO_PALLETS" });

      const other = request.agent(app!.getHttpServer());
      await signUpAndActivate(other);
      await other.get(`/code-search/shifts/${shiftId}/placards`).expect(404);
      await agent.get(`/code-search/shifts/${randomUUID()}/placards`).expect(404);
      await request(app!.getHttpServer())
        .get(`/code-search/shifts/${shiftId}/placards`)
        .set("x-api-key", stationKey)
        .expect(403);
    });
  });

  /** MUTATES the shared fixture -- from here on b2 is off the stack. */
  it("keeps a disassembled member box listed, flagged with its own timestamp", async () => {
    await postBatch({
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
          occurredAt: new Date().toISOString(),
        },
      ],
    });

    const res = await agent.get(`/code-search/pallets/${palletId}`).expect(200);
    const boxes = res.body.boxes as { id: string; disassembledAt: string | null }[];
    expect(boxes.map((box) => box.id).sort()).toEqual([box1Id, box2Id].sort());
    expect(boxes.find((box) => box.id === box2Id)?.disassembledAt).not.toBeNull();
    expect(boxes.find((box) => box.id === box1Id)?.disassembledAt).toBeNull();
    // The pallet itself is untouched: taking a box off a stack is not taking
    // the stack apart.
    expect(res.body.status).toBe("closed");
  });

  /** MUTATES the shared fixture -- from here on the pallet is retired. */
  it("reports the pallet's own disassembly as its status and an exception", async () => {
    await postBatch({
      boxes: [],
      palletExceptions: [
        {
          kind: "disassemble",
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          operatorId,
          reason: "паллета разобрана на складе",
          occurredAt: new Date().toISOString(),
        },
      ],
    });

    const res = await agent.get(`/code-search/pallets/${palletId}`).expect(200);
    expect(res.body.status).toBe("disassembled");
    expect(res.body.disassembledAt).not.toBeNull();
    expect(res.body.exceptions).toHaveLength(1);
    expect(res.body.exceptions[0]).toMatchObject({
      kind: "disassemble",
      reason: "паллета разобрана на складе",
      operatorId,
      disaggregationDocumentId: null,
      disaggregationDocNo: null,
    });
    // Its boxes stay on it: disassembly takes boxes off a stack, it does not
    // erase what stood there.
    expect((res.body.boxes as unknown[]).length).toBe(2);
  });
});
