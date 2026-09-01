import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth.js";
import { chzProductGroups, products } from "./platform.js";

export const nationalCatalogSchemaStatus = pgEnum("national_catalog_schema_status", [
  "observed",
  "validated",
  "active",
  "retired",
]);
export const productAttributeSource = pgEnum("product_attribute_source", [
  "manual",
  "1c",
  "national_catalog",
  "migration",
]);
export const productAttributeState = pgEnum("product_attribute_state", ["active", "inapplicable"]);
export const productRegulatoryProposalStatus = pgEnum("product_regulatory_proposal_status", [
  "preview",
  "applied",
  "rejected",
  "stale",
]);
export const productRegulatoryProposalKind = pgEnum("product_regulatory_proposal_kind", [
  "category_binding",
  "category_change",
  "national_catalog_import",
]);
export const nationalCatalogCardSourceMethod = pgEnum("national_catalog_card_source_method", [
  "legacy_unknown",
  "feed_product",
  "product",
]);
export const nationalCatalogFreshnessOutcome = pgEnum("national_catalog_freshness_outcome", [
  "changed",
  "unchanged",
  "not_modified",
  "not_found",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "invalid_response",
  "unavailable",
]);
export const nationalCatalogCategoryGroupMappingState = pgEnum(
  "national_catalog_category_group_mapping_state",
  ["exact", "ambiguous", "unmapped"],
);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

export const nationalCatalogSchemaVersions = pgTable(
  "national_catalog_schema_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKey: text("scope_key").notNull(),
    categoryId: text("category_id").notNull(),
    categoryName: text("category_name").notNull(),
    selectors: jsonb("selectors").notNull(),
    sourceVersion: text("source_version"),
    etag: text("etag"),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    definition: jsonb("definition").notNull(),
    status: nationalCatalogSchemaStatus("status").notNull().default("observed"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("national_catalog_schema_versions_scope_content_uq").on(
      table.scopeKey,
      table.contentHash,
    ),
    uniqueIndex("national_catalog_schema_versions_active_scope_uq")
      .on(table.scopeKey)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const nationalCatalogCategoryGroupMappings = pgTable(
  "national_catalog_category_group_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chzProductGroupCode: integer("chz_product_group_code")
      .notNull()
      .references(() => chzProductGroups.code),
    schemaVersionId: uuid("schema_version_id").references(() => nationalCatalogSchemaVersions.id),
    categoryId: text("category_id"),
    state: nationalCatalogCategoryGroupMappingState("state").notNull(),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "national_catalog_category_group_mappings_state_ck",
      sql`(${table.state} = 'unmapped' and ${table.categoryId} is null and ${table.schemaVersionId} is null) or (${table.state} <> 'unmapped' and ${table.categoryId} is not null and ${table.schemaVersionId} is not null)`,
    ),
    unique("national_catalog_category_group_mappings_candidate_uq").on(
      table.chzProductGroupCode,
      table.schemaVersionId,
    ),
    uniqueIndex("national_catalog_category_group_mappings_unmapped_uq")
      .on(table.chzProductGroupCode)
      .where(sql`${table.state} = 'unmapped'`),
  ],
);

export const nationalCatalogAttributeMappings = pgTable(
  "national_catalog_attribute_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersionId: uuid("schema_version_id")
      .notNull()
      .references(() => nationalCatalogSchemaVersions.id),
    sourceAttributeId: text("source_attribute_id").notNull(),
    targetField: text("target_field").notNull(),
    conversion: jsonb("conversion").notNull(),
    mappingVersion: integer("mapping_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("national_catalog_attribute_mappings_target_uq").on(
      table.schemaVersionId,
      table.sourceAttributeId,
      table.targetField,
    ),
  ],
);

export const productRegulatoryProfiles = pgTable(
  "product_regulatory_profiles",
  {
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    revision: integer("revision").notNull().default(1),
    categoryId: text("category_id").notNull(),
    categoryName: text("category_name").notNull(),
    tnVedCode: text("tn_ved_code"),
    okpd2Code: text("okpd2_code"),
    schemaVersionId: uuid("schema_version_id")
      .notNull()
      .references(() => nationalCatalogSchemaVersions.id),
    source: productAttributeSource("source").notNull(),
    confirmedBy: text("confirmed_by").references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId] }),
    foreignKey({
      name: "product_regulatory_profiles_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
  ],
);

export const productRegulatoryAttributeValues = pgTable(
  "product_regulatory_attribute_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    schemaVersionId: uuid("schema_version_id")
      .notNull()
      .references(() => nationalCatalogSchemaVersions.id),
    attributeId: text("attribute_id").notNull(),
    value: jsonb("value").notNull(),
    state: productAttributeState("state").notNull().default("active"),
    source: productAttributeSource("source").notNull(),
    sourceRef: text("source_ref"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    appliedBy: text("applied_by").references(() => user.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "product_regulatory_attribute_values_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
    uniqueIndex("product_regulatory_attribute_values_current_uq")
      .on(table.tenantId, table.productId, table.attributeId)
      .where(sql`${table.supersededAt} is null`),
  ],
);

export const productEgaisCodes = pgTable(
  "product_egais_codes",
  {
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    code: char("code", { length: 19 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    source: productAttributeSource("source").notNull(),
    sourceRef: text("source_ref"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId, table.code] }),
    check("product_egais_codes_digits_ck", sql`${table.code} ~ '^[0-9]{19}$'`),
    foreignKey({
      name: "product_egais_codes_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
    uniqueIndex("product_egais_codes_primary_uq")
      .on(table.tenantId, table.productId)
      .where(sql`${table.isPrimary} = true`),
  ],
);

export const nationalCatalogCardSnapshots = pgTable(
  "national_catalog_card_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    gtin14: char("gtin14", { length: 14 }).notNull(),
    cardId: text("card_id").notNull(),
    cardStatus: text("card_status").notNull(),
    sourceMethod: nationalCatalogCardSourceMethod("source_method").notNull(),
    payloadFormatVersion: integer("payload_format_version").notNull(),
    etag: text("etag"),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "national_catalog_card_snapshots_payload_format_version_ck",
      sql`${table.payloadFormatVersion} >= 1`,
    ),
    unique("national_catalog_card_snapshots_tenant_product_id_uq").on(
      table.tenantId,
      table.productId,
      table.id,
    ),
    unique("national_catalog_card_snapshots_cursor_identity_uq").on(
      table.tenantId,
      table.productId,
      table.cardId,
      table.sourceMethod,
      table.id,
    ),
    unique("national_catalog_card_snapshots_content_uq").on(
      table.tenantId,
      table.productId,
      table.cardId,
      table.sourceMethod,
      table.contentHash,
    ),
    foreignKey({
      name: "national_catalog_card_snapshots_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
  ],
);

export const nationalCatalogCardFreshness = pgTable(
  "national_catalog_card_freshness",
  {
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    cardId: text("card_id").notNull(),
    sourceMethod: nationalCatalogCardSourceMethod("source_method").notNull(),
    latestSnapshotId: uuid("latest_snapshot_id").notNull(),
    providerEtag: text("provider_etag"),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }).notNull(),
    lastOutcome: nationalCatalogFreshnessOutcome("last_outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.cardId, table.sourceMethod],
    }),
    check(
      "national_catalog_card_freshness_source_method_ck",
      sql`${table.sourceMethod} <> 'legacy_unknown'`,
    ),
    foreignKey({
      name: "national_catalog_card_freshness_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "national_catalog_card_freshness_snapshot_fk",
      columns: [
        table.tenantId,
        table.productId,
        table.cardId,
        table.sourceMethod,
        table.latestSnapshotId,
      ],
      foreignColumns: [
        nationalCatalogCardSnapshots.tenantId,
        nationalCatalogCardSnapshots.productId,
        nationalCatalogCardSnapshots.cardId,
        nationalCatalogCardSnapshots.sourceMethod,
        nationalCatalogCardSnapshots.id,
      ],
    }),
  ],
);

export const productRegulatoryProposals = pgTable(
  "product_regulatory_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    snapshotId: uuid("snapshot_id"),
    kind: productRegulatoryProposalKind("kind").notNull(),
    source: productAttributeSource("source").notNull(),
    sourceRef: text("source_ref"),
    baseRevision: integer("base_revision").notNull(),
    diff: jsonb("diff").notNull(),
    status: productRegulatoryProposalStatus("status").notNull().default("preview"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    terminalReason: text("terminal_reason"),
    appliedSelection: jsonb("applied_selection"),
    appliedSelectionHash: char("applied_selection_hash", { length: 64 }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    appliedBy: text("applied_by").references(() => user.id, { onDelete: "set null" }),
    rejectedBy: text("rejected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    staleAt: timestamp("stale_at", { withTimezone: true }),
  },
  (table) => [
    unique("product_regulatory_proposals_tenant_product_id_uq").on(
      table.tenantId,
      table.productId,
      table.id,
    ),
    check("product_regulatory_proposals_base_revision_ck", sql`${table.baseRevision} >= 0`),
    check(
      "product_regulatory_proposals_applied_selection_ck",
      sql`${table.appliedSelection} is null or jsonb_typeof(${table.appliedSelection}) = 'array'`,
    ),
    check(
      "product_regulatory_proposals_applied_selection_hash_ck",
      sql`${table.appliedSelectionHash} is null or ${table.appliedSelection} is not null`,
    ),
    foreignKey({
      name: "product_regulatory_proposals_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_regulatory_proposals_snapshot_fk",
      columns: [table.tenantId, table.productId, table.snapshotId],
      foreignColumns: [
        nationalCatalogCardSnapshots.tenantId,
        nationalCatalogCardSnapshots.productId,
        nationalCatalogCardSnapshots.id,
      ],
    }),
  ],
);

export const productRegulatoryBindingHistory = pgTable(
  "product_regulatory_binding_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    proposalId: uuid("proposal_id"),
    priorCategoryId: text("prior_category_id"),
    priorSchemaVersionId: uuid("prior_schema_version_id").references(
      () => nationalCatalogSchemaVersions.id,
    ),
    nextCategoryId: text("next_category_id").notNull(),
    nextSchemaVersionId: uuid("next_schema_version_id")
      .notNull()
      .references(() => nationalCatalogSchemaVersions.id),
    resultingRevision: integer("resulting_revision").notNull(),
    source: productAttributeSource("source").notNull(),
    sourceRef: text("source_ref"),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "product_regulatory_binding_history_resulting_revision_ck",
      sql`${table.resultingRevision} > 0`,
    ),
    foreignKey({
      name: "product_regulatory_binding_history_tenant_product_fk",
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_regulatory_binding_history_proposal_fk",
      columns: [table.tenantId, table.productId, table.proposalId],
      foreignColumns: [
        productRegulatoryProposals.tenantId,
        productRegulatoryProposals.productId,
        productRegulatoryProposals.id,
      ],
    }),
  ],
);
