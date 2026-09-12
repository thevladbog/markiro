import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

export const platformAgreementStatus = pgEnum("platform_agreement_status", [
  "draft",
  "in_review",
  "sent",
  "signed",
  "terminated",
]);

export const platformAgreementDocumentForm = pgEnum("platform_agreement_document_form", [
  "ru",
  "ru_en",
]);

export const platformAgreementDocumentKind = pgEnum("platform_agreement_document_kind", [
  "draft",
  "generated",
  "attachment",
]);

export const platformAgreements = pgTable(
  "platform_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    status: platformAgreementStatus("status").notNull().default("draft"),
    conclusionDate: date("conclusion_date"),
    city: text("city"),
    // Russian-only or the two-column Russian/English form. A property of the
    // record rather than a download option: the stored document is the copy
    // that gets signed, and two files under one number cannot be told apart
    // afterwards.
    documentForm: platformAgreementDocumentForm("document_form").notNull().default("ru"),
    // An agreement may be concluded before the tenant exists, so the link is
    // optional and is set by hand once the cabinet is registered.
    tenantId: text("tenant_id"),
    // Denormalised out of `counterparty` because it drives both the registry
    // search and the tenant-candidate lookup.
    counterpartyInn: text("counterparty_inn"),
    counterparty: jsonb("counterparty").$type<Record<string, unknown>>().notNull(),
    contractor: jsonb("contractor").$type<Record<string, unknown>>().notNull(),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedSnapshot: jsonb("signed_snapshot").$type<Record<string, unknown>>(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    terminationReason: text("termination_reason"),
    createdByPlatformUserId: text("created_by_platform_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_agreements_number_uq").on(table.number),
    index("platform_agreements_status_idx").on(table.status),
    index("platform_agreements_tenant_idx").on(table.tenantId),
    index("platform_agreements_counterparty_inn_idx").on(table.counterpartyInn),
    foreignKey({
      name: "platform_agreements_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [organization.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "platform_agreements_creator_fk",
      columns: [table.createdByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }).onDelete("restrict"),
    check(
      "platform_agreements_signed_consistency",
      sql`(${table.status} in ('signed', 'terminated')) = (${table.signedSnapshot} is not null and ${table.signedAt} is not null)`,
    ),
    check(
      "platform_agreements_terminated_consistency",
      sql`(${table.status} = 'terminated') = (${table.terminatedAt} is not null)`,
    ),
    check(
      "platform_agreements_termination_reason_consistency",
      sql`(${table.terminatedAt} is null) = (${table.terminationReason} is null)`,
    ),
    check(
      "platform_agreements_inn_format",
      sql`${table.counterpartyInn} is null or ${table.counterpartyInn} ~ '^[0-9]{10}$|^[0-9]{12}$'`,
    ),
  ],
);

export const platformAgreementDocuments = pgTable(
  "platform_agreement_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => platformAgreements.id, { onDelete: "cascade" }),
    kind: platformAgreementDocumentKind("kind").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    rendererVersion: text("renderer_version"),
    // Fingerprint of the agreement values this document was rendered from. A
    // draft is an explicitly rendered snapshot, so comparing this with the
    // record's current values is what tells an operator the file no longer
    // matches. Nullable: rows written before this column existed cannot be
    // fingerprinted retroactively, and they are reported as out of date
    // rather than vouched for.
    sourceDigest: text("source_digest"),
    uploadedByPlatformUserId: text("uploaded_by_platform_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_agreement_documents_object_key_uq").on(table.objectKey),
    index("platform_agreement_documents_agreement_idx").on(table.agreementId, table.createdAt),
    foreignKey({
      name: "platform_agreement_documents_uploader_fk",
      columns: [table.uploadedByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }).onDelete("restrict"),
    check("platform_agreement_documents_checksum_format", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("platform_agreement_documents_size_positive", sql`${table.byteSize} > 0`),
    check(
      "platform_agreement_documents_source_digest_format",
      sql`${table.sourceDigest} is null or ${table.sourceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "platform_agreement_documents_provenance",
      sql`(${table.kind} = 'attachment' and ${table.uploadedByPlatformUserId} is not null and ${table.rendererVersion} is null) or (${table.kind} in ('draft', 'generated') and ${table.uploadedByPlatformUserId} is null and ${table.rendererVersion} is not null)`,
    ),
  ],
);
