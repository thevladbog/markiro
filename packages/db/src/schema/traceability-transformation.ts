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
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { products } from "./platform.js";
import { referenceDocuments } from "./traceability-documents.js";
import { traceabilityLots } from "./traceability-lots.js";
import { traceabilityLocations } from "./traceability-master-data.js";
import { traceabilityEvents } from "./traceability-receiving.js";

const tenant = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);
const parent = () => ({
  tenantId: tenant(),
  eventId: uuid("event_id").notNull(),
  eventType: text("event_type")
    .notNull()
    .generatedAlwaysAs(sql`'transformation'::text`),
});
const eventFk = (name: string, t: { tenantId: PgColumn; eventId: PgColumn; eventType: PgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.eventId, t.eventType],
    foreignColumns: [traceabilityEvents.tenantId, traceabilityEvents.id, traceabilityEvents.type],
  });
const lotFk = (name: string, t: PgColumn, id: PgColumn) =>
  foreignKey({
    name,
    columns: [t, id],
    foreignColumns: [traceabilityLots.tenantId, traceabilityLots.id],
  });
const quantities = (name: string, t: { quantity: PgColumn; unitOfMeasure: PgColumn }) => [
  check(
    `${name}_quantity_valid`,
    sql`${t.quantity} ~ '^(0|[1-9][0-9]{0,14})(\\.[0-9]{1,3})?$' AND ${t.quantity}::numeric > 0`,
  ),
  check(
    `${name}_uom_valid`,
    sql`${t.unitOfMeasure} IN ('lb','oz','kg','g','each','case','bag','cup','gal','l')`,
  ),
];
export const transformationEventDetails = pgTable(
  "transformation_event_details",
  {
    ...parent(),
    reason: text("reason"),
    reasonNote: text("reason_note"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId] }),
    eventFk("transformation_details_event_fk", t),
    check(
      "transformation_details_reason_valid",
      sql`${t.reason} IN ('commingling_and_repacking','repacking','relabeling','processing','other')`,
    ),
    check(
      "transformation_details_note_valid",
      sql`length(btrim(${t.reasonNote})) BETWEEN 1 AND 2000`,
    ),
  ],
);
export const transformationEventInputs = pgTable(
  "transformation_event_inputs",
  {
    ...parent(),
    lineNo: integer("line_no").notNull(),
    kind: text("kind").notNull(),
    lotId: uuid("lot_id"),
    productId: uuid("product_id"),
    sourceLocationId: uuid("source_location_id"),
    reference: text("reference"),
    quantity: text("quantity"),
    unitOfMeasure: text("unit_of_measure"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.lineNo] }),
    eventFk("transformation_inputs_event_fk", t),
    lotFk("transformation_inputs_lot_fk", t.tenantId, t.lotId),
    foreignKey({
      name: "transformation_inputs_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "transformation_inputs_source_fk",
      columns: [t.tenantId, t.sourceLocationId],
      foreignColumns: [traceabilityLocations.tenantId, traceabilityLocations.id],
    }),
    unique("transformation_inputs_lot_uq").on(t.tenantId, t.eventId, t.lotId),
    index("transformation_inputs_lot_idx").on(t.tenantId, t.lotId, t.eventId),
    check("transformation_inputs_line_valid", sql`${t.lineNo} BETWEEN 1 AND 100`),
    check(
      "transformation_inputs_kind_valid",
      sql`(${t.kind}='ftl_lot' AND ${t.productId} IS NULL AND ${t.sourceLocationId} IS NULL AND ${t.reference} IS NULL) OR (${t.kind}='non_ftl' AND ${t.lotId} IS NULL)`,
    ),
    check(
      "transformation_inputs_reference_valid",
      sql`length(btrim(${t.reference})) BETWEEN 1 AND 2000`,
    ),
    ...quantities("transformation_inputs", t),
  ],
);
export const transformationEventOutputs = pgTable(
  "transformation_event_outputs",
  {
    ...parent(),
    lineNo: integer("line_no").notNull(),
    lotId: uuid("lot_id"),
    productId: uuid("product_id"),
    tlc: text("tlc"),
    quantity: text("quantity"),
    unitOfMeasure: text("unit_of_measure"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.lineNo] }),
    eventFk("transformation_outputs_event_fk", t),
    lotFk("transformation_outputs_lot_fk", t.tenantId, t.lotId),
    foreignKey({
      name: "transformation_outputs_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    unique("transformation_outputs_lot_uq").on(t.tenantId, t.eventId, t.lotId),
    index("transformation_outputs_lot_idx").on(t.tenantId, t.lotId, t.eventId),
    check("transformation_outputs_line_valid", sql`${t.lineNo} BETWEEN 1 AND 100`),
    check(
      "transformation_outputs_tlc_valid",
      sql`length(${t.tlc}) BETWEEN 1 AND 120 AND ${t.tlc}=btrim(${t.tlc}) AND ${t.tlc} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    ...quantities("transformation_outputs", t),
  ],
);
export const transformationEventDocuments = pgTable(
  "transformation_event_documents",
  {
    ...parent(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.documentId] }),
    eventFk("transformation_documents_event_fk", t),
    foreignKey({
      name: "transformation_documents_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [referenceDocuments.tenantId, referenceDocuments.id],
    }),
    unique("transformation_documents_position_uq").on(t.tenantId, t.eventId, t.position),
    check("transformation_documents_position_valid", sql`${t.position} BETWEEN 1 AND 100`),
  ],
);
export const transformationCounters = pgTable(
  "transformation_counters",
  { tenantId: tenant(), year: integer("year").notNull(), sequence: integer("sequence").notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.year] }),
    check("transformation_counters_valid", sql`${t.year} BETWEEN 1 AND 9999 AND ${t.sequence}>0`),
  ],
);
export const transformationOperations = pgTable(
  "transformation_operations",
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
    eventFk("transformation_operations_event_fk", t),
    index("transformation_operations_event_idx").on(t.tenantId, t.eventId),
    check(
      "transformation_operations_command_valid",
      sql`${t.command} IN ('transformation.create','transformation.save','transformation.finalize','transformation.amend','transformation.void')`,
    ),
    check("transformation_operations_digest_valid", sql`${t.inputDigest} ~ '^[a-f0-9]{64}$'`),
    check("transformation_operations_result_valid", sql`jsonb_typeof(${t.result})='object'`),
  ],
);
export const lotGenealogyEdges = pgTable(
  "lot_genealogy_edges",
  {
    ...parent(),
    inputLotId: uuid("input_lot_id").notNull(),
    outputLotId: uuid("output_lot_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId, t.inputLotId, t.outputLotId] }),
    eventFk("lot_genealogy_event_fk", t),
    lotFk("lot_genealogy_input_fk", t.tenantId, t.inputLotId),
    lotFk("lot_genealogy_output_fk", t.tenantId, t.outputLotId),
    index("lot_genealogy_input_idx").on(t.tenantId, t.inputLotId, t.eventId),
    index("lot_genealogy_output_idx").on(t.tenantId, t.outputLotId, t.eventId),
    check("lot_genealogy_direction_valid", sql`${t.inputLotId}<>${t.outputLotId}`),
  ],
);
