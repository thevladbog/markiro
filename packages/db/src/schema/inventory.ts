import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth.js";
import { labelTemplates } from "./labels.js";
import { employees } from "./pickup.js";
import { lines, products, stationDevices } from "./platform.js";

export const INVENTORY_CHZ_STATUSES = [
  "EMITTED",
  "INTRODUCED",
  "APPLIED",
  "RETIRED",
  "WRITTEN_OFF",
  "DISAGGREGATION",
] as const;
export type InventoryChzStatus = (typeof INVENTORY_CHZ_STATUSES)[number];

export const INVENTORY_LIFECYCLE_STATUSES = [
  "draft",
  "preparing",
  "ready",
  "cancelled",
  "running",
  "closed",
  "completed",
] as const;
export type InventoryLifecycleStatus = (typeof INVENTORY_LIFECYCLE_STATUSES)[number];

export const INVENTORY_MODES = ["check", "repack"] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];

export const INVENTORY_IMPORT_CONTAINER_KINDS = ["csv", "zip", "xlsx"] as const;
export type InventoryImportContainerKind = (typeof INVENTORY_IMPORT_CONTAINER_KINDS)[number];

export const INVENTORY_IMPORT_PARSE_OUTCOMES = ["succeeded", "failed"] as const;
export type InventoryImportParseOutcome = (typeof INVENTORY_IMPORT_PARSE_OUTCOMES)[number];

export const INVENTORY_PARTICIPANT_JOIN_METHODS = ["assigned_line", "task_barcode"] as const;
export type InventoryParticipantJoinMethod = (typeof INVENTORY_PARTICIPANT_JOIN_METHODS)[number];

export const INVENTORY_SCAN_BATCH_OUTCOMES = ["applied", "rejected", "quarantined"] as const;
export type InventoryScanBatchOutcome = (typeof INVENTORY_SCAN_BATCH_OUTCOMES)[number];

export const INVENTORY_SCAN_EVENT_KINDS = [
  "item",
  "known_box",
  "old_box",
  "repack_action",
] as const;
export type InventoryScanEventKind = (typeof INVENTORY_SCAN_EVENT_KINDS)[number];

export const INVENTORY_CODE_CLASSIFICATIONS = [
  "expected",
  "protected",
  "ineligible",
  "unknown",
  "voided",
] as const;
export type InventoryCodeClassification = (typeof INVENTORY_CODE_CLASSIFICATIONS)[number];

export const INVENTORY_REPACK_BOX_STATES = ["open", "closed", "invalidated"] as const;
export type InventoryRepackBoxState = (typeof INVENTORY_REPACK_BOX_STATES)[number];

export const INVENTORY_REPACK_PRINT_STATES = [
  "not_ready",
  "pending",
  "printing",
  "printed",
  "failed",
] as const;
export type InventoryRepackPrintState = (typeof INVENTORY_REPACK_PRINT_STATES)[number];

export const INVENTORY_CORRECTION_ACTIONS = [
  "void_scan",
  "restore_scan",
  "change_date",
  "remove_item",
  "invalidate_box",
  "reprint",
] as const;
export type InventoryCorrectionAction = (typeof INVENTORY_CORRECTION_ACTIONS)[number];

export const INVENTORY_LATE_EVENT_RESOLUTIONS = ["pending", "replayed", "discarded"] as const;
export type InventoryLateEventResolution = (typeof INVENTORY_LATE_EVENT_RESOLUTIONS)[number];

export const INVENTORY_PROGRESS_CHANGE_KINDS = ["claim", "correction"] as const;
export type InventoryProgressChangeKind = (typeof INVENTORY_PROGRESS_CHANGE_KINDS)[number];

export const INVENTORY_DOCUMENT_RUN_STATUSES = ["queued", "processing", "ready", "failed"] as const;
export type InventoryDocumentRunStatus = (typeof INVENTORY_DOCUMENT_RUN_STATUSES)[number];

export const inventoryChzStatusEnum = pgEnum("inventory_chz_status", INVENTORY_CHZ_STATUSES);
export const inventoryLifecycleStatusEnum = pgEnum(
  "inventory_lifecycle_status",
  INVENTORY_LIFECYCLE_STATUSES,
);
export const inventoryModeEnum = pgEnum("inventory_mode", INVENTORY_MODES);
export const inventoryImportContainerKindEnum = pgEnum(
  "inventory_import_container_kind",
  INVENTORY_IMPORT_CONTAINER_KINDS,
);
export const inventoryImportParseOutcomeEnum = pgEnum(
  "inventory_import_parse_outcome",
  INVENTORY_IMPORT_PARSE_OUTCOMES,
);
export const inventoryParticipantJoinMethodEnum = pgEnum(
  "inventory_participant_join_method",
  INVENTORY_PARTICIPANT_JOIN_METHODS,
);
export const inventoryScanBatchOutcomeEnum = pgEnum(
  "inventory_scan_batch_outcome",
  INVENTORY_SCAN_BATCH_OUTCOMES,
);
export const inventoryScanEventKindEnum = pgEnum(
  "inventory_scan_event_kind",
  INVENTORY_SCAN_EVENT_KINDS,
);
export const inventoryCodeClassificationEnum = pgEnum(
  "inventory_code_classification",
  INVENTORY_CODE_CLASSIFICATIONS,
);
export const inventoryRepackBoxStateEnum = pgEnum(
  "inventory_repack_box_state",
  INVENTORY_REPACK_BOX_STATES,
);
export const inventoryRepackPrintStateEnum = pgEnum(
  "inventory_repack_print_state",
  INVENTORY_REPACK_PRINT_STATES,
);
export const inventoryCorrectionActionEnum = pgEnum(
  "inventory_correction_action",
  INVENTORY_CORRECTION_ACTIONS,
);
export const inventoryLateEventResolutionEnum = pgEnum(
  "inventory_late_event_resolution",
  INVENTORY_LATE_EVENT_RESOLUTIONS,
);
export const inventoryProgressChangeKindEnum = pgEnum(
  "inventory_progress_change_kind",
  INVENTORY_PROGRESS_CHANGE_KINDS,
);
export const inventoryDocumentRunStatusEnum = pgEnum(
  "inventory_document_run_status",
  INVENTORY_DOCUMENT_RUN_STATUSES,
);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

type InventorySnapshotForeignKeyTarget = {
  tenantId: AnyPgColumn;
  id: AnyPgColumn;
  inventoryId: AnyPgColumn;
};

const inventorySnapshotForeignKeyTarget: {
  current: InventorySnapshotForeignKeyTarget | undefined;
} = { current: undefined };

function activeSnapshotForeignKeyTarget(): InventorySnapshotForeignKeyTarget {
  if (inventorySnapshotForeignKeyTarget.current === undefined) {
    throw new Error("inventory snapshot table is not initialized");
  }
  return inventorySnapshotForeignKeyTarget.current;
}

/**
 * One tenant-owned inventory operation. The product, GTIN, line, mode and
 * inclusive production-date range are fixed before the immutable snapshot is
 * published. Later execution tables attach to this aggregate in later slices.
 */
export const inventories = pgTable(
  "inventories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    number: text("number").notNull(),
    productId: uuid("product_id").notNull(),
    gtin14Snapshot: char("gtin14_snapshot", { length: 14 }).notNull(),
    lineId: uuid("line_id").notNull(),
    mode: inventoryModeEnum("mode").notNull(),
    productionDateFrom: date("production_date_from").notNull(),
    productionDateTo: date("production_date_to").notNull(),
    boxLabelTemplateId: uuid("box_label_template_id"),
    status: inventoryLifecycleStatusEnum("status").notNull().default("draft"),
    activeSnapshotId: uuid("active_snapshot_id"),
    stationManifest: jsonb("station_manifest"),
    resultRevision: integer("result_revision").notNull().default(0),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    cancelledByUserId: text("cancelled_by_user_id").references(() => user.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    startedAt: timestamp("started_at", { withTimezone: true }),
    closedByUserId: text("closed_by_user_id").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    emergencyCloseReason: text("emergency_close_reason"),
    emergencyClosedByUserId: text("emergency_closed_by_user_id").references(() => user.id),
    emergencyClosedAt: timestamp("emergency_closed_at", { withTimezone: true }),
    completionAcknowledgedByUserId: text("completion_acknowledged_by_user_id").references(
      () => user.id,
    ),
    completionAcknowledgedAt: timestamp("completion_acknowledged_at", { withTimezone: true }),
    completedByUserId: text("completed_by_user_id").references(() => user.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    const snapshot = activeSnapshotForeignKeyTarget();
    return [
      unique("inventories_tenant_id_uq").on(table.tenantId, table.id),
      unique("inventories_tenant_number_uq").on(table.tenantId, table.number),
      foreignKey({
        name: "inventories_tenant_product_fk",
        columns: [table.tenantId, table.productId],
        foreignColumns: [products.tenantId, products.id],
      }),
      foreignKey({
        name: "inventories_tenant_line_fk",
        columns: [table.tenantId, table.lineId],
        foreignColumns: [lines.tenantId, lines.id],
      }),
      foreignKey({
        name: "inventories_tenant_box_label_template_fk",
        columns: [table.tenantId, table.boxLabelTemplateId],
        foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
      }),
      foreignKey({
        name: "inventories_tenant_active_snapshot_fk",
        columns: [table.tenantId, table.activeSnapshotId, table.id],
        foreignColumns: [snapshot.tenantId, snapshot.id, snapshot.inventoryId],
      }),
      index("inventories_tenant_status_dates_idx").on(
        table.tenantId,
        table.status,
        table.productionDateFrom,
        table.productionDateTo,
      ),
      check(
        "inventories_production_date_order_check",
        sql`${table.productionDateFrom} <= ${table.productionDateTo}`,
      ),
      check("inventories_gtin14_snapshot_check", sql`${table.gtin14Snapshot} ~ '^[0-9]{14}$'`),
      check("inventories_number_nonempty_check", sql`length(btrim(${table.number})) > 0`),
      check("inventories_result_revision_nonnegative_check", sql`${table.resultRevision} >= 0`),
      check(
        "inventories_mode_template_check",
        sql`(${table.mode} = 'check' and ${table.boxLabelTemplateId} is null)
        or (${table.mode} = 'repack' and ${table.boxLabelTemplateId} is not null)`,
      ),
      check(
        "inventories_active_snapshot_lifecycle_check",
        sql`(${table.status} in ('draft', 'preparing') and ${table.activeSnapshotId} is null)
        or (${table.status} = 'cancelled')
        or (${table.status} in ('ready', 'running', 'closed', 'completed') and ${table.activeSnapshotId} is not null)`,
      ),
      check(
        "inventories_station_manifest_lifecycle_check",
        sql`(${table.status} in ('draft', 'preparing', 'ready', 'cancelled') and ${table.stationManifest} is null)
        or (${table.status} in ('running', 'closed', 'completed') and ${table.stationManifest} is not null)`,
      ),
      check(
        "inventories_cancelled_fields_check",
        sql`(${table.cancelledByUserId} is null and ${table.cancelledAt} is null)
          or (${table.cancelledByUserId} is not null and ${table.cancelledAt} is not null)`,
      ),
      check(
        "inventories_cancelled_lifecycle_check",
        sql`(${table.status} = 'cancelled'
            and ${table.cancelledByUserId} is not null
            and ${table.cancelledAt} is not null)
          or (${table.status} <> 'cancelled'
            and ${table.cancelledByUserId} is null
            and ${table.cancelledAt} is null)`,
      ),
      check(
        "inventories_emergency_close_fields_check",
        sql`(${table.emergencyCloseReason} is null and ${table.emergencyClosedByUserId} is null and ${table.emergencyClosedAt} is null)
        or (${table.emergencyCloseReason} is not null and ${table.emergencyClosedByUserId} is not null and ${table.emergencyClosedAt} is not null)`,
      ),
      check(
        "inventories_completion_acknowledgement_fields_check",
        sql`(${table.completionAcknowledgedByUserId} is null and ${table.completionAcknowledgedAt} is null)
        or (${table.completionAcknowledgedByUserId} is not null and ${table.completionAcknowledgedAt} is not null)`,
      ),
      check(
        "inventories_started_fields_check",
        sql`(${table.startedByUserId} is null and ${table.startedAt} is null)
          or (${table.startedByUserId} is not null and ${table.startedAt} is not null)`,
      ),
      check(
        "inventories_closed_fields_check",
        sql`(${table.closedByUserId} is null and ${table.closedAt} is null)
          or (${table.closedByUserId} is not null and ${table.closedAt} is not null)`,
      ),
      check(
        "inventories_completed_fields_check",
        sql`(${table.completedByUserId} is null and ${table.completedAt} is null)
          or (${table.completedByUserId} is not null and ${table.completedAt} is not null)`,
      ),
      check(
        "inventories_completed_lifecycle_check",
        sql`(${table.status} = 'completed'
            and ${table.completedByUserId} is not null
            and ${table.completedAt} is not null
            and ${table.completionAcknowledgedByUserId} is not null
            and ${table.completionAcknowledgedAt} is not null)
          or (${table.status} <> 'completed'
            and ${table.completedByUserId} is null
            and ${table.completedAt} is null
            and ${table.completionAcknowledgedByUserId} is null
            and ${table.completionAcknowledgedAt} is null)`,
      ),
    ];
  },
);

export interface InventoryDocumentFormatSelection {
  id: string;
  version: number;
}

/** One immutable request to render selected formats from one closed result revision. */
export const inventoryDocumentRuns = pgTable(
  "inventory_document_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    resultRevision: integer("result_revision").notNull(),
    selectedFormats: jsonb("selected_formats")
      .$type<InventoryDocumentFormatSelection[]>()
      .notNull(),
    requestDigest: char("request_digest", { length: 64 }).notNull(),
    organizationNameSnapshot: text("organization_name_snapshot").notNull(),
    organizationInnSnapshot: text("organization_inn_snapshot"),
    inventoryNumberSnapshot: text("inventory_number_snapshot").notNull(),
    inventoryClosedAtSnapshot: timestamp("inventory_closed_at_snapshot", {
      withTimezone: true,
    }).notNull(),
    status: inventoryDocumentRunStatusEnum("status").notNull().default("queued"),
    errorCode: text("error_code"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    sourceSnapshotStartedAt: timestamp("source_snapshot_started_at", { withTimezone: true }),
    sourceSnapshotCompletedAt: timestamp("source_snapshot_completed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_document_runs_tenant_id_uq").on(table.tenantId, table.id),
    unique("inventory_document_runs_tenant_actor_idempotency_uq").on(
      table.tenantId,
      table.createdByUserId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "inventory_document_runs_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    index("inventory_document_runs_tenant_inventory_created_idx").on(
      table.tenantId,
      table.inventoryId,
      table.createdAt,
    ),
    index("inventory_document_runs_queued_created_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    check(
      "inventory_document_runs_result_revision_nonnegative_check",
      sql`${table.resultRevision} >= 0`,
    ),
    check(
      "inventory_document_runs_selected_formats_nonempty_check",
      sql`jsonb_typeof(${table.selectedFormats}) = 'array' and jsonb_array_length(${table.selectedFormats}) > 0`,
    ),
    check(
      "inventory_document_runs_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_document_runs_attempt_count_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "inventory_document_runs_status_consistency_check",
      sql`(${table.status} = 'ready' and ${table.completedAt} is not null and ${table.errorCode} is null)
        or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.errorCode} is not null)
        or (${table.status} in ('queued', 'processing') and ${table.completedAt} is null and ${table.errorCode} is null)`,
    ),
  ],
);

/** Verified private object produced for one selected format and part. */
export const inventoryDocumentArtifacts = pgTable(
  "inventory_document_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    formatId: text("format_id").notNull(),
    formatVersion: integer("format_version").notNull(),
    partNumber: integer("part_number").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    rowCount: integer("row_count").notNull(),
    codeCount: integer("code_count").notNull(),
    boxCount: integer("box_count").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    objectKey: text("object_key").notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    downloadedByUserId: text("downloaded_by_user_id").references(() => user.id),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_document_artifacts_tenant_id_uq").on(table.tenantId, table.id),
    unique("inventory_document_artifacts_tenant_run_format_part_uq").on(
      table.tenantId,
      table.runId,
      table.formatId,
      table.partNumber,
    ),
    foreignKey({
      name: "inventory_document_artifacts_tenant_run_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [inventoryDocumentRuns.tenantId, inventoryDocumentRuns.id],
    }),
    check(
      "inventory_document_artifacts_format_version_positive_check",
      sql`${table.formatVersion} > 0`,
    ),
    check("inventory_document_artifacts_part_number_positive_check", sql`${table.partNumber} > 0`),
    check("inventory_document_artifacts_row_count_nonnegative_check", sql`${table.rowCount} >= 0`),
    check(
      "inventory_document_artifacts_code_count_nonnegative_check",
      sql`${table.codeCount} >= 0`,
    ),
    check("inventory_document_artifacts_box_count_nonnegative_check", sql`${table.boxCount} >= 0`),
    check("inventory_document_artifacts_byte_size_nonnegative_check", sql`${table.byteSize} >= 0`),
    check("inventory_document_artifacts_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "inventory_document_artifacts_download_fields_check",
      sql`(${table.downloadedAt} is null and ${table.downloadedByUserId} is null)
        or (${table.downloadedAt} is not null and ${table.downloadedByUserId} is not null)`,
    ),
  ],
);

/** Append-only metadata for every upload attempt, including failed parses. */
export const inventoryImports = pgTable(
  "inventory_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    declaredStatus: inventoryChzStatusEnum("declared_status").notNull(),
    fileName: text("file_name").notNull(),
    containerKind: inventoryImportContainerKindEnum("container_kind").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    objectKey: text("object_key").notNull(),
    parsedStatus: inventoryChzStatusEnum("parsed_status"),
    includedGtin14: char("included_gtin14", { length: 14 }),
    parseOutcome: inventoryImportParseOutcomeEnum("parse_outcome").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    errorCode: text("error_code"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_imports_tenant_id_uq").on(table.tenantId, table.id),
    unique("inventory_imports_tenant_id_inventory_status_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
      table.declaredStatus,
    ),
    unique("inventory_imports_tenant_id_inventory_status_outcome_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
      table.declaredStatus,
      table.parseOutcome,
    ),
    foreignKey({
      name: "inventory_imports_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    index("inventory_imports_inventory_status_created_idx").on(
      table.tenantId,
      table.inventoryId,
      table.declaredStatus,
      table.createdAt,
    ),
    check("inventory_imports_byte_size_nonnegative_check", sql`${table.byteSize} >= 0`),
    check("inventory_imports_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "inventory_imports_included_gtin14_check",
      sql`${table.includedGtin14} is null or ${table.includedGtin14} ~ '^[0-9]{14}$'`,
    ),
    check(
      "inventory_imports_counts_nonnegative_check",
      sql`${table.rowCount} >= 0 and ${table.errorCount} >= 0 and ${table.duplicateCount} >= 0`,
    ),
    check(
      "inventory_imports_error_code_check",
      sql`${table.errorCode} is null or ${table.errorCode} ~ '^[A-Z][A-Z0-9_]{0,127}$'`,
    ),
    check(
      "inventory_imports_parse_outcome_check",
      sql`(${table.parseOutcome} = 'succeeded'
          and ${table.parsedStatus} is not null
          and ${table.parsedStatus} = ${table.declaredStatus}
          and ${table.includedGtin14} is not null
          and ${table.errorCount} = 0
          and ${table.errorCode} is null)
        or (${table.parseOutcome} = 'failed'
          and ${table.errorCount} > 0
          and ${table.errorCode} is not null)`,
    ),
  ],
);

/** One immutable fixation of the six selected imports for an inventory. */
export const inventorySnapshots = pgTable(
  "inventory_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    revision: integer("revision").notNull().default(1),
    combinedDigest: char("combined_digest", { length: 64 }).notNull(),
    productName: text("product_name").notNull(),
    lineName: text("line_name").notNull(),
    boxCapacity: integer("box_capacity"),
    emittedCount: integer("emitted_count").notNull(),
    introducedCount: integer("introduced_count").notNull(),
    appliedCount: integer("applied_count").notNull(),
    retiredCount: integer("retired_count").notNull(),
    writtenOffCount: integer("written_off_count").notNull(),
    disaggregationCount: integer("disaggregation_count").notNull(),
    protectedCount: integer("protected_count").notNull(),
    expectedCount: integer("expected_count").notNull(),
    packageCount: integer("package_count").notNull(),
    looseCount: integer("loose_count").notNull(),
    fixedByUserId: text("fixed_by_user_id")
      .notNull()
      .references(() => user.id),
    fixedAt: timestamp("fixed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_snapshots_tenant_id_uq").on(table.tenantId, table.id),
    unique("inventory_snapshots_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    unique("inventory_snapshots_tenant_inventory_uq").on(table.tenantId, table.inventoryId),
    foreignKey({
      name: "inventory_snapshots_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    check("inventory_snapshots_revision_positive_check", sql`${table.revision} > 0`),
    check(
      "inventory_snapshots_combined_digest_check",
      sql`${table.combinedDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_snapshots_counts_nonnegative_check",
      sql`${table.emittedCount} >= 0
        and ${table.introducedCount} >= 0
        and ${table.appliedCount} >= 0
        and ${table.retiredCount} >= 0
        and ${table.writtenOffCount} >= 0
        and ${table.disaggregationCount} >= 0
        and ${table.protectedCount} >= 0
        and ${table.expectedCount} >= 0
        and ${table.packageCount} >= 0
        and ${table.looseCount} >= 0`,
    ),
  ],
);

inventorySnapshotForeignKeyTarget.current = inventorySnapshots;

/** Exactly one selected successful import for each status in a snapshot. */
export const inventorySnapshotInputs = pgTable(
  "inventory_snapshot_inputs",
  {
    tenantId: tenantId(),
    snapshotId: uuid("snapshot_id").notNull(),
    inventoryId: uuid("inventory_id").notNull(),
    status: inventoryChzStatusEnum("status").notNull(),
    importId: uuid("import_id").notNull(),
    importParseOutcome: inventoryImportParseOutcomeEnum("import_parse_outcome")
      .notNull()
      .default("succeeded"),
  },
  (table) => [
    unique("inventory_snapshot_inputs_tenant_snapshot_status_uq").on(
      table.tenantId,
      table.snapshotId,
      table.status,
    ),
    unique("inventory_snapshot_inputs_tenant_snapshot_import_uq").on(
      table.tenantId,
      table.snapshotId,
      table.importId,
    ),
    foreignKey({
      name: "inventory_snapshot_inputs_tenant_snapshot_inventory_fk",
      columns: [table.tenantId, table.snapshotId, table.inventoryId],
      foreignColumns: [
        inventorySnapshots.tenantId,
        inventorySnapshots.id,
        inventorySnapshots.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_snapshot_inputs_tenant_import_inventory_status_fk",
      columns: [
        table.tenantId,
        table.importId,
        table.inventoryId,
        table.status,
        table.importParseOutcome,
      ],
      foreignColumns: [
        inventoryImports.tenantId,
        inventoryImports.id,
        inventoryImports.inventoryId,
        inventoryImports.declaredStatus,
        inventoryImports.parseOutcome,
      ],
    }),
    check(
      "inventory_snapshot_inputs_successful_import_check",
      sql`${table.importParseOutcome} = 'succeeded'`,
    ),
  ],
);

/** Canonical immutable code rows derived once while fixing the snapshot. */
export const inventorySnapshotCodes = pgTable(
  "inventory_snapshot_codes",
  {
    tenantId: tenantId(),
    snapshotId: uuid("snapshot_id").notNull(),
    canonicalRaw: text("canonical_raw").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    gtin14: char("gtin14", { length: 14 }).notNull(),
    serial: text("serial").notNull(),
    sourceStatus: inventoryChzStatusEnum("source_status").notNull(),
    sourceState: text("source_state"),
    sourceProductionDate: date("source_production_date"),
    parentSscc: char("parent_sscc", { length: 18 }),
    expected: boolean("expected").notNull(),
    protected: boolean("protected").notNull(),
  },
  (table) => [
    unique("inventory_snapshot_codes_tenant_hash_uq").on(
      table.tenantId,
      table.snapshotId,
      table.codeHash,
    ),
    foreignKey({
      name: "inventory_snapshot_codes_tenant_snapshot_fk",
      columns: [table.tenantId, table.snapshotId],
      foreignColumns: [inventorySnapshots.tenantId, inventorySnapshots.id],
    }),
    index("inventory_snapshot_codes_parent_sscc_idx").on(table.snapshotId, table.parentSscc),
    index("inventory_snapshot_codes_expected_date_idx").on(
      table.snapshotId,
      table.expected,
      table.sourceProductionDate,
    ),
    check("inventory_snapshot_codes_hash_check", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check("inventory_snapshot_codes_gtin14_check", sql`${table.gtin14} ~ '^[0-9]{14}$'`),
    check(
      "inventory_snapshot_codes_canonical_raw_size_check",
      sql`octet_length(${table.canonicalRaw}) between 1 and 1024`,
    ),
    check("inventory_snapshot_codes_serial_nonempty_check", sql`length(${table.serial}) > 0`),
    check(
      "inventory_snapshot_codes_parent_sscc_check",
      sql`${table.parentSscc} is null or ${table.parentSscc} ~ '^[0-9]{18}$'`,
    ),
    check(
      "inventory_snapshot_codes_classification_check",
      sql`not (${table.expected} and ${table.protected})
        and ${table.protected} = coalesce(${table.sourceState} = 'MOVING_BY_UD', false)
        and (${table.protected}
          or ${table.sourceStatus} <> 'INTRODUCED'
          or ${table.sourceProductionDate} is not null)
        and (not ${table.expected}
          or (${table.sourceStatus} = 'INTRODUCED' and ${table.sourceProductionDate} is not null))`,
    ),
  ],
);

/** One station device's participation and close-blocker counters for an inventory. */
export const inventoryDeviceParticipants = pgTable(
  "inventory_device_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    operatorId: uuid("operator_id").notNull(),
    configuredLineId: uuid("configured_line_id").notNull(),
    joinMethod: inventoryParticipantJoinMethodEnum("join_method").notNull(),
    differentLineConfirmed: boolean("different_line_confirmed").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    pendingEventCount: integer("pending_event_count").notNull().default(0),
    openBoxCount: integer("open_box_count").notNull().default(0),
  },
  (table) => [
    unique("inventory_device_participants_tenant_id_uq").on(table.tenantId, table.id),
    unique("inventory_device_participants_tenant_inventory_device_uq").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
    ),
    foreignKey({
      name: "inventory_device_participants_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_device_participants_tenant_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "inventory_device_participants_tenant_operator_fk",
      columns: [table.tenantId, table.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "inventory_device_participants_tenant_line_fk",
      columns: [table.tenantId, table.configuredLineId],
      foreignColumns: [lines.tenantId, lines.id],
    }),
    index("inventory_device_participants_close_blockers_idx").on(
      table.tenantId,
      table.inventoryId,
      table.leftAt,
      table.pendingEventCount,
      table.openBoxCount,
    ),
    check(
      "inventory_device_participants_counts_check",
      sql`${table.pendingEventCount} >= 0 and ${table.openBoxCount} >= 0`,
    ),
    check(
      "inventory_device_participants_timestamps_check",
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

/** Device-scoped idempotency ledger for a bounded inventory event batch. */
export const inventoryScanBatches = pgTable(
  "inventory_scan_batches",
  {
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    batchId: text("batch_id").notNull(),
    payloadDigest: char("payload_digest", { length: 64 }).notNull(),
    sequenceCeiling: bigint("sequence_ceiling", { mode: "bigint" }).notNull(),
    outcome: inventoryScanBatchOutcomeEnum("outcome").notNull(),
    // The outcome and its exact replay body are committed together; there is no persisted pending row.
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_scan_batches_scope_batch_uq").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.batchId,
    ),
    foreignKey({
      name: "inventory_scan_batches_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_scan_batches_tenant_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    index("inventory_scan_batches_replay_idx").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.receivedAt,
    ),
    check(
      "inventory_scan_batches_batch_id_check",
      sql`octet_length(${table.batchId}) between 1 and 128`,
    ),
    check(
      "inventory_scan_batches_payload_digest_check",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("inventory_scan_batches_sequence_check", sql`${table.sequenceCeiling} >= 0`),
  ],
);

/** Immutable client scan facts. Projections may change, but these rows do not. */
export const inventoryScanEvents = pgTable(
  "inventory_scan_events",
  {
    eventId: uuid("event_id").primaryKey(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    batchId: text("batch_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    deviceSequence: bigint("device_sequence", { mode: "bigint" }).notNull(),
    operatorId: uuid("operator_id").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    kind: inventoryScanEventKindEnum("kind").notNull(),
    normalizedIdentity: text("normalized_identity").notNull(),
    codeHash: char("code_hash", { length: 64 }),
    rawPayload: text("raw_payload"),
    activeProductionDate: date("active_production_date"),
    snapshotRevision: integer("snapshot_revision").notNull(),
    localVerdict: text("local_verdict").notNull(),
    authoritativeVerdict: text("authoritative_verdict").notNull(),
    firstWinningEventId: uuid("first_winning_event_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_scan_events_tenant_inventory_event_uq").on(
      table.tenantId,
      table.inventoryId,
      table.eventId,
    ),
    unique("inventory_scan_events_tenant_inventory_device_sequence_uq").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.deviceSequence,
    ),
    unique("inventory_scan_events_tenant_inventory_winner_identity_uq").on(
      table.tenantId,
      table.inventoryId,
      table.eventId,
      table.deviceId,
      table.scannedAt,
    ),
    foreignKey({
      name: "inventory_scan_events_tenant_batch_fk",
      columns: [table.tenantId, table.inventoryId, table.deviceId, table.batchId],
      foreignColumns: [
        inventoryScanBatches.tenantId,
        inventoryScanBatches.inventoryId,
        inventoryScanBatches.deviceId,
        inventoryScanBatches.batchId,
      ],
    }),
    foreignKey({
      name: "inventory_scan_events_tenant_operator_fk",
      columns: [table.tenantId, table.operatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "inventory_scan_events_tenant_first_winner_fk",
      columns: [table.tenantId, table.inventoryId, table.firstWinningEventId],
      foreignColumns: [table.tenantId, table.inventoryId, table.eventId],
    }),
    index("inventory_scan_events_progress_cursor_idx").on(
      table.tenantId,
      table.inventoryId,
      table.recordedAt,
      table.eventId,
    ),
    index("inventory_scan_events_batch_idx").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.batchId,
    ),
    check("inventory_scan_events_sequence_check", sql`${table.deviceSequence} >= 0`),
    check("inventory_scan_events_snapshot_revision_check", sql`${table.snapshotRevision} > 0`),
    check(
      "inventory_scan_events_normalized_identity_check",
      sql`octet_length(${table.normalizedIdentity}) between 1 and 1024`,
    ),
    check(
      "inventory_scan_events_code_hash_check",
      sql`${table.codeHash} is null or ${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_scan_events_raw_payload_check",
      sql`${table.rawPayload} is null or octet_length(${table.rawPayload}) between 1 and 2048`,
    ),
    check(
      "inventory_scan_events_verdicts_check",
      sql`octet_length(${table.localVerdict}) between 1 and 64
        and octet_length(${table.authoritativeVerdict}) between 1 and 64`,
    ),
  ],
);

/** Per-source-event/code authoritative claim projection; source scan facts stay immutable. */
export const inventoryEventClaimOutcomes = pgTable(
  "inventory_event_claim_outcomes",
  {
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    status: text("status").notNull(),
    winningEventId: uuid("winning_event_id").notNull(),
    winningDeviceId: uuid("winning_device_id").notNull(),
    winningScannedAt: timestamp("winning_scanned_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_event_claim_outcomes_source_code_uq").on(
      table.tenantId,
      table.inventoryId,
      table.sourceEventId,
      table.codeHash,
    ),
    foreignKey({
      name: "inventory_event_claim_outcomes_source_event_fk",
      columns: [table.tenantId, table.inventoryId, table.sourceEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_event_claim_outcomes_winner_event_fk",
      columns: [table.tenantId, table.inventoryId, table.winningEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_event_claim_outcomes_winner_device_fk",
      columns: [table.tenantId, table.winningDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "inventory_event_claim_outcomes_winner_identity_fk",
      columns: [
        table.tenantId,
        table.inventoryId,
        table.winningEventId,
        table.winningDeviceId,
        table.winningScannedAt,
      ],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
        inventoryScanEvents.deviceId,
        inventoryScanEvents.scannedAt,
      ],
    }),
    index("inventory_event_claim_outcomes_winner_idx").on(
      table.tenantId,
      table.inventoryId,
      table.winningEventId,
    ),
    check(
      "inventory_event_claim_outcomes_code_hash_check",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_event_claim_outcomes_status_check",
      sql`${table.status} in ('claimed', 'duplicate')`,
    ),
    check(
      "inventory_event_claim_outcomes_identity_check",
      sql`(${table.status} = 'claimed' and ${table.sourceEventId} = ${table.winningEventId})
        or (${table.status} = 'duplicate' and ${table.sourceEventId} <> ${table.winningEventId})`,
    ),
  ],
);

/** One authoritative current projection for every physically found code. */
export const inventoryCodeResults = pgTable(
  "inventory_code_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    snapshotId: uuid("snapshot_id"),
    firstAcceptedEventId: uuid("first_accepted_event_id").notNull(),
    winningDeviceId: uuid("winning_device_id").notNull(),
    winningScannedAt: timestamp("winning_scanned_at", { withTimezone: true }).notNull(),
    observedProductionDate: date("observed_production_date"),
    classification: inventoryCodeClassificationEnum("classification").notNull(),
    originClassification: inventoryCodeClassificationEnum("origin_classification").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_code_results_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    unique("inventory_code_results_current_claim_uq").on(
      table.tenantId,
      table.inventoryId,
      table.codeHash,
    ),
    unique("inventory_code_results_tenant_id_inventory_observed_date_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
      table.observedProductionDate,
    ),
    foreignKey({
      name: "inventory_code_results_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_code_results_tenant_snapshot_inventory_fk",
      columns: [table.tenantId, table.snapshotId, table.inventoryId],
      foreignColumns: [
        inventorySnapshots.tenantId,
        inventorySnapshots.id,
        inventorySnapshots.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_code_results_tenant_snapshot_code_fk",
      columns: [table.tenantId, table.snapshotId, table.codeHash],
      foreignColumns: [
        inventorySnapshotCodes.tenantId,
        inventorySnapshotCodes.snapshotId,
        inventorySnapshotCodes.codeHash,
      ],
    }),
    foreignKey({
      name: "inventory_code_results_tenant_first_event_fk",
      columns: [table.tenantId, table.inventoryId, table.firstAcceptedEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_code_results_tenant_winning_device_fk",
      columns: [table.tenantId, table.winningDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    index("inventory_code_results_progress_cursor_idx").on(
      table.tenantId,
      table.inventoryId,
      table.updatedAt,
      table.id,
    ),
    check("inventory_code_results_hash_check", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "inventory_code_results_snapshot_origin_check",
      sql`${table.originClassification} <> 'voided'
        and (${table.classification} = ${table.originClassification}
          or ${table.classification} = 'voided')
        and ((${table.originClassification} = 'unknown' and ${table.snapshotId} is null)
          or (${table.originClassification} in ('expected', 'protected', 'ineligible')
            and ${table.snapshotId} is not null))`,
    ),
  ],
);

/** Monotonic, restart-safe delta stream for Station claim/correction polling. */
export const inventoryProgressChanges = pgTable(
  "inventory_progress_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    resultRevision: integer("result_revision").notNull(),
    kind: inventoryProgressChangeKindEnum("kind").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    classification: inventoryCodeClassificationEnum("classification").notNull(),
    observedProductionDate: date("observed_production_date"),
    winningEventId: uuid("winning_event_id"),
    winningDeviceId: uuid("winning_device_id"),
    winningScannedAt: timestamp("winning_scanned_at", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_progress_changes_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    foreignKey({
      name: "inventory_progress_changes_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_progress_changes_tenant_snapshot_inventory_fk",
      columns: [table.tenantId, table.snapshotId, table.inventoryId],
      foreignColumns: [
        inventorySnapshots.tenantId,
        inventorySnapshots.id,
        inventorySnapshots.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_progress_changes_tenant_winner_event_fk",
      columns: [table.tenantId, table.inventoryId, table.winningEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_progress_changes_tenant_winner_device_fk",
      columns: [table.tenantId, table.winningDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    index("inventory_progress_changes_cursor_idx").on(
      table.tenantId,
      table.inventoryId,
      table.resultRevision,
      table.id,
    ),
    check("inventory_progress_changes_revision_check", sql`${table.resultRevision} > 0`),
    check("inventory_progress_changes_hash_check", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "inventory_progress_changes_winner_check",
      sql`(${table.winningEventId} is null and ${table.winningDeviceId} is null and ${table.winningScannedAt} is null)
        or (${table.winningEventId} is not null and ${table.winningDeviceId} is not null and ${table.winningScannedAt} is not null)`,
    ),
  ],
);

/** Durable repack box ownership, date, lifecycle and print work. */
export const inventoryRepackBoxes = pgTable(
  "inventory_repack_boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    oldSsccContext: char("old_sscc_context", { length: 18 }),
    newSscc: char("new_sscc", { length: 18 }).notNull(),
    ownerDeviceId: uuid("owner_device_id").notNull(),
    openedEventId: uuid("opened_event_id"),
    closedEventId: uuid("closed_event_id"),
    capacity: integer("capacity").notNull(),
    productionDate: date("production_date").notNull(),
    state: inventoryRepackBoxStateEnum("state").notNull().default("open"),
    printState: inventoryRepackPrintStateEnum("print_state").notNull().default("not_ready"),
    printAttemptCount: integer("print_attempt_count").notNull().default(0),
    printErrorCode: text("print_error_code"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_repack_boxes_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    unique("inventory_repack_boxes_tenant_id_inventory_date_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
      table.productionDate,
    ),
    unique("inventory_repack_boxes_tenant_sscc_uq").on(table.tenantId, table.newSscc),
    foreignKey({
      name: "inventory_repack_boxes_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_repack_boxes_tenant_owner_device_fk",
      columns: [table.tenantId, table.ownerDeviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "inventory_repack_boxes_tenant_opened_event_fk",
      columns: [table.tenantId, table.inventoryId, table.openedEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_repack_boxes_tenant_closed_event_fk",
      columns: [table.tenantId, table.inventoryId, table.closedEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    index("inventory_repack_boxes_owner_open_idx").on(
      table.tenantId,
      table.inventoryId,
      table.ownerDeviceId,
      table.state,
    ),
    index("inventory_repack_boxes_close_blockers_idx").on(
      table.tenantId,
      table.inventoryId,
      table.state,
      table.printState,
    ),
    check("inventory_repack_boxes_capacity_check", sql`${table.capacity} > 0`),
    check(
      "inventory_repack_boxes_sscc_check",
      sql`${table.newSscc} ~ '^[0-9]{18}$'
        and (${table.oldSsccContext} is null or ${table.oldSsccContext} ~ '^[0-9]{18}$')`,
    ),
    check(
      "inventory_repack_boxes_lifecycle_check",
      sql`(${table.state} = 'open' and ${table.closedAt} is null and ${table.invalidatedAt} is null)
        or (${table.state} = 'closed' and ${table.closedAt} is not null and ${table.invalidatedAt} is null)
        or (${table.state} = 'invalidated' and ${table.invalidatedAt} is not null)`,
    ),
    check(
      "inventory_repack_boxes_lifecycle_print_check",
      sql`(${table.state} = 'open' and ${table.printState} = 'not_ready')
        or (${table.state} = 'closed'
          and ${table.printState} in ('pending', 'printing', 'printed', 'failed'))
        or ${table.state} = 'invalidated'`,
    ),
    check(
      "inventory_repack_boxes_print_state_check",
      sql`(${table.printState} = 'failed' and ${table.printErrorCode} is not null)
        or ${table.printState} = 'printed'
        or (${table.printState} not in ('failed', 'printed') and ${table.printErrorCode} is null)`,
    ),
    check(
      "inventory_repack_boxes_print_error_code_check",
      sql`${table.printErrorCode} is null or ${table.printErrorCode} ~ '^[A-Z][A-Z0-9_]{0,127}$'`,
    ),
    check(
      "inventory_repack_boxes_print_attempt_count_check",
      sql`(${table.printState} = 'not_ready' and ${table.printAttemptCount} = 0)
        or (${table.printState} = 'pending' and ${table.printAttemptCount} >= 0)
        or (${table.printState} in ('printing', 'printed', 'failed')
          and ${table.printAttemptCount} > 0)`,
    ),
    check(
      "inventory_repack_boxes_printed_at_check",
      sql`(${table.printState} = 'printed' and ${table.printedAt} is not null)
        or (${table.printState} <> 'printed' and ${table.printedAt} is null)`,
    ),
  ],
);

/** Append-only membership evidence; removed rows permit a later corrected assignment. */
export const inventoryRepackItems = pgTable(
  "inventory_repack_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    boxId: uuid("box_id").notNull(),
    resultId: uuid("result_id").notNull(),
    sourceEventId: uuid("source_event_id"),
    position: integer("position"),
    sourceParentMismatch: boolean("source_parent_mismatch").notNull().default(false),
    productionDate: date("production_date").notNull(),
    // Non-null only while active, so removed history does not block a later date correction.
    activeObservedProductionDate: date("active_observed_production_date"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    unique("inventory_repack_items_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    uniqueIndex("inventory_repack_items_tenant_box_result_uq")
      .on(table.tenantId, table.boxId, table.resultId)
      .where(sql`${table.removedAt} is null`),
    uniqueIndex("inventory_repack_items_active_result_uq")
      .on(table.tenantId, table.inventoryId, table.resultId)
      .where(sql`${table.removedAt} is null`),
    foreignKey({
      name: "inventory_repack_items_tenant_box_date_fk",
      columns: [table.tenantId, table.boxId, table.inventoryId, table.productionDate],
      foreignColumns: [
        inventoryRepackBoxes.tenantId,
        inventoryRepackBoxes.id,
        inventoryRepackBoxes.inventoryId,
        inventoryRepackBoxes.productionDate,
      ],
    }),
    foreignKey({
      name: "inventory_repack_items_tenant_result_fk",
      columns: [table.tenantId, table.resultId, table.inventoryId],
      foreignColumns: [
        inventoryCodeResults.tenantId,
        inventoryCodeResults.id,
        inventoryCodeResults.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_repack_items_tenant_source_event_fk",
      columns: [table.tenantId, table.inventoryId, table.sourceEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    uniqueIndex("inventory_repack_items_active_box_position_uq")
      .on(table.tenantId, table.inventoryId, table.boxId, table.position)
      .where(sql`${table.removedAt} is null`),
    foreignKey({
      name: "inventory_repack_items_tenant_result_active_date_fk",
      columns: [
        table.tenantId,
        table.resultId,
        table.inventoryId,
        table.activeObservedProductionDate,
      ],
      foreignColumns: [
        inventoryCodeResults.tenantId,
        inventoryCodeResults.id,
        inventoryCodeResults.inventoryId,
        inventoryCodeResults.observedProductionDate,
      ],
    }),
    index("inventory_repack_items_box_active_idx").on(
      table.tenantId,
      table.inventoryId,
      table.boxId,
      table.removedAt,
    ),
    check(
      "inventory_repack_items_removed_at_check",
      sql`${table.removedAt} is null or ${table.removedAt} >= ${table.addedAt}`,
    ),
    check(
      "inventory_repack_items_active_observed_date_check",
      sql`(${table.removedAt} is null
          and ${table.activeObservedProductionDate} is not null
          and ${table.activeObservedProductionDate} = ${table.productionDate})
        or (${table.removedAt} is not null
          and ${table.activeObservedProductionDate} is null)`,
    ),
    check(
      "inventory_repack_items_position_check",
      sql`${table.position} is null or ${table.position} > 0`,
    ),
  ],
);

/** Append-only authoritative initial-label and exact-SSCC reprint outcomes. */
export const inventoryRepackPrintAttempts = pgTable(
  "inventory_repack_print_attempts",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    boxId: uuid("box_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    kind: text("kind").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    result: text("result").notNull(),
    errorCode: text("error_code"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_repack_print_attempts_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    unique("inventory_repack_print_attempts_box_number_uq").on(
      table.tenantId,
      table.inventoryId,
      table.boxId,
      table.attemptNumber,
    ),
    foreignKey({
      name: "inventory_repack_print_attempts_tenant_box_fk",
      columns: [table.tenantId, table.boxId, table.inventoryId],
      foreignColumns: [
        inventoryRepackBoxes.tenantId,
        inventoryRepackBoxes.id,
        inventoryRepackBoxes.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_repack_print_attempts_tenant_event_fk",
      columns: [table.tenantId, table.inventoryId, table.sourceEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    check(
      "inventory_repack_print_attempts_kind_check",
      sql`${table.kind} in ('initial', 'reprint')`,
    ),
    check(
      "inventory_repack_print_attempts_result_check",
      sql`(${table.result} = 'printed' and ${table.errorCode} is null)
        or (${table.result} = 'failed'
          and ${table.errorCode} in ('template_missing', 'printer_unconfigured',
            'render_failed', 'transport_failed', 'persistence_failed'))`,
    ),
    check("inventory_repack_print_attempts_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "inventory_repack_print_attempts_time_check",
      sql`${table.completedAt} >= ${table.attemptedAt}`,
    ),
    index("inventory_repack_print_attempts_box_idx").on(
      table.tenantId,
      table.inventoryId,
      table.boxId,
      table.attemptNumber,
    ),
  ],
);

/** One idempotent cabinet request that atomically changes multiple code projections. */
export const inventoryCorrectionBatches = pgTable(
  "inventory_correction_batches",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    action: inventoryCorrectionActionEnum("action").notNull(),
    reason: text("reason").notNull(),
    requestDigest: char("request_digest", { length: 64 }).notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id),
    selectedEventCount: integer("selected_event_count").notNull(),
    affectedCodeCount: integer("affected_code_count").notNull(),
    resultRevision: integer("result_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_correction_batches_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    foreignKey({
      name: "inventory_correction_batches_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    index("inventory_correction_batches_inventory_revision_idx").on(
      table.tenantId,
      table.inventoryId,
      table.resultRevision,
      table.createdAt,
      table.id,
    ),
    check(
      "inventory_correction_batches_action_check",
      sql`${table.action} in ('void_scan', 'change_date')`,
    ),
    check(
      "inventory_correction_batches_counts_check",
      sql`${table.selectedEventCount} > 0 and ${table.affectedCodeCount} > 0`,
    ),
    check(
      "inventory_correction_batches_reason_check",
      sql`octet_length(btrim(${table.reason})) between 1 and 1024`,
    ),
    check(
      "inventory_correction_batches_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("inventory_correction_batches_revision_check", sql`${table.resultRevision} > 0`),
  ],
);

/** Append-only projection correction with exact actor, target and revision evidence. */
export const inventoryCorrections = pgTable(
  "inventory_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    batchId: uuid("batch_id"),
    action: inventoryCorrectionActionEnum("action").notNull(),
    reason: text("reason").notNull(),
    requestDigest: char("request_digest", { length: 64 }).notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    actorOperatorId: uuid("actor_operator_id"),
    targetEventId: uuid("target_event_id"),
    targetCodeResultId: uuid("target_code_result_id"),
    targetRepackBoxId: uuid("target_repack_box_id"),
    beforeProjectionDigest: char("before_projection_digest", { length: 64 }).notNull(),
    afterProjectionDigest: char("after_projection_digest", { length: 64 }).notNull(),
    resultRevision: integer("result_revision").notNull(),
    effectAt: timestamp("effect_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("inventory_corrections_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    foreignKey({
      name: "inventory_corrections_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_corrections_tenant_batch_fk",
      columns: [table.tenantId, table.batchId, table.inventoryId],
      foreignColumns: [
        inventoryCorrectionBatches.tenantId,
        inventoryCorrectionBatches.id,
        inventoryCorrectionBatches.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_corrections_tenant_operator_fk",
      columns: [table.tenantId, table.actorOperatorId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "inventory_corrections_tenant_event_fk",
      columns: [table.tenantId, table.inventoryId, table.targetEventId],
      foreignColumns: [
        inventoryScanEvents.tenantId,
        inventoryScanEvents.inventoryId,
        inventoryScanEvents.eventId,
      ],
    }),
    foreignKey({
      name: "inventory_corrections_tenant_result_fk",
      columns: [table.tenantId, table.targetCodeResultId, table.inventoryId],
      foreignColumns: [
        inventoryCodeResults.tenantId,
        inventoryCodeResults.id,
        inventoryCodeResults.inventoryId,
      ],
    }),
    foreignKey({
      name: "inventory_corrections_tenant_box_fk",
      columns: [table.tenantId, table.targetRepackBoxId, table.inventoryId],
      foreignColumns: [
        inventoryRepackBoxes.tenantId,
        inventoryRepackBoxes.id,
        inventoryRepackBoxes.inventoryId,
      ],
    }),
    index("inventory_corrections_progress_cursor_idx").on(
      table.tenantId,
      table.inventoryId,
      table.resultRevision,
      table.createdAt,
      table.id,
    ),
    index("inventory_corrections_batch_idx").on(
      table.tenantId,
      table.inventoryId,
      table.batchId,
      table.id,
    ),
    check(
      "inventory_corrections_actor_check",
      sql`(${table.actorUserId} is null) <> (${table.actorOperatorId} is null)`,
    ),
    check(
      "inventory_corrections_target_check",
      sql`${table.targetEventId} is not null
        or ${table.targetCodeResultId} is not null
        or ${table.targetRepackBoxId} is not null`,
    ),
    check(
      "inventory_corrections_reason_check",
      sql`octet_length(btrim(${table.reason})) between 1 and 1024`,
    ),
    check(
      "inventory_corrections_digests_check",
      sql`${table.beforeProjectionDigest} ~ '^[0-9a-f]{64}$'
        and ${table.afterProjectionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "inventory_corrections_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("inventory_corrections_revision_check", sql`${table.resultRevision} > 0`),
  ],
);

/** Canonical quarantined batch payload received after an inventory result froze. */
export const inventoryLateEvents = pgTable(
  "inventory_late_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    batchId: text("batch_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadDigest: char("payload_digest", { length: 64 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    closedRevision: integer("closed_revision").notNull(),
    reason: text("reason").notNull(),
    resolution: inventoryLateEventResolutionEnum("resolution").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id),
    replayAuthorizedAt: timestamp("replay_authorized_at", { withTimezone: true }),
    replayAuthorizedByUserId: text("replay_authorized_by_user_id"),
    replayAuthorizedRevision: integer("replay_authorized_revision"),
  },
  (table) => [
    unique("inventory_late_events_tenant_id_inventory_uq").on(
      table.tenantId,
      table.id,
      table.inventoryId,
    ),
    unique("inventory_late_events_scope_batch_uq").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.batchId,
    ),
    unique("inventory_late_events_scope_digest_uq").on(
      table.tenantId,
      table.inventoryId,
      table.deviceId,
      table.payloadDigest,
    ),
    foreignKey({
      name: "inventory_late_events_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "inventory_late_events_tenant_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "inventory_late_events_replay_authorized_by_user_fk",
      columns: [table.replayAuthorizedByUserId],
      foreignColumns: [user.id],
    }),
    index("inventory_late_events_resolution_idx").on(
      table.tenantId,
      table.inventoryId,
      table.resolution,
      table.receivedAt,
    ),
    check(
      "inventory_late_events_batch_id_check",
      sql`octet_length(${table.batchId}) between 1 and 128`,
    ),
    check(
      "inventory_late_events_payload_digest_check",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("inventory_late_events_revision_check", sql`${table.closedRevision} >= 0`),
    check("inventory_late_events_reason_check", sql`${table.reason} ~ '^[A-Z][A-Z0-9_]{0,127}$'`),
    check(
      "inventory_late_events_resolution_check",
      sql`(${table.resolution} = 'pending'
          and ${table.resolvedAt} is null
          and ${table.resolvedByUserId} is null)
        or (${table.resolution} in ('replayed', 'discarded')
          and ${table.resolvedAt} is not null
          and ${table.resolvedByUserId} is not null)`,
    ),
    check(
      "inventory_late_events_replay_authorization_check",
      sql`(${table.replayAuthorizedAt} is null
          and ${table.replayAuthorizedByUserId} is null
          and ${table.replayAuthorizedRevision} is null)
        or (${table.replayAuthorizedAt} is not null
          and ${table.replayAuthorizedByUserId} is not null
          and ${table.replayAuthorizedRevision} > ${table.closedRevision})`,
    ),
  ],
);

export type Inventory = typeof inventories.$inferSelect;
export type NewInventory = typeof inventories.$inferInsert;
export type InventoryImport = typeof inventoryImports.$inferSelect;
export type NewInventoryImport = typeof inventoryImports.$inferInsert;
export type InventorySnapshot = typeof inventorySnapshots.$inferSelect;
export type NewInventorySnapshot = typeof inventorySnapshots.$inferInsert;
export type InventorySnapshotInput = typeof inventorySnapshotInputs.$inferSelect;
export type NewInventorySnapshotInput = typeof inventorySnapshotInputs.$inferInsert;
export type InventorySnapshotCode = typeof inventorySnapshotCodes.$inferSelect;
export type NewInventorySnapshotCode = typeof inventorySnapshotCodes.$inferInsert;
export type InventoryDeviceParticipant = typeof inventoryDeviceParticipants.$inferSelect;
export type NewInventoryDeviceParticipant = typeof inventoryDeviceParticipants.$inferInsert;
export type InventoryScanBatch = typeof inventoryScanBatches.$inferSelect;
export type NewInventoryScanBatch = typeof inventoryScanBatches.$inferInsert;
export type InventoryScanEvent = typeof inventoryScanEvents.$inferSelect;
export type NewInventoryScanEvent = typeof inventoryScanEvents.$inferInsert;
export type InventoryEventClaimOutcome = typeof inventoryEventClaimOutcomes.$inferSelect;
export type NewInventoryEventClaimOutcome = typeof inventoryEventClaimOutcomes.$inferInsert;
export type InventoryCodeResult = typeof inventoryCodeResults.$inferSelect;
export type NewInventoryCodeResult = typeof inventoryCodeResults.$inferInsert;
export type InventoryProgressChange = typeof inventoryProgressChanges.$inferSelect;
export type NewInventoryProgressChange = typeof inventoryProgressChanges.$inferInsert;
export type InventoryRepackBox = typeof inventoryRepackBoxes.$inferSelect;
export type NewInventoryRepackBox = typeof inventoryRepackBoxes.$inferInsert;
export type InventoryRepackItem = typeof inventoryRepackItems.$inferSelect;
export type NewInventoryRepackItem = typeof inventoryRepackItems.$inferInsert;
export type InventoryCorrectionBatch = typeof inventoryCorrectionBatches.$inferSelect;
export type NewInventoryCorrectionBatch = typeof inventoryCorrectionBatches.$inferInsert;
export type InventoryCorrection = typeof inventoryCorrections.$inferSelect;
export type NewInventoryCorrection = typeof inventoryCorrections.$inferInsert;
export type InventoryLateEvent = typeof inventoryLateEvents.$inferSelect;
export type NewInventoryLateEvent = typeof inventoryLateEvents.$inferInsert;
