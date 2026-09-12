import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("P1 entitlement persistence", () => {
  it("exports prepared sources, exact previews, policies, observations and independent bigint revisions", () => {
    for (const name of [
      "entitlementSources",
      "entitlementSourcePreviews",
      "entitlementRevisions",
      "entitlementLifecyclePolicies",
      "entitlementShadowObservations",
    ])
      expect(schema).toHaveProperty(name);
    expect(schema.entitlementRevisions.revision.mapFromDriverValue("9007199254740993")).toBe(
      9007199254740993n,
    );
    expect(schema.entitlementRevisions.usageRevision.mapFromDriverValue("9007199254740993")).toBe(
      9007199254740993n,
    );
  });
  it("retains legacy unknown values without new defaults or a separate handheld quota", () => {
    for (const column of [
      schema.planEntitlements.chzIntegrationEnabled,
      schema.planEntitlements.inventoryEnabled,
      schema.planEntitlements.commerceMlEnabled,
      schema.planEntitlements.handheldEnabled,
      schema.catalogItemVersions.lifecyclePolicyId,
    ]) {
      expect(column.notNull).toBe(false);
      expect(column.hasDefault).toBe(false);
    }
    expect(schema.planEntitlements).not.toHaveProperty("maxHandhelds");
    expect(schema.saasEntitlementKey.enumValues).toEqual([
      "lines",
      "stations",
      "kiosks",
      "cabinetUsers",
      "labelEditor",
      "publicApi",
      "pallets",
      "chzIntegration",
      "inventory",
      "commerceMl",
      "handheld",
    ]);
  });
  it("pins source and preview subscriptions and results to their tenant", () => {
    for (const [table, name] of [
      [schema.entitlementSources, "entitlement_sources_tenant_subscription_fk"],
      [schema.entitlementSourcePreviews, "entitlement_previews_tenant_subscription_fk"],
      [schema.entitlementSourcePreviews, "entitlement_previews_tenant_result_fk"],
    ] as const) {
      const reference = getTableConfig(table)
        .foreignKeys.find((key) => key.getName() === name)
        ?.reference();
      expect(reference?.columns[0]?.name).toBe("tenant_id");
      expect(reference?.foreignColumns[0]?.name).toBe("tenant_id");
    }
  });
});
