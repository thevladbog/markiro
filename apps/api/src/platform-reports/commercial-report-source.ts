import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import {
  inWindow,
  localDay,
  pivotMetrics,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const COMMERCIAL_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "invoices_issued",
  "invoices_issued_net_minor",
  "invoices_issued_vat_minor",
  "invoices_issued_total_minor",
  "invoices_cancelled",
  "invoices_paid",
  "payments_received",
  "payments_received_minor",
  "acts_issued",
  "paid_subscriptions_started",
  "agreements_signed",
] as const;
const COMMERCIAL_METRICS = COMMERCIAL_COLUMNS.slice(3);
const MONEY_METRICS = new Set([
  "invoices_issued_net_minor",
  "invoices_issued_vat_minor",
  "invoices_issued_total_minor",
  "payments_received_minor",
]);

export const COMMERCIAL_DEFINITIONS: Record<string, string> = {
  invoices_issued:
    "Invoices with issued_at on the day (server clock). A later cancellation does not remove them; it is counted separately in invoices_cancelled. Drafts have no issued_at and are never counted.",
  invoices_issued_net_minor:
    "Sum of invoices.subtotal of invoices_issued, in RUB kopecks (integer).",
  invoices_issued_vat_minor:
    "Sum of invoices.vat_total of invoices_issued, in RUB kopecks (integer).",
  invoices_issued_total_minor:
    "Sum of invoices.total of invoices_issued, in RUB kopecks (integer).",
  invoices_cancelled: "Invoices with cancelled_at on the day (server clock).",
  invoices_paid:
    "Invoices with paid_at on the day. paid_at is set only when the invoice is fully paid, so a partially paid invoice is not counted here.",
  payments_received:
    "Payments at paid_at: billing_payments (invoice payments) plus legacy payments (offer payments). The two flows are disjoint: an offer payment writes only payments and an invoice payment writes only billing_payments, so they are summed without deduplication. A partial payment is counted when received.",
  payments_received_minor: "Sum of the amounts of payments_received, in RUB kopecks (integer).",
  acts_issued: "billing_acts with issued_at on the day (server clock).",
  paid_subscriptions_started:
    "Subscriptions whose source is paid_offer_line or paid_invoice_line, dated by starts_at, or by created_at when starts_at is null. Demo, manual and other sources are not counted.",
  agreements_signed:
    "platform_agreements with signed_at on the day (server clock) whose tenant_id is a selected tenant. Agreements not linked to a tenant are never reported.",
};

export async function loadCommercialRows(tx: ReportTransaction, input: PlatformReportInput) {
  return reportRows(
    tx,
    sql`
    WITH received AS MATERIALIZED (
      SELECT p.tenant_id, ${localDay(sql`p.paid_at`, input)} AS local_day, p.amount
      FROM billing_payments p
      WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.paid_at`, input)}
      UNION ALL
      SELECT p.tenant_id, ${localDay(sql`p.paid_at`, input)}, p.amount
      FROM payments p
      WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.paid_at`, input)}
    ), issued AS MATERIALIZED (
      SELECT i.tenant_id, ${localDay(sql`i.issued_at`, input)} AS local_day,
        i.subtotal, i.vat_total, i.total
      FROM invoices i
      WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.issued_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'invoices_issued' AS metric, count(*)::numeric AS n
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_net_minor', coalesce(sum(round(subtotal * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_vat_minor', coalesce(sum(round(vat_total * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_total_minor', coalesce(sum(round(total * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.cancelled_at`, input)}, 'invoices_cancelled', count(*)::numeric
        FROM invoices i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.cancelled_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.paid_at`, input)}, 'invoices_paid', count(*)::numeric
        FROM invoices i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.paid_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'payments_received', count(*)::numeric
        FROM received GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'payments_received_minor', coalesce(sum(round(amount * 100)), 0)::numeric
        FROM received GROUP BY tenant_id, local_day
      UNION ALL SELECT a.tenant_id, ${localDay(sql`a.issued_at`, input)}, 'acts_issued', count(*)::numeric
        FROM billing_acts a
        WHERE ${tenantScope(sql`a.tenant_id`, input)} AND ${inWindow(sql`a.issued_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT s.tenant_id, ${localDay(sql`coalesce(s.starts_at, s.created_at)`, input)}, 'paid_subscriptions_started', count(*)::numeric
        FROM tenant_subscriptions s
        WHERE ${tenantScope(sql`s.tenant_id`, input)}
          AND s.source::text IN ('paid_offer_line', 'paid_invoice_line')
          AND ${inWindow(sql`coalesce(s.starts_at, s.created_at)`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT g.tenant_id, ${localDay(sql`g.signed_at`, input)}, 'agreements_signed', count(*)::numeric
        FROM platform_agreements g
        WHERE ${tenantScope(sql`g.tenant_id`, input)} AND ${inWindow(sql`g.signed_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(COMMERCIAL_METRICS, MONEY_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
