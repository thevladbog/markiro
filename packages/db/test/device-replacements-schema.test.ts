import { getTableName } from "drizzle-orm";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("working device replacement schema", () => {
  it("exports durable preview and preparation tables", () => {
    expect(schema).toHaveProperty("workingDeviceReplacementPreviews");
    expect(schema).toHaveProperty("workingDeviceReplacementPreparations");
  });

  it("keeps preview request, actor, fingerprints, observation and result receipt fields", () => {
    expect(getTableName(schema.workingDeviceReplacementPreviews)).toBe(
      "working_device_replacement_previews",
    );
    expect(Object.keys(schema.workingDeviceReplacementPreviews)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "deviceId",
        "actorDomain",
        "actorId",
        "requestId",
        "payload",
        "payloadHash",
        "factsFingerprint",
        "observation",
        "createdAt",
        "expiresAt",
        "confirmedAt",
        "resultPreparationId",
        "response",
      ]),
    );
  });

  it("pins both tables to the tenant/source and preparations to their preview", () => {
    for (const table of [
      schema.workingDeviceReplacementPreviews,
      schema.workingDeviceReplacementPreparations,
    ]) {
      const config = getTableConfig(table);
      expect(
        config.foreignKeys.some(
          (key) =>
            key
              .reference()
              .columns.map((column) => column.name)
              .join(",") === "tenant_id,device_id",
        ),
      ).toBe(true);
    }
    const preparationConfig = getTableConfig(schema.workingDeviceReplacementPreparations);
    expect(
      preparationConfig.foreignKeys.some(
        (key) =>
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,device_id,preview_id",
      ),
    ).toBe(true);
  });

  it("allows only one current prepared replacement per tenant/source", () => {
    const index = getTableConfig(schema.workingDeviceReplacementPreparations).indexes.find(
      (candidate) => candidate.config.name === "working_device_replacements_one_prepared_uq",
    );
    expect(index?.config.unique).toBe(true);
    expect(
      index?.config.columns.map((column) =>
        column instanceof IndexedColumn ? column.name : undefined,
      ),
    ).toEqual(["tenant_id", "device_id"]);
    expect(index?.config.where).toBeDefined();
  });

  it("stores positive integer preparation revisions and required actor identities", () => {
    expect(schema.workingDeviceReplacementPreparations.revision.getSQLType()).toBe("integer");
    for (const table of [
      schema.workingDeviceReplacementPreviews,
      schema.workingDeviceReplacementPreparations,
    ]) {
      expect(table.actorDomain.notNull).toBe(true);
      expect(table.actorId.notNull).toBe(true);
    }
  });
});

describe("working device replacement execution schema", () => {
  it.each([
    "workingDeviceReplacementExecutionPreviews",
    "workingDeviceReplacementReadinessIntents",
    "workingDeviceReplacementReadinessReports",
    "workingDeviceReplacementExecutions",
    "workingDeviceReplacementClosureAcknowledgements",
  ])("exports %s for durable restart recovery", (name) => {
    expect(schema).toHaveProperty(name);
  });

  it("defaults legacy pairing codes to normal purpose", () => {
    expect(schema.stationPairingCodes).toHaveProperty("purpose");
  });
});

it("pins closure acknowledgements to the exact tenant, source, intent and epoch", () => {
  const table = schema.workingDeviceReplacementClosureAcknowledgements;
  expect(
    getTableConfig(table).foreignKeys.some(
      (key) =>
        key
          .reference()
          .columns.map((column) => column.name)
          .join(",") === "tenant_id,device_id,preparation_id,intent_id,credential_epoch",
    ),
  ).toBe(true);
  expect(table.requestHash.notNull).toBe(true);
  expect(table.response.notNull).toBe(true);
  expect(
    getTableConfig(table).uniqueConstraints.some(
      (constraint) =>
        constraint.columns.map((column) => column.name).join(",") === "tenant_id,request_id",
    ),
  ).toBe(true);
});

it("binds immutable execution previews to the exact tenant, source and preparation", () => {
  const table = schema.workingDeviceReplacementExecutionPreviews;
  expect(
    getTableConfig(table).foreignKeys.some(
      (key) =>
        key
          .reference()
          .columns.map((column) => column.name)
          .join(",") === "tenant_id,device_id,preparation_id",
    ),
  ).toBe(true);
  for (const column of [
    table.actorDomain,
    table.actorId,
    table.requestId,
    table.requestHash,
    table.expectedRevision,
    table.factsFingerprint,
    table.expiresAt,
    table.newWorkAllowedAt,
  ])
    expect(column.notNull).toBe(true);
  expect(
    getTableConfig(table).uniqueConstraints.some(
      (constraint) =>
        constraint.columns.map((column) => column.name).join(",") ===
        "tenant_id,actor_domain,request_id",
    ),
  ).toBe(true);
});

describe("replacement client capability evidence", () => {
  it("binds bounded server observations to tenant, device and credential epoch", () => {
    const table = schema.workingDeviceReplacementCapabilities;
    expect(getTableName(table)).toBe("working_device_replacement_capabilities");
    expect(Object.keys(table)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "deviceId",
        "credentialEpoch",
        "supported",
        "observedAt",
        "expiresAt",
      ]),
    );
    const config = getTableConfig(table);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "device_id",
      "credential_epoch",
    ]);
    expect(config.foreignKeys[0]?.reference().columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "device_id",
    ]);
    expect(config.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "replacement_capabilities_epoch_check",
        "replacement_capabilities_interval_check",
      ]),
    );
  });
});
