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
 * Task 20 (06d): proves the `pallets` box mode against REAL `boxes`/`pallets`/
 * `box_items` rows, built through the same `/station/scans` ingest path
 * `pallets.e2e.test.ts` uses -- not through a fake DB. Every fixture here is a
 * real closed box/pallet; `ShiftExportRunnerService.run` is invoked directly
 * (bypassing pg-boss, which is stubbed the same way `shift-exports.e2e.test.ts`
 * stubs it) so this asserts the actual rendered artifact bytes and the actual
 * terminal row state, not just the domain-level grouping in isolation.
 */
describe.skipIf(!ready)("shift exports pallets e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  const enqueueShiftExport = vi.fn(async (_exportId: string) => randomUUID());
  const putVerified = vi.fn(
    async (key: string, body: Buffer, _contentType: string, sha256: string) => ({
      byteSize: body.byteLength,
      sha256,
    }),
  );

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
      .useValue({ putVerified, ensureBucket: async () => undefined })
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    try {
      await settleQueuedBackgroundWork(db);
    } finally {
      await app?.close();
    }
  });

  const VALID_GTIN14 = "04006381333931";
  const ISSUER_PREFIX = "034600682";

  interface Fixture {
    agent: ReturnType<typeof request.agent>;
    shiftId: string;
  }

  /**
   * Builds a closed shift with box1+box2 stacked on pallet p1 and box3
   * standing on no pallet, mirroring `pallets.e2e.test.ts`'s own fixture
   * shape. Returns the raw (bare, 18-digit) SSCCs so assertions can predict
   * the `00`-prefixed, 20-digit form the export renders.
   */
  async function fixture(): Promise<
    Fixture & { box1Sscc: string; box2Sscc: string; box3Sscc: string; palletSscc: string }
  > {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Pallet export line");
    const stationKey = station.apiKey;

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
    const productId = (product.body as { id: string }).id;

    const shift = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2026-09-11" })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    function item(label: string, boxId: string, index: number): ScanItemDto {
      const raw = `01${VALID_GTIN14}21S-${label}`;
      const km = canonicalizeKm(raw);
      return {
        shiftId,
        terminalId: "t1",
        raw,
        verdict: "ok",
        scannedAt: new Date(Date.parse("2026-09-11T07:00:00.000Z") + index * 1000).toISOString(),
        code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
        boxId,
        operatorId: null,
      };
    }

    async function postBatch(body: Record<string, unknown>) {
      return request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", stationKey)
        .send({ batchId: `pallet-export-e2e-${randomUUID()}`, items: [], ...body })
        .expect(201);
    }

    // Real, check-digit-valid SSCCs: the pallets-mode export formats and
    // validates every SSCC (box's own, pallet's own, and box-within-pallet
    // references) via `formatGismtAggregationSscc`, unlike the box listing in
    // `pallets.e2e.test.ts`, which never runs that formatter over box SSCCs.
    const box1Sscc = buildSscc(1, ISSUER_PREFIX, 201);
    const box2Sscc = buildSscc(1, ISSUER_PREFIX, 202);
    const box3Sscc = buildSscc(1, ISSUER_PREFIX, 203);
    const palletSscc = buildSscc(9, ISSUER_PREFIX, 1);

    await postBatch({
      items: [
        item("b1-0", "b1", 0),
        item("b1-1", "b1", 1),
        item("b2-0", "b2", 2),
        item("b3-0", "b3", 3),
      ],
    });
    await postBatch({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: box1Sscc,
          closedAt: "2026-09-11T07:30:00.000Z",
          operatorId: null,
          devicePalletId: "p1",
        },
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: box2Sscc,
          closedAt: "2026-09-11T07:30:00.000Z",
          operatorId: null,
          devicePalletId: "p1",
        },
        {
          boxId: "b3",
          shiftId,
          terminalId: "t1",
          sscc: box3Sscc,
          closedAt: "2026-09-11T07:30:00.000Z",
          operatorId: null,
          devicePalletId: null,
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
          closedAt: "2026-09-11T08:00:00.000Z",
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });

    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "test close" }).expect(200);

    return { agent, shiftId, box1Sscc, box2Sscc, box3Sscc, palletSscc };
  }

  it("groups real boxes and pallets by pallet_id, pallet first, loose box after", async () => {
    const { agent, shiftId, box1Sscc, box2Sscc, box3Sscc, palletSscc } = await fixture();

    putVerified.mockClear();
    const created = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send({
        formatId: "shift_csv_pallets",
        formatVersion: 1,
        maxLines: null,
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const exportId = (created.body as { id: string }).id;

    await app!.get(ShiftExportRunnerService).run(exportId, { retryCount: 0, retryLimit: 5 });

    expect(putVerified).toHaveBeenCalledTimes(1);
    const [, body] = putVerified.mock.calls[0]!;
    const csv = (body as Buffer).toString("utf-8").replace(/^\uFEFF/, "");
    expect(csv).toBe(
      "pallet_sscc;box_sscc;code\r\n" +
        `00${palletSscc};00${box1Sscc};01${VALID_GTIN14}21S-b1-0\r\n` +
        `00${palletSscc};00${box1Sscc};01${VALID_GTIN14}21S-b1-1\r\n` +
        `00${palletSscc};00${box2Sscc};01${VALID_GTIN14}21S-b2-0\r\n` +
        `;00${box3Sscc};01${VALID_GTIN14}21S-b3-0\r\n`,
    );

    const [row] = await db
      .select()
      .from(schema.shiftExports)
      .where(eq(schema.shiftExports.id, exportId));
    expect(row).toMatchObject({
      status: "ready",
      errorCode: null,
      totalCodeCount: 4,
      totalBoxCount: 3,
    });
  });

  it("rejects a pallets-mode format for a shift with no pallets as a precise, terminal failure", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "Loose-only line");
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected tenant owner fixture");

    const product = await agent
      .post("/products")
      .send({
        name: "Water",
        gtin: "04006381333948",
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const productId = (product.body as { id: string }).id;
    const shift = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2026-09-11" })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    const raw = `01${"04006381333948"}21S-loose-0`;
    const km = canonicalizeKm(raw);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", station.apiKey)
      .send({
        batchId: `pallet-export-e2e-${randomUUID()}`,
        items: [
          {
            shiftId,
            terminalId: "t1",
            raw,
            verdict: "ok",
            scannedAt: "2026-09-11T07:00:00.000Z",
            code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
            boxId: "b1",
            operatorId: null,
          },
        ],
      })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", station.apiKey)
      .send({
        batchId: `pallet-export-e2e-${randomUUID()}`,
        items: [],
        boxes: [
          {
            boxId: "b1",
            shiftId,
            terminalId: "t1",
            sscc: buildSscc(1, ISSUER_PREFIX, 301),
            closedAt: "2026-09-11T07:30:00.000Z",
            operatorId: null,
            devicePalletId: null,
          },
        ],
      })
      .expect(201);
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "test close" }).expect(200);

    const created = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send({
        formatId: "shift_csv_pallets",
        formatVersion: 1,
        maxLines: null,
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const exportId = (created.body as { id: string }).id;

    await app!.get(ShiftExportRunnerService).run(exportId, { retryCount: 0, retryLimit: 5 });

    const [row] = await db
      .select()
      .from(schema.shiftExports)
      .where(eq(schema.shiftExports.id, exportId));
    expect(row).toMatchObject({ status: "failed", errorCode: "SHIFT_HAS_NO_PALLETS" });

    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "shift_export.failed"),
          eq(schema.tenantAuditEvents.targetId, exportId),
        ),
      );
    expect(audit).toMatchObject({ outcome: "failure" });
  });
});
