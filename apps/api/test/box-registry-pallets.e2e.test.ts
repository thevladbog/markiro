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

interface RegistryUpsert {
  kind: string;
  boxId: string;
  sscc: string;
  palletId: string | null;
  palletSscc: string | null;
  palletActive: boolean;
  closedAt: string;
  productionDate: string | null;
}

interface RegistryPage {
  until: string;
  items: RegistryUpsert[];
}

/**
 * Task 5 (box/pallet aggregation): the tenant-wide box-registry delta feed
 * carries each box's pallet membership, so a handheld can refuse a box that
 * already stands on a live pallet -- and stop refusing it once that pallet is
 * taken apart from the cabinet.
 *
 * `station-scans-warehouse-pallets.e2e.test.ts` cannot host these assertions:
 * its shifts run in `validation` mode, which deliberately claims no
 * `code_registry` ownership, so none of its boxes is a registry candidate at
 * all. This suite therefore builds ONE genuinely eligible box through the same
 * public routes -- an `aggregation` shift, scanned items, a station closure --
 * and then puts it on a warehouse pallet.
 *
 * The `it` blocks mutate that one box in sequence (listed loose, attached,
 * disassembled) because that is the life of the thing under test; they are
 * ordered deliberately and are not safe to reorder or run in isolation.
 */
describe.skipIf(!ready)("box registry pallet membership e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let stationKey: string;
  let stationDeviceId: string;
  let productId: string;
  let shiftId: string;
  let operatorId: string;
  let reasonId: string;
  let boxId: string;
  /** The second eligible box, closed straight onto a production pallet. */
  let palletBoxId: string;
  let warehouseSscc: string;
  let productionPalletSscc: string;
  let productionPalletId: string;
  /** The registry cut taken while the box stood on no pallet. */
  let looseUntil: string;

  const GTIN = "04006381333931";
  const ISSUER_PREFIX = "034600682";
  /** Extension digit 0: a box SSCC, disjoint from the pallets' digit 1. */
  const BOX_SSCC = buildSscc(0, ISSUER_PREFIX, 301);
  const PALLET_BOX_SSCC = buildSscc(0, ISSUER_PREFIX, 302);
  const PRODUCTION_DATE = "2026-09-10";
  const BOX_CLOSED_AT = "2026-09-17T08:00:00.000Z";
  const ITEM_BASE = Date.parse("2026-09-17T07:00:00.000Z");

  function item(label: string, index: number, deviceBoxId: string): ScanItemDto {
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

  async function postBatch(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({ batchId: `registry-pallet-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

  async function registry(query: Record<string, string> = {}): Promise<RegistryPage> {
    const res = await request(app!.getHttpServer())
      .get("/station/box-registry")
      .query({ limit: "500", ...query })
      .set("x-api-key", stationKey)
      .expect(200);
    return res.body as RegistryPage;
  }

  function findBox(page: RegistryPage, sscc: string = BOX_SSCC): RegistryUpsert {
    const found = page.items.find((change) => change.sscc === sscc);
    if (!found) {
      throw new Error(`Box ${sscc} is absent from the registry page: ${JSON.stringify(page)}`);
    }
    return found;
  }

  async function boxIdBySscc(sscc: string): Promise<string> {
    const [box] = await db
      .select({ id: schema.boxes.id })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)));
    if (!box) throw new Error(`Expected a persisted box with sscc ${sscc}`);
    return box.id;
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

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "TSD-registry", { kind: "handheld" });
    stationKey = station.apiKey;
    stationDeviceId = station.deviceId;

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
    productId = (product.body as { id: string }).id;

    // `aggregation`, not `validation`: only an aggregation shift claims
    // `code_registry` ownership for its codes, which is what makes its closed
    // boxes registry candidates at all.
    const boxLabelTemplateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: boxLabelTemplateId,
      tenantId,
      name: "Registry box template",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    const shift = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "aggregation",
        productionDate: PRODUCTION_DATE,
        boxLabelTemplateId,
      })
      .expect(201);
    shiftId = (shift.body as { id: string }).id;
    // The organisation's own GLN, sharing ISSUER_PREFIX with the SSCCs below:
    // activating an aggregation shift refuses with ORG_GLN_MISSING when no GLN
    // can number its boxes.
    await agent.put("/org/profile").send({ gln: "0346006820014" }).expect(200);
    await agent.post(`/shifts/${shiftId}/open`).expect(200);

    const employee = await agent.post("/employees").send({ fullName: "Operator One" }).expect(201);
    operatorId = (employee.body as { id: string }).id;

    const reason = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Расформирование паллеты" })
      .expect(201);
    reasonId = (reason.body as { id: string }).id;

    const block = await app
      .get(SsccService)
      .allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 5);
    warehouseSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);
    productionPalletSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial + 1);

    await postBatch({
      items: [
        item("r1", 1, "b1"),
        item("r2", 2, "b1"),
        item("r3", 3, "b1"),
        item("r4", 4, "b2"),
        item("r5", 5, "b2"),
      ],
    });
    // A separate batch, so the closure instant lands after every member's
    // `code_registry.updated_at` -- the registry's own eligibility rule.
    await postBatch({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: BOX_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: null,
        },
        {
          boxId: "b2",
          shiftId,
          terminalId: "t1",
          sscc: PALLET_BOX_SSCC,
          closedAt: BOX_CLOSED_AT,
          operatorId,
          devicePalletId: "p1",
        },
      ],
    });
    // A production pallet of the same shift. The cabinet's disaggregation
    // document resolves a pallet line through `pallets.shift_id`, so this is
    // the pallet the cabinet test below takes apart.
    await postBatch({
      pallets: [
        {
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          sscc: productionPalletSscc,
          closedAt: "2026-09-17T08:30:00.000Z",
          operatorId,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });
    boxId = await boxIdBySscc(BOX_SSCC);
    palletBoxId = await boxIdBySscc(PALLET_BOX_SSCC);
    const [productionPallet] = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(
        and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, productionPalletSscc)),
      );
    if (!productionPallet) throw new Error("The production pallet fixture was not persisted");
    productionPalletId = productionPallet.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("separates a box on no pallet from one closed onto a live production pallet", async () => {
    const page = await registry();
    looseUntil = page.until;
    expect(findBox(page)).toMatchObject({
      kind: "upsert",
      boxId,
      sscc: BOX_SSCC,
      palletId: null,
      palletSscc: null,
      palletActive: false,
      closedAt: BOX_CLOSED_AT,
      productionDate: PRODUCTION_DATE,
    });
    expect(findBox(page, PALLET_BOX_SSCC)).toMatchObject({
      kind: "upsert",
      boxId: palletBoxId,
      palletId: productionPalletId,
      palletSscc: productionPalletSscc,
      palletActive: true,
      closedAt: BOX_CLOSED_AT,
      productionDate: PRODUCTION_DATE,
    });
  });

  it("carries the raw pallet SSCC and an active membership once the pallet closes", async () => {
    await postBatch({
      palletMemberships: [
        {
          palletId: "w1",
          boxSscc: BOX_SSCC,
          addedAt: "2026-09-17T09:00:00.000Z",
          operatorId,
        },
      ],
    });
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

    const [pallet] = await db
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, warehouseSscc)));
    if (!pallet) throw new Error("The warehouse pallet fixture was not persisted");

    const page = await registry({ since: looseUntil });
    expect(findBox(page)).toMatchObject({
      kind: "upsert",
      boxId,
      sscc: BOX_SSCC,
      palletId: pallet.id,
      // Raw 18 digits: this feed is device-facing, never AI-00 formatted.
      palletSscc: warehouseSscc,
      palletActive: true,
      closedAt: BOX_CLOSED_AT,
      productionDate: PRODUCTION_DATE,
    });
    expect(warehouseSscc).toMatch(/^[0-9]{18}$/);
  });

  it("emits a palletActive:false delta after the cabinet disassembles the pallet", async () => {
    // The cabinet only resolves a pallet line through the pallet's shift, so
    // the shift closes first and the production pallet is the target.
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);

    const created = await agent.post("/disaggregation").send({}).expect(201);
    const documentId = (created.body as { id: string }).id;
    await agent.patch(`/disaggregation/${documentId}`).send({ reasonId }).expect(200);
    await agent
      .post(`/disaggregation/${documentId}/lines`)
      .send({ ssccs: [`(00)${productionPalletSscc}`] })
      .expect(201);
    const detail = await agent.get(`/disaggregation/${documentId}`).expect(200);
    expect((detail.body as { lines: Array<{ status: string }> }).lines[0]?.status).toBe("ok");

    const before = await registry();
    await agent.post(`/disaggregation/${documentId}/apply`).expect(200);

    const page = await registry({ since: before.until });
    expect(findBox(page, PALLET_BOX_SSCC)).toMatchObject({
      kind: "upsert",
      boxId: palletBoxId,
      // The membership itself is the durable record that the box stood there;
      // only `palletActive` flips, and that is what frees the box.
      palletId: productionPalletId,
      palletSscc: productionPalletSscc,
      palletActive: false,
      closedAt: BOX_CLOSED_AT,
      productionDate: PRODUCTION_DATE,
    });
  });
});
