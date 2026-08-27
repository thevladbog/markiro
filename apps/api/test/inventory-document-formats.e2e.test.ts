import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { inventoryDocumentFormatsResponseSchema } from "../src/modules/inventories/inventory-document-formats.dto";
import {
  createTestStationDevice,
  setOnlyOrganizationMemberRole,
  signUpAndActivate,
} from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const expectedFormats = {
  items: [
    {
      id: "inventory_xml_gismt_aggregation",
      version: 2,
      label: "[XML][ГИСМТ] Формирование упаковки",
      extension: "xml",
      mimeType: "application/xml; charset=utf-8",
      requiredSourceCategories: ["verified", "protected", "newBoxes"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_xml_gismt_disaggregation",
      version: 1,
      label: "[XML][ГИСМТ] Расформирование упаковки",
      extension: "xml",
      mimeType: "application/xml; charset=utf-8",
      requiredSourceCategories: ["verified", "protected", "newBoxes"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_txt_write_off",
      version: 1,
      label: "[TXT] Коды к списанию",
      extension: "txt",
      mimeType: "text/plain; charset=utf-8",
      requiredSourceCategories: ["writeOffCandidates", "protected"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_csv_write_off",
      version: 1,
      label: "[CSV] Коды к списанию",
      extension: "csv",
      mimeType: "text/csv; charset=utf-8",
      requiredSourceCategories: ["writeOffCandidates", "protected"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_csv_current_stock",
      version: 1,
      label: "[CSV] Коды на учёт",
      extension: "csv",
      mimeType: "text/csv; charset=utf-8",
      requiredSourceCategories: ["verified", "protected"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_csv_final_box_contents",
      version: 1,
      label: "[CSV] Состав итоговых коробов",
      extension: "csv",
      mimeType: "text/csv; charset=utf-8",
      requiredSourceCategories: ["verified", "protected", "newBoxes"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_txt_final_boxes",
      version: 1,
      label: "[TXT] Номера итоговых коробов",
      extension: "txt",
      mimeType: "text/plain; charset=utf-8",
      requiredSourceCategories: ["verified", "protected", "newBoxes"],
      supportsParts: false,
      availability: "available",
    },
    {
      id: "inventory_csv_balances_by_production_date",
      version: 1,
      label: "[CSV] Остатки по датам производства",
      extension: "csv",
      mimeType: "text/csv; charset=utf-8",
      requiredSourceCategories: ["verified", "protected", "newBoxes"],
      supportsParts: false,
      availability: "available",
    },
  ],
};

describe.skipIf(!ready)("inventory document formats e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const env = loadEnv({
      ...process.env,
      ...PLATFORM_TEST_ENV,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
    });
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
    );
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  async function owner() {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    return { agent, tenantId };
  }

  async function seedClosedInventory(tenantId: string): Promise<string> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected catalog acceptance actor");
    const productId = randomUUID();
    const lineId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600000000015",
      name: "Catalog acceptance product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Catalog acceptance line" });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: "04600000000015",
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: member.userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "a".repeat(64),
      productName: "Catalog acceptance product",
      lineName: "Catalog acceptance line",
      boxCapacity: null,
      emittedCount: 0,
      introducedCount: 0,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 0,
      packageCount: 0,
      looseCount: 0,
      fixedByUserId: member.userId,
    });
    await db
      .update(schema.inventories)
      .set({
        status: "closed",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        resultRevision: 1,
        startedByUserId: member.userId,
        startedAt: new Date("2026-08-27T08:00:00.000Z"),
        closedByUserId: member.userId,
        closedAt: new Date("2026-08-27T09:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    return inventoryId;
  }

  it("advertises the exact eight current formats and rejects unknown and hidden versions", async () => {
    const { agent, tenantId } = await owner();
    const closedInventoryId = await seedClosedInventory(tenantId);
    await agent.get("/inventory-document-formats").expect(200, expectedFormats);
    await agent
      .post(`/inventories/${randomUUID()}/document-runs`)
      .send({
        selectedFormats: [{ id: "synthetic_stock", version: 1 }],
        idempotencyKey: randomUUID(),
      })
      .expect(400, { code: "INVENTORY_DOCUMENT_FORMAT_UNKNOWN" });
    await agent
      .post(`/inventories/${closedInventoryId}/document-runs`)
      .send({
        selectedFormats: [{ id: "inventory_xml_gismt_aggregation", version: 1 }],
        idempotencyKey: randomUUID(),
      })
      .expect(400, { code: "INVENTORY_DOCUMENT_FORMAT_SUPERSEDED" });
  });

  it("requires operations.read and rejects station credentials", async () => {
    const denied = await owner();
    await setOnlyOrganizationMemberRole(db, denied.tenantId, "member");
    await denied.agent.get("/inventory-document-formats").expect(403);

    const stationOwner = await owner();
    const station = await createTestStationDevice(app!, stationOwner.agent, "Formats station");
    await request(app!.getHttpServer())
      .get("/inventory-document-formats")
      .set("x-api-key", station.apiKey)
      .expect(403);
  });

  it("remains available when a managed subscription becomes read-only", async () => {
    const { agent, tenantId } = await owner();
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    const subscription = await createManagedSubscription(db, { tenantId, planVersionId });
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));

    await agent.get("/inventory-document-formats").expect(200, expectedFormats);
  });

  it("publishes the exact strict response schema without unavailable candidate ids", () => {
    const operation = document.paths["/inventory-document-formats"]?.get;
    expect(operation).toBeDefined();
    const response = operation?.responses["200"];
    if (!response || "$ref" in response) throw new Error("Missing inline response");
    const schema = response.content?.["application/json"]?.schema as JsonSchema | undefined;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["items"],
    });
    expect(Object.keys(schema?.properties ?? {})).toEqual(["items"]);
    const item = schema?.properties?.items?.items;
    expect(item).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "version",
        "label",
        "extension",
        "mimeType",
        "requiredSourceCategories",
        "supportsParts",
        "availability",
      ],
    });
    expect(Object.keys(item?.properties ?? {})).toEqual([
      "id",
      "version",
      "label",
      "extension",
      "mimeType",
      "requiredSourceCategories",
      "supportsParts",
      "availability",
    ]);
    expect(item?.properties?.availability?.enum).toEqual(["available"]);
    expect(item?.properties?.id?.enum).toBeUndefined();
    expect(item?.properties?.mimeType?.pattern).toBe(
      "^[^\\s/;]+\\/[^\\s/;]+(?:; charset=[a-z0-9-]+)?$",
    );
    expect(item?.properties?.requiredSourceCategories).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    });
  });

  it("rejects unknown response properties and unavailable internal descriptors", () => {
    expect(() =>
      inventoryDocumentFormatsResponseSchema.parse({ items: [], extra: true }),
    ).toThrow();
    expect(() =>
      inventoryDocumentFormatsResponseSchema.parse({
        items: [
          {
            id: "synthetic_unavailable",
            version: 1,
            label: "Synthetic unavailable",
            extension: "xml",
            mimeType: "application/xml; charset=utf-8",
            requiredSourceCategories: ["newBoxes"],
            supportsParts: false,
            availability: "unavailable",
          },
        ],
      }),
    ).toThrow();
  });
});
