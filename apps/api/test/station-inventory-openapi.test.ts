import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

type JsonSchema = {
  type?: string;
  format?: string;
  pattern?: string;
  enum?: unknown[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
};

function operation(document: OpenAPIObject, path: string, method: "get" | "post") {
  const value = document.paths[path]?.[method];
  expect(value, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
  return value!;
}

function responseSchema(document: OpenAPIObject, path: string, method: "get" | "post"): JsonSchema {
  const response = operation(document, path, method).responses["200"];
  if (!response || "$ref" in response) throw new Error("Missing inline response");
  const schema = (response.content as Record<string, { schema?: JsonSchema }> | undefined)?.[
    "application/json"
  ]?.schema;
  if (!schema) throw new Error("Missing JSON response schema");
  return schema;
}

function requestSchema(document: OpenAPIObject, path: string): JsonSchema {
  const body = operation(document, path, "post").requestBody;
  if (!body || "$ref" in body) throw new Error("Missing inline request body");
  const schema = (body.content as Record<string, { schema?: JsonSchema }>)["application/json"]
    ?.schema;
  if (!schema) throw new Error("Missing JSON request schema");
  return schema;
}

function exactClosedObject(
  schema: JsonSchema,
  fields: readonly string[],
  required: readonly string[] = fields,
): void {
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
  expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
  expect(schema.additionalProperties).toBe(false);
}

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station inventory OpenAPI contract", () => {
  let setup: AuthSetup;
  let app: INestApplication | undefined;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it("documents station-only task, immutable bundle, sync, progress, and leave routes", () => {
    for (const [path, method] of [
      ["/station/inventory-tasks", "get"],
      ["/station/inventory-tasks/resolve-barcode", "post"],
      ["/station/inventories/{id}/join", "post"],
      ["/station/inventories/{id}/bundle/manifest", "get"],
      ["/station/inventories/{id}/bundle/codes", "get"],
      ["/station/inventories/{id}/event-batches", "post"],
      ["/station/inventories/{id}/progress", "get"],
      ["/station/inventories/{id}/leave", "post"],
    ] as const) {
      operation(document, path, method);
    }
  });

  it("pins closed batch outcomes, progress changes, and the zero-work leave contract", () => {
    const batch = requestSchema(document, "/station/inventories/{id}/event-batches");
    exactClosedObject(batch, [
      "batchId",
      "payloadDigest",
      "snapshotId",
      "snapshotRevision",
      "sequenceCeiling",
      "pendingEventCount",
      "openBoxCount",
      "events",
    ]);
    expect(batch.properties?.events?.items?.additionalProperties).toBe(false);
    expect(batch.properties?.events?.items?.required).toContain("operatorId");
    expect(batch.properties?.events?.maxItems).toBe(100);
    expect(batch.properties?.events?.items?.properties?.kind?.enum).toContain("repack_action");
    const repackActions = batch.properties?.events?.items?.properties?.repack?.oneOf;
    expect(repackActions).toHaveLength(9);
    const conflictResolution = repackActions?.find((item) =>
      item.properties?.action?.enum?.includes("resolve-conflict"),
    );
    exactClosedObject(conflictResolution ?? {}, ["action", "boxId", "reason", "changedAt"]);
    expect(conflictResolution?.properties?.reason?.enum).toEqual(["claim-lost"]);
    const printOutcome = repackActions?.find((item) =>
      item.properties?.action?.enum?.includes("print-outcome"),
    );
    exactClosedObject(printOutcome ?? {}, [
      "action",
      "boxId",
      "sscc",
      "attemptId",
      "attemptNumber",
      "result",
      "errorCode",
      "attemptedAt",
      "completedAt",
    ]);
    expect(printOutcome?.properties?.sscc?.pattern).toBe("^[0-9]{18}$");
    expect(printOutcome?.properties?.errorCode?.enum).toEqual([
      "template_missing",
      "printer_unconfigured",
      "render_failed",
      "transport_failed",
      "persistence_failed",
    ]);

    const batchResponse = responseSchema(
      document,
      "/station/inventories/{id}/event-batches",
      "post",
    );
    const outcome = batchResponse.properties?.outcomes?.items ?? {};
    expect(outcome.additionalProperties).toBe(false);
    expect(outcome.required).toEqual([
      "eventId",
      "status",
      "reasonCode",
      "claimedCount",
      "conflictCount",
      "claims",
    ]);
    expect(outcome.properties?.status?.enum).toEqual([
      "applied",
      "replay",
      "duplicate",
      "rejected",
      "quarantined",
    ]);
    expect(outcome.properties?.reasonCode?.enum).toEqual([
      "CLAIM_APPLIED",
      "CLAIM_LOST",
      "BATCH_REPLAY",
      "INVENTORY_EVENT_REJECTED",
      "INVENTORY_CLOSED",
      "INVENTORY_COMPLETED",
    ]);
    const claim = outcome.properties?.claims?.items ?? {};
    expect(claim.additionalProperties).toBe(false);
    expect(claim.required).toEqual(["codeHash", "status", "winner"]);
    expect(claim.properties?.winner?.additionalProperties).toBe(false);

    const progress = responseSchema(document, "/station/inventories/{id}/progress", "get");
    const change = progress.properties?.items?.items ?? {};
    expect(change.discriminator).toEqual({ propertyName: "kind" });
    expect(change.oneOf).toHaveLength(4);
    const [codeChange, removeItem, invalidateBox, reprint] = change.oneOf ?? [];
    exactClosedObject(codeChange ?? {}, [
      "id",
      "revision",
      "kind",
      "codeHash",
      "classification",
      "observedProductionDate",
      "winner",
      "correctedAt",
    ]);
    expect(codeChange?.properties?.kind?.enum).toEqual(["claim", "correction"]);
    exactClosedObject(removeItem ?? {}, [
      "id",
      "revision",
      "kind",
      "boxId",
      "resultId",
      "codeHash",
      "ownerDeviceId",
      "correctedAt",
    ]);
    expect(removeItem?.properties?.kind?.enum).toEqual(["remove_item"]);
    for (const [variant, kind] of [
      [invalidateBox, "invalidate_box"],
      [reprint, "reprint"],
    ] as const) {
      exactClosedObject(variant ?? {}, [
        "id",
        "revision",
        "kind",
        "boxId",
        "ownerDeviceId",
        "correctedAt",
      ]);
      expect(variant?.properties?.kind?.enum).toEqual([kind]);
    }
    expect(progress.properties?.items?.maxItems).toBe(200);
    const cursorPattern =
      "^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
    expect(progress.properties?.cursor?.pattern).toBe(cursorPattern);
    expect(progress.properties?.nextCursor?.pattern).toBe(cursorPattern);

    const leave = requestSchema(document, "/station/inventories/{id}/leave");
    exactClosedObject(leave, ["pendingEventCount", "openBoxCount"]);
    expect(leave.properties?.pendingEventCount?.enum).toEqual([0]);
    expect(leave.properties?.openBoxCount?.minimum).toBe(0);
    expect(leave.properties?.openBoxCount?.enum).toBeUndefined();
    exactClosedObject(responseSchema(document, "/station/inventories/{id}/leave", "post"), [
      "outcome",
    ]);
  });

  it("pins strict barcode/join inputs and does not admit a caller-selected line or tenant", () => {
    const barcode = requestSchema(document, "/station/inventory-tasks/resolve-barcode");
    exactClosedObject(barcode, ["barcode"]);
    expect(barcode.properties?.barcode).toEqual({ type: "string", maxLength: 128 });

    const join = requestSchema(document, "/station/inventories/{id}/join");
    exactClosedObject(join, ["operatorId", "barcode", "confirmDifferentLine"], ["operatorId"]);
    expect(join.properties).toEqual({
      operatorId: { type: "string", format: "uuid" },
      barcode: { type: "string", maxLength: 128 },
      confirmDifferentLine: { type: "boolean" },
    });
    expect(JSON.stringify(join)).not.toMatch(/tenantId|deviceId|lineId/);
  });

  it("pins immutable manifest identity, SSCC cursor, and bounded deterministic code pages", () => {
    const manifest = responseSchema(document, "/station/inventories/{id}/bundle/manifest", "get");
    expect(manifest.properties).toMatchObject({
      snapshotId: { type: "string", format: "uuid" },
      snapshotRevision: { type: "integer", minimum: 1, maximum: 1 },
      snapshotFixedAt: { type: "string", format: "date-time" },
      combinedDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      contentDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      codeCount: { type: "integer", minimum: 0 },
      boxCapacity: { type: "integer", minimum: 1 },
    });
    expect(manifest.required).toContain("boxCapacity");
    const sscc = manifest.properties?.sscc;
    if (!sscc) throw new Error("Missing SSCC schema");
    expect(sscc.nullable).toBe(true);
    exactClosedObject(sscc, [
      "allocationOrder",
      "issuerPrefix",
      "extensionDigit",
      "fromSerial",
      "toSerial",
      "consumedThroughSerial",
    ]);
    expect(sscc.properties?.allocationOrder).toEqual({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(sscc.properties?.consumedThroughSerial?.nullable).toBe(true);
    const revokedBlocks = manifest.properties?.ssccRevokedBlocks;
    expect(revokedBlocks?.type).toBe("array");
    exactClosedObject(revokedBlocks?.items ?? {}, ["allocationOrder", "fromSerial", "toSerial"]);
    expect(revokedBlocks?.items?.properties?.allocationOrder).toEqual({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });

    const page = responseSchema(document, "/station/inventories/{id}/bundle/codes", "get");
    exactClosedObject(page, [
      "snapshotId",
      "snapshotRevision",
      "snapshotFixedAt",
      "combinedDigest",
      "contentDigest",
      "cursor",
      "items",
      "nextCursor",
      "pageDigest",
    ]);
    expect(page.properties?.items?.items?.properties).toMatchObject({
      codeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      canonicalRaw: { type: "string", maxLength: 1024 },
      sourceStatus: {
        type: "string",
        enum: ["EMITTED", "INTRODUCED", "APPLIED", "RETIRED", "WRITTEN_OFF", "DISAGGREGATION"],
      },
    });
    expect(JSON.stringify({ manifest, page })).not.toMatch(/objectKey|fileName|private\//i);

    const operationJson = operation(document, "/station/inventories/{id}/bundle/codes", "get");
    const limit = operationJson.parameters?.find(
      (parameter) => !("$ref" in parameter) && parameter.name === "limit",
    );
    expect(limit && !("$ref" in limit) ? limit.schema : undefined).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 200,
    });
  });
});
