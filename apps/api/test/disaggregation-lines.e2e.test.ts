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

interface LineDtoWire {
  id: string;
  ssccInput: string;
  sscc: string | null;
  boxId: string | null;
  status: string;
  productId: string | null;
  productName: string | null;
  codeCount: number;
  validatedAt: string;
}

/**
 * Task 4: add/remove disaggregation lines, and their per-line validation
 * status. The only way to get a real, closed box (with a real SSCC) is
 * through `/station/scans` batches -- exactly like boxes.e2e.test.ts and
 * station-scans.e2e.test.ts build their fixtures -- so this file reuses the
 * same helper shapes.
 */
describe.skipIf(!ready)("disaggregation lines e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let shiftId: string;

  // Same fixture value boxes.e2e.test.ts uses -- a real, valid 18-digit SSCC.
  const SSCC1 = "123456789012345675";
  const VALID_GTIN14 = "04006381333931";

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

    const productId = await createActiveProduct();
    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    const operatorId = (operatorRes.body as { id: string }).id;

    // shift opened, 2 codes scanned into device box "b1", closure posted
    // with a valid SSCC, shift still OPEN (closed only in the second test).
    shiftId = await openShiftForProduct(productId);
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
      .send({ batchId: `dsg-lines-batch-${randomUUID()}`, items, boxes })
      .expect(201);
  }

  async function createDraft(): Promise<{ id: string }> {
    const created = await agent.post("/disaggregation").send({}).expect(201);
    return created.body as { id: string };
  }

  it("adds SSCCs with per-line validation statuses", async () => {
    const doc = await createDraft();
    const res = await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [`(00)${SSCC1}`, "not-an-sscc", `(00)${SSCC1}`] })
      .expect(201);
    const lines = (res.body as { lines: LineDtoWire[] }).lines;
    expect(lines).toHaveLength(3);
    // Response order isn't insertion order (see `listLinesTx`'s
    // `(createdAt, id)` orderBy -- all three lines land in the same
    // millisecond via one bulk INSERT, so ties break on the lines' random
    // ids, not on array position), so match by content instead of index.
    const notFoundLine = lines.find((line) => line.status === "not_found");
    expect(notFoundLine?.ssccInput).toBe("not-an-sscc"); // unparseable input preserved
    const ssccLines = lines.filter((line) => line.ssccInput === `(00)${SSCC1}`);
    expect(ssccLines).toHaveLength(2);
    expect(ssccLines.map((line) => line.status).sort()).toEqual(["duplicate", "shift_open"]); // box closed, but shift not
  });

  it("flips shift_open → ok once the shift closes", async () => {
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);
    const doc = await createDraft();
    const res = await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [SSCC1] })
      .expect(201);
    expect((res.body as { lines: LineDtoWire[] }).lines[0]!.status).toBe("ok");
    expect((res.body as { lines: LineDtoWire[] }).lines[0]!.codeCount).toBe(2);
  });

  it("removes a line; refuses line mutations on non-drafts", async () => {
    const doc = await createDraft();
    const added = await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [SSCC1] })
      .expect(201);
    const lineId = (added.body as { lines: { id: string }[] }).lines[0]!.id;
    await agent.delete(`/disaggregation/${doc.id}/lines/${lineId}`).expect(204);
    await agent.post(`/disaggregation/${doc.id}/cancel`).expect(200);
    await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [SSCC1] })
      .expect(409);
  });

  it("imports a text file of SSCCs", async () => {
    const doc = await createDraft();
    const res = await agent
      .post(`/disaggregation/${doc.id}/import`)
      .attach("file", Buffer.from(`${SSCC1}\ngarbage;${SSCC1}`), "codes.txt")
      .expect(201);
    const lines = (res.body as { lines: LineDtoWire[] }).lines;
    expect(lines.map((l) => l.status).sort()).toEqual(["duplicate", "not_found", "ok"].sort());
    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    expect((detail.body as { source: string }).source).toBe("import");
  });
});
