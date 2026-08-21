import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestEmployee, createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

interface DocumentDetailWire {
  id: string;
  status: string;
  appliedAt: string | null;
  lines: { id: string; sscc: string | null; status: string }[];
}

/**
 * Task 6: applying (проведение) a disaggregation document. The fixture
 * builds real, closed boxes via `/station/scans` batches -- same shape as
 * disaggregation-lines.e2e.test.ts -- plus a kiosk pickup order to lock a
 * box's SSCC for the "revalidate under the lock, all-or-nothing" scenario.
 */
describe.skipIf(!ready)("disaggregation apply e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let shiftId: string;
  let productId: string;
  let reasonId: string;
  let kioskToken: string;
  let pickupBadge: string;

  // Real, valid 18-digit SSCCs (same fixture family boxes.e2e.test.ts uses).
  const SSCC1 = "123456789012345675";
  const SSCC2 = "123456789012345682"; // distinct, valid check digit (kiosk order schema validates it)
  const VALID_GTIN14 = "04006381333931";

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
    const tenantId = await signUpAndActivate(agent);

    const station = await createTestStationDevice(app!, agent, "Line 1");
    stationKey = station.apiKey;

    productId = await createActiveProduct();
    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    const operatorId = (operatorRes.body as { id: string }).id;

    // Shift with two boxes, both closed, then the shift itself closed --
    // both boxes read as "ok" candidates once validated.
    shiftId = await openShiftForProduct(productId);
    await postBatch(stationKey, [
      scan(shiftId, "aa", "t1", "2026-07-01T10:00:00.000Z", "b1"),
      scan(shiftId, "bb", "t1", "2026-07-01T10:00:01.000Z", "b1"),
      scan(shiftId, "cc", "t1", "2026-07-01T10:00:02.000Z", "b2"),
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
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: SSCC2,
          closedAt: "2026-01-01T00:00:01.000Z",
          operatorId,
        },
      ],
    );
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);

    const reason = await agent.post("/disaggregation-reasons").send({ name: "Порча" }).expect(201);
    reasonId = (reason.body as { id: string }).id;

    // Kiosk fixture for the race test: a kiosk device + a badged employee
    // able to place box-level pickup orders (see kiosk-box-registry.e2e.test.ts
    // "accepts boxes atomically" for the same request shape).
    kioskToken = `kiosk-token-${randomUUID()}`;
    const kioskId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Kiosk A",
      deviceTokenHash: hashDeviceToken(kioskToken),
    });
    const employeeId = randomUUID();
    pickupBadge = `badge-${randomUUID()}`;
    await createTestEmployee(
      db,
      { id: employeeId, tenantId, fullName: "Kiosk Employee" },
      { limitMode: "unlimited", dayLimit: 20 },
    );
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: pickupBadge });
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
    const raw = `01${VALID_GTIN14}21S-apply-${codeLabel}`;
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
      .send({ batchId: `dsg-apply-batch-${randomUUID()}`, items, boxes })
      .expect(201);
  }

  async function createDraft(): Promise<{ id: string }> {
    const created = await agent.post("/disaggregation").send({}).expect(201);
    return created.body as { id: string };
  }

  async function createDraftWithReason(): Promise<{ id: string }> {
    const doc = await createDraft();
    await agent.patch(`/disaggregation/${doc.id}`).send({ reasonId }).expect(200);
    return doc;
  }

  async function createDraftWithLine(sscc: string): Promise<{ id: string }> {
    const doc = await createDraft();
    await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [sscc] })
      .expect(201);
    return doc;
  }

  async function draftWithReasonAndLine(sscc: string): Promise<{ id: string }> {
    const doc = await createDraftWithReason();
    await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [sscc] })
      .expect(201);
    return doc;
  }

  async function draftWithReasonAndLines(ssccs: string[]): Promise<{ id: string }> {
    const doc = await createDraftWithReason();
    await agent.post(`/disaggregation/${doc.id}/lines`).send({ ssccs }).expect(201);
    return doc;
  }

  async function lockBoxViaKioskOrder(sscc: string, deviceSeq: number): Promise<void> {
    await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", kioskToken)
      .send({
        deviceSeq,
        badgeCode: pickupBadge,
        reason: "buy",
        items: [],
        boxes: [{ sscc }],
      })
      .expect(201);
  }

  it("applies: boxes disassembled, items removed, exception + registry bump, doc applied", async () => {
    const doc = await draftWithReasonAndLine(SSCC1);
    const applied = await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);
    expect((applied.body as { status: string }).status).toBe("applied");
    expect((applied.body as { appliedAt: string }).appliedAt).toBeTruthy();

    // The box surfaces as disassembled on the existing per-shift endpoint.
    const boxes = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    const box = (
      boxes.body as {
        items: { sscc: string | null; itemCount: number; disassembledAt: string | null }[];
      }
    ).items.find((b) => b.sscc?.endsWith(SSCC1));
    expect(box?.disassembledAt).toBeTruthy();
    expect(box?.itemCount).toBe(0); // active items removed

    // Audit continuity: a disassemble exception exists for the shift.
    const exceptions = await agent.get(`/box-exceptions?shiftId=${shiftId}`).expect(200);
    const kinds = (exceptions.body as { items: { kind: string }[] }).items.map((e) => e.kind);
    expect(kinds).toContain("disassemble");
  });

  it("apply is all-or-nothing: a written_off line blocks and re-marks, the valid line's box stays untouched", async () => {
    // A fresh box for the still-valid line: SSCC1's box was already
    // disassembled by the previous test, so reusing it here would prove
    // nothing about a *valid* line's box staying untouched -- both lines
    // would already be invalid.
    const shift3 = await openShiftForProduct(productId);
    const validSscc = "123456789012345705";
    await postBatch(stationKey, [scan(shift3, "gg", "t3", "2026-07-01T12:00:00.000Z", "b6")]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b6",
          shiftId: shift3,
          terminalId: "t3",
          sscc: validSscc,
          closedAt: "2026-01-03T00:00:00.000Z",
          operatorId: null,
        },
      ],
    );
    await agent.post(`/shifts/${shift3}/close`).send({ reason: "done" }).expect(200);

    // Second box (SSCC2, still untouched so far): lock it via a kiosk
    // pickup order AFTER the draft validated it as ok, then attempt apply.
    const doc = await draftWithReasonAndLines([validSscc, SSCC2]);
    await lockBoxViaKioskOrder(SSCC2, 1);
    const res = await agent.post(`/disaggregation/${doc.id}/apply`).expect(409);
    const resBody = res.body as { code: string; lines: { sscc: string | null; status: string }[] };
    expect(resBody.code).toBe("invalid_lines");
    // The 409 payload itself carries the refreshed statuses, not just the
    // re-fetched document below.
    expect(resBody.lines.find((l) => l.sscc?.endsWith(SSCC2))?.status).toBe("written_off");
    expect(resBody.lines.find((l) => l.sscc?.endsWith(validSscc))?.status).toBe("ok");

    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    const body = detail.body as DocumentDetailWire;
    expect(body.status).toBe("draft"); // nothing applied
    expect(body.lines.find((l) => l.sscc?.endsWith(SSCC2))?.status).toBe("written_off");
    expect(body.lines.find((l) => l.sscc?.endsWith(validSscc))?.status).toBe("ok");

    // The valid line's own box must be completely untouched by the failed
    // apply: still not disassembled, its item still active.
    const boxes = await agent.get(`/boxes?shiftId=${shift3}`).expect(200);
    const validBox = (
      boxes.body as {
        items: { sscc: string | null; itemCount: number; disassembledAt: string | null }[];
      }
    ).items.find((b) => b.sscc?.endsWith(validSscc));
    expect(validBox?.disassembledAt).toBeNull();
    expect(validBox?.itemCount).toBe(1);
  });

  it("refuses apply without a reason / without lines / twice", async () => {
    const noReason = await createDraftWithLine(SSCC1);
    expect(
      (
        (await agent.post(`/disaggregation/${noReason.id}/apply`).expect(409)).body as {
          code: string;
        }
      ).code,
    ).toBe("reason_required");

    const empty = await createDraftWithReason();
    expect(
      ((await agent.post(`/disaggregation/${empty.id}/apply`).expect(409)).body as { code: string })
        .code,
    ).toBe("no_lines");

    // A fresh box for the apply-twice case: SSCC1's box was already
    // disassembled by the first test above, which would revalidate as
    // already_disassembled rather than exercising not_draft.
    const shift2 = await openShiftForProduct(productId);
    const sscc5 = "123456789012345699";
    await postBatch(stationKey, [scan(shift2, "ff", "t2", "2026-07-01T11:00:00.000Z", "b5")]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b5",
          shiftId: shift2,
          terminalId: "t2",
          sscc: sscc5,
          closedAt: "2026-01-02T00:00:00.000Z",
          operatorId: null,
        },
      ],
    );
    await agent.post(`/shifts/${shift2}/close`).send({ reason: "done" }).expect(200);
    const doc = await draftWithReasonAndLine(sscc5);
    await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);
    await agent.post(`/disaggregation/${doc.id}/apply`).expect(409); // not_draft
  });

  it("prints both report variants: boxes-only for a draft, boxes+contents after apply", async () => {
    // Fresh box with two codes so the full variant has real contents to show.
    const shift4 = await openShiftForProduct(productId);
    const reportSscc = "123456789012345712";
    await postBatch(stationKey, [
      scan(shift4, "rep1", "t4", "2026-07-01T13:00:00.000Z", "b7"),
      scan(shift4, "rep2", "t4", "2026-07-01T13:00:01.000Z", "b7"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b7",
          shiftId: shift4,
          terminalId: "t4",
          sscc: reportSscc,
          closedAt: "2026-01-04T00:00:00.000Z",
          operatorId: null,
        },
      ],
    );
    await agent.post(`/shifts/${shift4}/close`).send({ reason: "done" }).expect(200);

    const doc = await draftWithReasonAndLine(reportSscc);
    await agent.patch(`/disaggregation/${doc.id}`).send({ comment: "Мятый короб" }).expect(200);

    const draftReport = await agent
      .get(`/disaggregation/${doc.id}/report?variant=boxes`)
      .expect(200)
      .expect("Content-Type", /text\/html/);
    expect(draftReport.text).toContain("Акт дезагрегации");
    expect(draftReport.text).toContain(`(00)${reportSscc}`);
    expect(draftReport.text).toContain("Порча");
    expect(draftReport.text).toContain("Мятый короб");
    expect(draftReport.text).toContain("Черновик");
    expect(draftReport.text).not.toContain('class="dm-box"');

    await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);

    // The full variant still shows the box's contents AFTER the apply
    // released its items (removed_at = disassembled_at).
    const fullReport = await agent
      .get(`/disaggregation/${doc.id}/report?variant=full`)
      .expect(200)
      .expect("Content-Type", /text\/html/);
    expect(fullReport.text).toContain(`(00)${reportSscc}`);
    expect(fullReport.text).toContain("Проведён");
    expect(fullReport.text.match(/class="dm-box"/g)).toHaveLength(2);
    expect(fullReport.text).toContain("21 S-apply-rep1");
    expect(fullReport.text).toContain("21 S-apply-rep2");
    expect(fullReport.text).toContain("коробов — 1 · кодов — 2");
    expect(fullReport.text).not.toContain("₽");

    await agent.get(`/disaggregation/${doc.id}/report?variant=bogus`).expect(400);
  });
});
