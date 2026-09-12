import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Same fixture as sscc.e2e.test.ts.
const VALID_GTIN14 = "04006381333931";
// org-profile's PUT only validates /^\d{13}$/ (see org-profile/dto.ts) --
// no GS1 check digit -- and sscc_counters/sscc_blocks are keyed on
// (tenantId, issuerPrefix, extensionDigit), so every fresh tenant created
// below can safely reuse the SAME GLN without its box/pallet serial spaces
// colliding with another tenant's.
const ORG_GLN = "4601112222005";
const ISSUER_PREFIX = ORG_GLN.slice(0, 9);
const PALLET_EXTENSION_DIGIT = 1;
// Matches SsccService.allocate's own capacity ceiling for a 9-digit issuer
// prefix (10 ** (16 - 9)); see sscc.e2e.test.ts's capacity-boundary suite.
const CAPACITY = 10_000_000;

interface BundleSsccBlock {
  issuerPrefix: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
  consumedThroughSerial: number | null;
}

interface ShiftBundleResponse {
  product: unknown;
  operators: unknown[];
  sscc: BundleSsccBlock | null;
  palletSscc: BundleSsccBlock | null;
}

describe.skipIf(!ready)("pallet serial blocks in the shift bundle (Task 7)", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

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
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * A fresh tenant with an org GLN, a default box label template, an active
   * operator and an enrolled station device -- everything `getBundle` needs
   * besides the shift itself. Every test gets its OWN tenant so mutating one
   * test's sscc_counters (e.g. exhausting the pallet counter) can never bleed
   * into another test's expectations.
   */
  async function setupTenant(): Promise<{
    agent: ReturnType<typeof request.agent>;
    tenantId: string;
    productId: string;
    apiKey: string;
  }> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await agent.put("/org/profile").send({ gln: ORG_GLN }).expect(200);

    const boxLabelTemplateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: boxLabelTemplateId,
      tenantId,
      name: "Pallet bundle test template",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    await agent
      .put("/org/profile")
      .send({ defaultBoxLabelTemplateId: boxLabelTemplateId })
      .expect(200);

    // Every test below opens a pallets-enabled shift, and the shift service
    // now refuses to enable pallets with no resolvable pallet label template.
    const palletLabelTemplateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: palletLabelTemplateId,
      tenantId,
      name: "Pallet bundle test pallet template",
      purpose: "pallet",
      spec: { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements: [] },
    });
    await agent
      .put("/org/profile")
      .send({ defaultPalletLabelTemplateId: palletLabelTemplateId })
      .expect(200);

    const product = await agent
      .post("/products")
      .send({
        name: "Pallet Cola",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const productId = (product.body as { id: string }).id;

    const employee = await agent
      .post("/employees")
      .send({ fullName: "Оператор паллет" })
      .expect(201);
    await agent
      .put(`/operators/${employee.body.id}`)
      .send({ login: "3400", pin: "1234" })
      .expect(200);

    const device = await createTestStationDevice(app!, agent, "Pallet-block terminal");
    return { agent, tenantId, productId, apiKey: device.apiKey };
  }

  async function openAggregationShift(
    agent: ReturnType<typeof request.agent>,
    productId: string,
    overrides: { palletsEnabled: boolean; palletBoxCapacity?: number },
  ): Promise<{ id: string }> {
    const created = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "aggregation",
        palletsEnabled: overrides.palletsEnabled,
        ...(overrides.palletBoxCapacity !== undefined
          ? { palletBoxCapacity: overrides.palletBoxCapacity }
          : {}),
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return { id };
  }

  async function getBundle(shiftId: string, apiKey: string): Promise<ShiftBundleResponse> {
    const res = await request(app!.getHttpServer())
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", apiKey)
      .expect(200);
    return res.body as ShiftBundleResponse;
  }

  /**
   * Seeds (tenant, ISSUER_PREFIX, extensionDigit)'s counter directly to
   * capacity, bypassing putSscc's own floor check (not under test here) --
   * same technique as sscc.e2e.test.ts's capacity-boundary suite.
   */
  async function exhaustCounter(tenantId: string, extensionDigit: number): Promise<void> {
    await db.insert(schema.ssccCounters).values({
      tenantId,
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit,
      nextSerial: CAPACITY,
    });
  }

  /**
   * Records a pallet closure directly through SsccService.recordConsumedSerial
   * -- the same call a real pallet close will make at ingest -- rather than
   * through an endpoint, since pallet closure itself is a later task.
   */
  async function recordPalletClosure(tenantId: string, serial: number): Promise<void> {
    const svc = app!.get(SsccService);
    await svc.recordConsumedSerial(
      tenantId,
      buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, serial),
    );
  }

  it("hands a pallet block only to a shift with pallets", async () => {
    const { agent, productId, apiKey } = await setupTenant();
    const withPallets = await openAggregationShift(agent, productId, {
      palletsEnabled: true,
      palletBoxCapacity: 12,
    });
    const bundle = await getBundle(withPallets.id, apiKey);
    expect(bundle.palletSscc?.extensionDigit).toBe(1);
    expect(bundle.palletSscc?.issuerPrefix).toBe(bundle.sscc?.issuerPrefix);

    const withoutPallets = await openAggregationShift(agent, productId, { palletsEnabled: false });
    expect((await getBundle(withoutPallets.id, apiKey)).palletSscc).toBeNull();
  });

  it("keeps box and pallet serial spaces apart", async () => {
    const { agent, productId, apiKey } = await setupTenant();
    const shift = await openAggregationShift(agent, productId, {
      palletsEnabled: true,
      palletBoxCapacity: 12,
    });
    const bundle = await getBundle(shift.id, apiKey);
    // Both start their own numbering: digit 0 starts at 1, every other digit at 0.
    expect(bundle.sscc!.fromSerial).toBe(1);
    expect(bundle.palletSscc!.fromSerial).toBe(0);
  });

  it("cuts a smaller block for pallets than for boxes", async () => {
    const { agent, productId, apiKey } = await setupTenant();
    const shift = await openAggregationShift(agent, productId, {
      palletsEnabled: true,
      palletBoxCapacity: 12,
    });
    const bundle = await getBundle(shift.id, apiKey);
    const boxSize = bundle.sscc!.toSerial - bundle.sscc!.fromSerial + 1;
    const palletSize = bundle.palletSscc!.toSerial - bundle.palletSscc!.fromSerial + 1;
    expect(boxSize).toBe(2000);
    expect(palletSize).toBe(200);
  });

  it("degrades the pallet block to null rather than losing the whole bundle", async () => {
    const { agent, tenantId, productId, apiKey } = await setupTenant();
    const shift = await openAggregationShift(agent, productId, {
      palletsEnabled: true,
      palletBoxCapacity: 12,
    });
    await exhaustCounter(tenantId, PALLET_EXTENSION_DIGIT);

    const bundle = await getBundle(shift.id, apiKey);
    expect(bundle.palletSscc).toBeNull();
    // The box block, which is unaffected by the pallet counter's exhaustion,
    // must still be granted -- and so must everything else in the bundle.
    expect(bundle.sscc).not.toBeNull();
    expect(bundle.product).not.toBeNull();
    expect(bundle.operators.length).toBeGreaterThan(0);
  });

  it("returns the same pallet block on a repeat fetch, with its consumed cursor", async () => {
    const { agent, tenantId, productId, apiKey } = await setupTenant();
    const shift = await openAggregationShift(agent, productId, {
      palletsEnabled: true,
      palletBoxCapacity: 12,
    });

    const first = await getBundle(shift.id, apiKey);
    await recordPalletClosure(tenantId, first.palletSscc!.fromSerial + 3);
    const second = await getBundle(shift.id, apiKey);

    expect(second.palletSscc!.fromSerial).toBe(first.palletSscc!.fromSerial);
    expect(second.palletSscc!.consumedThroughSerial).toBe(first.palletSscc!.fromSerial + 3);
  });
});
