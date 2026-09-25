import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const VALID_GTIN14 = "04006381333931";
const codeHashFor = (label: string) => kmHash(canonicalizeKm(`01${VALID_GTIN14}21S-${label}`));

describe.skipIf(!ready)("GET /station/shifts/:id/progress", () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  function scan(
    shiftId: string,
    label: string,
    terminalId: string,
    scannedAt: string,
    boxId: string,
  ): ScanItemDto {
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

  function correction(
    kind: "undo" | "clear",
    shiftId: string,
    terminalId: string,
    codeHash: string | null,
    targetScannedAt: string | null,
  ) {
    return {
      kind,
      boxId: "b1",
      codeHash,
      targetScannedAt,
      shiftId,
      terminalId,
      operatorId: null,
      reason: null,
      occurredAt: new Date().toISOString(),
    };
  }

  async function post(apiKey: string, body: { items?: ScanItemDto[]; exceptions?: unknown[] }) {
    await http()
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `shift-progress-${randomUUID()}`, items: [], boxes: [], ...body })
      .expect(201);
  }

  async function openValidationShift(agent: ReturnType<typeof request.agent>): Promise<string> {
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
    const shift = await agent
      .post("/shifts")
      .send({ productId: (product.body as { id: string }).id, mode: "validation" })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);
    return shiftId;
  }

  /**
   * Setup pattern from `box-registry-pallets.e2e.test.ts`: an aggregation
   * shift needs a box label template and an org GLN (SSCC issuer) before it
   * can open at all.
   */
  async function openAggregationShift(
    agent: ReturnType<typeof request.agent>,
    tenantId: string,
  ): Promise<string> {
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
    const boxLabelTemplateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: boxLabelTemplateId,
      tenantId,
      name: "Progress aggregation template",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    const shift = await agent
      .post("/shifts")
      .send({
        productId: (product.body as { id: string }).id,
        mode: "aggregation",
        boxLabelTemplateId,
      })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.put("/org/profile").send({ gln: "0346006820014" }).expect(200);
    await agent.post(`/shifts/${shiftId}/open`).expect(200);
    return shiftId;
  }

  it("counts the whole shift and the caller's share, net of undone codes", async () => {
    const agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "Line 1");
    const handheld = await createTestStationDevice(app, agent, "ТСД 1", { kind: "handheld" });
    const shiftId = await openValidationShift(agent);

    await post(station.apiKey, {
      items: [
        scan(shiftId, "aa", station.deviceId, "2026-07-01T10:00:00.000Z", "b1"),
        scan(shiftId, "bb", station.deviceId, "2026-07-01T10:00:01.000Z", "b1"),
        scan(shiftId, "cc", station.deviceId, "2026-07-01T10:00:02.000Z", "b1"),
      ],
    });
    await post(handheld.apiKey, {
      items: [scan(shiftId, "dd", handheld.deviceId, "2026-07-01T10:00:03.000Z", "h1")],
    });
    await post(station.apiKey, {
      exceptions: [
        correction(
          "undo",
          shiftId,
          station.deviceId,
          codeHashFor("aa"),
          "2026-07-01T10:00:00.000Z",
        ),
      ],
    });

    const mine = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(mine.body).toEqual({
      shiftId,
      acceptedUnits: 3,
      deviceAcceptedUnits: 2,
      asOf: expect.any(String),
    });
    expect(Number.isNaN(Date.parse((mine.body as { asOf: string }).asOf))).toBe(false);

    const theirs = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", handheld.apiKey)
      .expect(200);
    expect(theirs.body).toMatchObject({ acceptedUnits: 3, deviceAcceptedUnits: 1 });
  });

  it("drops a cleared box from the total", async () => {
    const agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "Line 1");
    const shiftId = await openValidationShift(agent);
    await post(station.apiKey, {
      items: [
        scan(shiftId, "ee", station.deviceId, "2026-07-01T11:00:00.000Z", "b1"),
        scan(shiftId, "ff", station.deviceId, "2026-07-01T11:00:01.000Z", "b1"),
      ],
    });
    await post(station.apiKey, {
      exceptions: [correction("clear", shiftId, station.deviceId, null, null)],
    });
    const res = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(res.body).toMatchObject({ acceptedUnits: 0, deviceAcceptedUnits: 0 });
  });

  it("counts an aggregation shift's scans while their box is still open", async () => {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "Line 1");
    const shiftId = await openAggregationShift(agent, tenantId);

    // Only `items`, never a matching `boxes` closure: box "b1" stays open.
    await post(station.apiKey, {
      items: [
        scan(shiftId, "gg", station.deviceId, "2026-07-01T12:00:00.000Z", "b1"),
        scan(shiftId, "hh", station.deviceId, "2026-07-01T12:00:01.000Z", "b1"),
        scan(shiftId, "ii", station.deviceId, "2026-07-01T12:00:02.000Z", "b1"),
      ],
    });

    const res = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(res.body).toMatchObject({ acceptedUnits: 3, deviceAcceptedUnits: 3 });
  });

  it("hides foreign, unknown and malformed shifts and refuses other credential kinds", async () => {
    const owner = request.agent(app.getHttpServer());
    await signUpAndActivate(owner);
    const shiftId = await openValidationShift(owner);
    const stranger = request.agent(app.getHttpServer());
    await signUpAndActivate(stranger);
    const strangerDevice = await createTestStationDevice(app, stranger, "Other line");

    await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await http()
      .get(`/station/shifts/${randomUUID()}/progress`)
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await http()
      .get("/station/shifts/not-a-uuid/progress")
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await owner.get(`/station/shifts/${shiftId}/progress`).expect(403);
    await http().get(`/station/shifts/${shiftId}/progress`).expect(401);
  });
});
