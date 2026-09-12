import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  buildDuplicateLabelTemplate,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  PRODUCT_LABEL_PROTOCOL,
  validationPrintPolicySchema,
  type ProductLabelEvent,
  type ProductLabelReceipt,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { stationScansBodyParser } from "../src/modules/station-scans/body-parser";
import { ShiftExportSourceService } from "../src/modules/shift-exports/shift-export-source.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("validation reprocessing admission", () => {
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
    const base = {
      eventId: randomUUID(),
      jobId: prepared.jobId,
      attemptId: prepared.attemptId,
      sequence: 2,
      shiftId,
      codeHash: prepared.codeHash,
      acceptedAt,
      policyRevision: prepared.policyRevision,
      templateDigest: prepared.templateDigest,
      payloadDigest: prepared.payloadDigest,
      operatorId,
      occurredAt: acceptedAt,
    };
    const sending: ProductLabelEvent = { ...base, kind: "sending" };
    const sent: ProductLabelEvent = { ...base, eventId: randomUUID(), sequence: 3, kind: "sent" };
    const verified: ProductLabelEvent = {
      ...base,
      eventId: randomUUID(),
      sequence: 4,
      kind: "verified",
      scannedPayloadDigest: prepared.payloadDigest,
    };
    return { prepared, sending, sent, verified, item, shiftId };
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
  const receipt = (
    accepted: ProductLabelEvent[],
    rejected: ProductLabelReceipt["quarantined"] = [],
  ): ProductLabelReceipt => ({
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: accepted.map((e) => e.eventId),
    quarantined: rejected,
  });

  it("accepts a closed-source occurrence without transferring registry ownership and binds print evidence", async () => {
    const source = await fixture();
    await send(batch([source.prepared], [source.item]));
    await agent.post(`/shifts/${source.shiftId}/close`).send({ reason: "completed" }).expect(200);
    const target = await fixture(true);
    const scannedAt = new Date(Date.now() + 1000).toISOString();
    const item = { ...source.item, shiftId: target.shiftId, scannedAt };
    const event = {
      ...target.prepared,
      codeHash: source.prepared.codeHash,
      payloadDigest: source.prepared.payloadDigest,
      acceptedAt: scannedAt,
    };
    const body = batch([event], [item]);
    const result = (await send(body)).body;
    expect(result.conflicts).toEqual([]);
    expect(result.validationOccurrences).toEqual([
      { shiftId: target.shiftId, codeHash: item.code.codeHash, scannedAt, outcome: "reprocessed" },
    ]);
    expect(result.productLabelReceipt).toEqual(receipt([event]));
    expect((await send(body)).body).toMatchObject({
      alreadyApplied: true,
      validationOccurrences: result.validationOccurrences,
    });
    const [owner] = await db
      .select()
      .from(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, item.code.codeHash),
        ),
      );
    expect(owner?.shiftId).toBe(source.shiftId);
    const summary = await agent.get(`/shifts/${target.shiftId}/summary`).expect(200);
    expect(summary.body.output).toEqual({
      mode: "validation",
      acceptedUnits: 1,
      firstAcceptedUnits: 0,
      reprocessedUnits: 1,
    });
  });

  async function closedSource() {
    const source = await fixture();
    await send(batch([source.prepared], [source.item]));
    await agent.post(`/shifts/${source.shiftId}/close`).send({ reason: "completed" }).expect(200);
    return source;
  }
  async function enter(shiftId: string, device = station) {
    await request(app.getHttpServer())
      .post(`/shifts/${shiftId}/enter`)
      .set("x-api-key", device.apiKey)
      .set("x-station-capabilities", `${PRODUCT_LABEL_PROTOCOL},validation-reprocessing-v1`)
      .expect(200);
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
  it("refuses false and active sources, retaining registry and no accepted print job", async () => {
    const source = await fixture();
    await send(batch([], [source.item]));
    for (const allow of [false, true]) {
      const target = await fixture(allow);
      const r = repeated(source, target);
      const result = (await send(batch([r.event], [r.item]))).body;
      expect(result.validationOccurrences[0].outcome).toBe("conflict");
      expect(result.productLabelReceipt).toEqual(
        receipt([], [{ eventId: r.event.eventId, code: "ownership_conflict" }]),
      );
    }
    await agent.post(`/shifts/${source.shiftId}/close`).send({ reason: "completed" }).expect(200);
    const target = await fixture(false);
    const r = repeated(source, target);
    expect((await send(batch([], [r.item]))).body.validationOccurrences[0].outcome).toBe(
      "conflict",
    );
  });
  it("keeps one earliest occurrence across devices and lets an acknowledged loser learn its later displacement", async () => {
    const source = await closedSource();
    const target = await fixture(true);
    await enter(target.shiftId);
    await enter(target.shiftId, otherStation);
    const later = repeated(source, target, 2000);
    await send(batch([later.event], [later.item]));
    const earlier = repeated(source, target, 1000);
    const response = (await send(batch([], [earlier.item]), otherStation)).body;
    expect(response.validationOccurrences[0].outcome).toBe("reprocessed");
    const query = {
      occurrences: [
        {
          shiftId: target.shiftId,
          codeHash: later.item.code.codeHash,
          scannedAt: later.item.scannedAt,
        },
      ],
    };
    const status = await request(app.getHttpServer())
      .post("/station/validation-occurrences/status")
      .set("x-api-key", station.apiKey)
      .send(query)
      .expect(200);
    expect(status.body.occurrences[0].outcome).toBe("conflict");
    const history = await agent.get(`/shifts/${target.shiftId}/product-labels`).expect(200);
    expect(history.body.items[0].ownershipConflict).toBe(true);
    const conflicts = await db
      .select()
      .from(schema.codeConflicts)
      .where(
        and(
          eq(schema.codeConflicts.tenantId, tenantId),
          eq(schema.codeConflicts.losingShiftId, target.shiftId),
        ),
      );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      tenantId,
      codeHash: later.item.code.codeHash,
      losingTerminalId: station.deviceId,
      losingScannedAt: new Date(later.item.scannedAt),
      winningTerminalId: otherStation.deviceId,
      winningScannedAt: new Date(earlier.item.scannedAt),
    });
    const duplicate = repeated(source, target, 3000);
    expect((await send(batch([], [duplicate.item]))).body.validationOccurrences[0].outcome).toBe(
      "conflict",
    );
    const another = await fixture(true);
    const blocked = repeated(source, another, 4000);
    expect((await send(batch([], [blocked.item]))).body.validationOccurrences[0].outcome).toBe(
      "conflict",
    );
  });
  it.each([false, true])(
    "returns only the earliest same-batch occurrence with mixed timestamp precision (repeat=%s)",
    async (isRepeat) => {
      const source = isRepeat ? await closedSource() : await fixture();
      const target = isRepeat ? await fixture(true) : source;
      const second = new Date(Math.floor(Date.now() / 1000) * 1000 + 2000).toISOString();
      const earlier = {
        ...source.item,
        shiftId: target.shiftId,
        scannedAt: second.replace(".000Z", "Z"),
      };
      const later = { ...earlier, scannedAt: second.replace(".000Z", ".1Z") };
      const body = batch([], [later, earlier]);
      const response = (await send(body)).body;
      expect(response.validationOccurrences).toEqual([
        {
          shiftId: target.shiftId,
          codeHash: earlier.code.codeHash,
          scannedAt: earlier.scannedAt,
          outcome: isRepeat ? "reprocessed" : "first_accepted",
        },
        {
          shiftId: target.shiftId,
          codeHash: later.code.codeHash,
          scannedAt: later.scannedAt,
          outcome: "conflict",
        },
      ]);
      expect(response.conflicts).toEqual([
        {
          codeHash: earlier.code.codeHash,
          winningTerminalId: station.deviceId,
          winningScannedAt: second,
        },
      ]);
      expect((await send(body)).body).toMatchObject({
        alreadyApplied: true,
        validationOccurrences: response.validationOccurrences,
        conflicts: response.conflicts,
      });
      const conflicts = await db
        .select()
        .from(schema.codeConflicts)
        .where(
          and(
            eq(schema.codeConflicts.tenantId, tenantId),
            eq(schema.codeConflicts.codeHash, earlier.code.codeHash),
          ),
        );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        tenantId,
        codeHash: earlier.code.codeHash,
        losingShiftId: target.shiftId,
        losingTerminalId: station.deviceId,
        losingScannedAt: new Date(later.scannedAt),
        winningShiftId: target.shiftId,
        winningTerminalId: station.deviceId,
        winningScannedAt: new Date(earlier.scannedAt),
      });
      const table = isRepeat ? schema.validationCodeReprocessings : schema.codeRegistry;
      const accepted = await db
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.codeHash, earlier.code.codeHash)));
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        shiftId: target.shiftId,
        terminalId: station.deviceId,
        scannedAt: new Date(earlier.scannedAt),
      });
    },
  );

  it.each([false, true])(
    "blocks another active repeat after source release until it closes (allow=%s)",
    async (allow) => {
      const source = await closedSource();
      const active = await fixture(true);
      const held = repeated(source, active);
      await send(batch([], [held.item]));
      expect((await send(batch([], [source.item]))).body.validationOccurrences[0].outcome).toBe(
        "first_accepted",
      );
      const hash = source.item.code.codeHash;
      // Existing explicit release removes original ownership, never the separate repeat fact.
      await db
        .delete(schema.codeRegistry)
        .where(
          and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, hash)),
        );
      const target = await fixture(allow);
      const blocked = repeated(source, target, 3000);
      const response = (await send(batch([], [blocked.item]))).body;
      expect(response.validationOccurrences).toEqual([
        {
          shiftId: target.shiftId,
          codeHash: hash,
          scannedAt: blocked.item.scannedAt,
          outcome: "conflict",
        },
      ]);
      expect(response.conflicts).toEqual([
        {
          codeHash: hash,
          winningTerminalId: station.deviceId,
          winningScannedAt: held.item.scannedAt,
        },
      ]);
      const conflicts = await db
        .select()
        .from(schema.codeConflicts)
        .where(
          and(eq(schema.codeConflicts.tenantId, tenantId), eq(schema.codeConflicts.codeHash, hash)),
        );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        tenantId,
        codeHash: hash,
        losingShiftId: target.shiftId,
        losingTerminalId: station.deviceId,
        losingScannedAt: new Date(blocked.item.scannedAt),
        winningShiftId: active.shiftId,
        winningTerminalId: station.deviceId,
        winningScannedAt: new Date(held.item.scannedAt),
      });
      expect((await send(batch([], [held.item]))).body.validationOccurrences[0].outcome).toBe(
        "reprocessed",
      );
      expect(
        await db
          .select()
          .from(schema.codeRegistry)
          .where(
            and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, hash)),
          ),
      ).toEqual([]);
      const repeats = await db
        .select()
        .from(schema.validationCodeReprocessings)
        .where(
          and(
            eq(schema.validationCodeReprocessings.tenantId, tenantId),
            eq(schema.validationCodeReprocessings.codeHash, hash),
          ),
        );
      expect(repeats).toHaveLength(1);
      expect(repeats[0]).toMatchObject({
        shiftId: active.shiftId,
        sourceShiftId: source.shiftId,
        terminalId: station.deviceId,
        scannedAt: new Date(held.item.scannedAt),
      });
      await agent.post(`/shifts/${active.shiftId}/close`).send({ reason: "completed" }).expect(200);
      const admitted = repeated(source, target, 5000);
      expect((await send(batch([], [admitted.item]))).body.validationOccurrences[0].outcome).toBe(
        "first_accepted",
      );
      const owners = await db
        .select()
        .from(schema.codeRegistry)
        .where(
          and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, hash)),
        );
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatchObject({
        shiftId: target.shiftId,
        terminalId: station.deviceId,
        scannedAt: new Date(admitted.item.scannedAt),
      });
    },
  );

  it("returns and persists the final blocker when its occurrence is corrected later in the same batch", async () => {
    const source = await closedSource();
    const active = await fixture(true);
    const later = repeated(source, active, 5000);
    await send(batch([], [later.item]));
    const target = await fixture(true);
    const blocked = repeated(source, target, 1000);
    const earlier = repeated(source, active, 2000);
    const response = (await send(batch([], [blocked.item, earlier.item]), otherStation)).body;
    expect(response.validationOccurrences).toEqual([
      {
        shiftId: target.shiftId,
        codeHash: blocked.item.code.codeHash,
        scannedAt: blocked.item.scannedAt,
        outcome: "conflict",
      },
      {
        shiftId: active.shiftId,
        codeHash: earlier.item.code.codeHash,
        scannedAt: earlier.item.scannedAt,
        outcome: "reprocessed",
      },
    ]);
    expect(response.conflicts).toEqual([
      {
        codeHash: blocked.item.code.codeHash,
        winningTerminalId: otherStation.deviceId,
        winningScannedAt: earlier.item.scannedAt,
      },
    ]);
    const conflicts = await db
      .select()
      .from(schema.codeConflicts)
      .where(
        and(
          eq(schema.codeConflicts.tenantId, tenantId),
          eq(schema.codeConflicts.codeHash, blocked.item.code.codeHash),
        ),
      );
    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts)
      expect(conflict).toMatchObject({
        tenantId,
        codeHash: blocked.item.code.codeHash,
        winningShiftId: active.shiftId,
        winningTerminalId: otherStation.deviceId,
        winningScannedAt: new Date(earlier.item.scannedAt),
      });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          losingShiftId: target.shiftId,
          losingTerminalId: otherStation.deviceId,
          losingScannedAt: new Date(blocked.item.scannedAt),
        }),
        expect.objectContaining({
          losingShiftId: active.shiftId,
          losingTerminalId: station.deviceId,
          losingScannedAt: new Date(later.item.scannedAt),
        }),
      ]),
    );
  });

  it("distinguishes historical correction from effective ownership after a stale closed-source history", async () => {
    const old = await closedSource();
    const target = await fixture(true);
    await enter(target.shiftId, otherStation);
    const cached = await request(app.getHttpServer())
      .get(`/shifts/${target.shiftId}/code-history`)
      .set("x-api-key", otherStation.apiKey)
      .expect(200);
    expect(cached.body.items).toContainEqual(
      expect.objectContaining({
        codeHash: old.item.code.codeHash,
        shiftId: old.shiftId,
        kind: "original",
        shiftStatus: "closed",
      }),
    );
    const ownerWhere = and(
      eq(schema.codeRegistry.tenantId, tenantId),
      eq(schema.codeRegistry.codeHash, old.item.code.codeHash),
    );
    await db.delete(schema.codeRegistry).where(ownerWhere);
    const later = repeated(old, target, 10000);
    expect((await send(batch([], [later.item]))).body.validationOccurrences[0]).not.toHaveProperty(
      "ownership",
    );
    await db.delete(schema.codeRegistry).where(ownerWhere);
    const earlier = repeated(old, target, 9000);
    const result = (await send(batch([earlier.event], [earlier.item]), otherStation)).body;
    expect(result.validationOccurrences).toEqual([
      {
        shiftId: target.shiftId,
        codeHash: old.item.code.codeHash,
        scannedAt: earlier.item.scannedAt,
        outcome: "first_accepted",
        ownership: "released",
      },
    ]);
    expect(result.productLabelReceipt.acceptedEventIds).toEqual([]);
    expect(await db.select().from(schema.codeRegistry).where(ownerWhere)).toEqual([]);
    const status = await request(app.getHttpServer())
      .post("/station/validation-occurrences/status")
      .set("x-api-key", otherStation.apiKey)
      .send({
        occurrences: [
          {
            shiftId: target.shiftId,
            codeHash: old.item.code.codeHash,
            scannedAt: earlier.item.scannedAt,
          },
        ],
      })
      .expect(200);
    expect(status.body.occurrences).toEqual(result.validationOccurrences);
    const summary = await agent.get(`/shifts/${target.shiftId}/summary`).expect(200);
    expect(summary.body.output.acceptedUnits).toBe(0);
  });

  it("retained ordinary identity does not hide displacement by an earlier no-print owner", async () => {
    const source = await fixture();
    await send(batch([], [source.item]));
    await enter(source.shiftId);
    const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const otherId: string = created.body.id;
    await agent.post(`/shifts/${otherId}/open`).expect(200);
    const earlierAt = new Date(Date.parse(source.item.scannedAt) - 1000).toISOString();
    await send(
      batch([], [{ ...source.item, shiftId: otherId, scannedAt: earlierAt }]),
      otherStation,
    );
    const query = {
      occurrences: [
        {
          shiftId: source.shiftId,
          codeHash: source.item.code.codeHash,
          scannedAt: source.item.scannedAt,
        },
      ],
    };
    const status = await request(app.getHttpServer())
      .post("/station/validation-occurrences/status")
      .set("x-api-key", station.apiKey)
      .send(query)
      .expect(200);
    expect(status.body.occurrences[0].outcome).toBe("conflict");
    expect((await send(batch([], [source.item]))).body.validationOccurrences[0].outcome).toBe(
      "conflict",
    );
    const owner = await db
      .select()
      .from(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, source.item.code.codeHash),
        ),
      );
    expect(owner[0]).toMatchObject({ shiftId: otherId, scannedAt: new Date(earlierAt) });
  });

  it("backfills only authoritative duplicate-print owners and enforces tenant shift keys", async () => {
    const current = await fixture();
    await send(batch([], [current.item]));
    const plain = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const plainShiftId: string = plain.body.id;
    await agent.post(`/shifts/${plainShiftId}/open`).expect(200);
    const plainRaw = current.item.raw.replace("21S", "21N");
    const plainKm = parseDuplicateKm(plainRaw);
    await send(
      batch(
        [],
        [
          {
            ...current.item,
            shiftId: plainShiftId,
            raw: plainRaw,
            code: { codeHash: kmHash(plainKm), gtin14: plainKm.gtin14, serial: plainKm.serial },
          },
        ],
      ),
    );
    const table = schema.validationCodeAcceptances;
    await db
      .delete(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.shiftId, current.shiftId)));
    const migration = await readFile(
      resolve(__dirname, "../../../packages/db/migrations/0143_validation_acceptance.sql"),
      "utf8",
    );
    const backfill = migration.slice(migration.indexOf("-- Only the effective registry"));
    await db.execute(sql.raw(backfill));
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.shiftId, current.shiftId)));
    expect(rows).toEqual([
      {
        tenantId,
        shiftId: current.shiftId,
        codeHash: current.item.code.codeHash,
        terminalId: station.deviceId,
        scannedAt: new Date(current.item.scannedAt),
      },
    ]);
    const foreignAgent = request.agent(app.getHttpServer());
    const foreignTenant = await signUpAndActivate(foreignAgent);
    expect(
      await db
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.shiftId, plainShiftId))),
    ).toEqual([]);
    const retained = rows[0];
    if (!retained) throw new Error("Missing backfilled identity");
    await expect(
      db.insert(table).values({ ...retained, tenantId: foreignTenant }),
    ).rejects.toThrow();
    await db
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, current.item.code.codeHash),
        ),
      );
    await db.execute(sql.raw(backfill));
    expect(
      await db
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.shiftId, current.shiftId))),
    ).toEqual(rows);
  });

  it.each([false, true])(
    "retains same-shift acceptance after explicit release (allow=%s)",
    async (allow) => {
      const source = await fixture(allow);
      const body = batch([source.prepared], [source.item]);
      await send(body);
      await enter(source.shiftId);
      const hash = source.item.code.codeHash;
      const ownerWhere = and(
        eq(schema.codeRegistry.tenantId, tenantId),
        eq(schema.codeRegistry.codeHash, hash),
      );
      // The release channel removes the exact effective registry owner, retaining historical evidence.
      await db.delete(schema.codeRegistry).where(ownerWhere);
      const laterAt = new Date(Date.parse(source.item.scannedAt) + 1000).toISOString();
      const laterEvent = {
        ...source.prepared,
        eventId: randomUUID(),
        jobId: randomUUID(),
        attemptId: randomUUID(),
        acceptedAt: laterAt,
      };
      const later = await send(
        batch([laterEvent], [{ ...source.item, scannedAt: laterAt }]),
        otherStation,
      );
      expect(later.body.validationOccurrences).toEqual([
        { shiftId: source.shiftId, codeHash: hash, scannedAt: laterAt, outcome: "conflict" },
      ]);
      expect(later.body.productLabelReceipt.acceptedEventIds).toEqual([]);
      expect(await db.select().from(schema.codeRegistry).where(ownerWhere)).toEqual([]);
      expect((await send(body)).body.alreadyApplied).toBe(true);
      expect((await send(batch([], [source.item]))).body.validationOccurrences[0].outcome).toBe(
        "first_accepted",
      );
      expect(await db.select().from(schema.codeRegistry).where(ownerWhere)).toEqual([]);
      const history = await request(app.getHttpServer())
        .get(`/shifts/${source.shiftId}/code-history`)
        .set("x-api-key", station.apiKey)
        .expect(200);
      expect(history.body.items).toContainEqual(
        expect.objectContaining({
          codeHash: hash,
          kind: "original",
          shiftId: source.shiftId,
          scannedAt: source.item.scannedAt,
        }),
      );
      const earlierAt = new Date(Date.parse(source.item.scannedAt) - 1000).toISOString();
      expect(
        (await send(batch([], [{ ...source.item, scannedAt: earlierAt }]), otherStation)).body
          .validationOccurrences[0].outcome,
      ).toBe("first_accepted");
      expect(await db.select().from(schema.codeRegistry).where(ownerWhere)).toEqual([]);
      const status = await request(app.getHttpServer())
        .post("/station/validation-occurrences/status")
        .set("x-api-key", station.apiKey)
        .send({
          occurrences: [
            { shiftId: source.shiftId, codeHash: hash, scannedAt: source.item.scannedAt },
          ],
        })
        .expect(200);
      expect(status.body.occurrences[0].outcome).toBe("conflict");
      const target = await fixture(allow);
      expect(
        (await send(batch([], [{ ...source.item, shiftId: target.shiftId, scannedAt: laterAt }])))
          .body.validationOccurrences[0].outcome,
      ).toBe("first_accepted");
      const reassignedHistory = await request(app.getHttpServer())
        .get(`/shifts/${source.shiftId}/code-history`)
        .set("x-api-key", station.apiKey)
        .expect(200);
      expect(reassignedHistory.body.items).toContainEqual(
        expect.objectContaining({
          codeHash: hash,
          kind: "original",
          shiftId: source.shiftId,
          scannedAt: earlierAt,
        }),
      );
      expect(reassignedHistory.body.items).toContainEqual(
        expect.objectContaining({ codeHash: hash, kind: "original", shiftId: target.shiftId }),
      );
      const jobs = await db
        .select()
        .from(schema.productLabelJobs)
        .where(
          and(
            eq(schema.productLabelJobs.tenantId, tenantId),
            eq(schema.productLabelJobs.codeHash, hash),
          ),
        );
      expect(jobs).toHaveLength(1);
    },
  );

  it("pages an immutable product history despite new writes and refuses other devices/tenants", async () => {
    const source = await closedSource();
    const target = await fixture(true);
    await enter(target.shiftId);
    const r = repeated(source, target);
    await send(batch([], [r.item]));
    const get = (query = "", device = station) =>
      request(app.getHttpServer())
        .get(`/shifts/${target.shiftId}/code-history${query}`)
        .set("x-api-key", device.apiKey);
    await get("", otherStation).expect(404);
    const first = (await get("?limit=1").expect(200)).body;
    expect(first.complete).toBe(false);
    const frozen = await db
      .select()
      .from(schema.validationHistorySnapshotEntries)
      .where(
        and(
          eq(schema.validationHistorySnapshotEntries.tenantId, tenantId),
          eq(schema.validationHistorySnapshotEntries.snapshotId, first.snapshot),
        ),
      )
      .orderBy(schema.validationHistorySnapshotEntries.cursor);
    const expected = frozen.map((row) => ({
      codeHash: row.codeHash,
      kind: row.kind,
      shiftId: row.shiftId,
      shiftNumber: row.shiftNumber,
      shiftStatus: row.shiftStatus,
      scannedAt: row.scannedAt.toISOString(),
    }));
    // Change all three dimensions after publishing page one: insert, delete and source status.
    const added = await fixture();
    await send(batch([], [added.item]));
    await db
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, source.item.code.codeHash),
        ),
      );
    await agent.post(`/shifts/${target.shiftId}/close`).send({ reason: "completed" }).expect(200);
    const items = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = (
        await get(
          `?limit=1&snapshot=${first.snapshot}&cursor=${encodeURIComponent(cursor)}`,
        ).expect(200)
      ).body;
      expect(page.snapshot).toBe(first.snapshot);
      expect(page.fetchedAt).toBe(first.fetchedAt);
      expect(page.expiresAt).toBe(first.expiresAt);
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(items).toEqual(expected);
    const fresh = (await get("?limit=1000").expect(200)).body;
    expect(fresh.items).toContainEqual(
      expect.objectContaining({ codeHash: added.item.code.codeHash, kind: "original" }),
    );
    expect(fresh.items).not.toContainEqual(
      expect.objectContaining({ codeHash: source.item.code.codeHash, kind: "original" }),
    );
    expect(fresh.items).toContainEqual(
      expect.objectContaining({
        codeHash: r.item.code.codeHash,
        kind: "reprocessing",
        shiftStatus: "closed",
      }),
    );
    expect(
      items
        .filter((item: { codeHash: string }) => item.codeHash === r.item.code.codeHash)
        .map((item: { kind: string }) => item.kind)
        .sort(),
    ).toEqual(["original", "reprocessing"]);
    const stable = await get(
      `?limit=1&snapshot=${first.snapshot}&cursor=${encodeURIComponent(first.nextCursor)}`,
    ).expect(200);
    expect(stable.body.fetchedAt).toBe(first.fetchedAt);
    await db
      .update(schema.validationHistorySnapshots)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(schema.validationHistorySnapshots.tenantId, tenantId),
          eq(schema.validationHistorySnapshots.snapshotId, first.snapshot),
        ),
      );
    await get(
      `?limit=1&snapshot=${first.snapshot}&cursor=${encodeURIComponent(first.nextCursor)}`,
    ).expect(409);
    const otherAgent = request.agent(app.getHttpServer());
    await signUpAndActivate(otherAgent);
    const foreign = await createTestStationDevice(app, otherAgent, "Foreign");
    await get("", foreign).expect(404);
    await otherAgent.get(`/shifts/${target.shiftId}/reprocessings`).expect(404);
    await send(batch([], [r.item]), foreign, 400);
  });
  it("exports first and repeated raw codes once, preserves prior source bytes and adds no aggregation", async () => {
    const source = await closedSource();
    await db
      .update(schema.shifts)
      .set({ productionDate: "2026-09-12" })
      .where(eq(schema.shifts.id, source.shiftId));
    const exports = new ShiftExportSourceService(db);
    const before = await exports.load(tenantId, source.shiftId, {
      boxMode: "flat",
      extension: "txt",
    });
    const target = await fixture(true);
    const r = repeated(source, target);
    await send(batch([], [r.item, target.item]));
    await agent.post(`/shifts/${target.shiftId}/close`).send({ reason: "completed" }).expect(200);
    await db
      .update(schema.shifts)
      .set({ productionDate: "2026-09-12" })
      .where(eq(schema.shifts.id, target.shiftId));
    const flat = await exports.load(tenantId, target.shiftId, {
      boxMode: "flat",
      extension: "txt",
    });
    expect(flat.source).toEqual({
      mode: "flat",
      codes: [parseDuplicateKm(target.item.raw).raw, parseDuplicateKm(source.item.raw).raw],
    });
    expect(
      (await exports.load(tenantId, source.shiftId, { boxMode: "flat", extension: "txt" })).source,
    ).toEqual(before.source);
    const detail = await agent.get(`/shifts/${target.shiftId}/reprocessings`).expect(200);
    expect(detail.body.items[0]).toMatchObject({
      canonicalRaw: parseDuplicateKm(source.item.raw).raw,
      sourceShift: { id: source.shiftId },
      occurrence: {
        shiftId: target.shiftId,
        deviceId: station.deviceId,
        operatorId,
        scannedAt: r.item.scannedAt,
      },
    });
    const summary = await agent.get(`/shifts/${target.shiftId}/summary`).expect(200);
    expect(summary.body.output).toEqual({
      mode: "validation",
      acceptedUnits: 2,
      firstAcceptedUnits: 1,
      reprocessedUnits: 1,
    });
    expect(
      await db
        .select()
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.shiftId, target.shiftId))),
    ).toEqual([]);
  });
  it("projects legacy false policies and rejects old capabilities before enabled work", async () => {
    const legacy = await fixture(false);
    for (const route of [
      `/shifts/${legacy.shiftId}/bundle`,
      `/shifts/${legacy.shiftId}/reference-bundle`,
    ]) {
      const result = await request(app.getHttpServer())
        .get(route)
        .set("x-api-key", station.apiKey)
        .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
        .expect(200);
      expect(result.body.shift.validationPrint).not.toHaveProperty("allowPreviouslyAcceptedCodes");
    }
    const enabled = await fixture(true);
    await request(app.getHttpServer())
      .post(`/shifts/${enabled.shiftId}/enter`)
      .set("x-api-key", station.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .expect(409);
    await agent
      .patch(`/shifts/${enabled.shiftId}`)
      .send({
        validationPrint: {
          mode: "duplicate_dm",
          verification: "required",
          templateId,
          allowPreviouslyAcceptedCodes: false,
        },
      })
      .expect(409);
  });
  it("serializes simultaneous device batches and preserves multiple closed processing shifts in a drain", async () => {
    const source = await closedSource();
    const target = await fixture(true);
    const early = repeated(source, target, 1000);
    const late = repeated(source, target, 2000);
    await Promise.all([send(batch([], [late.item])), send(batch([], [early.item]), otherStation)]);
    const rows = await db
      .select()
      .from(schema.validationCodeReprocessings)
      .where(
        and(
          eq(schema.validationCodeReprocessings.tenantId, tenantId),
          eq(schema.validationCodeReprocessings.shiftId, target.shiftId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceShiftId: source.shiftId,
      terminalId: otherStation.deviceId,
      scannedAt: new Date(early.item.scannedAt),
    });
    await agent.post(`/shifts/${target.shiftId}/close`).send({ reason: "completed" }).expect(200);
    const next = await fixture(true);
    const nextScan = repeated(source, next, 3000);
    const result = (await send(batch([], [early.item, nextScan.item]), otherStation)).body;
    expect(result.validationOccurrences.map((entry: { outcome: string }) => entry.outcome)).toEqual(
      ["reprocessed", "reprocessed"],
    );
    await db
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, source.item.code.codeHash),
        ),
      );
    expect(
      (await send(batch([], [early.item]), otherStation)).body.validationOccurrences[0].outcome,
    ).toBe("reprocessed");
    expect(
      await db
        .select()
        .from(schema.codeRegistry)
        .where(
          and(
            eq(schema.codeRegistry.tenantId, tenantId),
            eq(schema.codeRegistry.codeHash, source.item.code.codeHash),
          ),
        ),
    ).toEqual([]);
  });

  it("binds repeat print evidence to its own raw occurrence even when the source timestamp collides", async () => {
    const source = await closedSource();
    const target = await fixture(true);
    const item = { ...source.item, shiftId: target.shiftId };
    const event = {
      ...target.prepared,
      codeHash: source.prepared.codeHash,
      payloadDigest: source.prepared.payloadDigest,
      acceptedAt: item.scannedAt,
    };
    const result = (await send(batch([event], [item]))).body;
    expect(result.productLabelReceipt).toEqual(receipt([event]));
    const invalid = {
      ...event,
      eventId: randomUUID(),
      jobId: randomUUID(),
      payloadDigest: "f".repeat(64),
    };
    expect((await send(batch([invalid]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: invalid.eventId, code: "policy_mismatch" }]),
    );
    const next = {
      ...target.sending,
      codeHash: event.codeHash,
      payloadDigest: event.payloadDigest,
      acceptedAt: event.acceptedAt,
    };
    expect((await send(batch([next]))).body.productLabelReceipt).toEqual(receipt([next]));
  });
});
