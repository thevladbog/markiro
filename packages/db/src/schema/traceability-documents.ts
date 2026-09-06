import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { traceabilityParties } from "./traceability-master-data.js";

export const referenceDocumentType = pgEnum("reference_document_type", [
  "bol",
  "po",
  "asn",
  "work_order",
  "invoice",
  "database_record",
  "batch_log",
  "production_log",
  "other",
]);

export const referenceDocuments = pgTable(
  "reference_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    type: referenceDocumentType("type").notNull(),
    typeOtherLabel: text("type_other_label"),
    number: text("number").notNull(),
    partyId: uuid("party_id"),
    issuedOn: date("issued_on", { mode: "string" }),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Historical attribution survives deletion of the cabinet account.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("reference_documents_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      name: "reference_documents_party_fk",
      columns: [table.tenantId, table.partyId],
      foreignColumns: [traceabilityParties.tenantId, traceabilityParties.id],
    }),
    uniqueIndex("reference_documents_without_party_uq")
      .on(table.tenantId, table.type, table.number)
      .where(sql`${table.partyId} IS NULL`),
    uniqueIndex("reference_documents_with_party_uq")
      .on(table.tenantId, table.type, table.partyId, table.number)
      .where(sql`${table.partyId} IS NOT NULL`),
    index("reference_documents_tenant_party_idx").on(table.tenantId, table.partyId),
    check(
      "reference_documents_number_valid",
      sql`length(${table.number}) BETWEEN 1 AND 128 AND ${table.number} = btrim(${table.number}) AND ${table.number} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    check(
      "reference_documents_other_shape",
      sql`(${table.type} = 'other' AND ${table.typeOtherLabel} IS NOT NULL) OR (${table.type} <> 'other' AND ${table.typeOtherLabel} IS NULL)`,
    ),
    check(
      "reference_documents_other_label_valid",
      sql`length(btrim(${table.typeOtherLabel})) BETWEEN 1 AND 200 AND ${table.typeOtherLabel} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    check("reference_documents_notes_valid", sql`length(btrim(${table.notes})) BETWEEN 1 AND 2000`),
    check(
      "reference_documents_date_range",
      sql`${table.issuedOn} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'`,
    ),
    check(
      "reference_documents_actor_valid",
      sql`length(btrim(${table.createdBy})) BETWEEN 1 AND 128`,
    ),
  ],
);
