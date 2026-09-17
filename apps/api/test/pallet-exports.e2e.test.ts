import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { PgBossService } from "../src/jobs/jobs.module";
import { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { settleQueuedBackgroundWork } from "./support/background-work";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 9: a per-pallet GIS MT aggregation export. One pallet -- production or
 * warehouse -- rendered as ONE `pack_content` naming its box SSCCs and no
 * `<cis>` at all, through the same durable job the shift exports use.
 *
 * Every fixture is a real `pallets`/`boxes` row built through `/station/scans`,
 * and `ShiftExportRunnerService.run` is invoked directly (pg-boss and object
 * storage are stubbed exactly as `shift-exports-pallets.e2e.test.ts` stubs
 * them), so these assertions cover the actual rendered bytes and the actual
 * terminal row and audit state.
 */
describe.skipIf(!ready)("pallet exports e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let userId: string;
  let productionPalletId: string;
  let warehousePalletId: string;
  let openPalletId: string;
  let disassembledPalletId: string;
  let productionPalletSscc: string;
  let warehousePalletSscc: string;
  let box1Sscc: string;
  let box2Sscc: string;
  let box3Sscc: string;
  let box4Sscc: string;

  const enqueueShiftExport = vi.fn(async (_exportId: string) => randomUUID());
  const putVerified = vi.fn(
    async (key: string, body: Buffer, _contentType: string, sha256: string) => ({
      byteSize: body.byteLength,
      sha256,
    }),
  );
  const presignRead = vi.fn(async (objectKey: string) => `https://storage.test/${objectKey}`);

  const GTIN = "04006381333931";
  const ISSUER_PREFIX = "034600682";
  const ITEM_BASE = Date.parse("2026-09-17T07:00:00.000Z");

  async function postBatch(stationKey: string, body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({ batchId: `pallet-export-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

  async function palletIdBySscc(sscc: string): Promise<string> {
    const [pallet] = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, sscc)));
    if (!pallet) throw new Error(`Expected a persisted pallet with sscc ${sscc}`);
    return pallet.id;
  }

  function createBody() {
    return {
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      idempotencyKey: randomUUID(),
    };
  }

  async function runAndReadArtifact(exportId: string): Promise<string> {
    putVerified.mockClear();
    await app!.get(ShiftExportRunnerService).run(exportId, { retryCount: 0, retryLimit: 5 });
    expect(putVerified).toHaveBeenCalledTimes(1);
    const call = putVerified.mock.calls[0];
    if (!call) throw new Error("Expected the runner to upload exactly one artifact");
    return call[1].toString("utf-8");
  }

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    await settleQueuedBackgroundWork(db);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(PgBossService)
      .useValue({ enqueueShiftExport, checkReady: async () => undefined })
      .overrideProvider(ObjectStorageService)
      .useValue({ putVerified, presignRead, ensureBucket: async () => undefined })
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected the tenant owner fixture");
    userId = member.userId;

    otherAgent = request.agent(app.getHttpServer());
    await signUpAndActivate(otherAgent);

    // The GISMT aggregation document carries the tenant's ИНН as `LP_TIN`.
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: "7701234567" })
      .onConflictDoUpdate({ target: schema.orgProfiles.tenantId, set: { inn: "7701234567" } });

    const station = await createTestStationDevice(app, agent, "TSD pallet export", {
      kind: "handheld",
    });
    const stationKey = station.apiKey;

    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: GTIN,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const productId = (product.body as { id: string }).id;

    const shift = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2026-09-17" })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    function item(label: string, deviceBoxId: string, index: number): ScanItemDto {
      const raw = `01${GTIN}21S-${label}`;
      const km = canonicalizeKm(raw);
      return {
        shiftId,
        terminalId: "t1",
        raw,
        verdict: "ok",
        scannedAt: new Date(ITEM_BASE + index * 1000).toISOString(),
        code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
        boxId: deviceBoxId,
        operatorId: null,
      };
    }

    box1Sscc = buildSscc(0, ISSUER_PREFIX, 401);
    box2Sscc = buildSscc(0, ISSUER_PREFIX, 402);
    box3Sscc = buildSscc(0, ISSUER_PREFIX, 403);
    box4Sscc = buildSscc(0, ISSUER_PREFIX, 404);
    const box5Sscc = buildSscc(0, ISSUER_PREFIX, 405);
    const box6Sscc = buildSscc(0, ISSUER_PREFIX, 406);
    productionPalletSscc = buildSscc(1, ISSUER_PREFIX, 11);
    warehousePalletSscc = buildSscc(1, ISSUER_PREFIX, 12);
    const disassembledPalletSscc = buildSscc(1, ISSUER_PREFIX, 13);

    await postBatch(stationKey, {
      items: [
        item("b1-0", "b1", 0),
        item("b2-0", "b2", 1),
        item("b3-0", "b3", 2),
        item("b4-0", "b4", 3),
        item("b5-0", "b5", 4),
        item("b6-0", "b6", 5),
      ],
    });
    function box(deviceBoxId: string, sscc: string, devicePalletId: string | null) {
      return {
        boxId: deviceBoxId,
        shiftId,
        terminalId: "t1",
        sscc,
        closedAt: "2026-09-17T08:00:00.000Z",
        operatorId: null,
        devicePalletId,
      };
    }

    await postBatch(stationKey, {
      boxes: [
        // p1: the closed production pallet under test.
        box("b1", box1Sscc, "p1"),
        box("b2", box2Sscc, "p1"),
        // b3/b4 stand on no pallet at closure; a warehouse pallet claims them below.
        box("b3", box3Sscc, null),
        box("b4", box4Sscc, null),
        // p2 never closes: an open pallet must refuse an export.
        box("b5", box5Sscc, "p2"),
        // p3 closes and is then taken apart.
        box("b6", box6Sscc, "p3"),
      ],
    });
    await postBatch(stationKey, {
      pallets: [
        {
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          sscc: productionPalletSscc,
          closedAt: "2026-09-17T08:30:00.000Z",
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
        {
          palletId: "p3",
          shiftId,
          terminalId: "t1",
          sscc: disassembledPalletSscc,
          closedAt: "2026-09-17T08:30:00.000Z",
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });

    // A warehouse pallet: built from closed boxes of any shift, belonging to
    // none, with its product carried on the pallet itself.
    await postBatch(stationKey, {
      palletMemberships: [
        {
          palletId: "w1",
          boxSscc: box3Sscc,
          addedAt: "2026-09-17T09:00:00.000Z",
          operatorId: null,
        },
        {
          palletId: "w1",
          boxSscc: box4Sscc,
          addedAt: "2026-09-17T09:00:10.000Z",
          operatorId: null,
        },
      ],
    });
    await postBatch(stationKey, {
      pallets: [
        {
          palletId: "w1",
          kind: "warehouse",
          shiftId: null,
          productId,
          terminalId: null,
          sscc: warehousePalletSscc,
          closedAt: "2026-09-17T09:30:00.000Z",
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });

    productionPalletId = await palletIdBySscc(productionPalletSscc);
    warehousePalletId = await palletIdBySscc(warehousePalletSscc);
    disassembledPalletId = await palletIdBySscc(disassembledPalletSscc);
    const [openPallet] = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.devicePalletId, "p2")));
    if (!openPallet) throw new Error("Expected the open pallet fixture to persist");
    openPalletId = openPallet.id;

    // Retiring a closed pallet is the cabinet's disaggregation document; this
    // suite only needs the resulting STATE, so the row is retired directly.
    await db
      .update(schema.pallets)
      .set({ disassembledAt: new Date("2026-09-17T10:00:00.000Z") })
      .where(
        and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, disassembledPalletId)),
      );

    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "test close" }).expect(200);
  }, 180_000);

  afterAll(async () => {
    try {
      await settleQueuedBackgroundWork(db);
    } finally {
      await app?.close();
    }
  });

  it("queues, runs and audits a per-pallet export of a production pallet", async () => {
    const created = await agent
      .post(`/pallets/${productionPalletId}/exports`)
      .send(createBody())
      .expect(201);
    const body = created.body as { id: string; artifacts: { id: string; filename: string }[] };
    expect(created.body).toMatchObject({
      shiftId: null,
      palletId: productionPalletId,
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      maxLines: null,
      status: "queued",
    });
    expect(enqueueShiftExport).toHaveBeenCalledWith(body.id);

    const xml = await runAndReadArtifact(body.id);
    expect(xml).not.toContain("<cis>");
    expect(xml).toContain(`<pack_code>00${productionPalletSscc}</pack_code>`);
    expect(xml).toContain(`<sscc>00${box1Sscc}</sscc>`);
    expect(xml).toContain(`<sscc>00${box2Sscc}</sscc>`);
    expect((xml.match(/<pack_content>/g) ?? []).length).toBe(1);
    expect(xml).toContain('LP_TIN="7701234567"');

    const list = await agent.get(`/pallets/${productionPalletId}/exports`).expect(200);
    const listed = (list.body as Record<string, unknown>[])[0];
    expect(listed).toMatchObject({
      id: body.id,
      shiftId: null,
      palletId: productionPalletId,
      status: "ready",
      errorCode: null,
      totalBoxCount: 2,
      totalCodeCount: 0,
      productNameSnapshot: "Cola",
      shiftDateSnapshot: "2026-09-17",
      stale: false,
    });
    const artifacts = (
      listed as { artifacts: { id: string; filename: string; codeCount: number }[] }
    ).artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      partNumber: 1,
      codeCount: 0,
      boxCount: 2,
      filename: `Cola_2026-09-17_паллета_00${productionPalletSscc}_2_коробов.xml`,
      mimeType: "application/xml; charset=utf-8",
    });

    // The download route is shared with the shift exports; a pallet export's
    // artifact must be reachable through it unchanged.
    const download = await agent
      .get(`/shift-exports/${body.id}/artifacts/${artifacts[0]!.id}/download`)
      .expect(200);
    expect(download.body).toMatchObject({
      filename: `Cola_2026-09-17_паллета_00${productionPalletSscc}_2_коробов.xml`,
      expiresInSeconds: 300,
    });

    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, body.id),
        ),
      );
    expect(audits.map((event) => event.action).sort()).toEqual([
      "pallet_export.completed",
      "pallet_export.created",
      "pallet_export.downloaded",
    ]);
    expect(audits.find((event) => event.action === "pallet_export.created")).toMatchObject({
      organizationId: tenantId,
      actorUserId: userId,
      outcome: "success",
      targetType: "shift_export",
      targetId: body.id,
      after: {
        tenantId,
        actorUserId: userId,
        shiftId: null,
        palletId: productionPalletId,
        exportId: body.id,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        maxLines: null,
        outcome: "success",
        status: "queued",
      },
    });
    expect(audits.find((event) => event.action === "pallet_export.completed")).toMatchObject({
      organizationId: tenantId,
      actorUserId: userId,
      outcome: "success",
      targetType: "shift_export",
      targetId: body.id,
      after: {
        tenantId,
        actorUserId: userId,
        shiftId: null,
        palletId: productionPalletId,
        exportId: body.id,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        maxLines: null,
        outcome: "success",
        status: "ready",
        partCount: 1,
        totalCodeCount: 0,
        totalBoxCount: 2,
      },
    });
  });

  it("exports a warehouse pallet, which belongs to no shift at all", async () => {
    const created = await agent
      .post(`/pallets/${warehousePalletId}/exports`)
      .send(createBody())
      .expect(201);
    const exportId = (created.body as { id: string }).id;

    const xml = await runAndReadArtifact(exportId);
    expect(xml).not.toContain("<cis>");
    expect(xml).toContain(`<pack_code>00${warehousePalletSscc}</pack_code>`);
    expect(xml).toContain(`<sscc>00${box3Sscc}</sscc>`);
    expect(xml).toContain(`<sscc>00${box4Sscc}</sscc>`);

    const [row] = await db
      .select()
      .from(schema.shiftExports)
      .where(eq(schema.shiftExports.id, exportId));
    expect(row).toMatchObject({
      shiftId: null,
      palletId: warehousePalletId,
      status: "ready",
      errorCode: null,
      totalCodeCount: 0,
      totalBoxCount: 2,
      // A warehouse pallet reaches its product directly, not through a shift.
      productNameSnapshot: "Cola",
      shiftDateSnapshot: "2026-09-17",
    });
  });

  it("collapses only the same actor/idempotency key and creates a job for each distinct key", async () => {
    enqueueShiftExport.mockClear();
    const key = randomUUID();
    const first = await agent
      .post(`/pallets/${productionPalletId}/exports`)
      .send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: key })
      .expect(201);
    const repeated = await agent
      .post(`/pallets/${productionPalletId}/exports`)
      .send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: key })
      .expect(201);
    expect(repeated.body.id).toBe(first.body.id);
    expect(enqueueShiftExport).toHaveBeenCalledTimes(1);

    const rows = await db
      .select()
      .from(schema.shiftExports)
      .where(
        and(
          eq(schema.shiftExports.tenantId, tenantId),
          eq(schema.shiftExports.idempotencyKey, key),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("refuses the same idempotency key reused for a different pallet", async () => {
    const key = randomUUID();
    await agent
      .post(`/pallets/${productionPalletId}/exports`)
      .send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: key })
      .expect(201);
    await agent
      .post(`/pallets/${warehousePalletId}/exports`)
      .send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: key })
      .expect(409);
  });

  it("refuses an open, a disassembled and another tenant's pallet, and advertises one format", async () => {
    await agent.post(`/pallets/${openPalletId}/exports`).send(createBody()).expect(409);
    await agent.post(`/pallets/${disassembledPalletId}/exports`).send(createBody()).expect(409);
    await otherAgent.post(`/pallets/${productionPalletId}/exports`).send(createBody()).expect(404);
    await otherAgent
      .get(`/pallets/${productionPalletId}/exports`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual([]);
      });
    await agent
      .get("/pallet-exports/formats")
      .expect(200)
      .expect((res) => {
        expect((res.body as { id: string }[]).map((format) => format.id)).toEqual([
          "pallet_xml_gismt_aggregation",
        ]);
      });
    await agent
      .post(`/pallets/${productionPalletId}/exports`)
      .send({ ...createBody(), formatVersion: 2 })
      .expect(400);
  });
});
