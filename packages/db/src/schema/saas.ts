import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformRole, platformUsers } from "./platform-auth.js";

export const SAAS_ENTITLEMENT_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
  "labelEditor",
  "publicApi",
  "pallets",
] as const;
export type SaasEntitlementKey = (typeof SAAS_ENTITLEMENT_KEYS)[number];

export const CATALOG_ITEM_KINDS = ["plan", "addon", "service"] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

export const CATALOG_VERSION_STATUSES = ["draft", "published", "retired"] as const;
export type CatalogVersionStatus = (typeof CATALOG_VERSION_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = [
  "pending_activation",
  "scheduled",
  "trial",
  "active",
  "expired",
  "superseded",
  "cancelled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const OFFER_STATUSES = ["draft", "published", "paid", "cancelled", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const FULFILMENT_KINDS = ["subscription", "subscription_addon", "ordered_service"] as const;
export type FulfilmentKind = (typeof FULFILMENT_KINDS)[number];

export const saasEntitlementKey = pgEnum("saas_entitlement_key", SAAS_ENTITLEMENT_KEYS);
export const catalogItemKind = pgEnum("catalog_item_kind", CATALOG_ITEM_KINDS);
export const catalogItemStatus = pgEnum("catalog_item_status", ["active", "archived"]);
export const catalogVersionStatus = pgEnum("catalog_version_status", CATALOG_VERSION_STATUSES);
export const catalogBillingMode = pgEnum("catalog_billing_mode", ["one_time", "recurring"]);
export const catalogBillingPeriod = pgEnum("catalog_billing_period", ["month", "year"]);
export const subscriptionStatus = pgEnum("subscription_status", SUBSCRIPTION_STATUSES);
export const subscriptionSource = pgEnum("subscription_source", [
  "demo",
  "manual",
  "paid_offer_line",
  "paid_invoice_line",
]);
export const subscriptionAddonStatus = pgEnum("subscription_addon_status", [
  "scheduled",
  "active",
  "expired",
  "revoked",
]);
export const offerStatus = pgEnum("offer_status", OFFER_STATUSES);
export const offerActivationPolicy = pgEnum("offer_activation_policy", [
  "immediately",
  "after_current",
]);
export const fulfilmentKind = pgEnum("fulfilment_kind", FULFILMENT_KINDS);
export const orderedServiceStatus = pgEnum("ordered_service_status", [
  "ordered",
  "in_progress",
  "completed",
  "cancelled",
]);

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    nameRu: text("name_ru").notNull(),
    nameEn: text("name_en").notNull(),
    kind: catalogItemKind("kind").notNull(),
    status: catalogItemStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("catalog_items_code_uq").on(table.code),
    unique("catalog_items_id_kind_uq").on(table.id, table.kind),
  ],
);

export const catalogItemVersions = pgTable(
  "catalog_item_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    kind: catalogItemKind("kind").notNull(),
    version: integer("version").notNull(),
    status: catalogVersionStatus("status").notNull().default("draft"),
    nameRu: text("name_ru").notNull(),
    nameEn: text("name_en").notNull(),
    descriptionRu: text("description_ru"),
    descriptionEn: text("description_en"),
    unit: text("unit").notNull(),
    billingMode: catalogBillingMode("billing_mode").notNull(),
    billingPeriod: catalogBillingPeriod("billing_period"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatIncluded: boolean("vat_included").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByPlatformUserId: text("published_by_platform_user_id").references(
      () => platformUsers.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("catalog_item_versions_item_version_uq").on(table.catalogItemId, table.version),
    unique("catalog_item_versions_id_kind_uq").on(table.id, table.kind),
    foreignKey({
      name: "catalog_item_versions_item_kind_fk",
      columns: [table.catalogItemId, table.kind],
      foreignColumns: [catalogItems.id, catalogItems.kind],
    }),
    check("catalog_item_versions_version_positive", sql`${table.version} > 0`),
    check("catalog_item_versions_unit_price_nonnegative", sql`${table.unitPrice} >= 0`),
    check(
      "catalog_item_versions_kind_billing_check",
      sql`(
        ${table.kind} = 'service' and ${table.billingMode} = 'one_time' and ${table.billingPeriod} is null
      ) or (
        ${table.kind} in ('plan', 'addon') and ${table.billingMode} = 'recurring' and ${table.billingPeriod} is not null
      )`,
    ),
    check(
      "catalog_item_versions_publication_check",
      sql`(${table.status} = 'draft' and ${table.publishedAt} is null and ${table.publishedByPlatformUserId} is null)
        or (${table.status} in ('published', 'retired') and ${table.publishedAt} is not null)`,
    ),
    check(
      "catalog_item_versions_vat_rate_check",
      sql`${table.vatRate} is null or (${table.vatRate} >= 0 and ${table.vatRate} <= 100)`,
    ),
  ],
);

export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    catalogVersionId: uuid("catalog_version_id").primaryKey(),
    catalogKind: catalogItemKind("catalog_kind").notNull().default("plan"),
    maxLines: integer("max_lines"),
    maxStations: integer("max_stations"),
    maxKiosks: integer("max_kiosks"),
    maxCabinetUsers: integer("max_cabinet_users"),
    labelEditorEnabled: boolean("label_editor_enabled").notNull().default(false),
    publicApiEnabled: boolean("public_api_enabled").notNull().default(false),
    palletsEnabled: boolean("pallets_enabled").notNull().default(false),
    demoDurationDays: integer("demo_duration_days"),
  },
  (table) => [
    foreignKey({
      name: "plan_entitlements_plan_version_fk",
      columns: [table.catalogVersionId, table.catalogKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    check("plan_entitlements_kind_check", sql`${table.catalogKind} = 'plan'`),
    check(
      "plan_entitlements_max_lines_positive",
      sql`${table.maxLines} is null or ${table.maxLines} > 0`,
    ),
    check(
      "plan_entitlements_max_stations_positive",
      sql`${table.maxStations} is null or ${table.maxStations} > 0`,
    ),
    check(
      "plan_entitlements_max_kiosks_positive",
      sql`${table.maxKiosks} is null or ${table.maxKiosks} > 0`,
    ),
    check(
      "plan_entitlements_max_cabinet_users_positive",
      sql`${table.maxCabinetUsers} is null or ${table.maxCabinetUsers} > 0`,
    ),
    check(
      "plan_entitlements_demo_duration_positive",
      sql`${table.demoDurationDays} is null or ${table.demoDurationDays} > 0`,
    ),
  ],
);

export const addonEntitlements = pgTable(
  "addon_entitlements",
  {
    catalogVersionId: uuid("catalog_version_id").notNull(),
    catalogKind: catalogItemKind("catalog_kind").notNull().default("addon"),
    entitlementKey: saasEntitlementKey("entitlement_key").notNull(),
    quotaIncrement: integer("quota_increment"),
    featureEnabled: boolean("feature_enabled").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.catalogVersionId, table.entitlementKey] }),
    foreignKey({
      name: "addon_entitlements_addon_version_fk",
      columns: [table.catalogVersionId, table.catalogKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    check("addon_entitlements_kind_check", sql`${table.catalogKind} = 'addon'`),
    check(
      "addon_entitlements_effect_shape_check",
      sql`(${table.quotaIncrement} is not null and ${table.quotaIncrement} > 0 and ${table.featureEnabled} = false)
        or (${table.quotaIncrement} is null and ${table.featureEnabled} = true)`,
    ),
    check(
      "addon_entitlements_key_shape_check",
      sql`(${table.entitlementKey} in ('lines', 'stations', 'kiosks', 'cabinetUsers') and ${table.quotaIncrement} is not null)
        or (${table.entitlementKey} in ('labelEditor', 'publicApi', 'pallets') and ${table.quotaIncrement} is null and ${table.featureEnabled} = true)`,
    ),
  ],
);

export const platformSettings = pgTable(
  "platform_settings",
  {
    key: text("key").primaryKey(),
    defaultDemoCatalogVersionId: uuid("default_demo_catalog_version_id").notNull(),
    catalogKind: catalogItemKind("catalog_kind").notNull().default("plan"),
    updatedByPlatformUserId: text("updated_by_platform_user_id").references(() => platformUsers.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("platform_settings_singleton_key_check", sql`${table.key} = 'default'`),
    check("platform_settings_plan_kind_check", sql`${table.catalogKind} = 'plan'`),
    foreignKey({
      name: "platform_settings_demo_plan_version_fk",
      columns: [table.defaultDemoCatalogVersionId, table.catalogKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
  ],
);

export const commercialOffers = pgTable(
  "commercial_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    familyId: uuid("family_id").notNull().defaultRandom(),
    revision: integer("revision").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    status: offerStatus("status").notNull().default("draft"),
    number: text("number"),
    sellerBankAccountId: uuid("seller_bank_account_id"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    termsMarkdown: text("terms_markdown"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByPlatformUserId: text("published_by_platform_user_id").references(
      () => platformUsers.id,
    ),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdByPlatformUserId: text("created_by_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offers_tenant_id_uq").on(table.tenantId, table.id),
    unique("commercial_offers_number_uq").on(table.number),
    unique("commercial_offers_tenant_family_revision_uq").on(
      table.tenantId,
      table.familyId,
      table.revision,
    ),
    foreignKey({
      name: "commercial_offers_tenant_previous_revision_fk",
      columns: [table.tenantId, table.previousRevisionId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check("commercial_offers_revision_positive", sql`${table.revision} > 0`),
    check("commercial_offers_total_nonnegative", sql`${table.total} >= 0`),
  ],
);

export const commercialOfferPrintSnapshots = pgTable(
  "commercial_offer_print_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    revision: integer("revision").notNull(),
    number: text("number").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sellerSnapshot: jsonb("seller_snapshot").notNull(),
    buyerSnapshot: jsonb("buyer_snapshot").notNull(),
    sellerBankAccountSnapshot: jsonb("seller_bank_account_snapshot"),
    buyerBankAccountSnapshot: jsonb("buyer_bank_account_snapshot"),
    linesSnapshot: jsonb("lines_snapshot").notNull(),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull(),
    vatTotal: numeric("vat_total", { precision: 14, scale: 2 }).notNull(),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    termsMarkdown: text("terms_markdown"),
    termsHtml: text("terms_html"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offer_print_snapshots_tenant_id_uq").on(table.tenantId, table.id),
    unique("commercial_offer_print_snapshots_offer_revision_uq").on(table.offerId, table.revision),
    foreignKey({
      name: "commercial_offer_print_snapshots_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    check("commercial_offer_print_snapshots_revision_positive", sql`${table.revision} > 0`),
    check(
      "commercial_offer_print_snapshots_totals_nonnegative",
      sql`${table.subtotal} >= 0 and ${table.vatTotal} >= 0 and ${table.total} >= 0`,
    ),
  ],
);

export const commercialOfferDocuments = pgTable(
  "commercial_offer_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    revision: integer("revision").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull().default("pending"),
    objectKey: text("object_key"),
    contentType: text("content_type"),
    sha256: text("sha256"),
    byteSize: integer("byte_size"),
    rendererVersion: text("renderer_version").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offer_documents_tenant_id_uq").on(table.tenantId, table.id),
    unique("commercial_offer_documents_offer_revision_format_uq").on(
      table.offerId,
      table.revision,
      table.format,
    ),
    index("commercial_offer_documents_tenant_created_id_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "commercial_offer_documents_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    check("commercial_offer_documents_revision_positive", sql`${table.revision} > 0`),
    check("commercial_offer_documents_format_check", sql`${table.format} in ('pdf', 'html')`),
    check(
      "commercial_offer_documents_status_check",
      sql`${table.status} in ('pending', 'ready', 'failed')`,
    ),
    check(
      "commercial_offer_documents_ready_metadata_check",
      sql`${table.status} <> 'ready' or (${table.objectKey} is not null and ${table.sha256} is not null and ${table.byteSize} is not null)`,
    ),
  ],
);

export const commercialOfferLines = pgTable(
  "commercial_offer_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    position: integer("position").notNull(),
    kind: catalogItemKind("kind").notNull(),
    catalogVersionId: uuid("catalog_version_id"),
    nameRu: text("name_ru").notNull(),
    nameEn: text("name_en").notNull(),
    descriptionRu: text("description_ru"),
    descriptionEn: text("description_en"),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull(),
    catalogUnitPrice: numeric("catalog_unit_price", { precision: 14, scale: 2 }),
    agreedUnitPrice: numeric("agreed_unit_price", { precision: 14, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatIncluded: boolean("vat_included").notNull(),
    priceOverrideReason: text("price_override_reason"),
    activationPolicy: offerActivationPolicy("activation_policy"),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offer_lines_tenant_id_uq").on(table.tenantId, table.id),
    unique("commercial_offer_lines_offer_position_uq").on(table.offerId, table.position),
    foreignKey({
      name: "commercial_offer_lines_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    foreignKey({
      name: "commercial_offer_lines_catalog_version_kind_fk",
      columns: [table.catalogVersionId, table.kind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    check("commercial_offer_lines_position_positive", sql`${table.position} > 0`),
    check("commercial_offer_lines_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "commercial_offer_lines_prices_nonnegative",
      sql`${table.agreedUnitPrice} >= 0 and (${table.catalogUnitPrice} is null or ${table.catalogUnitPrice} >= 0) and ${table.lineTotal} >= 0`,
    ),
    check(
      "commercial_offer_lines_catalog_service_check",
      sql`${table.kind} = 'service' or ${table.catalogVersionId} is not null`,
    ),
    check(
      "commercial_offer_lines_activation_policy_check",
      sql`(${table.kind} = 'plan' and ${table.activationPolicy} is not null)
        or (${table.kind} <> 'plan' and ${table.activationPolicy} is null)`,
    ),
    check(
      "commercial_offer_lines_override_reason_check",
      sql`${table.catalogUnitPrice} is null
        or ${table.agreedUnitPrice} = ${table.catalogUnitPrice}
        or nullif(btrim(${table.priceOverrideReason}), '') is not null`,
    ),
  ],
);

export const tenantSubscriptions = pgTable(
  "tenant_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    planVersionId: uuid("plan_version_id").notNull(),
    planKind: catalogItemKind("plan_kind").notNull().default("plan"),
    status: subscriptionStatus("status").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    source: subscriptionSource("source").notNull(),
    sourceOfferLineId: uuid("source_offer_line_id"),
    sourceInvoiceLineId: uuid("source_invoice_line_id"),
    createdByPlatformUserId: text("created_by_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_subscriptions_tenant_id_uq").on(table.tenantId, table.id),
    uniqueIndex("tenant_subscriptions_one_current_uq")
      .on(table.tenantId)
      .where(sql`${table.status} in ('pending_activation', 'trial', 'active')`),
    uniqueIndex("tenant_subscriptions_one_scheduled_uq")
      .on(table.tenantId)
      .where(sql`${table.status} = 'scheduled'`),
    uniqueIndex("tenant_subscriptions_invoice_line_uq")
      .on(table.tenantId, table.sourceInvoiceLineId)
      .where(sql`${table.sourceInvoiceLineId} is not null`),
    foreignKey({
      name: "tenant_subscriptions_plan_version_fk",
      columns: [table.planVersionId, table.planKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    foreignKey({
      name: "tenant_subscriptions_tenant_source_offer_line_fk",
      columns: [table.tenantId, table.sourceOfferLineId],
      foreignColumns: [commercialOfferLines.tenantId, commercialOfferLines.id],
    }),
    check("tenant_subscriptions_plan_kind_check", sql`${table.planKind} = 'plan'`),
    check(
      "tenant_subscriptions_time_order_check",
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      "tenant_subscriptions_pending_dates_check",
      sql`${table.status} <> 'pending_activation' or (${table.startsAt} is null and ${table.endsAt} is null)`,
    ),
    check(
      "tenant_subscriptions_commercial_source_check",
      sql`((${table.source} = 'paid_offer_line') = (${table.sourceOfferLineId} is not null))
        and ((${table.source} = 'paid_invoice_line') = (${table.sourceInvoiceLineId} is not null))`,
    ),
  ],
);

export const subscriptionAddons = pgTable(
  "subscription_addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    addonVersionId: uuid("addon_version_id").notNull(),
    addonKind: catalogItemKind("addon_kind").notNull().default("addon"),
    quantity: integer("quantity").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: subscriptionAddonStatus("status").notNull(),
    source: subscriptionSource("source").notNull(),
    sourceOfferLineId: uuid("source_offer_line_id"),
    sourceInvoiceLineId: uuid("source_invoice_line_id"),
    createdByPlatformUserId: text("created_by_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("subscription_addons_tenant_id_uq").on(table.tenantId, table.id),
    uniqueIndex("subscription_addons_invoice_line_uq")
      .on(table.tenantId, table.sourceInvoiceLineId)
      .where(sql`${table.sourceInvoiceLineId} is not null`),
    foreignKey({
      name: "subscription_addons_tenant_subscription_fk",
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    foreignKey({
      name: "subscription_addons_addon_version_fk",
      columns: [table.addonVersionId, table.addonKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    foreignKey({
      name: "subscription_addons_tenant_source_offer_line_fk",
      columns: [table.tenantId, table.sourceOfferLineId],
      foreignColumns: [commercialOfferLines.tenantId, commercialOfferLines.id],
    }),
    check("subscription_addons_kind_check", sql`${table.addonKind} = 'addon'`),
    check("subscription_addons_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "subscription_addons_time_order_check",
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      "subscription_addons_commercial_source_check",
      sql`((${table.source} = 'paid_offer_line') = (${table.sourceOfferLineId} is not null))
        and ((${table.source} = 'paid_invoice_line') = (${table.sourceInvoiceLineId} is not null))`,
    ),
  ],
);

export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    eventKind: text("event_kind").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    actorPlatformUserId: text("actor_platform_user_id").references(() => platformUsers.id),
    source: text("source").notNull(),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("subscription_events_tenant_id_uq").on(table.tenantId, table.id),
    index("subscription_events_tenant_effective_idx").on(table.tenantId, table.effectiveAt),
    foreignKey({
      name: "subscription_events_tenant_subscription_fk",
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("RUB"),
    bankReference: text("bank_reference").notNull(),
    platformUserId: text("platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payments_tenant_id_uq").on(table.tenantId, table.id),
    unique("payments_offer_uq").on(table.tenantId, table.offerId),
    unique("payments_idempotency_key_uq").on(table.idempotencyKey),
    foreignKey({
      name: "payments_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    check("payments_amount_positive", sql`${table.amount} > 0`),
    check("payments_currency_rub_check", sql`${table.currency} = 'RUB'`),
    check(
      "payments_bank_reference_check",
      sql`nullif(btrim(${table.bankReference}), '') is not null`,
    ),
  ],
);

export const orderedServices = pgTable(
  "ordered_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerLineId: uuid("offer_line_id"),
    paymentId: uuid("payment_id"),
    invoiceId: uuid("invoice_id"),
    invoiceLineId: uuid("invoice_line_id"),
    billingPaymentId: uuid("billing_payment_id"),
    catalogVersionId: uuid("catalog_version_id"),
    catalogKind: catalogItemKind("catalog_kind").notNull().default("service"),
    nameRu: text("name_ru").notNull(),
    nameEn: text("name_en").notNull(),
    descriptionRu: text("description_ru"),
    descriptionEn: text("description_en"),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull(),
    status: orderedServiceStatus("status").notNull().default("ordered"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("ordered_services_tenant_id_uq").on(table.tenantId, table.id),
    unique("ordered_services_offer_line_uq").on(table.tenantId, table.offerLineId),
    uniqueIndex("ordered_services_invoice_line_uq")
      .on(table.tenantId, table.invoiceLineId)
      .where(sql`${table.invoiceLineId} is not null`),
    foreignKey({
      name: "ordered_services_tenant_offer_line_fk",
      columns: [table.tenantId, table.offerLineId],
      foreignColumns: [commercialOfferLines.tenantId, commercialOfferLines.id],
    }),
    foreignKey({
      name: "ordered_services_tenant_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    foreignKey({
      name: "ordered_services_catalog_version_fk",
      columns: [table.catalogVersionId, table.catalogKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    check("ordered_services_kind_check", sql`${table.catalogKind} = 'service'`),
    check("ordered_services_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "ordered_services_source_check",
      sql`(${table.offerLineId} is not null and ${table.paymentId} is not null and ${table.invoiceId} is null and ${table.invoiceLineId} is null and ${table.billingPaymentId} is null)
        or (${table.offerLineId} is null and ${table.paymentId} is null and ${table.invoiceId} is not null and ${table.invoiceLineId} is not null and ${table.billingPaymentId} is not null)`,
    ),
  ],
);

export const offerLineFulfilments = pgTable(
  "offer_line_fulfilments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerLineId: uuid("offer_line_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    kind: fulfilmentKind("kind").notNull(),
    tenantSubscriptionId: uuid("tenant_subscription_id"),
    subscriptionAddonId: uuid("subscription_addon_id"),
    orderedServiceId: uuid("ordered_service_id"),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("offer_line_fulfilments_offer_line_uq").on(table.tenantId, table.offerLineId),
    foreignKey({
      name: "offer_line_fulfilments_tenant_offer_line_fk",
      columns: [table.tenantId, table.offerLineId],
      foreignColumns: [commercialOfferLines.tenantId, commercialOfferLines.id],
    }),
    foreignKey({
      name: "offer_line_fulfilments_tenant_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    foreignKey({
      name: "offer_line_fulfilments_tenant_subscription_fk",
      columns: [table.tenantId, table.tenantSubscriptionId],
      foreignColumns: [tenantSubscriptions.tenantId, tenantSubscriptions.id],
    }),
    foreignKey({
      name: "offer_line_fulfilments_tenant_subscription_addon_fk",
      columns: [table.tenantId, table.subscriptionAddonId],
      foreignColumns: [subscriptionAddons.tenantId, subscriptionAddons.id],
    }),
    foreignKey({
      name: "offer_line_fulfilments_tenant_ordered_service_fk",
      columns: [table.tenantId, table.orderedServiceId],
      foreignColumns: [orderedServices.tenantId, orderedServices.id],
    }),
    check(
      "offer_line_fulfilments_target_check",
      sql`(${table.kind} = 'subscription' and ${table.tenantSubscriptionId} is not null and ${table.subscriptionAddonId} is null and ${table.orderedServiceId} is null)
        or (${table.kind} = 'subscription_addon' and ${table.tenantSubscriptionId} is null and ${table.subscriptionAddonId} is not null and ${table.orderedServiceId} is null)
        or (${table.kind} = 'ordered_service' and ${table.tenantSubscriptionId} is null and ${table.subscriptionAddonId} is null and ${table.orderedServiceId} is not null)`,
    ),
  ],
);

export const platformAuditEvents = pgTable(
  "platform_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorPlatformUserId: text("actor_platform_user_id").references(() => platformUsers.id),
    actorRole: platformRole("actor_role"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    tenantId: text("tenant_id").references(() => organization.id),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("platform_audit_events_created_idx").on(table.createdAt)],
);
