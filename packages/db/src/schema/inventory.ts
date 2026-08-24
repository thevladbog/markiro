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
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth.js";
import { labelTemplates } from "./labels.js";
import { lines, products } from "./platform.js";

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
    resultRevision: integer("result_revision").notNull().default(0),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
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
        or (${table.status} in ('ready', 'running', 'closed', 'completed') and ${table.activeSnapshotId} is not null)`,
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
