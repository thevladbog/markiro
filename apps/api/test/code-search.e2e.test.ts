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
 * Task 7: the read-only `code-search` module -- classify a scanned/typed
 * input into a box or a code, and browse the tenant's code registry with
 * derived status. Fixture shape copied from disaggregation-lines.e2e.test.ts:
 * the only way to get a real, closed box (with a real SSCC) is through
 * `/station/scans` batches.
 */
describe.skipIf(!ready)("code-search e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let productId: string;

  // Same fixture value boxes.e2e.test.ts / disaggregation-lines.e2e.test.ts use.
  const SSCC1 = "123456789012345675";
  const VALID_GTIN14 = "04006381333931";

  function codeHashFor(label: string): string {
    return kmHash(canonicalizeKm(`01${VALID_GTIN14}21S-${label}`));
  }
  const KM1 = `01${VALID_GTIN14}21S-aa`;

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

    const station = await createTestStationDevice(app!, agent, "Line 1");
    stationKey = station.apiKey;

    productId = await createActiveProduct();
    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    const operatorId = (operatorRes.body as { id: string }).id;

    const shiftId = await openShiftForProduct(productId);
    await postBatch(stationKey, [
      scan(shiftId, "aa", "t1", "2026-07-01T10:00:00.000Z", "b1"),
      scan(shiftId, "bb", "t1", "2026-07-01T10:00:01.000Z", "b1"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: SSCC1,
          closedAt: "2026-01-01T00:00:00.000Z",
          operatorId,
        },
      ],
    );
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createActiveProduct(): Promise<string> {
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
    return (product.body as { id: string }).id;
  }

  async function openShiftForProduct(productId: string): Promise<string> {
    const shift = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  function scan(
    shift: string,
    codeLabel: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${codeLabel}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId: shift,
      terminalId,
      raw,
      verdict: "ok",
      scannedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  interface ClosureFixture {
    boxId: string;
    shiftId: string;
    terminalId: string | null;
    sscc: string;
    closedAt: string;
    operatorId: string | null;
  }

  async function postBatch(apiKey: string, items: ScanItemDto[], boxes: ClosureFixture[] = []) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `code-search-batch-${randomUUID()}`, items, boxes })
      .expect(201);
  }

  it("classifies and finds a box by SSCC and a code by KM", async () => {
    const byBox = await agent.get(`/code-search?q=(00)${SSCC1}`).expect(200);
    expect((byBox.body as { type: string }).type).toBe("box");
    const byCode = await agent.get(`/code-search?q=${encodeURIComponent(KM1)}`).expect(200);
    expect(byCode.body as object).toEqual({ type: "code", codeHash: codeHashFor("aa") });
  });

  it("404s with reason codes", async () => {
    expect(
      ((await agent.get(`/code-search?q=zzz`).expect(404)).body as { code: string }).code,
    ).toBe("unrecognized");
    const missing = `01${VALID_GTIN14}21S-nope`;
    expect(
      (
        (await agent.get(`/code-search?q=${encodeURIComponent(missing)}`).expect(404)).body as {
          code: string;
        }
      ).code,
    ).toBe("not_found");
  });

  it("lists the code registry with derived statuses and filters", async () => {
    const all = await agent.get(`/code-search/codes`).expect(200);
    const items = (all.body as { items: { codeHash: string; status: string }[] }).items;
    expect(items.find((i) => i.codeHash === codeHashFor("aa"))?.status).toBe("aggregated");
    const filtered = await agent.get(`/code-search/codes?status=free`).expect(200);
    expect(
      (filtered.body as { items: { codeHash: string }[] }).items.map((i) => i.codeHash),
    ).not.toContain(codeHashFor("aa"));
  });

  it("code card: derived status, current box, ordered history", async () => {
    const res = await agent.get(`/code-search/codes/${codeHashFor("aa")}`).expect(200);
    const card = res.body as {
      status: string;
      currentBox: { sscc: string } | null;
      history: { type: string }[];
    };
    expect(card.status).toBe("aggregated");
    expect(card.currentBox?.sscc).toContain(SSCC1);
    expect(card.history[0]!.type).toBe("scanned");
    expect(card.history.map((h) => h.type)).toContain("box_added");
  });

  it("surfaces the owner shift's effective production date and filters the registry by it", async () => {
    // A shift with BOTH dates: the explicit productionDate must win over
    // plannedDate (the same fallback shift exports apply).
    const shift = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        plannedDate: "2026-03-01",
        productionDate: "2026-03-05",
      })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);
    await postBatch(stationKey, [scan(shiftId, "pp", "t1", "2026-07-03T10:00:00.000Z", null)]);

    const filtered = await agent
      .get(`/code-search/codes?productionFrom=2026-03-05&productionTo=2026-03-05`)
      .expect(200);
    const items = (filtered.body as { items: { codeHash: string; productionDate: string }[] })
      .items;
    expect(items.map((i) => i.codeHash)).toEqual([codeHashFor("pp")]);
    expect(items[0]!.productionDate).toBe("2026-03-05");

    // The planned date alone must NOT match -- productionDate overrides it.
    const byPlanned = await agent
      .get(`/code-search/codes?productionFrom=2026-03-01&productionTo=2026-03-01`)
      .expect(200);
    expect((byPlanned.body as { items: unknown[] }).items).toEqual([]);

    const card = (await agent.get(`/code-search/codes/${codeHashFor("pp")}`).expect(200)).body as {
      productionDate: string | null;
    };
    expect(card.productionDate).toBe("2026-03-05");

    // The beforeAll fixture shift has neither date -> null.
    const dateless = (await agent.get(`/code-search/codes/${codeHashFor("aa")}`).expect(200))
      .body as { productionDate: string | null };
    expect(dateless.productionDate).toBeNull();
  });

  it("404s the code card for a malformed or unknown codeHash", async () => {
    await agent.get(`/code-search/codes/not-a-hash`).expect(404);
    await agent.get(`/code-search/codes/${"0".repeat(64)}`).expect(404);
  });

  it("code card history includes a scan whose raw carries a ]d2 AIM prefix and edge whitespace", async () => {
    // `scan_events.raw` is the ORIGINAL wire text; `codes.canonicalRaw` is
    // `canonicalizeKm`'s output (edge whitespace trimmed, leading `]d2`
    // AIM prefix stripped). A regression test for matching them by plain
    // equality: this scan's raw carries both, and its `scanned` event must
    // still surface in the code card's history.
    const label = "dd";
    const raw = ` ]d201${VALID_GTIN14}21S-${label} `;
    const km = canonicalizeKm(raw);
    const codeHash = kmHash(km);
    const shiftId = await openShiftForProduct(productId);
    await postBatch(stationKey, [
      {
        shiftId,
        terminalId: "t9",
        raw,
        verdict: "ok",
        scannedAt: "2026-07-02T09:00:00.000Z",
        code: { codeHash, gtin14: km.gtin14, serial: km.serial },
        boxId: null,
        operatorId: null,
      },
    ]);

    const res = await agent.get(`/code-search/codes/${codeHash}`).expect(200);
    const card = res.body as { history: { type: string }[] };
    expect(card.history[0]!.type).toBe("scanned");
  });

  it("box card: composition with dimmed removed rows + exceptions", async () => {
    const box = (await agent.get(`/code-search?q=${SSCC1}`).expect(200)).body as { boxId: string };
    const res = await agent.get(`/code-search/boxes/${box.boxId}`).expect(200);
    const card = res.body as { status: string; items: { codeHash: string }[] };
    expect(card.status).toBe("closed");
    expect(card.items).toHaveLength(2);
  });

  it("404s the box card for an unknown boxId", async () => {
    await agent.get(`/code-search/boxes/${randomUUID()}`).expect(404);
  });

  it("box report: print-ready HTML with the SSCC and a DataMatrix per code", async () => {
    const box = (await agent.get(`/code-search?q=${SSCC1}`).expect(200)).body as { boxId: string };
    const res = await agent
      .get(`/code-search/boxes/${box.boxId}/report`)
      .expect(200)
      .expect("Content-Type", /text\/html/);
    expect(res.text).toContain("Состав короба");
    expect(res.text).toContain(`(00)${SSCC1}`);
    expect(res.text.match(/class="dm-box"/g)).toHaveLength(2);
  });

  it("404s the box report for an unknown boxId", async () => {
    await agent.get(`/code-search/boxes/${randomUUID()}/report`).expect(404);
  });

  it("history shows disaggregation after a document applies", async () => {
    const reason = await agent.post("/disaggregation-reasons").send({ name: "Порча" }).expect(201);
    const reasonId = (reason.body as { id: string }).id;
    const doc = await agent.post("/disaggregation").send({}).expect(201);
    const docId = (doc.body as { id: string }).id;
    await agent.patch(`/disaggregation/${docId}`).send({ reasonId }).expect(200);
    await agent
      .post(`/disaggregation/${docId}/lines`)
      .send({ ssccs: [SSCC1] })
      .expect(201);
    await agent.post(`/disaggregation/${docId}/apply`).expect(200);

    const res = await agent.get(`/code-search/codes/${codeHashFor("aa")}`).expect(200);
    const card = res.body as {
      status: string;
      history: { type: string; disaggregationDocNo?: string }[];
    };
    expect(card.status).toBe("free");
    const dis = card.history.find((h) => h.type === "box_disassembled");
    expect(dis?.disaggregationDocNo).toMatch(/^DSG-/);
  });
});
