import { sql } from "drizzle-orm";
import {
  type PgTableExtraConfigValue,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { products } from "./platform.js";
import { referenceDocuments } from "./traceability-documents.js";
import { traceabilityLots } from "./traceability-lots.js";
import { traceabilityLocations } from "./traceability-master-data.js";

const tenant = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/** Saved drafts and immutable ordinary Receiving history. */
export const traceabilityEvents = pgTable(
  "traceability_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenant(),
    rootEventId: uuid("root_event_id").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    supersededByEventId: uuid("superseded_by_event_id"),
    amendmentReason: text("amendment_reason"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: text("superseded_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
    eventNumber: text("event_number").notNull(),
    type: text("type").notNull().default("receiving"),
    status: text("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    draftVersion: integer("draft_version").notNull().default(1),
    timeZone: text("time_zone").notNull(),
    dateReceived: date("date_received", { mode: "string" }),
    locationId: uuid("location_id"),
    previousSourceLocationId: uuid("previous_source_location_id"),
    receivedAtNote: text("received_at_note"),
    notes: text("notes"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by"),
    finalizationSnapshot: jsonb("finalization_snapshot").$type<unknown>(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("traceability_events_tenant_id_uq").on(t.tenantId, t.id),
    unique("traceability_events_root_id_uq").on(t.tenantId, t.rootEventId, t.id),
    unique("traceability_events_root_revision_uq").on(t.tenantId, t.rootEventId, t.revision),
    uniqueIndex("receiving_one_current_uq")
      .on(t.tenantId, t.rootEventId)
      .where(sql`${t.status} = 'finalized'`),
    uniqueIndex("receiving_one_pending_uq")
      .on(t.tenantId, t.rootEventId)
      .where(sql`${t.status} = 'draft'`),
    foreignKey({
      name: "receiving_previous_revision_fk",
      columns: [t.tenantId, t.rootEventId, t.previousRevisionId],
      foreignColumns: [t.tenantId, t.rootEventId, t.id],
    }),
    foreignKey({
      name: "receiving_superseded_by_fk",
      columns: [t.tenantId, t.rootEventId, t.supersededByEventId],
      foreignColumns: [t.tenantId, t.rootEventId, t.id],
    }),
    foreignKey({
      name: "traceability_events_root_fk",
      columns: [t.tenantId, t.rootEventId],
      foreignColumns: [receivingEventRoots.tenantId, receivingEventRoots.id],
    }),
    foreignKey({
      name: "traceability_events_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    foreignKey({
      name: "traceability_events_previous_source_fk",
      columns: [t.tenantId, t.previousSourceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    index("traceability_events_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
    check(
      "traceability_events_lifecycle_valid",
      sql`${t.type} = 'receiving' AND ${t.revision} > 0
        AND ((${t.revision}=1 AND ${t.previousRevisionId} IS NULL AND ${t.amendmentReason} IS NULL)
          OR (${t.revision}>1 AND ${t.previousRevisionId} IS NOT NULL AND ${t.amendmentReason} IS NOT NULL AND length(btrim(${t.amendmentReason})) BETWEEN 1 AND 2000))
        AND ((${t.status}='amended' AND ${t.supersededByEventId} IS NOT NULL AND ${t.supersededAt} IS NOT NULL AND ${t.supersededBy} IS NOT NULL AND length(btrim(${t.supersededBy})) BETWEEN 1 AND 128)
          OR (${t.status}<>'amended' AND ${t.supersededByEventId} IS NULL AND ${t.supersededAt} IS NULL AND ${t.supersededBy} IS NULL))
        AND ((${t.status}='void' AND ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL AND length(btrim(${t.voidedBy})) BETWEEN 1 AND 128 AND ${t.voidReason} IS NOT NULL AND length(btrim(${t.voidReason})) BETWEEN 1 AND 2000)
          OR (${t.status}<>'void' AND ${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL AND ${t.voidReason} IS NULL))
        AND (
        (${t.status} IN ('draft','void') AND ${t.finalizedAt} IS NULL AND ${t.finalizedBy} IS NULL AND ${t.finalizationSnapshot} IS NULL)
        OR (${t.status} IN ('finalized','amended','void') AND ${t.finalizedAt} IS NOT NULL AND ${t.finalizedBy} IS NOT NULL
        AND length(btrim(${t.finalizedBy})) BETWEEN 1 AND 128 AND ${t.finalizationSnapshot} IS NOT NULL
        AND jsonb_typeof(${t.finalizationSnapshot}) = 'object' AND ${t.dateReceived} IS NOT NULL
        AND ${t.locationId} IS NOT NULL AND ${t.previousSourceLocationId} IS NOT NULL
        AND ${t.updatedAt} = ${t.finalizedAt} AND ${t.updatedBy} = ${t.finalizedBy}))`,
    ),
    check("traceability_events_version_valid", sql`${t.draftVersion} > 0`),
    check("traceability_events_number_valid", sql`${t.eventNumber} ~ '^REC-[0-9]{2}-[0-9]{4,10}$'`),
    check("traceability_events_zone_valid", sql`length(${t.timeZone}) BETWEEN 1 AND 64`),
    check(
      "traceability_events_date_valid",
      sql`${t.dateReceived} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'`,
    ),
    check(
      "traceability_events_notes_valid",
      sql`length(btrim(${t.notes})) BETWEEN 1 AND 2000 AND length(btrim(${t.receivedAtNote})) BETWEEN 1 AND 2000`,
    ),
    check(
      "traceability_events_actors_valid",
      sql`length(btrim(${t.createdBy})) BETWEEN 1 AND 128 AND length(btrim(${t.updatedBy})) BETWEEN 1 AND 128`,
    ),
  ],
);

/** Permanent identity and current pointers; circular FKs are deferred in SQL. */
export const receivingEventRoots = pgTable(
  "receiving_event_roots",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenant(),
    eventNumber: text("event_number").notNull(),
    lifecycleVersion: integer("lifecycle_version").notNull().default(1),
    nextRevision: integer("next_revision").notNull().default(2),
    currentEventId: uuid("current_event_id"),
    pendingDraftId: uuid("pending_draft_id"),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("receiving_roots_tenant_id_uq").on(t.tenantId, t.id),
    unique("receiving_roots_number_uq").on(t.tenantId, t.eventNumber),
    foreignKey({
      name: "receiving_roots_current_fk",
      columns: [t.tenantId, t.id, t.currentEventId],
      foreignColumns: [
        traceabilityEvents.tenantId,
        traceabilityEvents.rootEventId,
        traceabilityEvents.id,
      ],
    }),
    foreignKey({
      name: "receiving_roots_pending_fk",
      columns: [t.tenantId, t.id, t.pendingDraftId],
      foreignColumns: [
        traceabilityEvents.tenantId,
        traceabilityEvents.rootEventId,
        traceabilityEvents.id,
      ],
    }),
    check("receiving_roots_version_valid", sql`${t.lifecycleVersion} > 0`),
    check("receiving_roots_revision_valid", sql`${t.nextRevision} > 1`),
    check("receiving_roots_number_valid", sql`${t.eventNumber} ~ '^REC-[0-9]{2}-[0-9]{4,10}$'`),
  ],
);

export const receivingEventItems = pgTable(
  "receiving_event_items",
  {
    tenantId: tenant(),
    eventId: uuid("event_id").notNull(),
    lineNo: integer("line_no").notNull(),
    previousLineNo: integer("previous_line_no"),
    productId: uuid("product_id"),
    lotId: uuid("lot_id"),
    lotLinkMode: text("lot_link_mode").notNull(),
    tlc: text("tlc"),
    quantity: text("quantity"),
    unitOfMeasure: text("unit_of_measure"),
    sourceLocationId: uuid("source_location_id"),
    sourceReferenceKind: text("source_reference_kind"),
    sourceReferenceValue: text("source_reference_value"),
    sourceReferenceLocationId: uuid("source_reference_location_id"),
    exemptSupplier: boolean("exempt_supplier").notNull(),
    exemptReason: text("exempt_reason"),
    exemptReceipt: jsonb("exempt_receipt").$type<unknown>(),
    supplierLotReference: text("supplier_lot_reference"),
    notes: text("notes"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.lineNo] }),
    unique("receiving_items_previous_line_uq").on(t.tenantId, t.eventId, t.previousLineNo),
    check("receiving_items_previous_line_valid", sql`${t.previousLineNo} BETWEEN 1 AND 100`),
    foreignKey({
      name: "receiving_items_event_fk",
      columns: [t.tenantId, t.eventId],
      foreignColumns: [traceabilityEvents.tenantId, traceabilityEvents.id],
    }),
    foreignKey({
      name: "receiving_items_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "receiving_items_lot_fk",
      columns: [t.tenantId, t.lotId],
      foreignColumns: [traceabilityLots.tenantId, traceabilityLots.id],
    }),
    foreignKey({
      name: "receiving_items_source_fk",
      columns: [t.tenantId, t.sourceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    foreignKey({
      name: "receiving_items_reference_source_fk",
      columns: [t.tenantId, t.sourceReferenceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    check("receiving_items_position_valid", sql`${t.lineNo} BETWEEN 1 AND 100`),
    check(
      "receiving_items_exempt_receipt_valid",
      sql`${t.exemptReceipt} IS NULL OR coalesce((
        jsonb_typeof(${t.exemptReceipt}) = 'object'
        AND ${t.exemptReceipt} ?& ARRAY['evidenceUrl','tlcHandling','proposedTlc']
        AND (${t.exemptReceipt} - ARRAY['evidenceUrl','tlcHandling','proposedTlc']) = '{}'::jsonb
        AND (${t.exemptReceipt}->'evidenceUrl' = 'null'::jsonb OR (
          jsonb_typeof(${t.exemptReceipt}->'evidenceUrl') = 'string'
          AND octet_length(${t.exemptReceipt}->>'evidenceUrl') BETWEEN 1 AND 1024))
        AND (${t.exemptReceipt}->'tlcHandling' = 'null'::jsonb OR (
          jsonb_typeof(${t.exemptReceipt}->'tlcHandling') = 'string'
          AND ${t.exemptReceipt}->>'tlcHandling' IN ('preserve_existing','assign_if_missing')))
        AND (${t.exemptReceipt}->'proposedTlc' = 'null'::jsonb OR (
          jsonb_typeof(${t.exemptReceipt}->'proposedTlc') = 'string'
          AND length(${t.exemptReceipt}->>'proposedTlc') BETWEEN 1 AND 120
          AND ${t.exemptReceipt}->>'proposedTlc' = btrim(${t.exemptReceipt}->>'proposedTlc')
          AND ${t.exemptReceipt}->>'proposedTlc' !~ U&'[\\0001-\\001F\\007F-\\009F]'))
      ),false)`,
    ),
    check(
      "receiving_items_mode_valid",
      sql`${t.lotLinkMode} IN ('create_on_finalize', 'link_existing')`,
    ),
    check(
      "receiving_items_quantity_valid",
      sql`${t.quantity} ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,3})?$' AND ${t.quantity} ~ '[1-9]'`,
    ),
    check(
      "receiving_items_tlc_valid",
      sql`length(${t.tlc}) BETWEEN 1 AND 120 AND ${t.tlc} = btrim(${t.tlc}) AND ${t.tlc} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    check(
      "receiving_items_text_valid",
      sql`length(btrim(${t.exemptReason})) BETWEEN 1 AND 2000 AND length(btrim(${t.supplierLotReference})) BETWEEN 1 AND 128 AND length(btrim(${t.notes})) BETWEEN 1 AND 2000`,
    ),
    check(
      "receiving_items_source_shape",
      sql`(
    ${t.sourceLocationId} IS NULL AND ${t.sourceReferenceKind} IS NULL AND ${t.sourceReferenceValue} IS NULL AND ${t.sourceReferenceLocationId} IS NULL
  ) OR (
    ${t.sourceLocationId} IS NOT NULL AND ${t.sourceReferenceKind} IS NULL AND ${t.sourceReferenceValue} IS NULL AND ${t.sourceReferenceLocationId} IS NULL
  ) OR (
    ${t.sourceLocationId} IS NULL AND ${t.sourceReferenceKind} IS NOT NULL AND ${t.sourceReferenceKind} = 'web_url'
    AND ${t.sourceReferenceValue} IS NOT NULL AND octet_length(${t.sourceReferenceValue}) BETWEEN 1 AND 1024
    AND ${t.sourceReferenceLocationId} IS NOT NULL
  )`,
    ),
  ],
);

export const receivingEventDocuments = pgTable(
  "receiving_event_documents",
  {
    tenantId: tenant(),
    eventId: uuid("event_id").notNull(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.documentId] }),
    unique("receiving_documents_position_uq").on(t.tenantId, t.eventId, t.position),
    foreignKey({
      name: "receiving_documents_event_fk",
      columns: [t.tenantId, t.eventId],
      foreignColumns: [traceabilityEvents.tenantId, traceabilityEvents.id],
    }),
    foreignKey({
      name: "receiving_documents_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [referenceDocuments.tenantId, referenceDocuments.id],
    }),
    check("receiving_documents_position_valid", sql`${t.position} BETWEEN 1 AND 100`),
  ],
);

export const receivingCounters = pgTable(
  "receiving_counters",
  {
    tenantId: tenant(),
    year: integer("year").notNull(),
    sequence: integer("sequence").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.year] }),
    check("receiving_counters_valid", sql`${t.year} BETWEEN 1 AND 9999 AND ${t.sequence} > 0`),
  ],
);

/** Durable command results, not sessions; retained with the draft history. */
export const receivingOperations = pgTable(
  "receiving_operations",
  {
    tenantId: tenant(),
    command: text("command").notNull(),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    eventId: uuid("event_id").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.command, t.operationKey] }),
    foreignKey({
      name: "receiving_operations_event_fk",
      columns: [t.tenantId, t.eventId],
      foreignColumns: [traceabilityEvents.tenantId, traceabilityEvents.id],
    }),
    check(
      "receiving_operations_command_valid",
      sql`${t.command} IN ('receiving.create', 'receiving.save', 'receiving.finalize', 'receiving.amend', 'receiving.void')`,
    ),
    check("receiving_operations_digest_valid", sql`${t.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check("receiving_operations_result_valid", sql`jsonb_typeof(${t.result}) = 'object'`),
  ],
);
