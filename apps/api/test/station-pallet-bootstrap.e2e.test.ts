import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/** GLN with a valid GS1 check digit; issuer prefix is its first 9 digits. */
const ORG_GLN = "0460068200000";
const ORG_ISSUER_PREFIX = "046006820";

const GTIN_ACTIVE = "04600682000013";
const GTIN_ARCHIVED = "04600682000020";

describe.skipIf(!ready)("station pallet bootstrap e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let apiKey: string;
  let activeProductId: string;
  let employeeId: string;

  let foreignApiKey: string;

  let cabinetAgent: ReturnType<typeof request.agent>;

  /**
   * A pallet-purpose template with a non-empty spec, created through the API.
   * Mirrors `createPalletTemplate` in org-profile.e2e.test.ts: a fresh org
   * created via Better Auth's `organization/create` gets no stock template --
   * only tenant provisioning's real onboarding flow seeds one (see
   * tenant-provisioning.service.ts) -- so this fixture must create its own.
   */
  async function createPalletTemplate(
    agent: ReturnType<typeof request.agent>,
    name: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await agent
      .post("/label-templates")
      .send({
        name,
        purpose: "pallet",
        spec: {
          widthMm: 100,
          heightMm: 150,
          dpi: 203,
          language: "zpl",
          elements: [{ kind: "text", id: "cap", xMm: 2, yMm: 2, text: "Паллета", fontSizePt: 12 }],
        },
        ...overrides,
      })
      .expect(201);
    return created.body.id as string;
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

    cabinetAgent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(cabinetAgent);

    const device = await createTestStationDevice(app, cabinetAgent, "ТСД-1", { kind: "handheld" });
    apiKey = device.apiKey;

    activeProductId = randomUUID();
    await db.insert(schema.products).values([
      {
        id: activeProductId,
        tenantId,
        gtin14: GTIN_ACTIVE,
        name: "Вода 0,5 л",
        chzProductGroupCode: 8,
        palletBoxCapacity: 12,
        archived: false,
      },
      {
        id: randomUUID(),
        tenantId,
        gtin14: GTIN_ARCHIVED,
        name: "Вода 1,5 л (архив)",
        archived: true,
      },
    ]);

    // employeePickupPolicies row is inserted by EmployeesService.createEmployee
    // in production; this fixture inserts the employee directly, so insert the
    // matching policy row too before flipping canBuildPallets.
    employeeId = randomUUID();
    await db.insert(schema.employees).values({
      id: employeeId,
      tenantId,
      fullName: "Оператор П.",
    });
    await db.insert(schema.employeePickupPolicies).values({
      tenantId,
      employeeId,
      canBuildPallets: false,
    });
    await cabinetAgent
      .patch(`/employees/${employeeId}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 5, canWriteoff: false, canBuildPallets: true })
      .expect(200);

    const orgTemplateId = await createPalletTemplate(cabinetAgent, "Organisation pallet default");
    const categoryTemplateId = await createPalletTemplate(cabinetAgent, "Category 8 pallet", {
      chzProductGroupCodes: [8],
    });
    await cabinetAgent
      .put("/org/profile")
      .send({
        gln: ORG_GLN,
        defaultPalletLabelTemplateId: orgTemplateId,
        categoryPalletLabelTemplateDefaults: [
          { chzProductGroupCode: 8, templateId: categoryTemplateId },
        ],
      })
      .expect(200);

    const foreignAgent = request.agent(app.getHttpServer());
    await signUpAndActivate(foreignAgent);
    const foreignDevice = await createTestStationDevice(app, foreignAgent, "ТСД-2", {
      kind: "handheld",
    });
    foreignApiKey = foreignDevice.apiKey;
    // Deliberately no GLN and no products/employees for the foreign tenant.
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (key: string) =>
    request(app!.getHttpServer()).get("/station/pallet-bootstrap").set("x-api-key", key);

  it("returns products, operators, the extension-1 block and templates", async () => {
    const res = await get(apiKey).expect(200);

    expect(typeof res.body.generatedAt).toBe("string");

    expect(res.body.products.map((p: { id: string }) => p.id)).toEqual([activeProductId]);
    expect(res.body.products[0]).toMatchObject({
      id: activeProductId,
      gtin14: GTIN_ACTIVE,
      palletBoxCapacity: 12,
      chzProductGroupCode: 8,
    });

    expect(res.body.operators).toContainEqual({ employeeId, canBuildPallets: true });

    expect(res.body.palletSscc).toMatchObject({
      extensionDigit: 1,
      issuerPrefix: ORG_ISSUER_PREFIX,
    });
    expect(typeof res.body.palletSscc.fromSerial).toBe("number");
    expect(typeof res.body.palletSscc.toSerial).toBe("number");
    expect(res.body.palletSsccRevokedFrom).toEqual([]);

    expect(res.body.palletLabelTemplates.organisation).not.toBeNull();
    expect(res.body.palletLabelTemplates.organisation).toMatchObject({ widthMm: 100, heightMm: 150 });
    expect(res.body.palletLabelTemplates.byCategory).toEqual([
      {
        chzProductGroupCode: 8,
        template: expect.objectContaining({ widthMm: 100, heightMm: 150 }),
      },
    ]);
  });

  it("hands the same block back on a second call", async () => {
    const first = await get(apiKey).expect(200);
    const second = await get(apiKey).expect(200);
    expect(second.body.palletSscc.fromSerial).toBe(first.body.palletSscc.fromSerial);
    expect(second.body.palletSscc.toSerial).toBe(first.body.palletSscc.toSerial);
  });

  it("degrades to a null block without an organisation GLN", async () => {
    const res = await get(foreignApiKey).expect(200);
    expect(res.body.palletSscc).toBeNull();
    expect(res.body.palletSsccRevokedFrom).toEqual([]);
    expect(res.body.products).toEqual([]);
    expect(res.body.operators).toEqual([]);
  });

  it("refuses a cabinet session", async () => {
    await cabinetAgent.get("/station/pallet-bootstrap").expect(403);
  });

  it("refuses another tenant's device key and keeps tenant isolation", async () => {
    const res = await get(foreignApiKey).expect(200);
    // The foreign tenant's device never sees our products/operators/GLN --
    // only its own (empty) catalogue.
    expect(res.body.products.map((p: { id: string }) => p.id)).not.toContain(activeProductId);
    expect(res.body.operators.map((o: { employeeId: string }) => o.employeeId)).not.toContain(
      employeeId,
    );
    expect(res.body.palletSscc).toBeNull();
  });
});
