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
