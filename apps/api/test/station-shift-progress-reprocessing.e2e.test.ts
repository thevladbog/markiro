import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDuplicateLabelTemplate,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  PRODUCT_LABEL_PROTOCOL,
  validationPrintPolicySchema,
  type ProductLabelEvent,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { stationScansBodyParser } from "../src/modules/station-scans/body-parser";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 3 review finding: `GET /station/shifts/:id/progress` adds
 * `validation_code_reprocessings` rows to `code_registry` rows when the shift
 * allows previously accepted codes (see the service's SQL), but no e2e test
 * exercised that branch against a real database. Duplicate-DM reprocessing
 * needs `VALIDATION_DM_DUPLICATE_ENABLED` and the `stationScansBodyParser`
 * ahead of `express.json()` (see `validation-reprocessing.e2e.test.ts`), a
 * different app wiring than the plain `station-shift-progress.e2e.test.ts`
 * suite uses -- hence a separate file rather than bending that one.
 */
describe.skipIf(!ready)("GET /station/shifts/:id/progress with reprocessed units", () => {
  let app: INestApplication;
  let db: Db;
  let tenantId: string;
  let agent: ReturnType<typeof request.agent>;
  let station: Awaited<ReturnType<typeof createTestStationDevice>>;
  let otherStation: typeof station;
  let productId: string;
  let templateId: string;
  let operatorId: string;

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, VALIDATION_DM_DUPLICATE_ENABLED: "true" });
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(stationScansBodyParser);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    station = await createTestStationDevice(app, agent, "A");
    otherStation = await createTestStationDevice(app, agent, "B");
    productId = randomUUID();
    templateId = randomUUID();
    operatorId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600000000015",
      name: "Кега",
      status: "active",
    });
    await db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId,
      name: "Дубликат",
      purpose: "product_duplicate",
      spec: buildDuplicateLabelTemplate(),
    });
    await db.insert(schema.employees).values({ id: operatorId, tenantId, fullName: "Оператор" });
  });

  afterAll(async () => {
    await app?.close();
  });

  // Same fixture shape as validation-reprocessing.e2e.test.ts's `fixture`,
  // trimmed to the events this file's scenario needs.
  async function fixture(allowPreviouslyAcceptedCodes = false) {
    const created = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        validationPrint: {
          mode: "duplicate_dm",
          verification: "required",
          templateId,
          allowPreviouslyAcceptedCodes,
        },
      })
      .expect(201);
    const shiftId: string = created.body.id;
    const opened = await agent.post(`/shifts/${shiftId}/open`).expect(200);
    const policy = validationPrintPolicySchema.parse(opened.body.validationPrint);
    if (policy.mode !== "duplicate_dm") throw new Error("fixture policy missing");
    const raw = `]d2010460000000001521S${randomUUID().slice(0, 8)}\u001d91Key1\u001d92Crypto(93)^FNC1tail`;
    const km = parseDuplicateKm(raw);
    const acceptedAt = new Date().toISOString();
    const prepared: ProductLabelEvent = {
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      sequence: 1,
      shiftId,
      codeHash: kmHash(km),
      acceptedAt,
      policyRevision: policy.policyRevision,
      templateDigest: policy.snapshot.digest,
      payloadDigest: duplicatePayloadDigest(km.raw),
      operatorId,
      occurredAt: acceptedAt,
      kind: "prepared",
      attemptNo: 1,
      reason: null,
      language: "zpl",
      dpi: 203,
      bytesDigest: "a".repeat(64),
    };
    const item = {
      shiftId,
      terminalId: "untrusted-local-id",
      raw,
      verdict: "ok",
      scannedAt: acceptedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId: null,
      operatorId,
    };
    return { prepared, item, shiftId };
  }

  async function closedSource() {
    const source = await fixture();
    await send(batch([source.prepared], [source.item]));
    await agent.post(`/shifts/${source.shiftId}/close`).send({ reason: "completed" }).expect(200);
    return source;
  }

  function repeated(
    source: Awaited<ReturnType<typeof fixture>>,
    target: Awaited<ReturnType<typeof fixture>>,
    offset = 1000,
  ) {
    const scannedAt = new Date(Date.now() + offset).toISOString();
    return {
      item: { ...source.item, shiftId: target.shiftId, scannedAt },
      event: {
        ...target.prepared,
        codeHash: source.prepared.codeHash,
        payloadDigest: source.prepared.payloadDigest,
        acceptedAt: scannedAt,
      },
    };
  }

  function send(body: object, device = station, status = 201) {
    return request(app.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device.apiKey)
      .set("x-station-capabilities", `${PRODUCT_LABEL_PROTOCOL},validation-reprocessing-v1`)
      .send(body)
      .expect(status);
  }
  const batch = (events: ProductLabelEvent[], items: unknown[] = []) => ({
    batchId: `labels:${randomUUID()}`,
    items,
    productLabelEvents: events,
  });

  function progress(apiKey: string, shiftId: string) {
    return request(app.getHttpServer())
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", apiKey)
      .expect(200);
  }

  it("counts a reprocessed unit toward the target shift, attributed to the scanning device", async () => {
    const source = await closedSource();
    const target = await fixture(true);
    const r = repeated(source, target);

    const result = (await send(batch([r.event], [r.item]))).body;
    expect(result.validationOccurrences).toEqual([
      {
        shiftId: target.shiftId,
        codeHash: r.item.code.codeHash,
        scannedAt: r.item.scannedAt,
        outcome: "reprocessed",
      },
    ]);

    // `station` made the call that created the reprocessing row: it owns the
    // unit in `deviceAcceptedUnits`.
    const mine = await progress(station.apiKey, target.shiftId);
    expect(mine.body).toMatchObject({
      shiftId: target.shiftId,
      acceptedUnits: 1,
      deviceAcceptedUnits: 1,
    });

    // A second device on the same tenant sees the unit in the shift-wide
    // total but not attributed to itself.
    const theirs = await progress(otherStation.apiKey, target.shiftId);
    expect(theirs.body).toMatchObject({
      shiftId: target.shiftId,
      acceptedUnits: 1,
      deviceAcceptedUnits: 0,
    });
  });
});
