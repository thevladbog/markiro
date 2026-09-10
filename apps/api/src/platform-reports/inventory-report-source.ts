import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import { inWindow, reportRows, tenantScope, type ReportTransaction } from "./report-query";

export const INVENTORY_COLUMNS = [
  "tenant_id",
  "inventory_id",
  "inventory_number",
  "status",
  "line_id",
  "line_name",
  "product_id",
  "product_name",
  "gtin14",
  "current_expected",
  "current_protected",
  "current_found_expected",
  "current_found_protected",
  "current_ineligible",
  "current_unknown",
  "current_voided",
  "current_missing_expected",
  "period_item_accepted",
  "period_duplicate_events",
  "period_rejected_events",
  "period_claimed_codes",
  "period_duplicate_codes",
  "period_repack_closed",
  "period_repack_invalidated",
  "period_initial_printed",
  "period_initial_failed",
  "period_reprint_printed",
  "period_reprint_failed",
];

export async function loadInventoryRows(tx: ReportTransaction, input: PlatformReportInput) {
  return reportRows(
    tx,
    sql`
    WITH selected AS MATERIALIZED (
      SELECT i.id,i.tenant_id,i.number,i.status,i.line_id,l.name AS line_name,i.product_id,p.name AS product_name,i.gtin14_snapshot,
        i.active_snapshot_id,i.created_at,i.started_at,i.closed_at,i.completed_at,i.cancelled_at,
        snap.expected_count,snap.protected_count
      FROM inventories i
      JOIN products p ON p.id=i.product_id AND p.tenant_id=i.tenant_id
      JOIN lines l ON l.id=i.line_id AND l.tenant_id=i.tenant_id
      LEFT JOIN inventory_snapshots snap ON snap.id=i.active_snapshot_id AND snap.inventory_id=i.id AND snap.tenant_id=i.tenant_id
      WHERE ${tenantScope(sql`i.tenant_id`, input)}
        ${input.lineId ? sql`AND i.line_id=${input.lineId}::uuid` : sql``}
        ${input.productId ? sql`AND i.product_id=${input.productId}::uuid` : sql``}
        ${input.gtin14 ? sql`AND i.gtin14_snapshot=${input.gtin14}` : sql``}
        ${input.status ? sql`AND i.status::text=${input.status}` : sql``}
    ), events AS MATERIALIZED (
      SELECT e.tenant_id,e.inventory_id,e.event_id,e.kind,e.authoritative_verdict
      FROM inventory_scan_events e JOIN selected i ON i.id=e.inventory_id AND i.tenant_id=e.tenant_id
      WHERE ${inWindow(sql`e.scanned_at`, input)}
    ), facts AS (
      SELECT e.tenant_id,e.inventory_id, 'scan' AS category,
        CASE WHEN e.kind='item' AND e.authoritative_verdict='applied' THEN 'item_accepted'
          WHEN e.authoritative_verdict='duplicate' THEN 'duplicate_event'
          WHEN e.authoritative_verdict='rejected' THEN 'rejected_event' ELSE 'other' END AS kind
      FROM events e
      UNION ALL
      SELECT e.tenant_id,e.inventory_id,'claim',o.status
      FROM events e JOIN inventory_event_claim_outcomes o ON o.source_event_id=e.event_id AND o.inventory_id=e.inventory_id AND o.tenant_id=e.tenant_id
      UNION ALL
      SELECT b.tenant_id,b.inventory_id,'box',event.kind
      FROM inventory_repack_boxes b JOIN selected i ON i.id=b.inventory_id AND i.tenant_id=b.tenant_id
      CROSS JOIN LATERAL (VALUES(b.opened_at,'opened'),(b.closed_at,'closed'),(b.invalidated_at,'invalidated')) event(at,kind)
      WHERE ${inWindow(sql`event.at`, input)}
      UNION ALL
      SELECT a.tenant_id,a.inventory_id,'print',a.kind || '_' || a.result
      FROM inventory_repack_print_attempts a JOIN selected i ON i.id=a.inventory_id AND i.tenant_id=a.tenant_id
      WHERE ${inWindow(sql`a.completed_at`, input)}
    ), totals AS (
      SELECT tenant_id,inventory_id,count(*) AS fact_count,
        count(*) FILTER(WHERE category='scan' AND kind='item_accepted')::int AS period_item_accepted,
        count(*) FILTER(WHERE category='scan' AND kind='duplicate_event')::int AS period_duplicate_events,
        count(*) FILTER(WHERE category='scan' AND kind='rejected_event')::int AS period_rejected_events,
        count(*) FILTER(WHERE category='claim' AND kind='claimed')::int AS period_claimed_codes,
        count(*) FILTER(WHERE category='claim' AND kind='duplicate')::int AS period_duplicate_codes,
        count(*) FILTER(WHERE category='box' AND kind='closed')::int AS period_repack_closed,
        count(*) FILTER(WHERE category='box' AND kind='invalidated')::int AS period_repack_invalidated,
        count(*) FILTER(WHERE category='print' AND kind='initial_printed')::int AS period_initial_printed,
        count(*) FILTER(WHERE category='print' AND kind='initial_failed')::int AS period_initial_failed,
        count(*) FILTER(WHERE category='print' AND kind='reprint_printed')::int AS period_reprint_printed,
        count(*) FILTER(WHERE category='print' AND kind='reprint_failed')::int AS period_reprint_failed
      FROM facts GROUP BY tenant_id,inventory_id
    ), current_results AS (
      SELECT r.tenant_id,r.inventory_id,
        count(*) FILTER(WHERE classification='expected')::int AS found_expected,
        count(*) FILTER(WHERE classification='protected')::int AS found_protected,
        count(*) FILTER(WHERE classification='ineligible')::int AS ineligible,
        count(*) FILTER(WHERE classification='unknown')::int AS unknown,
        count(*) FILTER(WHERE classification='voided')::int AS voided,
        count(*) FILTER(WHERE classification='expected' AND r.snapshot_id=i.active_snapshot_id)::int AS snapshot_found_expected
      FROM inventory_code_results r JOIN selected i ON i.id=r.inventory_id AND i.tenant_id=r.tenant_id
      GROUP BY r.tenant_id,r.inventory_id
    )
    SELECT i.tenant_id,i.id AS inventory_id,i.number AS inventory_number,i.status::text AS status,i.line_id,i.line_name,i.product_id,i.product_name,i.gtin14_snapshot AS gtin14,
      i.expected_count AS current_expected,i.protected_count AS current_protected,
      coalesce(r.found_expected,0)::int AS current_found_expected,coalesce(r.found_protected,0)::int AS current_found_protected,
      coalesce(r.ineligible,0)::int AS current_ineligible,coalesce(r.unknown,0)::int AS current_unknown,coalesce(r.voided,0)::int AS current_voided,
      CASE WHEN i.status='completed' AND i.expected_count IS NOT NULL THEN greatest(0,i.expected_count-coalesce(r.snapshot_found_expected,0)) ELSE NULL END::int AS current_missing_expected,
      coalesce(t.period_item_accepted,0)::int AS period_item_accepted,coalesce(t.period_duplicate_events,0)::int AS period_duplicate_events,
      coalesce(t.period_rejected_events,0)::int AS period_rejected_events,coalesce(t.period_claimed_codes,0)::int AS period_claimed_codes,
      coalesce(t.period_duplicate_codes,0)::int AS period_duplicate_codes,coalesce(t.period_repack_closed,0)::int AS period_repack_closed,
      coalesce(t.period_repack_invalidated,0)::int AS period_repack_invalidated,coalesce(t.period_initial_printed,0)::int AS period_initial_printed,
      coalesce(t.period_initial_failed,0)::int AS period_initial_failed,coalesce(t.period_reprint_printed,0)::int AS period_reprint_printed,
      coalesce(t.period_reprint_failed,0)::int AS period_reprint_failed
    FROM selected i LEFT JOIN totals t ON t.inventory_id=i.id AND t.tenant_id=i.tenant_id
    LEFT JOIN current_results r ON r.inventory_id=i.id AND r.tenant_id=i.tenant_id
    WHERE coalesce(t.fact_count,0)>0 OR ${inWindow(sql`i.created_at`, input)} OR ${inWindow(sql`i.started_at`, input)}
      OR ${inWindow(sql`i.closed_at`, input)} OR ${inWindow(sql`i.completed_at`, input)} OR ${inWindow(sql`i.cancelled_at`, input)}
    ORDER BY i.tenant_id,i.id LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
