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
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

interface LineWire {
  id: string;
  ssccInput: string;
  sscc: string | null;
  boxId: string | null;
  palletId: string | null;
  status: string;
  productId: string | null;
  codeCount: number;
}

interface DocumentDetailWire {
  id: string;
  status: string;
  reasonName: string | null;
  lines: LineWire[];
}

/**
 * Security regression: tenant B must never be able to reach tenant A's
 * disaggregation documents or reasons through any of the write/read
 * endpoints, even when it has a valid ID from tenant A (e.g. leaked via
 * logs/screenshots). Every endpoint is guarded by `TenantGuard` scoping
 * every query to `req.tenantId`, so a foreign id should 404 exactly like an
 * unknown one -- never 403 (which would leak "this id exists, just not for
 * you").
 */
describe.skipIf(!ready)("cross-tenant disaggregation e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;
  let tenantAId: string;
  let tenantBId: string;

  // Tenant A fixture used by the cross-tenant SSCC-resolution tests below:
  // one closed box on one closed pallet, both on a closed shift, so both
  // rows are genuinely "ok"-resolvable -- not merely present.
  let stationKeyA: string;
  let productIdA: string;
  let operatorIdA: string;
  let fixtureBoxSscc: string;
  let fixturePalletSscc: string;
  const VALID_GTIN14 = "04006381333931";
  const SSCC_PREFIX = "987654321"; // distinct 9-digit prefix from other e2e suites' fixtures
  let ssccSerial = 0;
  let codeLabelSeq = 0;

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

    agentA = request.agent(app!.getHttpServer());
    tenantAId = await signUpAndActivate(agentA);
    agentB = request.agent(app!.getHttpServer());
    tenantBId = await signUpAndActivate(agentB);

    const station = await createTestStationDevice(app!, agentA, "Cross-tenant SSCC fixture");
    stationKeyA = station.apiKey;

    const product = await agentA
      .post("/products")
      .send({
        name: "Cross-tenant fixture product",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    productIdA = (product.body as { id: string }).id;

    const operatorRes = await agentA
      .post("/employees")
      .send({ fullName: "Fixture Operator" })
      .expect(201);
    operatorIdA = (operatorRes.body as { id: string }).id;

    const fixture = await createTenantAFixture();
    fixtureBoxSscc = fixture.boxSscc;
    fixturePalletSscc = fixture.palletSscc;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A genuine, checksum-valid 18-digit SSCC, distinct on every call. */
  function nextSscc(): string {
    return buildSscc(0, SSCC_PREFIX, ssccSerial++);
  }

  function scanItem(
    shiftId: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    const label = `xt-${codeLabelSeq++}`;
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

  async function postBatchA(body: Record<string, unknown>) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKeyA)
      .send({ batchId: `xt-dsg-${randomUUID()}`, items: [], ...body })
      .expect(201);
  }

  async function openShiftA(): Promise<string> {
    const shift = await agentA
      .post("/shifts")
      .send({ productId: productIdA, mode: "validation" })
      .expect(201);
    const id = (shift.body as { id: string }).id;
    await agentA.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  /**
   * Tenant A's closed box + closed pallet (shift also closed), created once
   * and reused by both cross-tenant assertions below. SSCCs are built from a
   * counter that restarts at 0 in every process run and this suite may run
   * against a shared, not-torn-down database (see disaggregation-pallets.e2e
   * for the same caveat), so every DB assertion below scopes by tenantId, not
   * just sscc.
   */
  async function createTenantAFixture(): Promise<{ boxSscc: string; palletSscc: string }> {
    const shiftId = await openShiftA();
    const base = Date.parse("2026-09-11T11:00:00.000Z");
    const items = Array.from({ length: 12 }, (_, i) =>
      scanItem(shiftId, "t1", new Date(base + i * 1000).toISOString(), "b1"),
    );
    await postBatchA({ items });

    const boxSscc = nextSscc();
    await postBatchA({
      boxes: [
        {
          boxId: "b1",
          shiftId,
          terminalId: "t1",
          sscc: boxSscc,
          closedAt: "2026-09-11T11:30:00.000Z",
          operatorId: operatorIdA,
          devicePalletId: "p1",
        },
      ],
    });

    const palletSscc = nextSscc();
    await postBatchA({
      pallets: [
        {
          palletId: "p1",
          shiftId,
          terminalId: "t1",
          sscc: palletSscc,
          closedAt: "2026-09-11T12:00:00.000Z",
          operatorId: operatorIdA,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });

    await agentA.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);
    return { boxSscc, palletSscc };
  }

  async function findBoxBySscc(tenantId: string, sscc: string) {
    const [box] = await db
      .select()
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)));
    if (!box) throw new Error(`Expected a box with sscc ${sscc} for tenant ${tenantId}`);
    return box;
  }

  async function findPalletBySscc(tenantId: string, sscc: string) {
    const [pallet] = await db
      .select()
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, sscc)));
    if (!pallet) throw new Error(`Expected a pallet with sscc ${sscc} for tenant ${tenantId}`);
    return pallet;
  }

  function ai00(sscc: string): string {
    return `(00)${sscc}`;
  }

  async function addLinesAsAgent(
    agent: ReturnType<typeof request.agent>,
    lines: string[],
  ): Promise<DocumentDetailWire> {
    const created = await agent.post("/disaggregation").send({}).expect(201);
    const id = (created.body as { id: string }).id;
    await agent.post(`/disaggregation/${id}/lines`).send({ ssccs: lines }).expect(201);
    return (await agent.get(`/disaggregation/${id}`).expect(200)).body as DocumentDetailWire;
  }

  it("org B gets 404 on org A's disaggregation document and reason across every mutating/reading route", async () => {
    const reasonRes = await agentA
      .post("/disaggregation-reasons")
      .send({ name: "Брак упаковки" })
      .expect(201);
    const reasonId = (reasonRes.body as { id: string }).id;

    const docRes = await agentA.post("/disaggregation").send({}).expect(201);
    const docId = (docRes.body as { id: string }).id;
    await agentA.patch(`/disaggregation/${docId}`).send({ reasonId }).expect(200);

    await agentB.get(`/disaggregation/${docId}`).expect(404);
    await agentB.patch(`/disaggregation/${docId}`).send({ comment: "hijack" }).expect(404);
    await agentB.post(`/disaggregation/${docId}/cancel`).expect(404);
    await agentB.post(`/disaggregation/${docId}/apply`).expect(404);
    await agentB
      .patch(`/disaggregation-reasons/${reasonId}`)
      .send({ name: "Hijacked" })
      .expect(404);
  });

  it("fixture sanity check: tenant A's own box and pallet SSCCs genuinely resolve to ok", async () => {
    // Ground truth for the denial test below -- if this ever stopped
    // resolving "ok", a not_found there would prove nothing about
    // tenant-scoping.
    const box = await findBoxBySscc(tenantAId, fixtureBoxSscc);
    const pallet = await findPalletBySscc(tenantAId, fixturePalletSscc);

    const doc = await addLinesAsAgent(agentA, [ai00(fixtureBoxSscc), ai00(fixturePalletSscc)]);

    // `line.sscc` comes back AI-formatted ("00" + bare 18 digits, per
    // dto.ts), so lines are disambiguated by `ssccInput` -- the exact raw
    // string this test posted -- not by comparing against the bare value.
    const boxLine = doc.lines.find((l) => l.ssccInput === ai00(fixtureBoxSscc));
    const palletLine = doc.lines.find((l) => l.ssccInput === ai00(fixturePalletSscc));
    expect(boxLine).toMatchObject({ status: "ok", boxId: box.id, palletId: null });
    expect(palletLine).toMatchObject({ status: "ok", boxId: null, palletId: pallet.id });
  });

  it("org B naming org A's box or pallet SSCC as a disaggregation line gets not_found, never org A's row", async () => {
    // Closing the pre-existing coverage gap: neither validateBoxCandidates
    // nor validatePalletCandidates had a cross-tenant denial test (only
    // document/reason ID access was covered above). Both resolvers scope
    // their lookup by tenantId, so tenant B naming tenant A's real, closed
    // box/pallet SSCC must resolve exactly like an unknown SSCC -- not_found,
    // with no box/pallet/product id leaking into the response -- never
    // tenant A's actual row. Re-confirms (see the sanity-check test above)
    // that both rows genuinely exist and resolve "ok" for their own tenant,
    // so this not_found is denial, not "nothing to find".
    await findBoxBySscc(tenantAId, fixtureBoxSscc);
    await findPalletBySscc(tenantAId, fixturePalletSscc);

    const doc = await addLinesAsAgent(agentB, [ai00(fixtureBoxSscc), ai00(fixturePalletSscc)]);

    // Same AI-formatting caveat as above: disambiguate by `ssccInput`.
    const boxLine = doc.lines.find((l) => l.ssccInput === ai00(fixtureBoxSscc));
    const palletLine = doc.lines.find((l) => l.ssccInput === ai00(fixturePalletSscc));
    expect(boxLine).toMatchObject({
      status: "not_found",
      boxId: null,
      palletId: null,
      productId: null,
      codeCount: 0,
    });
    expect(palletLine).toMatchObject({
      status: "not_found",
      boxId: null,
      palletId: null,
      productId: null,
      codeCount: 0,
    });

    // And confirm no row was ever created under tenant B's own id for these
    // exact SSCC values -- the miss is denial, not an accidental cross-tenant
    // write triggered by this test.
    const boxesUnderB = await db
      .select()
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantBId), eq(schema.boxes.sscc, fixtureBoxSscc)));
    expect(boxesUnderB).toHaveLength(0);
    const palletsUnderB = await db
      .select()
      .from(schema.pallets)
      .where(
        and(eq(schema.pallets.tenantId, tenantBId), eq(schema.pallets.sscc, fixturePalletSscc)),
      );
    expect(palletsUnderB).toHaveLength(0);
  });
});
