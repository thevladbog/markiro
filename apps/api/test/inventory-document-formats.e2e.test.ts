import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { eq } from "drizzle-orm";
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

  it("advertises no format until an approved checked-in contract fixture exists", async () => {
    const { agent } = await owner();
    await agent.get("/inventory-document-formats").expect(200, { items: [] });
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

    await agent.get("/inventory-document-formats").expect(200, { items: [] });
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
