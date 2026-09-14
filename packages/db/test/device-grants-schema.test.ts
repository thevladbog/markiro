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

  it("models prepared cohorts and exact device activation ownership", () => {
    expect(schema).toHaveProperty("offlineGrantActivationPreparations");
    expect(schema).toHaveProperty("offlineGrantActivationMembers");
    expect(schema).toHaveProperty("offlineGrantDeviceActivations");

    const preparations = getTableConfig(schema.offlineGrantActivationPreparations);
    expect(preparations.name).toBe("offline_grant_activation_preparations");
    expect(preparations.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "offline_grant_activation_state_check",
        "offline_grant_activation_interval_check",
        "offline_grant_activation_confirm_actor_check",
        "offline_grant_activation_payload_check",
      ]),
    );
    expect(preparations.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "offline_grant_activation_base_policy_fk",
        "offline_grant_activation_rollout_policy_fk",
        "offline_grant_activation_prepared_by_fk",
        "offline_grant_activation_confirmed_by_fk",
        "offline_grant_activation_cancelled_by_fk",
      ]),
    );

    const members = getTableConfig(schema.offlineGrantActivationMembers);
    expect(members.name).toBe("offline_grant_activation_members");
    expect(members.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "offline_grant_activation_members_owner_check",
        "offline_grant_activation_members_snapshot_check",
      ]),
    );
    expect(members.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "offline_grant_activation_members_subscription_fk",
        "offline_grant_activation_members_station_fk",
        "offline_grant_activation_members_kiosk_fk",
      ]),
    );
    expect(members.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "offline_grant_activation_members_station_prepared_uq",
        "offline_grant_activation_members_kiosk_prepared_uq",
      ]),
    );

    const activations = getTableConfig(schema.offlineGrantDeviceActivations);
    expect(activations.name).toBe("offline_grant_device_activations");
    expect(activations.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "offline_grant_device_activations_station_active_uq",
        "offline_grant_device_activations_kiosk_active_uq",
      ]),
    );

    const configurations = getTableConfig(schema.deviceGrantConfigurations);
    expect(configurations.columns.some((column) => column.name === "activation_id")).toBe(true);
    expect(configurations.foreignKeys.map((key) => key.getName())).toContain(
      "device_grant_configurations_activation_fk",
    );
  });

  it("models selective rollback preparations and terminal activation provenance", () => {
    expect(schema).toHaveProperty("offlineGrantRollbackPreparations");
    expect(schema).toHaveProperty("offlineGrantRollbackMembers");

    const preparations = getTableConfig(schema.offlineGrantRollbackPreparations);
    expect(preparations.name).toBe("offline_grant_rollback_preparations");
    expect(preparations.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "offline_grant_rollback_state_check",
        "offline_grant_rollback_interval_check",
        "offline_grant_rollback_confirm_actor_check",
        "offline_grant_rollback_payload_check",
      ]),
    );

    const members = getTableConfig(schema.offlineGrantRollbackMembers);
    expect(members.name).toBe("offline_grant_rollback_members");
    expect(members.indexes.map((index) => index.config.name)).toContain(
      "offline_grant_rollback_members_active_reservation_uq",
    );
    expect(members.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "offline_grant_rollback_members_activation_fk",
        "offline_grant_rollback_members_subscription_fk",
        "offline_grant_rollback_members_station_fk",
        "offline_grant_rollback_members_kiosk_fk",
      ]),
    );

    const activations = getTableConfig(schema.offlineGrantDeviceActivations);
    const columns = new Map(activations.columns.map((column) => [column.name, column]));
    for (const name of [
      "rollback_preparation_id",
      "observe_policy_id",
      "rolled_back_by_platform_user_id",
      "rolled_back_at",
    ]) {
      expect(columns.has(name), name).toBe(true);
    }
    expect(activations.checks.map((constraint) => constraint.name)).toContain(
      "offline_grant_device_activations_rollback_check",
    );
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
