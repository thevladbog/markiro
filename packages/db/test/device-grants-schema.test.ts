import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
describe("offline grant provenance schema", () => {
  it("persists independent credential epochs on durable native identities", () => {
    for (const table of [schema.stationDevices, schema.kiosks]) {
      const epoch = getTableConfig(table).columns.find(
        (column) => column.name === "credential_epoch",
      );
      expect(epoch?.notNull).toBe(true);
      expect(epoch?.default).toBe(1);
    }
  });
  it("exposes issuance, frozen authority and retained evidence", () => {
    expect(schema).toHaveProperty("deviceGrantIssuances");
    expect(schema).toHaveProperty("deviceGrantTaskSources");
    expect(schema).toHaveProperty("deviceGrantEvidence");
    expect(schema).toHaveProperty("deviceGrantConfigurations");
  });

  it("models append-only client readiness with tenant-scoped matched facts", () => {
    expect(schema).toHaveProperty("deviceGrantClientReadinessReports");
    const config = getTableConfig(schema.deviceGrantClientReadinessReports);
    const columns = new Map(config.columns.map((column) => [column.name, column]));

    for (const name of [
      "tenant_id",
      "owner_kind",
      "station_device_id",
      "kiosk_id",
      "credential_epoch",
      "request_id",
      "payload_digest",
      "client_build",
      "storage_revision",
      "reported_mode",
      "reported_policy_revision",
      "reported_keyset_revision",
      "reported_grant_id",
      "configuration_id",
      "verified_grant_id",
      "matches_current_configuration",
      "verified_grant_matched",
      "received_at",
    ]) {
      expect(columns.has(name), name).toBe(true);
    }
    expect(columns.get("received_at")?.notNull).toBe(true);
    expect(columns.get("payload_digest")?.notNull).toBe(true);
    expect(columns.get("storage_revision")?.notNull).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "device_grant_client_readiness_owner_check",
        "device_grant_client_readiness_epoch_check",
        "device_grant_client_readiness_shape_check",
      ]),
    );
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "device_grant_client_readiness_station_fk",
        "device_grant_client_readiness_kiosk_fk",
        "device_grant_client_readiness_configuration_fk",
        "device_grant_client_readiness_verified_grant_fk",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "device_grant_client_readiness_station_request_uq",
        "device_grant_client_readiness_kiosk_request_uq",
        "device_grant_client_readiness_station_latest_idx",
        "device_grant_client_readiness_kiosk_latest_idx",
      ]),
    );
  });
});
