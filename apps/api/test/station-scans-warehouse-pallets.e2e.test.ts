import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { PALLET_EXTENSION_DIGIT, SsccService } from "../src/modules/sscc/sscc.service";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 4 (box/pallet aggregation): warehouse pallets built on a handheld from
 * boxes that closed in ARBITRARY shifts, delivered through the ordinary
 * `POST /station/scans` batch as `palletMemberships` plus a `kind:
 * "warehouse"` closure.
 *
 * Like pallets.e2e.test.ts, the `it` blocks below deliberately mutate ONE
 * shared warehouse pallet in sequence (attach, replay, close, disassemble,
 * re-attach) because that is the life of the thing under test. They are
 * ordered deliberately and are not safe to reorder or run in isolation.
 */
describe.skipIf(!ready)("station scans warehouse pallets e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let stationKey: string;
  let stationDeviceId: string;
  /** A second handheld of the SAME tenant: its "w1" is not device 1's "w1". */
  let device2Key: string;
  let device2Id: string;
  let productId: string;
  let shift1Id: string;
  let shift2Id: string;
  let otherShiftId: string;
  let operatorId: string;
  let warehouseSscc: string;

  const GTIN_A = "04006381333931";
  const GTIN_B = "04006381333900";
  /** A third product, for the read-only tenant's own fixtures. */
  const GTIN_C = "04600682000013";
  // Nine digits, so `ssccSerialCapacity` leaves a seven-digit serial -- same
  // fixture shape as pallets.e2e.test.ts.
  const ISSUER_PREFIX = "034600682";
  const ITEM_BASE = Date.parse("2026-09-17T07:00:00.000Z");
  const BOX_CLOSED_AT = "2026-09-17T08:00:00.000Z";
  /** Only shift 2 is dated, so the card's per-box production day is provable. */
  const SHIFT2_PLANNED_DATE = "2026-09-16";

  /** b1, b2: closed in shift 1. b3: closed in a SECOND shift of the same product. */
  const B1_SSCC = "003460682000000101";
  const B2_SSCC = "003460682000000102";
  const B3_SSCC = "003460682000000103";
  /** b4: a closed box of a DIFFERENT product. */
  const B4_SSCC = "003460682000000104";
  /** b5: never closed -- see the seeding note in `beforeAll`. */
  const B5_SSCC = "003460682000000105";
  /** b6: its items are seeded below, but it closes in the SAME batch that attaches it. */
  const B6_SSCC = "003460682000000106";
  /** b7: closed, then taken apart from the station before anyone palletises it. */
  const B7_SSCC = "003460682000000107";
  const UNKNOWN_SSCC = "003460068299999990";
  /** l1, l2: boxes of the READ-ONLY tenant below, closed before its plan lapses. */
  const L1_SSCC = "003460682000000201";
  const L2_SSCC = "003460682000000202";

  function item(gtin: string, shiftId: string, label: string, boxId: string): ScanItemDto {
    const raw = `01${gtin}21S-${label}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId: "t1",
      raw,
      verdict: "ok",
      scannedAt: new Date(
        ITEM_BASE + Number.parseInt(label.replace(/\D/g, ""), 10) * 1000,
      ).toISOString(),
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  async function postBatch(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({ batchId: `warehouse-e2e-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

  const membership = (palletId: string, boxSscc: string) => ({
    palletId,
    boxSscc,
    addedAt: "2026-09-17T09:00:00.000Z",
    operatorId,
  });

  async function warehousePallets() {
    const db = app!.get<Db>(DB);
    return db
      .select({
        id: schema.pallets.id,
        kind: schema.pallets.kind,
        sscc: schema.pallets.sscc,
        productId: schema.pallets.productId,
        deviceId: schema.pallets.deviceId,
        devicePalletId: schema.pallets.devicePalletId,
        closedAt: schema.pallets.closedAt,
        disassembledAt: schema.pallets.disassembledAt,
      })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.kind, "warehouse")))
      .orderBy(schema.pallets.devicePalletId, schema.pallets.deviceId);
  }

  /** Two devices may each own a pallet called "w1"; always say which. */
  async function warehousePallet(devicePalletId: string, deviceId: string) {
    const rows = await warehousePallets();
    const found = rows.find(
      (pallet) => pallet.devicePalletId === devicePalletId && pallet.deviceId === deviceId,
    );
    if (!found) throw new Error(`No warehouse pallet ${devicePalletId} for device ${deviceId}`);
    return found;
  }

  async function boxRegistryVersions() {
    const db = app!.get<Db>(DB);
    const rows = await db
      .select({ sscc: schema.boxes.sscc, registryVersion: schema.boxes.registryVersion })
      .from(schema.boxes)
      .where(eq(schema.boxes.tenantId, tenantId));
    return new Map(
      rows.flatMap((row) => (row.sscc === null ? [] : [[row.sscc, row.registryVersion] as const])),
    );
  }

  async function memberBoxSsccs(palletId: string) {
    const db = app!.get<Db>(DB);
    const rows = await db
      .select({ sscc: schema.boxes.sscc })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, palletId)))
      .orderBy(schema.boxes.sscc);
    return rows.flatMap((row) => (row.sscc === null ? [] : [row.sscc]));
  }

  async function rejections(palletId: string) {
    const db = app!.get<Db>(DB);
    return db
      .select({
        boxSscc: schema.palletMembershipRejections.boxSscc,
        reason: schema.palletMembershipRejections.reason,
      })
      .from(schema.palletMembershipRejections)
      .where(
        and(
          eq(schema.palletMembershipRejections.tenantId, tenantId),
          eq(schema.palletMembershipRejections.palletId, palletId),
        ),
      )
      .orderBy(schema.palletMembershipRejections.boxSscc);
  }

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
    tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app!, agent, "TSD-1", { kind: "handheld" });
    stationKey = station.apiKey;
    stationDeviceId = station.deviceId;
    const device2 = await createTestStationDevice(app!, agent, "TSD-2", { kind: "handheld" });
    device2Key = device2.apiKey;
    device2Id = device2.deviceId;

    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: GTIN_A,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    productId = (product.body as { id: string }).id;
    const otherProduct = await agent
      .post("/products")
      .send({
        name: "Fanta",
        gtin: GTIN_B,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const otherProductId = (otherProduct.body as { id: string }).id;

    const openShift = async (forProduct: string, plannedDate?: string) => {
      const shift = await agent
        .post("/shifts")
        .send({
          productId: forProduct,
          mode: "validation",
          ...(plannedDate === undefined ? {} : { plannedDate }),
        })
        .expect(201);
      const id = (shift.body as { id: string }).id;
      await agent.post(`/shifts/${id}/open`).expect(200);
      return id;
    };
    shift1Id = await openShift(productId);
    // Dated on purpose: the pallet card reports each member box's OWN
    // production day, and only a shift that has one proves it is read per box
    // rather than taken from the (non-existent) pallet shift.
    shift2Id = await openShift(productId, SHIFT2_PLANNED_DATE);
    otherShiftId = await openShift(otherProductId);

    const employee = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
    operatorId = (employee.body as { id: string }).id;

    const block = await app!
      .get(SsccService)
      .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 5);
    warehouseSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);

    await postBatch({
      items: [
        item(GTIN_A, shift1Id, "b1-1", "b1"),
        item(GTIN_A, shift1Id, "b1-2", "b1"),
        item(GTIN_A, shift1Id, "b2-11", "b2"),
        item(GTIN_A, shift1Id, "b5-21", "b5"),
        item(GTIN_A, shift1Id, "b6-31", "b6"),
      ],
    });
    await postBatch({ items: [item(GTIN_A, shift2Id, "b3-31", "b3")] });
    await postBatch({ items: [item(GTIN_B, otherShiftId, "b4-41", "b4")] });

    const closure = (boxId: string, shiftId: string, sscc: string) => ({
      boxId,
      shiftId,
      terminalId: "t1",
      sscc,
      closedAt: BOX_CLOSED_AT,
      operatorId,
      devicePalletId: null,
    });
    await postBatch({
      boxes: [
        closure("b1", shift1Id, B1_SSCC),
        closure("b2", shift1Id, B2_SSCC),
        closure("b3", shift2Id, B3_SSCC),
        closure("b4", otherShiftId, B4_SSCC),
      ],
    });

    // b5 stays OPEN but needs an SSCC to be addressable by one: the ingest
    // only ever writes `boxes.sscc` in the same statement as `closed_at`, so
    // an open box cannot be reached through any public route. The
    // `not_closed` refusal is nevertheless a real server rule the handheld
    // depends on, so the row is seeded here directly rather than left untested.
    const db = app!.get<Db>(DB);
    await db
      .update(schema.boxes)
      .set({ sscc: B5_SSCC })
      .where(
        and(
          eq(schema.boxes.tenantId, tenantId),
          eq(schema.boxes.shiftId, shift1Id),
          eq(schema.boxes.deviceBoxId, "b5"),
        ),
      );
  });

  afterAll(async () => {
    await app?.close();
  });

  it("attaches closed boxes from two shifts to a warehouse pallet and reports each outcome", async () => {
    const res = await postBatch({
      palletMemberships: [
        membership("w1", B1_SSCC),
        membership("w1", B3_SSCC),
        membership("w1", B4_SSCC), // other product
        membership("w1", B5_SSCC), // still open
        membership("w1", UNKNOWN_SSCC), // unknown
      ],
    });
    expect(res.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "accepted" },
      { palletId: "w1", boxSscc: B3_SSCC, status: "accepted" },
      { palletId: "w1", boxSscc: B4_SSCC, status: "product_mismatch" },
      { palletId: "w1", boxSscc: B5_SSCC, status: "not_closed" },
      { palletId: "w1", boxSscc: UNKNOWN_SSCC, status: "not_found" },
    ]);

    // The cabinet sees the same pallet through its own org-wide list.
    const listed = await agent.get("/pallets").query({ kind: "warehouse" }).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      kind: "warehouse",
      boxCount: 2,
      rejectedMembershipCount: 3,
      productName: "Cola",
      sscc: null,
    });

    const pallets = await warehousePallets();
    expect(pallets).toHaveLength(1);
    expect(pallets[0]).toMatchObject({
      kind: "warehouse",
      devicePalletId: "w1",
      productId,
      deviceId: stationDeviceId,
      sscc: null,
    });
    expect(await memberBoxSsccs(pallets[0]!.id)).toEqual([B1_SSCC, B3_SSCC]);
    // Ordered by SSCC, and the unknown one sorts first.
    expect(await rejections(pallets[0]!.id)).toEqual([
      { boxSscc: UNKNOWN_SSCC, reason: "not_found" },
      { boxSscc: B4_SSCC, reason: "product_mismatch" },
      { boxSscc: B5_SSCC, reason: "not_closed" },
    ]);
  });

  /**
   * Runs straight after the attach above, while w1 still holds BOTH boxes:
   * the later tests disassemble it and move B1 onto w2, which is exactly the
   * cross-shift membership this card has to show.
   */
  it("shows the warehouse pallet card with box origin shifts and rejections", async () => {
    const list = await agent.get("/pallets").query({ kind: "warehouse" }).expect(200);
    const w1 = (list.body.items as { id: string; boxCount: number }[]).find(
      (pallet) => pallet.boxCount >= 1,
    );
    expect(w1).toBeDefined();
    const card = await agent.get(`/code-search/pallets/${w1!.id}`).expect(200);
    expect(card.body).toMatchObject({
      kind: "warehouse",
      shiftId: null,
      shiftNumber: null,
      productName: "Cola",
      status: "open",
    });
    expect((card.body.boxes as { shiftId: string }[]).map((box) => box.shiftId).sort()).toEqual(
      [shift1Id, shift2Id].sort(),
    );
    // Each member box still dates from the shift it closed in: only shift 2
    // has a planned date, and only its own box reports one.
    const byShift = new Map(
      (card.body.boxes as { shiftId: string; productionDate: string | null }[]).map((box) => [
        box.shiftId,
        box.productionDate,
      ]),
    );
    expect(byShift.get(shift2Id)).toBe(SHIFT2_PLANNED_DATE);
    expect(byShift.get(shift1Id)).toBeNull();
    expect(card.body.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ boxSscc: `00${B4_SSCC}`, reason: "product_mismatch" }),
        expect.objectContaining({ boxSscc: `00${UNKNOWN_SSCC}`, reason: "not_found", boxId: null }),
        expect.objectContaining({ boxSscc: `00${B5_SSCC}`, reason: "not_closed" }),
      ]),
    );
    expect(card.body.rejections).toHaveLength(3);
  });

  it("replays a membership as a no-op and refuses the box for another device's pallet", async () => {
    const replay = await postBatch({ palletMemberships: [membership("w1", B1_SSCC)] });
    expect(replay.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "replayed" },
    ]);

    const rival = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device2Key)
      .send({
        batchId: `rival-${randomUUID()}`,
        items: [],
        palletMemberships: [membership("w1", B1_SSCC)],
      })
      .expect(201);
    // Device 2's own "w1" is a different pallet, and it has no SSCC yet, so no
    // `winningPalletSscc` either way; after device 1 closes below, a repeat
    // carries it.
    expect(rival.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "already_on_pallet" },
    ]);
    expect(await warehousePallets()).toHaveLength(2);
    // Device 2's own "w1" was created by the refused membership and stands empty.
    const rivalPallet = await warehousePallet("w1", device2Id);
    expect(await memberBoxSsccs(rivalPallet.id)).toEqual([]);
  });

  it("closes the warehouse pallet with an extension-1 serial and bumps its boxes' registry version", async () => {
    const before = await boxRegistryVersions();
    await postBatch({
      pallets: [
        {
          palletId: "w1",
          kind: "warehouse",
          shiftId: null,
          productId,
          terminalId: null,
          sscc: warehouseSscc,
          closedAt: "2026-09-17T09:30:00.000Z",
          operatorId,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });
    // The `GET /station/box-registry` delta's `palletSscc`/`palletActive`
    // fields are asserted in `box-registry-pallets.e2e.test.ts`: this suite's
    // shifts run in `validation` mode, which claims no `code_registry`
    // ownership, so none of its boxes is a registry candidate. What the
    // closure must do HERE is advance every member box's registry version,
    // since a warehouse pallet's serial only exists once it closes.
    const after = await boxRegistryVersions();
    expect(after.get(B1_SSCC)).toBeGreaterThan(before.get(B1_SSCC)!);
    expect(after.get(B3_SSCC)).toBeGreaterThan(before.get(B3_SSCC)!);
    // A box that never stood on this pallet is untouched.
    expect(after.get(B2_SSCC)).toEqual(before.get(B2_SSCC));

    const closed = await warehousePallet("w1", stationDeviceId);
    expect(closed.sscc).toEqual(warehouseSscc);
    expect(closed.closedAt).not.toBeNull();

    const rival = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device2Key)
      .send({
        batchId: `rival2-${randomUUID()}`,
        items: [],
        palletMemberships: [membership("w9", B1_SSCC)],
      })
      .expect(201);
    expect(rival.body.memberships[0]).toEqual({
      palletId: "w9",
      boxSscc: B1_SSCC,
      status: "already_on_pallet",
      winningPalletSscc: `00${warehouseSscc}`,
    });
  });

  it("re-attaches a box once its old pallet is disassembled", async () => {
    await postBatch({
      palletExceptions: [
        {
          kind: "disassemble",
          palletId: "w1",
          shiftId: null,
          terminalId: null,
          operatorId,
          reason: "перекладка",
          occurredAt: "2026-09-17T10:00:00.000Z",
        },
      ],
    });
    const res = await postBatch({ palletMemberships: [membership("w2", B1_SSCC)] });
    expect(res.body.memberships).toEqual([
      { palletId: "w2", boxSscc: B1_SSCC, status: "accepted" },
    ]);

    const w1 = await warehousePallet("w1", stationDeviceId);
    const w2 = await warehousePallet("w2", stationDeviceId);
    expect(w1.disassembledAt).not.toBeNull();
    expect(await memberBoxSsccs(w2.id)).toEqual([B1_SSCC]);
    // The disassembled pallet keeps B3: taking a pallet apart does not open
    // its boxes, and only a box re-attached elsewhere leaves it.
    expect(await memberBoxSsccs(w1.id)).toEqual([B3_SSCC]);
  });

  it("does not let another tenant's device see or touch these pallets", async () => {
    const other = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(other);
    const otherDevice = await createTestStationDevice(app!, other, "Other", { kind: "handheld" });
    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", otherDevice.apiKey)
      .send({
        batchId: `other-${randomUUID()}`,
        items: [],
        palletMemberships: [membership("w1", B1_SSCC)],
      })
      .expect(201);
    expect(res.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "not_found" },
    ]);

    const theirList = await other.get("/pallets").query({ kind: "warehouse" }).expect(200);
    expect(theirList.body.items).toEqual([]);
    // Nor through the card: another tenant's pallet id is a plain 404.
    const w1 = await warehousePallet("w1", stationDeviceId);
    await other.get(`/code-search/pallets/${w1.id}`).expect(404);

    const db = app!.get<Db>(DB);
    const theirs = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(eq(schema.pallets.tenantId, otherTenantId));
    expect(theirs).toEqual([]);
  });
  it("closes a box and attaches it to a new warehouse pallet in the same batch", async () => {
    // `boxes.sscc` is written by the box-closure loop, and a membership names
    // its box by that SSCC, so the two must be resolved in the right order
    // WITHIN one batch: a handheld closes the box it has just filled and scans
    // it onto a pallet without waiting for a round trip in between.
    const res = await postBatch({
      boxes: [
        {
          boxId: "b6",
          shiftId: shift1Id,
          terminalId: "t1",
          sscc: B6_SSCC,
          closedAt: "2026-09-17T10:30:00.000Z",
          operatorId,
          devicePalletId: null,
        },
      ],
      palletMemberships: [membership("w6", B6_SSCC)],
    });
    expect(res.body.memberships).toEqual([
      { palletId: "w6", boxSscc: B6_SSCC, status: "accepted" },
    ]);

    // The pallet was created by this very batch, seeded with the product of
    // the shift the box closed in.
    const w6 = await warehousePallet("w6", stationDeviceId);
    expect(w6).toMatchObject({ kind: "warehouse", productId, deviceId: stationDeviceId });
    expect(await memberBoxSsccs(w6.id)).toEqual([B6_SSCC]);
    expect(await rejections(w6.id)).toEqual([]);
  });

  it("replays an identical membership batch under the same batchId verbatim", async () => {
    const batchId = `warehouse-replay-${randomUUID()}`;
    const body = { batchId, items: [], palletMemberships: [membership("w7", B2_SSCC)] };
    const first = await postBatch(body);
    expect(first.body.alreadyApplied).toBe(false);
    expect(first.body.memberships).toEqual([
      { palletId: "w7", boxSscc: B2_SSCC, status: "accepted" },
    ]);

    // The device's drain redelivers a batch it never saw acknowledged. The
    // answer must be the stored one, byte for byte: the handheld rebuilds its
    // conflict view from it, and a second pass over the rules would report
    // `replayed` instead of `accepted`.
    const again = await postBatch(body);
    expect(again.body.alreadyApplied).toBe(true);
    expect(again.body.memberships).toEqual(first.body.memberships);

    const w7 = await warehousePallet("w7", stationDeviceId);
    expect(await memberBoxSsccs(w7.id)).toEqual([B2_SSCC]);
    expect(await rejections(w7.id)).toEqual([]);
  });

  it("refuses a box that was disassembled after it closed", async () => {
    // The box is built, closed and taken apart entirely through the station
    // path, so the refusal is reached the way a real handheld reaches it: the
    // box exists, carries an SSCC and matches the pallet's product, and only
    // `boxes.disassembled_at` stands between it and the pallet.
    await postBatch({ items: [item(GTIN_A, shift1Id, "b7-71", "b7")] });
    await postBatch({
      boxes: [
        {
          boxId: "b7",
          shiftId: shift1Id,
          terminalId: "t1",
          sscc: B7_SSCC,
          closedAt: "2026-09-17T11:00:00.000Z",
          operatorId,
          devicePalletId: null,
        },
      ],
    });
    await postBatch({
      exceptions: [
        {
          kind: "disassemble",
          boxId: "b7",
          codeHash: null,
          targetScannedAt: null,
          shiftId: shift1Id,
          terminalId: "t1",
          operatorId: null,
          reason: "короб вскрыт на складе",
          occurredAt: "2026-09-17T11:30:00.000Z",
        },
      ],
    });

    const res = await postBatch({ palletMemberships: [membership("w8", B7_SSCC)] });
    expect(res.body.memberships).toEqual([
      { palletId: "w8", boxSscc: B7_SSCC, status: "disassembled" },
    ]);

    const w8 = await warehousePallet("w8", stationDeviceId);
    expect(await memberBoxSsccs(w8.id)).toEqual([]);
    expect(await rejections(w8.id)).toEqual([{ boxSscc: B7_SSCC, reason: "disassembled" }]);
  });

  /**
   * By now this tenant holds both OPEN and CLOSED warehouse pallets, which is
   * the case the keyset cursor has to get right: the list sorts
   * `closed_at DESC NULLS FIRST`, so a page that ends inside the still-open
   * block must continue with the rest of that block AND everything closed.
   * Walked one row at a time, the pages must reconstruct the single-page list
   * exactly -- no row seen twice, none skipped.
   */
  it("pages the whole list one row at a time without losing or repeating a pallet", async () => {
    const whole = await agent.get("/pallets").expect(200);
    const expected = (whole.body.items as { id: string }[]).map((pallet) => pallet.id);
    expect(expected.length).toBeGreaterThan(2);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= expected.length; page += 1) {
      const res = await agent
        .get("/pallets")
        .query({ limit: 1, ...(cursor === undefined ? {} : { cursor }) })
        .expect(200);
      walked.push(...(res.body.items as { id: string }[]).map((pallet) => pallet.id));
      cursor = res.body.nextCursor as string | undefined;
      if (cursor === undefined) break;
    }
    expect(cursor).toBeUndefined();
    expect(walked).toEqual(expected);
  });

  it("denies, quarantines and reports every membership of a read-only tenant", async () => {
    const db = app!.get<Db>(DB);
    const lapsed = request.agent(app!.getHttpServer());
    const lapsedTenantId = await signUpAndActivate(lapsed);
    const lapsedDevice = await createTestStationDevice(app!, lapsed, "TSD-lapsed", {
      kind: "handheld",
    });
    const lapsedProduct = await lapsed
      .post("/products")
      .send({
        name: "Sprite",
        gtin: GTIN_C,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const lapsedProductId = (lapsedProduct.body as { id: string }).id;
    const lapsedShift = await lapsed
      .post("/shifts")
      .send({ productId: lapsedProductId, mode: "validation" })
      .expect(201);
    const lapsedShiftId = (lapsedShift.body as { id: string }).id;
    await lapsed.post(`/shifts/${lapsedShiftId}/open`).expect(200);

    const postLapsed = (payload: Record<string, unknown>) =>
      request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", lapsedDevice.apiKey)
        // `denied` is returned only to a client that negotiated recovery.
        .set("x-station-capabilities", "station-recovery-v1")
        .send({ batchId: `lapsed-${randomUUID()}`, items: [], ...payload })
        .expect(201);

    // Seeded while the tenant may still write; the subscription lapses below.
    await postLapsed({
      items: [item(GTIN_C, lapsedShiftId, "l1-1", "l1"), item(GTIN_C, lapsedShiftId, "l2-2", "l2")],
    });
    await postLapsed({
      boxes: [
        {
          boxId: "l1",
          shiftId: lapsedShiftId,
          terminalId: "t1",
          sscc: L1_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId: null,
          devicePalletId: null,
        },
        {
          boxId: "l2",
          shiftId: lapsedShiftId,
          terminalId: "t1",
          sscc: L2_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId: null,
          devicePalletId: null,
        },
      ],
    });

    const endsAt = new Date(Date.now() - 60_000);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
      palletsEnabled: true,
    });
    await createManagedSubscription(db, {
      tenantId: lapsedTenantId,
      planVersionId,
      startsAt: new Date(endsAt.getTime() - 86_400_000),
      endsAt,
    });

    const batchId = `lapsed-readonly-${randomUUID()}`;
    const denied = await postLapsed({
      batchId,
      // A warehouse pallet has no shift to date it by, so its own closure
      // instant is judged against `endsAt` -- and this one is now.
      pallets: [
        {
          palletId: "lw1",
          kind: "warehouse",
          shiftId: null,
          productId: lapsedProductId,
          terminalId: null,
          sscc: "103460682000000101",
          closedAt: new Date().toISOString(),
          operatorId: null,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
      palletMemberships: [membership("lw1", L1_SSCC), membership("lw1", L2_SSCC)],
    });

    expect(denied.body.denied).toEqual([
      { recordKind: "pallet", recordIndex: 0, shiftId: null, code: "subscription_read_only" },
      {
        recordKind: "pallet_membership",
        recordIndex: 0,
        shiftId: null,
        code: "subscription_read_only",
      },
      {
        recordKind: "pallet_membership",
        recordIndex: 1,
        shiftId: null,
        code: "subscription_read_only",
      },
    ]);
    // Every SUBMITTED membership keeps its position and reports the refusal.
    expect(denied.body.memberships).toEqual([
      { palletId: "lw1", boxSscc: L1_SSCC, status: "subscription_read_only" },
      { palletId: "lw1", boxSscc: L2_SSCC, status: "subscription_read_only" },
    ]);

    // Durable: the record survives in quarantine, not only in the answer.
    const quarantined = await db.execute<{
      record_kind: string;
      record_index: number;
      reason: string;
      payload: { palletId?: string; boxSscc?: string };
    }>(sql`
      select record_kind, record_index, reason, payload
      from station_sync_quarantine
      where tenant_id = ${lapsedTenantId} and batch_id = ${batchId}
        and record_kind = 'pallet_membership'
      order by record_index
    `);
    expect(quarantined.rows).toEqual([
      {
        record_kind: "pallet_membership",
        record_index: 0,
        reason: "subscription_read_only",
        payload: expect.objectContaining({ palletId: "lw1", boxSscc: L1_SSCC }),
      },
      {
        record_kind: "pallet_membership",
        record_index: 1,
        reason: "subscription_read_only",
        payload: expect.objectContaining({ palletId: "lw1", boxSscc: L2_SSCC }),
      },
    ]);

    // Nothing was applied: no pallet row, and both boxes stand on no pallet.
    const lapsedPallets = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(eq(schema.pallets.tenantId, lapsedTenantId));
    expect(lapsedPallets).toEqual([]);
    const lapsedBoxes = await db
      .select({ sscc: schema.boxes.sscc, palletId: schema.boxes.palletId })
      .from(schema.boxes)
      .where(eq(schema.boxes.tenantId, lapsedTenantId))
      .orderBy(schema.boxes.sscc);
    expect(lapsedBoxes).toEqual([
      { sscc: L1_SSCC, palletId: null },
      { sscc: L2_SSCC, palletId: null },
    ]);
  });
});
