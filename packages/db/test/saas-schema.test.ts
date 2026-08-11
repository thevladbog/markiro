import { getTableName } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

function foreignKey(table: AnyPgTable, name: string) {
  const key = getTableConfig(table).foreignKeys.find((item) => item.getName() === name);
  expect(key, `missing foreign key ${name}`).toBeDefined();
  return key!.reference();
}

describe("SaaS catalog and subscription schema", () => {
  it("exports every platform-control-plane table under its stable SQL name", () => {
    expect(getTableName(schema.catalogItems)).toBe("catalog_items");
    expect(getTableName(schema.catalogItemVersions)).toBe("catalog_item_versions");
    expect(getTableName(schema.planEntitlements)).toBe("plan_entitlements");
    expect(getTableName(schema.addonEntitlements)).toBe("addon_entitlements");
    expect(getTableName(schema.tenantSubscriptions)).toBe("tenant_subscriptions");
    expect(getTableName(schema.subscriptionAddons)).toBe("subscription_addons");
    expect(getTableName(schema.subscriptionEvents)).toBe("subscription_events");
    expect(getTableName(schema.commercialOffers)).toBe("commercial_offers");
    expect(getTableName(schema.commercialOfferLines)).toBe("commercial_offer_lines");
    expect(getTableName(schema.payments)).toBe("payments");
    expect(getTableName(schema.offerLineFulfilments)).toBe("offer_line_fulfilments");
    expect(getTableName(schema.orderedServices)).toBe("ordered_services");
    expect(getTableName(schema.platformAuditEvents)).toBe("platform_audit_events");
  });

  it("keeps platform identities in tables separate from customer Better Auth identities", () => {
    expect(getTableName(schema.platformUsers)).toBe("platform_users");
    expect(getTableName(schema.platformSessions)).toBe("platform_sessions");
    expect(getTableName(schema.platformAccounts)).toBe("platform_accounts");
    expect(getTableName(schema.platformVerifications)).toBe("platform_verifications");
    expect(getTableName(schema.platformTwoFactors)).toBe("platform_two_factors");

    const userTargets = getTableConfig(schema.platformSessions).foreignKeys.map((key) =>
      getTableName(key.reference().foreignTable),
    );
    expect(userTargets).toEqual(["platform_users"]);
    expect(userTargets).not.toContain("user");
  });

  it("stores every two-factor state field required by the Better Auth plugin", () => {
    expect(Object.keys(schema.platformTwoFactors)).toEqual(
      expect.arrayContaining([
        "secret",
        "backupCodes",
        "userId",
        "verified",
        "failedVerificationCount",
        "lockedUntil",
      ]),
    );
  });

  it("pins stable catalog identities and immutable numbered versions", () => {
    const itemConfig = getTableConfig(schema.catalogItems);
    expect(itemConfig.uniqueConstraints.map((item) => item.getName())).toContain(
      "catalog_items_code_uq",
    );

    const versionConfig = getTableConfig(schema.catalogItemVersions);
    expect(versionConfig.uniqueConstraints.map((item) => item.getName())).toContain(
      "catalog_item_versions_item_version_uq",
    );
    expect(Object.keys(schema.catalogItemVersions)).toEqual(
      expect.arrayContaining([
        "catalogItemId",
        "version",
        "status",
        "nameRu",
        "nameEn",
        "descriptionRu",
        "descriptionEn",
        "unit",
        "billingMode",
        "billingPeriod",
        "unitPrice",
        "vatRate",
        "vatIncluded",
        "publishedAt",
        "publishedByPlatformUserId",
      ]),
    );
    expect(schema.catalogItemVersions.unitPrice.columnType).toContain("Numeric");
  });

  it("uses explicit positive plan and add-on entitlement constraints", () => {
    expect(Object.keys(schema.planEntitlements)).toEqual(
      expect.arrayContaining([
        "maxLines",
        "maxStations",
        "maxKiosks",
        "maxCabinetUsers",
        "labelEditorEnabled",
        "publicApiEnabled",
        "palletsEnabled",
        "demoDurationDays",
      ]),
    );
    expect(getTableConfig(schema.planEntitlements).checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "plan_entitlements_max_lines_positive",
        "plan_entitlements_max_stations_positive",
        "plan_entitlements_max_kiosks_positive",
        "plan_entitlements_max_cabinet_users_positive",
        "plan_entitlements_demo_duration_positive",
      ]),
    );
    expect(getTableConfig(schema.addonEntitlements).checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "addon_entitlements_effect_shape_check",
        "addon_entitlements_key_shape_check",
      ]),
    );
  });

  it("allows only one current and one scheduled subscription per tenant", () => {
    const indexes = getTableConfig(schema.tenantSubscriptions).indexes;
    const current = indexes.find(
      (item) => item.config.name === "tenant_subscriptions_one_current_uq",
    );
    const scheduled = indexes.find(
      (item) => item.config.name === "tenant_subscriptions_one_scheduled_uq",
    );
    expect(current?.config.unique).toBe(true);
    expect(current?.config.where).toBeDefined();
    expect(scheduled?.config.unique).toBe(true);
    expect(scheduled?.config.where).toBeDefined();
  });

  it("keeps immutable subscription source facts as typed columns", () => {
    expect(Object.keys(schema.tenantSubscriptions)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "planVersionId",
        "status",
        "startsAt",
        "endsAt",
        "source",
        "sourceOfferLineId",
        "createdByPlatformUserId",
      ]),
    );
    expect(Object.keys(schema.subscriptionAddons)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "subscriptionId",
        "addonVersionId",
        "quantity",
        "status",
        "source",
        "sourceOfferLineId",
      ]),
    );
  });

  it("snapshots published offer terms and permits a null catalog version only for services", () => {
    expect(schema.commercialOfferLines.catalogVersionId.notNull).toBe(false);
    expect(Object.keys(schema.commercialOfferLines)).toEqual(
      expect.arrayContaining([
        "kind",
        "nameRu",
        "nameEn",
        "descriptionRu",
        "descriptionEn",
        "quantity",
        "unit",
        "catalogUnitPrice",
        "agreedUnitPrice",
        "vatRate",
        "vatIncluded",
        "priceOverrideReason",
        "activationPolicy",
        "lineTotal",
      ]),
    );
    expect(getTableConfig(schema.commercialOfferLines).checks.map((item) => item.name)).toContain(
      "commercial_offer_lines_catalog_service_check",
    );
  });

  it("enforces payment idempotency and one fulfilment fact per offer line", () => {
    expect(
      getTableConfig(schema.payments).uniqueConstraints.map((item) => item.getName()),
    ).toContain("payments_idempotency_key_uq");
    expect(
      getTableConfig(schema.offerLineFulfilments).uniqueConstraints.map((item) => item.getName()),
    ).toContain("offer_line_fulfilments_offer_line_uq");
  });

  it("uses composite tenant foreign keys for tenant-owned commercial history", () => {
    const references = [
      [
        schema.subscriptionAddons,
        "subscription_addons_tenant_subscription_fk",
        "tenant_subscriptions",
      ],
      [
        schema.subscriptionEvents,
        "subscription_events_tenant_subscription_fk",
        "tenant_subscriptions",
      ],
      [schema.commercialOfferLines, "commercial_offer_lines_tenant_offer_fk", "commercial_offers"],
      [schema.payments, "payments_tenant_offer_fk", "commercial_offers"],
      [
        schema.offerLineFulfilments,
        "offer_line_fulfilments_tenant_offer_line_fk",
        "commercial_offer_lines",
      ],
      [schema.orderedServices, "ordered_services_tenant_offer_line_fk", "commercial_offer_lines"],
    ] as const;

    for (const [table, keyName, target] of references) {
      const reference = foreignKey(table, keyName);
      expect(getTableName(reference.foreignTable)).toBe(target);
      expect(reference.columns[0]?.name).toBe("tenant_id");
      expect(reference.foreignColumns[0]?.name).toBe("tenant_id");
    }
  });
});
