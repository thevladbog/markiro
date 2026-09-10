import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import {
  factWindow,
  inWindow,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const SHIFT_COLUMNS = [
  "tenant_id",
  "shift_id",
  "shift_number",
  "production_date",
  "status",
  "line_id",
  "line_name",
  "product_id",
  "product_name",
  "gtin14",
  "accepted_scans",
  "duplicate_scans",
  "wrong_gtin_scans",
  "invalid_scans",
  "boxes",
  "sscc_assigned_boxes",
  "print_confirmed_boxes",
  "reprint_requests",
  "disassembled_boxes",
  "conflicts",
  "first_event_at",
  "last_event_at",
];
export function shiftColumns(input: PlatformReportInput): string[] {
  return input.reportType === "shift_operators" && input.privacy !== "aggregate"
    ? [...SHIFT_COLUMNS, "operator_id", "operator_name"]
    : SHIFT_COLUMNS;
}

export async function loadShiftRows(tx: ReportTransaction, input: PlatformReportInput) {
  const persons = input.reportType === "shift_operators" && input.privacy !== "aggregate";
  const operatorScope = input.operatorId
    ? sql`AND f.operator_id = ${input.operatorId}::uuid`
    : sql``;
  const personColumns = persons
    ? sql`, f.operator_id, CASE WHEN f.operator_id IS NULL THEN 'unknown' ELSE e.full_name END AS operator_name`
    : sql``;
  const result = await reportRows(
    tx,
    sql`
    WITH selected AS MATERIALIZED (
      SELECT s.id, s.tenant_id, s.number_month_key, s.number_seq, s.created_from, s.production_date,
        s.status, s.line_id, l.name AS line_name, s.product_id, p.name AS product_name, p.gtin14,
        s.created_at, s.opened_at, s.closed_at
      FROM shifts s
      JOIN products p ON p.id=s.product_id AND p.tenant_id=s.tenant_id
      LEFT JOIN lines l ON l.id=s.line_id AND l.tenant_id=s.tenant_id
      WHERE ${tenantScope(sql`s.tenant_id`, input)}
        ${input.lineId ? sql`AND s.line_id=${input.lineId}::uuid` : sql``}
        ${input.productId ? sql`AND s.product_id=${input.productId}::uuid` : sql``}
        ${input.gtin14 ? sql`AND p.gtin14=${input.gtin14}` : sql``}
        ${input.status ? sql`AND s.status::text=${input.status}` : sql``}
        ${
          input.periodBasis === "production_date"
            ? sql`AND s.production_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date`
            : sql`AND (
          ${inWindow(sql`s.created_at`, input)} OR ${inWindow(sql`s.opened_at`, input)} OR ${inWindow(sql`s.closed_at`, input)}
          OR EXISTS (SELECT 1 FROM scan_events v WHERE v.tenant_id=s.tenant_id AND v.shift_id=s.id
            AND ${inWindow(sql`v.scanned_at`, input)})
          OR EXISTS (SELECT 1 FROM boxes b WHERE b.tenant_id=s.tenant_id AND b.shift_id=s.id
            AND (${inWindow(sql`b.opened_at`, input)} OR ${inWindow(sql`b.closed_at`, input)}
              OR ${inWindow(sql`b.print_verified_at`, input)} OR ${inWindow(sql`b.disassembled_at`, input)}))
          OR EXISTS (SELECT 1 FROM box_exceptions x WHERE x.tenant_id=s.tenant_id AND x.shift_id=s.id
            AND x.kind='reprint' AND ${inWindow(sql`x.occurred_at`, input)})
          OR EXISTS (SELECT 1 FROM code_conflicts c WHERE c.tenant_id=s.tenant_id AND c.losing_shift_id=s.id
            AND ${inWindow(sql`c.detected_at`, input)})
        )`
        }
    ), facts AS (
      SELECT s.tenant_id, s.id AS shift_id, v.operator_id, v.scanned_at AS at, 'scan_' || v.verdict AS kind, 0 AS sscc
      FROM selected s JOIN scan_events v ON v.shift_id=s.id AND v.tenant_id=s.tenant_id
      WHERE ${factWindow(sql`v.scanned_at`, input)}
      UNION ALL
      SELECT s.tenant_id, s.id, b.operator_id, event.at, event.kind,
        CASE WHEN event.kind='box_closed' AND b.sscc IS NOT NULL THEN 1 ELSE 0 END
      FROM selected s JOIN boxes b ON b.shift_id=s.id AND b.tenant_id=s.tenant_id
      CROSS JOIN LATERAL (VALUES (b.opened_at,'box_opened'),(b.closed_at,'box_closed'),
        (b.print_verified_at,'box_printed'),(b.disassembled_at,'box_disassembled')) event(at,kind)
      WHERE ${factWindow(sql`event.at`, input)}
      UNION ALL
      SELECT s.tenant_id, s.id, x.operator_id, x.occurred_at, 'reprint', 0
      FROM selected s JOIN box_exceptions x ON x.shift_id=s.id AND x.tenant_id=s.tenant_id
      WHERE x.kind='reprint' AND ${factWindow(sql`x.occurred_at`, input)}
      UNION ALL
      SELECT s.tenant_id, s.id, NULL::uuid, c.detected_at, 'conflict', 0
      FROM selected s JOIN code_conflicts c ON c.losing_shift_id=s.id AND c.tenant_id=s.tenant_id
      WHERE ${factWindow(sql`c.detected_at`, input)}
    )
    SELECT s.tenant_id, s.id AS shift_id,
      s.number_month_key || '-' || CASE WHEN length(s.number_seq::text)<3 THEN lpad(s.number_seq::text,3,'0') ELSE s.number_seq::text END || CASE WHEN s.created_from='station' THEN '/S' ELSE '' END AS shift_number,
      s.production_date::text AS production_date, s.status::text AS status, s.line_id, s.line_name, s.product_id, s.product_name, s.gtin14,
      count(*) FILTER(WHERE f.kind='scan_ok')::int AS accepted_scans,
      count(*) FILTER(WHERE f.kind='scan_duplicate')::int AS duplicate_scans,
      count(*) FILTER(WHERE f.kind='scan_wrong_gtin')::int AS wrong_gtin_scans,
      count(*) FILTER(WHERE f.kind='scan_invalid')::int AS invalid_scans,
      count(*) FILTER(WHERE f.kind='box_closed')::int AS boxes,
      coalesce(sum(f.sscc),0)::int AS sscc_assigned_boxes,
      count(*) FILTER(WHERE f.kind='box_printed')::int AS print_confirmed_boxes,
      count(*) FILTER(WHERE f.kind='reprint')::int AS reprint_requests,
      count(*) FILTER(WHERE f.kind='box_disassembled')::int AS disassembled_boxes,
      ${persons || input.operatorId ? sql`NULL::int` : sql`count(*) FILTER(WHERE f.kind='conflict')::int`} AS conflicts,
      min(f.at) FILTER(WHERE f.kind LIKE 'scan_%' OR f.kind IN ('box_opened','box_closed')) AS first_event_at,
      max(f.at) FILTER(WHERE f.kind LIKE 'scan_%' OR f.kind IN ('box_opened','box_closed')) AS last_event_at
      ${personColumns}
    FROM selected s
    LEFT JOIN facts f ON f.tenant_id=s.tenant_id AND f.shift_id=s.id ${operatorScope} ${persons ? sql`AND f.kind <> 'conflict'` : sql``}
    ${persons ? sql`LEFT JOIN employees e ON e.id=f.operator_id AND e.tenant_id=s.tenant_id` : sql``}
    WHERE ${input.periodBasis === "production_date" ? sql`true` : sql`(${inWindow(sql`s.created_at`, input)} OR ${inWindow(sql`s.opened_at`, input)} OR ${inWindow(sql`s.closed_at`, input)} OR f.shift_id IS NOT NULL)`}
      ${input.operatorId ? sql`AND f.shift_id IS NOT NULL` : sql``}
    GROUP BY s.tenant_id,s.id,s.number_month_key,s.number_seq,s.created_from,s.production_date,s.status,s.line_id,s.line_name,s.product_id,s.product_name,s.gtin14
      ${persons ? sql`,f.operator_id,e.full_name` : sql``}
    ORDER BY s.tenant_id,s.id ${persons ? sql`,f.operator_id NULLS FIRST` : sql``}
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
  return result;
}
