import { sql, type SQLWrapper } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth.js";
import { billingPayments, invoiceLines, invoices } from "./billing.js";
import { platformUsers } from "./platform-auth.js";
import { catalogItems, catalogItemVersions, orderedServices } from "./saas.js";

const requestHashCheck = (column: SQLWrapper) => sql`${column} ~ '^[0-9a-f]{64}$'`;
const responseObjectCheck = (column: SQLWrapper) =>
  sql`jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 65536`;

export const servicePeriods = pgTable(
  "service_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    orderedServiceId: uuid("ordered_service_id").notNull(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    catalogVersionId: uuid("catalog_version_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    invoiceLineId: uuid("invoice_line_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    billingTimezone: text("billing_timezone").notNull(),
    renewalAnchor: jsonb("renewal_anchor").notNull(),
    commercialSnapshot: jsonb("commercial_snapshot").notNull(),
    allowanceSnapshot: jsonb("allowance_snapshot").notNull(),
    includedMinutes: integer("included_minutes").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("service_periods_tenant_id_uq").on(table.tenantId, table.id),
    unique("service_periods_tenant_invoice_line_uq").on(table.tenantId, table.invoiceLineId),
    index("service_periods_tenant_catalog_starts_idx").on(
      table.tenantId,
      table.catalogItemId,
      table.startsAt,
      table.id,
    ),
    foreignKey({
      name: "service_periods_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [organization.id],
    }),
    foreignKey({
      name: "service_periods_tenant_ordered_service_fk",
      columns: [table.tenantId, table.orderedServiceId],
      foreignColumns: [orderedServices.tenantId, orderedServices.id],
    }),
    foreignKey({
      name: "service_periods_catalog_item_fk",
      columns: [table.catalogItemId],
      foreignColumns: [catalogItems.id],
    }),
    foreignKey({
      name: "service_periods_catalog_version_fk",
      columns: [table.catalogVersionId],
      foreignColumns: [catalogItemVersions.id],
    }),
    foreignKey({
      name: "service_periods_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "service_periods_tenant_invoice_line_fk",
      columns: [table.tenantId, table.invoiceLineId],
      foreignColumns: [invoiceLines.tenantId, invoiceLines.id],
    }),
    foreignKey({
      name: "service_periods_tenant_payment_fk",
      columns: [table.tenantId, table.invoiceId, table.paymentId],
      foreignColumns: [billingPayments.tenantId, billingPayments.invoiceId, billingPayments.id],
    }),
    check(
      "service_periods_time_check",
      sql`isfinite(${table.startsAt}) and isfinite(${table.endsAt}) and isfinite(${table.createdAt}) and ${table.endsAt} > ${table.startsAt}`,
    ),
    check("service_periods_timezone_check", sql`${table.billingTimezone} = 'Europe/Moscow'`),
    check(
      "service_periods_json_check",
      sql`jsonb_typeof(${table.renewalAnchor}) = 'object' and jsonb_typeof(${table.commercialSnapshot}) = 'object' and jsonb_typeof(${table.allowanceSnapshot}) = 'object'`,
    ),
    check(
      "service_periods_included_minutes_check",
      sql`${table.includedMinutes} between 1 and 100000`,
    ),
    check(
      "service_periods_revision_check",
      sql`${table.revision} between 1 and 2147483647`,
    ),
  ],
);

export const serviceUsageEntries = pgTable(
  "service_usage_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    servicePeriodId: uuid("service_period_id").notNull(),
    kind: text("kind").$type<"usage" | "correction">().notNull(),
    classification: text("classification")
      .$type<"customer_service" | "product_defect">()
      .notNull(),
    originalEntryId: uuid("original_entry_id"),
    workReference: text("work_reference").notNull(),
    description: text("description").notNull(),
    internalNote: text("internal_note"),
    actualMinutesDelta: integer("actual_minutes_delta").notNull(),
    allowanceMinutesDelta: integer("allowance_minutes_delta").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
    actorPlatformUserId: text("actor_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("service_usage_entries_tenant_id_uq").on(table.tenantId, table.id),
    unique("service_usage_entries_tenant_request_id_uq").on(table.tenantId, table.requestId),
    index("service_usage_entries_tenant_period_posted_idx").on(
      table.tenantId,
      table.servicePeriodId,
      table.postedAt,
      table.id,
    ),
    foreignKey({
      name: "service_usage_entries_tenant_period_fk",
      columns: [table.tenantId, table.servicePeriodId],
      foreignColumns: [servicePeriods.tenantId, servicePeriods.id],
    }),
    foreignKey({
      name: "service_usage_entries_tenant_original_fk",
      columns: [table.tenantId, table.originalEntryId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check(
      "service_usage_entries_shape_check",
      sql`(
        ${table.kind} = 'usage'
        and ${table.originalEntryId} is null
        and ${table.actualMinutesDelta} between 1 and 2147483647
        and ${table.allowanceMinutesDelta} between 0 and 2147483647
        and (${table.classification} = 'customer_service' or (${table.classification} = 'product_defect' and ${table.allowanceMinutesDelta} = 0))
      ) or (
        ${table.kind} = 'correction'
        and ${table.originalEntryId} is not null
        and ${table.classification} in ('customer_service', 'product_defect')
        and ${table.actualMinutesDelta} between -2147483647 and 2147483647
        and ${table.allowanceMinutesDelta} between -2147483647 and 2147483647
        and (${table.actualMinutesDelta} <> 0 or ${table.allowanceMinutesDelta} <> 0)
      )`,
    ),
    check(
      "service_usage_entries_text_check",
      sql`length(btrim(${table.workReference})) between 1 and 300 and length(btrim(${table.description})) between 1 and 4000 and (${table.internalNote} is null or length(btrim(${table.internalNote})) <= 4000)`,
    ),
    check(
      "service_usage_entries_time_check",
      sql`isfinite(${table.performedAt}) and isfinite(${table.postedAt})`,
    ),
    check("service_usage_entries_request_hash_check", requestHashCheck(table.requestHash)),
    check("service_usage_entries_response_check", responseObjectCheck(table.response)),
  ],
);

export const serviceExcessApprovals = pgTable(
  "service_excess_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    servicePeriodId: uuid("service_period_id").notNull(),
    kind: text("kind").$type<"approval" | "withdrawal">().notNull(),
    originalApprovalId: uuid("original_approval_id"),
    minuteDelta: integer("minute_delta").notNull(),
    externalReference: text("external_reference").notNull(),
    externalUrl: text("external_url"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    actorPlatformUserId: text("actor_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("service_excess_approvals_tenant_id_uq").on(table.tenantId, table.id),
    unique("service_excess_approvals_tenant_request_id_uq").on(table.tenantId, table.requestId),
    index("service_excess_approvals_tenant_period_posted_idx").on(
      table.tenantId,
      table.servicePeriodId,
      table.postedAt,
      table.id,
    ),
    foreignKey({
      name: "service_excess_approvals_tenant_period_fk",
      columns: [table.tenantId, table.servicePeriodId],
      foreignColumns: [servicePeriods.tenantId, servicePeriods.id],
    }),
    foreignKey({
      name: "service_excess_approvals_tenant_original_fk",
      columns: [table.tenantId, table.originalApprovalId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check(
      "service_excess_approvals_shape_check",
      sql`(
        ${table.kind} = 'approval' and ${table.originalApprovalId} is null and ${table.minuteDelta} between 1 and 2147483647
      ) or (
        ${table.kind} = 'withdrawal' and ${table.originalApprovalId} is not null and ${table.minuteDelta} between -2147483647 and -1
      )`,
    ),
    check(
      "service_excess_approvals_text_check",
      sql`length(btrim(${table.externalReference})) between 1 and 1000 and (${table.externalUrl} is null or length(${table.externalUrl}) between 1 and 2000) and length(btrim(${table.reason})) between 1 and 1000`,
    ),
    check(
      "service_excess_approvals_time_check",
      sql`isfinite(${table.approvedAt}) and isfinite(${table.postedAt})`,
    ),
    check("service_excess_approvals_request_hash_check", requestHashCheck(table.requestHash)),
    check("service_excess_approvals_response_check", responseObjectCheck(table.response)),
  ],
);

export type ServicePeriodRow = typeof servicePeriods.$inferSelect;
export type ServiceUsageEntryRow = typeof serviceUsageEntries.$inferSelect;
export type ServiceExcessApprovalRow = typeof serviceExcessApprovals.$inferSelect;
