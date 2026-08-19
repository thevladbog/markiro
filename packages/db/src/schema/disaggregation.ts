import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth.js";
import { boxes, products } from "./platform.js";

export const disaggregationDocumentStatus = pgEnum("disaggregation_document_status", [
  "draft",
  "applied",
  "cancelled",
]);
export const disaggregationSource = pgEnum("disaggregation_source", ["manual", "import"]);
export const disaggregationLineStatus = pgEnum("disaggregation_line_status", [
  "ok",
  "not_found",
  "not_closed",
  "shift_open",
  "already_disassembled",
  "written_off",
  "duplicate",
]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/** Managed dictionary of disaggregation reasons — clone of pickup_order_reasons. */
export const disaggregationReasons = pgTable(
  "disaggregation_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("disaggregation_reasons_tenant_id_uq").on(t.tenantId, t.id)],
);

/** Per-tenant monotonic counter for DSG-YY-NNNN — same pattern as pickup_order_counters. */
export const disaggregationDocCounters = pgTable("disaggregation_doc_counters", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  seq: integer("seq").notNull().default(0),
});

export const disaggregationDocuments = pgTable(
  "disaggregation_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    docNo: text("doc_no").notNull(),
    status: disaggregationDocumentStatus("status").notNull().default("draft"),
    /** Nullable while draft; the apply endpoint refuses a document without one. */
    reasonId: uuid("reason_id"),
    comment: text("comment"),
    source: disaggregationSource("source").notNull().default("manual"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedByUserId: text("applied_by_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("disaggregation_documents_tenant_id_uq").on(t.tenantId, t.id),
    unique("disaggregation_documents_tenant_doc_no_uq").on(t.tenantId, t.docNo),
    index("disaggregation_documents_tenant_created_idx").on(t.tenantId, t.createdAt),
    foreignKey({
      name: "disaggregation_documents_tenant_reason_fk",
      columns: [t.tenantId, t.reasonId],
      foreignColumns: [disaggregationReasons.tenantId, disaggregationReasons.id],
    }),
    check(
      "disaggregation_documents_applied_fields_check",
      sql`(${t.status} = 'applied') = (${t.appliedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * One SSCC per line. `ssccInput` preserves what the user typed/imported;
 * `sscc` is the normalized bare 18 digits (null when unparseable); `boxId`
 * resolves at validation time. Snapshot columns (`productId`, `codeCount`)
 * exist only so the UI can render without re-joining on every render — the
 * apply transaction re-derives everything from live tables.
 */
export const disaggregationDocumentLines = pgTable(
  "disaggregation_document_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    ssccInput: text("sscc_input").notNull(),
    sscc: char("sscc", { length: 18 }),
    boxId: uuid("box_id"),
    status: disaggregationLineStatus("status").notNull(),
    productId: uuid("product_id"),
    codeCount: integer("code_count").notNull().default(0),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("disaggregation_document_lines_tenant_doc_idx").on(t.tenantId, t.documentId),
    // One line per parseable SSCC per document. Partial: unparseable input
    // (sscc NULL) may repeat — each bad import line stays visible as its own row.
    unique("disaggregation_document_lines_doc_sscc_uq").on(t.tenantId, t.documentId, t.sscc),
    foreignKey({
      name: "disaggregation_document_lines_tenant_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [disaggregationDocuments.tenantId, disaggregationDocuments.id],
    }),
    foreignKey({
      name: "disaggregation_document_lines_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "disaggregation_document_lines_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);
