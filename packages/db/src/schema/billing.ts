import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { catalogItemKind, catalogItemVersions } from "./saas.js";
import { platformUsers } from "./platform-auth.js";

export const BILLING_PROFILE_KINDS = [
  "individual",
  "self_employed",
  "sole_proprietor",
  "legal_entity",
] as const;
export type BillingProfileKind = (typeof BILLING_PROFILE_KINDS)[number];

export const INVOICE_STATUSES = ["draft", "issued", "paid", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_KINDS = ["plan", "addon", "service", "custom"] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const INVOICE_APPLICATION_MODES = ["manual", "automatic"] as const;
export type InvoiceApplicationMode = (typeof INVOICE_APPLICATION_MODES)[number];

export const INVOICE_ACTIVATION_POLICIES = ["immediate", "after_current", "manual"] as const;
export type InvoiceActivationPolicy = (typeof INVOICE_ACTIVATION_POLICIES)[number];

export const DOCUMENT_STATUSES = ["pending", "ready", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const PAYMENT_SOURCES = ["manual", "bank_import"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_IMPORT_STATUSES = ["processing", "ready", "failed"] as const;
export type PaymentImportStatus = (typeof PAYMENT_IMPORT_STATUSES)[number];

export const PAYMENT_MATCH_STATUSES = [
  "unmatched",
  "suggested",
  "matched",
  "rejected",
  "needs_review",
] as const;
export type PaymentMatchStatus = (typeof PAYMENT_MATCH_STATUSES)[number];

export const INVOICE_APPLICATION_STATUSES = ["pending", "applied", "failed", "skipped"] as const;
export type InvoiceApplicationStatus = (typeof INVOICE_APPLICATION_STATUSES)[number];

export const BANK_ACCOUNT_STATUSES = ["active", "archived"] as const;
export type BankAccountStatus = (typeof BANK_ACCOUNT_STATUSES)[number];

export const billingProfileKind = pgEnum("billing_profile_kind", BILLING_PROFILE_KINDS);
export const invoiceStatus = pgEnum("invoice_status", INVOICE_STATUSES);
export const invoiceLineKind = pgEnum("invoice_line_kind", INVOICE_LINE_KINDS);
export const invoiceApplicationMode = pgEnum("invoice_application_mode", INVOICE_APPLICATION_MODES);
export const invoiceActivationPolicy = pgEnum(
  "invoice_activation_policy",
  INVOICE_ACTIVATION_POLICIES,
);
export const documentStatus = pgEnum("billing_document_status", DOCUMENT_STATUSES);
export const paymentSource = pgEnum("billing_payment_source", PAYMENT_SOURCES);
export const paymentImportStatus = pgEnum("payment_import_status", PAYMENT_IMPORT_STATUSES);
export const paymentMatchStatus = pgEnum("payment_match_status", PAYMENT_MATCH_STATUSES);
export const invoiceApplicationStatus = pgEnum(
  "invoice_application_status",
  INVOICE_APPLICATION_STATUSES,
);
export const bankAccountStatus = pgEnum("bank_account_status", BANK_ACCOUNT_STATUSES);

const profileColumns = {
  kind: billingProfileKind("kind").notNull(),
  fullName: text("full_name").notNull(),
  displayName: text("display_name").notNull(),
  inn: text("inn"),
  kpp: text("kpp"),
  ogrn: text("ogrn"),
  ogrnip: text("ogrnip"),
  addressRaw: text("address_raw").notNull(),
  address: jsonb("address"),
  legalAddressRaw: text("legal_address_raw").notNull(),
  legalAddress: jsonb("legal_address"),
  actualSameAsLegal: boolean("actual_same_as_legal").notNull().default(true),
  actualAddressRaw: text("actual_address_raw"),
  actualAddress: jsonb("actual_address"),
  postalSameAsLegal: boolean("postal_same_as_legal").notNull().default(false),
  postalAddressRaw: text("postal_address_raw"),
  postalAddress: jsonb("postal_address"),
  bankDetails: jsonb("bank_details"),
  contact: jsonb("contact"),
  isConfirmed: boolean("is_confirmed").notNull().default(false),
  confirmedByPlatformUserId: text("confirmed_by_platform_user_id").references(
    () => platformUsers.id,
  ),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
};

export const operatorBillingProfiles = pgTable(
  "operator_billing_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revision: integer("revision").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    ...profileColumns,
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("operator_billing_profiles_revision_uq").on(table.revision),
    uniqueIndex("operator_billing_profiles_current_uq")
      .on(table.isCurrent)
      .where(sql`${table.isCurrent} = true`),
    check("operator_billing_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "operator_billing_profiles_confirmation_check",
      sql`(${table.isConfirmed} = false and ${table.confirmedByPlatformUserId} is null and ${table.confirmedAt} is null) or (${table.isConfirmed} = true and ${table.confirmedByPlatformUserId} is not null and ${table.confirmedAt} is not null)`,
    ),
    check(
      "operator_billing_profiles_actual_same_check",
      sql`${table.actualSameAsLegal} = false or (${table.actualAddressRaw} is null and ${table.actualAddress} is null)`,
    ),
    check(
      "operator_billing_profiles_postal_same_check",
      sql`${table.postalSameAsLegal} = false or (${table.postalAddressRaw} is null and ${table.postalAddress} is null)`,
    ),
  ],
);

export const tenantBillingProfiles = pgTable(
  "tenant_billing_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    revision: integer("revision").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    ...profileColumns,
    createdByPlatformUserId: text("created_by_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_billing_profiles_tenant_id_uq").on(table.tenantId, table.id),
    unique("tenant_billing_profiles_revision_uq").on(table.tenantId, table.revision),
    uniqueIndex("tenant_billing_profiles_current_uq")
      .on(table.tenantId)
      .where(sql`${table.isCurrent} = true`),
    check("tenant_billing_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "tenant_billing_profiles_confirmation_check",
      sql`(${table.isConfirmed} = false and ${table.confirmedByPlatformUserId} is null and ${table.confirmedAt} is null) or (${table.isConfirmed} = true and ${table.confirmedByPlatformUserId} is not null and ${table.confirmedAt} is not null)`,
    ),
    check(
      "tenant_billing_profiles_actual_same_check",
      sql`${table.actualSameAsLegal} = false or (${table.actualAddressRaw} is null and ${table.actualAddress} is null)`,
    ),
    check(
      "tenant_billing_profiles_postal_same_check",
      sql`${table.postalSameAsLegal} = false or (${table.postalAddressRaw} is null and ${table.postalAddress} is null)`,
    ),
  ],
);

const bankAccountColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  settlementAccount: text("settlement_account").notNull(),
  bic: text("bic").notNull(),
  bankName: text("bank_name").notNull(),
  correspondentAccount: text("correspondent_account").notNull(),
  currency: text("currency").notNull().default("RUB"),
  status: bankAccountStatus("status").notNull().default("active"),
  isDefault: boolean("is_default").notNull().default(false),
  createdByPlatformUserId: text("created_by_platform_user_id")
    .notNull()
    .references(() => platformUsers.id),
  archivedByPlatformUserId: text("archived_by_platform_user_id").references(() => platformUsers.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const operatorBankAccounts = pgTable(
  "operator_bank_accounts",
  {
    ...bankAccountColumns,
    migrationSourceProfileId: uuid("migration_source_profile_id").references(
      () => operatorBillingProfiles.id,
    ),
  },
  (table) => [
    uniqueIndex("operator_bank_accounts_default_uq")
      .on(table.isDefault)
      .where(sql`${table.status} = 'active' and ${table.isDefault} = true`),
    uniqueIndex("operator_bank_accounts_migration_source_uq")
      .on(table.migrationSourceProfileId)
      .where(sql`${table.migrationSourceProfileId} is not null`),
    check(
      "operator_bank_accounts_identifiers_check",
      sql`${table.settlementAccount} ~ '^[0-9]{20}$' and ${table.bic} ~ '^[0-9]{9}$' and ${table.correspondentAccount} ~ '^[0-9]{20}$'`,
    ),
    check("operator_bank_accounts_currency_rub_check", sql`${table.currency} = 'RUB'`),
    check(
      "operator_bank_accounts_default_active_check",
      sql`${table.isDefault} = false or ${table.status} = 'active'`,
    ),
    check(
      "operator_bank_accounts_archive_check",
      sql`(${table.status} = 'active' and ${table.archivedByPlatformUserId} is null and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.isDefault} = false and ${table.archivedByPlatformUserId} is not null and ${table.archivedAt} is not null)`,
    ),
  ],
);

export const tenantBankAccounts = pgTable(
  "tenant_bank_accounts",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    ...bankAccountColumns,
    migrationSourceProfileId: uuid("migration_source_profile_id"),
  },
  (table) => [
    unique("tenant_bank_accounts_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.migrationSourceProfileId],
      foreignColumns: [tenantBillingProfiles.tenantId, tenantBillingProfiles.id],
      name: "tenant_bank_accounts_profile_fk",
    }),
    uniqueIndex("tenant_bank_accounts_default_uq")
      .on(table.tenantId)
      .where(sql`${table.status} = 'active' and ${table.isDefault} = true`),
    uniqueIndex("tenant_bank_accounts_migration_source_uq")
      .on(table.tenantId, table.migrationSourceProfileId)
      .where(sql`${table.migrationSourceProfileId} is not null`),
    check(
      "tenant_bank_accounts_identifiers_check",
      sql`${table.settlementAccount} ~ '^[0-9]{20}$' and ${table.bic} ~ '^[0-9]{9}$' and ${table.correspondentAccount} ~ '^[0-9]{20}$'`,
    ),
    check("tenant_bank_accounts_currency_rub_check", sql`${table.currency} = 'RUB'`),
    check(
      "tenant_bank_accounts_default_active_check",
      sql`${table.isDefault} = false or ${table.status} = 'active'`,
    ),
    check(
      "tenant_bank_accounts_archive_check",
      sql`(${table.status} = 'active' and ${table.archivedByPlatformUserId} is null and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.isDefault} = false and ${table.archivedByPlatformUserId} is not null and ${table.archivedAt} is not null)`,
    ),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    number: text("number").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    issueDate: timestamp("issue_date", { withTimezone: true }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    currency: text("currency").notNull().default("RUB"),
    sellerBankAccountId: uuid("seller_bank_account_id").references(() => operatorBankAccounts.id),
    sellerSnapshot: jsonb("seller_snapshot"),
    buyerSnapshot: jsonb("buyer_snapshot"),
    sellerBankAccountSnapshot: jsonb("seller_bank_account_snapshot"),
    buyerBankAccountSnapshot: jsonb("buyer_bank_account_snapshot"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    vatTotal: numeric("vat_total", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    applicationMode: invoiceApplicationMode("application_mode").notNull().default("manual"),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    issuedByPlatformUserId: text("issued_by_platform_user_id").references(() => platformUsers.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invoices_number_uq").on(table.number),
    unique("invoices_tenant_id_uq").on(table.tenantId, table.id),
    index("invoices_tenant_status_issued_idx").on(table.tenantId, table.status, table.issuedAt),
    check("invoices_currency_rub_check", sql`${table.currency} = 'RUB'`),
    check(
      "invoices_totals_nonnegative",
      sql`${table.subtotal} >= 0 and ${table.vatTotal} >= 0 and ${table.total} >= 0`,
    ),
    check(
      "invoices_issued_snapshot_check",
      sql`${table.status} = 'draft' or (${table.issueDate} is not null and ${table.sellerSnapshot} is not null and ${table.buyerSnapshot} is not null)`,
    ),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    position: integer("position").notNull(),
    kind: invoiceLineKind("kind").notNull(),
    catalogVersionId: uuid("catalog_version_id"),
    catalogKind: catalogItemKind("catalog_kind"),
    nameRu: text("name_ru").notNull(),
    nameEn: text("name_en").notNull(),
    descriptionRu: text("description_ru"),
    descriptionEn: text("description_en"),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull(),
    catalogUnitPrice: numeric("catalog_unit_price", { precision: 14, scale: 2 }),
    agreedUnitPrice: numeric("agreed_unit_price", { precision: 14, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatIncluded: boolean("vat_included").notNull(),
    lineSubtotal: numeric("line_subtotal", { precision: 14, scale: 2 }).notNull(),
    lineVat: numeric("line_vat", { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    activationPolicy: invoiceActivationPolicy("activation_policy"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invoice_lines_tenant_id_uq").on(table.tenantId, table.id),
    unique("invoice_lines_tenant_invoice_id_uq").on(table.tenantId, table.invoiceId, table.id),
    unique("invoice_lines_invoice_position_uq").on(table.invoiceId, table.position),
    foreignKey({
      name: "invoice_lines_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "invoice_lines_catalog_version_kind_fk",
      columns: [table.catalogVersionId, table.catalogKind],
      foreignColumns: [catalogItemVersions.id, catalogItemVersions.kind],
    }),
    check("invoice_lines_position_positive", sql`${table.position} > 0`),
    check("invoice_lines_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "invoice_lines_prices_nonnegative",
      sql`${table.agreedUnitPrice} >= 0 and ${table.lineSubtotal} >= 0 and ${table.lineVat} >= 0 and ${table.lineTotal} >= 0`,
    ),
    check(
      "invoice_lines_catalog_kind_check",
      sql`(${table.kind} = 'custom' and ${table.catalogVersionId} is null and ${table.catalogKind} is null) or (${table.kind} <> 'custom' and ${table.catalogVersionId} is not null and ${table.catalogKind} is not null)`,
    ),
    check(
      "invoice_lines_activation_policy_check",
      sql`(${table.kind} in ('plan', 'addon') and ${table.activationPolicy} is not null) or (${table.kind} in ('service', 'custom') and ${table.activationPolicy} is null)`,
    ),
  ],
);

export const invoiceDocuments = pgTable(
  "invoice_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    revision: integer("revision").notNull(),
    format: text("format").notNull(),
    status: documentStatus("status").notNull().default("pending"),
    objectKey: text("object_key"),
    contentType: text("content_type"),
    sha256: text("sha256"),
    byteSize: integer("byte_size"),
    rendererVersion: text("renderer_version").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invoice_documents_tenant_id_uq").on(table.tenantId, table.id),
    unique("invoice_documents_invoice_revision_format_uq").on(
      table.invoiceId,
      table.revision,
      table.format,
    ),
    foreignKey({
      name: "invoice_documents_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    check("invoice_documents_revision_positive", sql`${table.revision} > 0`),
    check("invoice_documents_format_check", sql`${table.format} in ('pdf', 'html')`),
    check(
      "invoice_documents_ready_metadata_check",
      sql`${table.status} <> 'ready' or (${table.objectKey} is not null and ${table.sha256} is not null and ${table.byteSize} is not null)`,
    ),
  ],
);

export const paymentImports = pgTable(
  "payment_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: paymentSource("source").notNull().default("bank_import"),
    sourceChecksum: text("source_checksum").notNull(),
    fileName: text("file_name"),
    parserVersion: text("parser_version").notNull(),
    status: paymentImportStatus("status").notNull().default("processing"),
    rowCount: integer("row_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payment_imports_source_checksum_uq").on(table.sourceChecksum),
    check("payment_imports_source_check", sql`${table.source} = 'bank_import'`),
    check(
      "payment_imports_counts_nonnegative",
      sql`${table.rowCount} >= 0 and ${table.errorCount} >= 0`,
    ),
  ],
);

export const paymentImportRows = pgTable(
  "payment_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id").notNull(),
    sourceRowId: text("source_row_id").notNull(),
    operationDate: timestamp("operation_date", { withTimezone: true }),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: text("currency"),
    payerName: text("payer_name"),
    paymentPurpose: text("payment_purpose"),
    bankReference: text("bank_reference"),
    rawFields: jsonb("raw_fields"),
    parseError: text("parse_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payment_import_rows_import_source_uq").on(table.importId, table.sourceRowId),
    foreignKey({
      name: "payment_import_rows_import_fk",
      columns: [table.importId],
      foreignColumns: [paymentImports.id],
    }),
    check(
      "payment_import_rows_amount_nonnegative",
      sql`${table.amount} is null or ${table.amount} >= 0`,
    ),
  ],
);

export const paymentMatches = pgTable(
  "payment_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importRowId: uuid("import_row_id").notNull(),
    tenantId: text("tenant_id"),
    invoiceId: uuid("invoice_id"),
    tenantBankAccountId: uuid("tenant_bank_account_id"),
    payerAccountEvidence: jsonb("payer_account_evidence"),
    status: paymentMatchStatus("status").notNull().default("unmatched"),
    score: integer("score"),
    reason: text("reason"),
    decidedByPlatformUserId: text("decided_by_platform_user_id").references(() => platformUsers.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payment_matches_import_row_uq").on(table.importRowId),
    foreignKey({
      name: "payment_matches_import_row_fk",
      columns: [table.importRowId],
      foreignColumns: [paymentImportRows.id],
    }),
    foreignKey({
      name: "payment_matches_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "payment_matches_tenant_account_fk",
      columns: [table.tenantId, table.tenantBankAccountId],
      foreignColumns: [tenantBankAccounts.tenantId, tenantBankAccounts.id],
    }),
    check(
      "payment_matches_account_tenant_check",
      sql`${table.tenantBankAccountId} is null or ${table.tenantId} is not null`,
    ),
    check(
      "payment_matches_score_check",
      sql`${table.score} is null or (${table.score} >= 0 and ${table.score} <= 100)`,
    ),
  ],
);

export const billingPayments = pgTable(
  "billing_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    source: paymentSource("source").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("RUB"),
    bankReference: text("bank_reference").notNull(),
    importRowId: uuid("import_row_id"),
    platformUserId: text("platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("billing_payments_tenant_id_uq").on(table.tenantId, table.id),
    unique("billing_payments_invoice_uq").on(table.tenantId, table.invoiceId),
    unique("billing_payments_tenant_invoice_id_uq").on(table.tenantId, table.invoiceId, table.id),
    unique("billing_payments_idempotency_uq").on(table.idempotencyKey),
    foreignKey({
      name: "billing_payments_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "billing_payments_import_row_fk",
      columns: [table.importRowId],
      foreignColumns: [paymentImportRows.id],
    }),
    check("billing_payments_amount_positive", sql`${table.amount} > 0`),
    check("billing_payments_currency_rub_check", sql`${table.currency} = 'RUB'`),
    check(
      "billing_payments_source_row_check",
      sql`(${table.source} = 'manual' and ${table.importRowId} is null) or (${table.source} = 'bank_import' and ${table.importRowId} is not null)`,
    ),
  ],
);

export const invoiceApplicationEvents = pgTable(
  "invoice_application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    invoiceLineId: uuid("invoice_line_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: invoiceApplicationStatus("status").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    beforeSnapshot: jsonb("before_snapshot"),
    afterSnapshot: jsonb("after_snapshot"),
    errorCode: text("error_code"),
    actorPlatformUserId: text("actor_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invoice_application_events_tenant_id_uq").on(table.tenantId, table.id),
    unique("invoice_application_events_line_attempt_uq").on(
      table.tenantId,
      table.invoiceLineId,
      table.attempt,
    ),
    foreignKey({
      name: "invoice_application_events_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "invoice_application_events_tenant_line_fk",
      columns: [table.tenantId, table.invoiceLineId],
      foreignColumns: [invoiceLines.tenantId, invoiceLines.id],
    }),
    check("invoice_application_events_attempt_positive", sql`${table.attempt} > 0`),
  ],
);
