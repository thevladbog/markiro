import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth.js";
import { mediaAssets } from "./media.js";
import { products } from "./platform.js";
import { nationalCatalogCardSnapshots } from "./product-regulatory.js";

export const nationalCatalogEnvironment = pgEnum("national_catalog_environment", [
  "production",
  "sandbox",
]);
export const nationalCatalogImportMode = pgEnum("national_catalog_import_mode", [
  "own_catalog",
  "gtins",
]);
export const nationalCatalogImportSessionState = pgEnum("national_catalog_import_session_state", [
  "queued",
  "loading",
  "ready",
  "partial",
  "blocked",
  "cancelled",
  "expired",
]);
export const nationalCatalogImportMatch = pgEnum("national_catalog_import_match", [
  "new",
  "existing",
  "linked",
  "other_link",
  "archived_local",
  "ambiguous",
  "invalid",
  "inaccessible",
  "not_found",
]);
export const nationalCatalogImportAccess = pgEnum("national_catalog_import_access", [
  "own",
  "provided",
]);
export const nationalCatalogImportOperationState = pgEnum(
  "national_catalog_import_operation_state",
  ["pending", "running", "finished", "cancelled"],
);
export const nationalCatalogImportProductResult = pgEnum("national_catalog_import_product_result", [
  "pending",
  "applied",
  "conflict",
  "failed",
  "cancelled",
]);
export const nationalCatalogImportImageResult = pgEnum("national_catalog_import_image_result", [
  "none",
  "pending",
  "applied",
  "unchanged",
  "failed",
]);
export const nationalCatalogImportImageState = pgEnum("national_catalog_import_image_state", [
  "pending",
  "ready",
  "failed",
  "released",
]);
export const nationalCatalogLinkOutcome = pgEnum("national_catalog_link_outcome", [
  "ok",
  "error",
  "never",
]);
export const nationalCatalogStatusKey = pgEnum("national_catalog_status_key", [
  "draft",
  "moderation",
  "errors",
  "unsigned",
  "published",
  "archived",
  "unknown",
]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);
const actorId = () =>
  text("actor_id")
    .notNull()
    .references(() => user.id);
const at = (name: string) => timestamp(name, { withTimezone: true });
const hash = (name: string) => char(name, { length: 64 });

/** Expiry closes new work. Identity rows remain while accepted receipts reference them. */
export const nationalCatalogImportSessions = pgTable(
  "national_catalog_import_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    actorId: actorId(),
    environment: nationalCatalogEnvironment("environment").notNull(),
    mode: nationalCatalogImportMode("mode").notNull(),
    state: nationalCatalogImportSessionState("state").notNull().default("queued"),
    revision: integer("revision").notNull().default(1),
    startedAt: at("started_at").notNull().defaultNow(),
    throughAt: at("through_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    loaded: integer("loaded").notNull().default(0),
    selected: integer("selected").notNull().default(0),
    complete: boolean("complete").notNull().default(false),
    intervalStack: jsonb("interval_stack"),
    cursor: jsonb("cursor"),
    checkpoint: jsonb("checkpoint"),
    catchUpBoundary: at("catch_up_boundary"),
    incompleteReason: text("incomplete_reason"),
    cancelledAt: at("cancelled_at"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_import_sessions_tenant_id_uq").on(t.tenantId, t.id),
    index("nc_import_sessions_expiry_idx").on(t.expiresAt),
    check(
      "nc_import_sessions_counts_ck",
      sql`${t.loaded} between 0 and 100000 and ${t.selected} between 0 and ${t.loaded}`,
    ),
    check("nc_import_sessions_revision_ck", sql`${t.revision} > 0`),
    check("nc_import_sessions_expiry_ck", sql`${t.expiresAt} > ${t.startedAt}`),
  ],
);

export const nationalCatalogImportItems = pgTable(
  "national_catalog_import_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    input: text("input"),
    gtin14: char("gtin14", { length: 14 }),
    cardId: text("card_id"),
    name: text("name"),
    brand: text("brand"),
    statusKeys: nationalCatalogStatusKey("status_keys")
      .array()
      .notNull()
      .default(sql`'{}'`),
    rawStatus: text("raw_status"),
    rawDetailedStatuses: text("raw_detailed_statuses")
      .array()
      .notNull()
      .default(sql`'{}'`),
    match: nationalCatalogImportMatch("match").notNull(),
    productId: uuid("product_id"),
    selected: boolean("selected").notNull().default(false),
    selectable: boolean("selectable").notNull().default(false),
    reason: text("reason"),
    access: nationalCatalogImportAccess("access"),
    source: jsonb("source"),
    sourceHash: hash("source_hash"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_import_items_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_items_session_id_uq").on(t.tenantId, t.sessionId, t.id),
    uniqueIndex("nc_import_items_card_gtin_uq")
      .on(t.tenantId, t.sessionId, t.cardId, t.gtin14)
      .where(sql`${t.cardId} is not null and ${t.gtin14} is not null`),
    foreignKey({
      name: "nc_import_items_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [nationalCatalogImportSessions.tenantId, nationalCatalogImportSessions.id],
    }),
    foreignKey({
      name: "nc_import_items_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    check("nc_import_items_gtin_ck", sql`${t.gtin14} is null or ${t.gtin14} ~ '^[0-9]{14}$'`),
    check("nc_import_items_selected_ck", sql`not ${t.selected} or ${t.selectable}`),
  ],
);

/** Issued content is immutable in the repository. Only explicit safe GC may clear payloads. */
export const nationalCatalogImportPreviews = pgTable(
  "national_catalog_import_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    itemId: uuid("item_id").notNull(),
    productId: uuid("product_id"),
    expiresAt: at("expires_at").notNull(),
    source: jsonb("source"),
    sourceHash: hash("source_hash").notNull(),
    expectedProductRevision: text("expected_product_revision"),
    expectedProfileRevision: integer("expected_profile_revision"),
    expectedLinkRevision: integer("expected_link_revision"),
    expectedSchemaRevision: text("expected_schema_revision"),
    previousValues: jsonb("previous_values"),
    previousPhoto: jsonb("previous_photo"),
    diff: jsonb("diff"),
    manualProvenance: jsonb("manual_provenance"),
    categoryOptions: jsonb("category_options"),
    createdAt: at("created_at").notNull().defaultNow(),
    payloadPurgedAt: at("payload_purged_at"),
  },
  (t) => [
    unique("nc_import_previews_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_previews_session_id_uq").on(t.tenantId, t.sessionId, t.id),
    unique("nc_import_previews_source_uq").on(t.tenantId, t.sessionId, t.id, t.sourceHash),
    foreignKey({
      name: "nc_import_previews_item_fk",
      columns: [t.tenantId, t.sessionId, t.itemId],
      foreignColumns: [
        nationalCatalogImportItems.tenantId,
        nationalCatalogImportItems.sessionId,
        nationalCatalogImportItems.id,
      ],
    }),
    foreignKey({
      name: "nc_import_previews_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    index("nc_import_previews_expiry_idx").on(t.expiresAt),
    check(
      "nc_import_previews_revisions_ck",
      sql`(${t.expectedProfileRevision} is null or ${t.expectedProfileRevision} >= 0) and (${t.expectedLinkRevision} is null or ${t.expectedLinkRevision} >= 0)`,
    ),
  ],
);

export const nationalCatalogImportOperations = pgTable(
  "national_catalog_import_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    actorId: actorId(),
    requestId: uuid("request_id").notNull(),
    decisionHash: hash("decision_hash").notNull(),
    state: nationalCatalogImportOperationState("state").notNull().default("pending"),
    enqueuePending: boolean("enqueue_pending").notNull().default(true),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
    cancelledAt: at("cancelled_at"),
  },
  (t) => [
    unique("nc_import_operations_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_operations_session_id_uq").on(t.tenantId, t.sessionId, t.id),
    unique("nc_import_operations_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "nc_import_operations_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [nationalCatalogImportSessions.tenantId, nationalCatalogImportSessions.id],
    }),
    index("nc_import_operations_enqueue_idx")
      .on(t.createdAt)
      .where(sql`${t.enqueuePending} = true`),
  ],
);

/** Source URLs are server-only. Retain accepted assets until retry is explicitly ended. */
export const nationalCatalogImportImages = pgTable(
  "national_catalog_import_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    sourceHash: hash("source_hash").notNull(),
    sourceUrl: text("source_url"),
    stagedAssetId: uuid("staged_asset_id"),
    checksum: hash("checksum"),
    byteSize: integer("byte_size"),
    width: integer("width"),
    height: integer("height"),
    state: nationalCatalogImportImageState("state").notNull().default("pending"),
    expiresAt: at("expires_at").notNull(),
    primary: boolean("primary").notNull().default(false),
    errorCode: text("error_code"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_import_images_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_images_preview_id_uq").on(t.tenantId, t.sessionId, t.previewId, t.id),
    unique("nc_import_images_candidate_uq").on(t.tenantId, t.sessionId, t.previewId, t.candidateId),
    foreignKey({
      name: "nc_import_images_source_fk",
      columns: [t.tenantId, t.sessionId, t.previewId, t.sourceHash],
      foreignColumns: [
        nationalCatalogImportPreviews.tenantId,
        nationalCatalogImportPreviews.sessionId,
        nationalCatalogImportPreviews.id,
        nationalCatalogImportPreviews.sourceHash,
      ],
    }),
    foreignKey({
      name: "nc_import_images_asset_fk",
      columns: [t.tenantId, t.stagedAssetId],
      foreignColumns: [mediaAssets.ownerTenantId, mediaAssets.id],
    }),
    index("nc_import_images_expiry_idx").on(t.expiresAt),
    check(
      "nc_import_images_dimensions_ck",
      sql`(${t.byteSize} is null or ${t.byteSize} between 1 and 5242880) and (${t.width} is null or ${t.width} between 1 and 1200) and (${t.height} is null or ${t.height} between 1 and 1200)`,
    ),
    check(
      "nc_import_images_ready_ck",
      sql`${t.state} <> 'ready' or (${t.stagedAssetId} is not null and ${t.checksum} is not null and ${t.byteSize} is not null and ${t.width} is not null and ${t.height} is not null)`,
    ),
  ],
);

/** Durable exact decisions/results outlive temporary previews; failed photos can still retry. */
export const nationalCatalogImportOperationItems = pgTable(
  "national_catalog_import_operation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    decision: jsonb("decision").notNull(),
    appliedEvidence: jsonb("applied_evidence"),
    productId: uuid("product_id"),
    productResult: nationalCatalogImportProductResult("product_result")
      .notNull()
      .default("pending"),
    imageResult: nationalCatalogImportImageResult("image_result").notNull().default("none"),
    acceptedImageId: uuid("accepted_image_id"),
    imageRetryEligible: boolean("image_retry_eligible").notNull().default(false),
    errorCode: text("error_code"),
    imageErrorCode: text("image_error_code"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at"),
    imageAttempts: integer("image_attempts").notNull().default(0),
    nextImageAttemptAt: at("next_image_attempt_at"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_import_operation_items_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_operation_items_preview_uq").on(t.tenantId, t.operationId, t.previewId),
    foreignKey({
      name: "nc_import_operation_items_operation_fk",
      columns: [t.tenantId, t.sessionId, t.operationId],
      foreignColumns: [
        nationalCatalogImportOperations.tenantId,
        nationalCatalogImportOperations.sessionId,
        nationalCatalogImportOperations.id,
      ],
    }),
    foreignKey({
      name: "nc_import_operation_items_preview_fk",
      columns: [t.tenantId, t.sessionId, t.previewId],
      foreignColumns: [
        nationalCatalogImportPreviews.tenantId,
        nationalCatalogImportPreviews.sessionId,
        nationalCatalogImportPreviews.id,
      ],
    }),
    foreignKey({
      name: "nc_import_operation_items_image_fk",
      columns: [t.tenantId, t.sessionId, t.previewId, t.acceptedImageId],
      foreignColumns: [
        nationalCatalogImportImages.tenantId,
        nationalCatalogImportImages.sessionId,
        nationalCatalogImportImages.previewId,
        nationalCatalogImportImages.id,
      ],
    }),
    foreignKey({
      name: "nc_import_operation_items_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    check(
      "nc_import_operation_items_attempts_ck",
      sql`${t.attempts} >= 0 and ${t.imageAttempts} >= 0`,
    ),
    check(
      "nc_import_operation_items_retry_ck",
      sql`not ${t.imageRetryEligible} or (${t.acceptedImageId} is not null and ${t.imageResult} in ('pending', 'failed'))`,
    ),
    check(
      "nc_import_operation_items_applied_ck",
      sql`${t.productResult} <> 'applied' or ${t.productId} is not null`,
    ),
  ],
);

export const nationalCatalogProductLinks = pgTable(
  "national_catalog_product_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    environment: nationalCatalogEnvironment("environment").notNull(),
    cardId: text("card_id").notNull(),
    boundGtin14: char("bound_gtin14", { length: 14 }).notNull(),
    revision: integer("revision").notNull().default(1),
    confirmedBy: text("confirmed_by")
      .notNull()
      .references(() => user.id),
    confirmedAt: at("confirmed_at").notNull().defaultNow(),
    closedBy: text("closed_by").references(() => user.id),
    closedAt: at("closed_at"),
    closedReason: text("closed_reason"),
    latestSnapshotId: uuid("latest_snapshot_id"),
    reviewedSnapshotId: uuid("reviewed_snapshot_id"),
    lastAttemptAt: at("last_attempt_at"),
    lastSuccessAt: at("last_success_at"),
    lastOutcome: nationalCatalogLinkOutcome("last_outcome").notNull().default("never"),
    rawStatus: text("raw_status"),
    rawDetailedStatuses: text("raw_detailed_statuses")
      .array()
      .notNull()
      .default(sql`'{}'`),
    statusKeys: nationalCatalogStatusKey("status_keys")
      .array()
      .notNull()
      .default(sql`'{}'`),
    observedMeaningfulHash: hash("observed_meaningful_hash"),
    reviewedMeaningfulHash: hash("reviewed_meaningful_hash"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_product_links_tenant_id_uq").on(t.tenantId, t.id),
    uniqueIndex("national_catalog_product_links_current")
      .on(t.tenantId, t.productId)
      .where(sql`${t.closedAt} is null`),
    index("nc_product_links_status_idx")
      .using("gin", t.statusKeys)
      .where(sql`${t.closedAt} is null`),
    index("nc_product_links_freshness_idx")
      .on(t.lastAttemptAt)
      .where(sql`${t.closedAt} is null`),
    foreignKey({
      name: "nc_product_links_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "nc_product_links_latest_snapshot_fk",
      columns: [t.tenantId, t.productId, t.latestSnapshotId],
      foreignColumns: [
        nationalCatalogCardSnapshots.tenantId,
        nationalCatalogCardSnapshots.productId,
        nationalCatalogCardSnapshots.id,
      ],
    }),
    foreignKey({
      name: "nc_product_links_reviewed_snapshot_fk",
      columns: [t.tenantId, t.productId, t.reviewedSnapshotId],
      foreignColumns: [
        nationalCatalogCardSnapshots.tenantId,
        nationalCatalogCardSnapshots.productId,
        nationalCatalogCardSnapshots.id,
      ],
    }),
    check("nc_product_links_revision_ck", sql`${t.revision} > 0`),
    check("nc_product_links_gtin_ck", sql`${t.boundGtin14} ~ '^[0-9]{14}$'`),
    check(
      "nc_product_links_closed_ck",
      sql`(${t.closedAt} is null and ${t.closedBy} is null and ${t.closedReason} is null) or (${t.closedAt} is not null and ${t.closedBy} is not null and ${t.closedReason} is not null)`,
    ),
  ],
);

export const nationalCatalogRequestLeases = pgTable(
  "national_catalog_request_leases",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    owner: uuid("owner").notNull(),
    fence: bigint("fence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    leaseUntil: at("lease_until").notNull(),
    nextAllowedAt: at("next_allowed_at").notNull(),
    totalQuota: jsonb("total_quota"),
    methodQuotas: jsonb("method_quotas"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [check("nc_request_leases_fence_ck", sql`${t.fence} >= 0`)],
);

/** Mutable durable preparation intent, separate from immutable issued comparisons. */
export const nationalCatalogImportPreparations = pgTable(
  "national_catalog_import_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    actorId: actorId(),
    requestId: uuid("request_id").notNull(),
    requestHash: hash("request_hash").notNull(),
    request: jsonb("request").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("nc_import_preparations_tenant_id_uq").on(t.tenantId, t.id),
    unique("nc_import_preparations_session_id_uq").on(t.tenantId, t.sessionId, t.id),
    unique("nc_import_preparations_request_uq").on(t.tenantId, t.sessionId, t.requestId),
    foreignKey({
      name: "nc_import_preparations_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [nationalCatalogImportSessions.tenantId, nationalCatalogImportSessions.id],
    }),
    index("nc_import_preparations_repair_idx").on(t.expiresAt, t.updatedAt),
  ],
);
