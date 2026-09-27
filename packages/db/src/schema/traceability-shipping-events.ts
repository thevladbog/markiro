import { sql } from "drizzle-orm";
import {
  type PgColumn,
  check,
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
import { referenceDocuments } from "./traceability-documents.js";
import { traceabilityLots } from "./traceability-lots.js";
import { traceabilityLocations } from "./traceability-master-data.js";
import { traceabilityEvents } from "./traceability-receiving.js";

const parent = () => ({
  tenantId: text("tenant_id")
    .notNull()
    .references(() => organization.id),
  eventId: uuid("event_id").notNull(),
  eventType: text("event_type")
    .notNull()
    .generatedAlwaysAs(sql`'shipping'::text`),
});
const eventFk = (name: string, t: { tenantId: PgColumn; eventId: PgColumn; eventType: PgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.eventId, t.eventType],
    foreignColumns: [traceabilityEvents.tenantId, traceabilityEvents.id, traceabilityEvents.type],
  });

export const shippingEventDetails = pgTable(
  "shipping_event_details",
  {
    ...parent(),
    recipientLocationId: uuid("recipient_location_id"),
    recipientSnapshot: jsonb("recipient_snapshot").$type<unknown>(),
    carrierReference: text("carrier_reference"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId] }),
    eventFk("shipping_details_event_fk", t),
    foreignKey({
      name: "shipping_details_recipient_fk",
      columns: [t.tenantId, t.recipientLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    check(
      "shipping_details_carrier_valid",
      sql`length(btrim(${t.carrierReference})) BETWEEN 1 AND 2000`,
    ),
    check(
      "shipping_details_snapshot_valid",
      sql`${t.recipientSnapshot} IS NULL OR jsonb_typeof(${t.recipientSnapshot}) = 'object'`,
    ),
  ],
);

export const shippingEventItems = pgTable(
  "shipping_event_items",
  {
    ...parent(),
    lineNo: integer("line_no").notNull(),
    lotId: uuid("lot_id").notNull(),
    quantity: text("quantity"),
    unitOfMeasure: text("unit_of_measure"),
    tlcSnapshot: text("tlc_snapshot"),
    sourceSnapshot: jsonb("source_snapshot").$type<unknown>(),
    productSnapshot: jsonb("product_snapshot").$type<unknown>(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.lineNo] }),
    eventFk("shipping_items_event_fk", t),
    foreignKey({
      name: "shipping_items_lot_fk",
      columns: [t.tenantId, t.lotId],
      foreignColumns: [traceabilityLots.tenantId, traceabilityLots.id],
    }),
    unique("shipping_items_lot_uq").on(t.tenantId, t.eventId, t.lotId),
    index("shipping_items_lot_idx").on(t.tenantId, t.lotId, t.eventId),
    check("shipping_items_line_valid", sql`${t.lineNo} BETWEEN 1 AND 100`),
    check(
      "shipping_items_quantity_valid",
      sql`${t.quantity} ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,3})?$' AND ${t.quantity} ~ '[1-9]'`,
    ),
    check(
      "shipping_items_uom_valid",
      sql`${t.unitOfMeasure} IN ('lb','oz','kg','g','each','case','bag','cup','gal','l')`,
    ),
    check(
      "shipping_items_tlc_valid",
      sql`length(${t.tlcSnapshot}) BETWEEN 1 AND 120 AND ${t.tlcSnapshot} = btrim(${t.tlcSnapshot})`,
    ),
    check(
      "shipping_items_snapshots_valid",
      sql`(${t.sourceSnapshot} IS NULL OR jsonb_typeof(${t.sourceSnapshot})='object') AND (${t.productSnapshot} IS NULL OR jsonb_typeof(${t.productSnapshot})='object')`,
    ),
  ],
);

export const shippingEventDocuments = pgTable(
  "shipping_event_documents",
  {
    ...parent(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.documentId] }),
    eventFk("shipping_documents_event_fk", t),
    foreignKey({
      name: "shipping_documents_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [referenceDocuments.tenantId, referenceDocuments.id],
    }),
    unique("shipping_documents_position_uq").on(t.tenantId, t.eventId, t.position),
    check("shipping_documents_position_valid", sql`${t.position} BETWEEN 1 AND 100`),
  ],
);

/** An open effect is the sole Shipping owner of a lot's automatic status. */
export const shippingLotStatusEffects = pgTable(
  "shipping_lot_status_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...parent(),
    lotId: uuid("lot_id").notNull(),
    priorStatus: text("prior_status").notNull(),
    newStatus: text("new_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    compensatedAt: timestamp("compensated_at", { withTimezone: true }),
    compensationReason: text("compensation_reason"),
  },
  (t) => [
    unique("shipping_effects_tenant_id_uq").on(t.tenantId, t.id),
    eventFk("shipping_effects_event_fk", t),
    foreignKey({
      name: "shipping_effects_lot_fk",
      columns: [t.tenantId, t.lotId],
      foreignColumns: [traceabilityLots.tenantId, traceabilityLots.id],
    }),
    uniqueIndex("shipping_effects_one_active_lot_uq")
      .on(t.tenantId, t.lotId)
      .where(sql`${t.compensatedAt} IS NULL`),
    index("shipping_effects_event_idx").on(t.tenantId, t.eventId),
    check(
      "shipping_effects_status_valid",
      sql`${t.priorStatus}='active' AND ${t.newStatus}='shipped'`,
    ),
    check(
      "shipping_effects_compensation_valid",
      sql`(${t.compensatedAt} IS NULL AND ${t.compensationReason} IS NULL) OR (${t.compensatedAt} IS NOT NULL AND length(btrim(${t.compensationReason})) BETWEEN 1 AND 2000)`,
    ),
  ],
);

/** A sequence is allocated independently for each tenant and civil year. */
export const shippingCounters = pgTable(
  "shipping_counters",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    year: integer("year").notNull(),
    sequence: integer("sequence").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.year] }),
    check("shipping_counters_valid", sql`${t.year} BETWEEN 1 AND 9999 AND ${t.sequence} > 0`),
  ],
);

/** Immutable command receipts retained with the Shipping event history. */
export const shippingOperations = pgTable(
  "shipping_operations",
  {
    ...parent(),
    command: text("command").notNull(),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.command, t.operationKey] }),
    eventFk("shipping_operations_event_fk", t),
    index("shipping_operations_event_idx").on(t.tenantId, t.eventId),
    check(
      "shipping_operations_command_valid",
      sql`${t.command} IN ('shipping.create','shipping.save','shipping.finalize','shipping.amend','shipping.void')`,
    ),
    check("shipping_operations_digest_valid", sql`${t.inputDigest} ~ '^[a-f0-9]{64}$'`),
    check("shipping_operations_result_valid", sql`jsonb_typeof(${t.result})='object'`),
  ],
);
