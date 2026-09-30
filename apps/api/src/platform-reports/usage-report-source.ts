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

export const USAGE_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "shifts_active",
  "active_lines",
  "active_devices",
  "active_operators",
  "accepted_units",
  "boxes_closed",
  "sscc_boxes",
  "print_confirmed_boxes",
  "production_pallets_closed",
  "warehouse_pallets_closed",
  "pickup_orders_buy",
  "pickup_orders_writeoff",
  "pickup_orders_kiosk",
  "pickup_orders_handheld",
  "pickup_items_buy",
  "pickup_items_writeoff",
  "inventories_completed",
  "gtins_added",
] as const;
const USAGE_METRICS = USAGE_COLUMNS.slice(3);

export const USAGE_DEFINITIONS: Record<string, string> = {
  shifts_active:
    "Distinct shifts that have at least one accepted scan (scanned_at) or one box closure (closure_received_at) on the day.",
  active_lines:
    "Distinct non-null shift line ids among the facts counted in shifts_active; a shift without a line contributes none.",
  active_devices:
    "Distinct non-null terminal ids on accepted scans and closed boxes of the day. Terminal ids are device-reported text and may be legacy non-UUID values; they are counted as text.",
  active_operators:
    "Distinct non-null operator ids on accepted scans and closed boxes of the day. A count only; no person is identified.",
  accepted_units:
    "scan_events with verdict=ok at scanned_at (device clock; scan_events has no server receipt time). This is not the current registry ownership count used by the tenant dashboard, which shrinks when codes are released, cleared or disassembled.",
  boxes_closed:
    "Boxes with closure_received_at on the day (server clock at receipt of the closure), including boxes disassembled later.",
  sscc_boxes: "Of boxes_closed, boxes with a non-null SSCC.",
  print_confirmed_boxes:
    "Boxes with print_verified_at on the day. The timestamp is the station's device clock carried in the closure record. It is print confirmation, not a reprint request.",
  production_pallets_closed:
    "Production pallets with closure_received_at on the day (server clock).",
  warehouse_pallets_closed: "Warehouse pallets with closure_received_at on the day (server clock).",
  pickup_orders_buy:
    "Non-cancelled pickup orders with reason=buy, dated by created_at. created_at is the device time when it lies within the accepted skew of the server clock, otherwise the server time.",
  pickup_orders_writeoff:
    "Non-cancelled pickup orders with reason=writeoff, dated like pickup_orders_buy.",
  pickup_orders_kiosk: "Non-cancelled pickup orders filed by a kiosk, both reasons.",
  pickup_orders_handheld: "Non-cancelled pickup orders filed by a handheld, both reasons.",
  pickup_items_buy:
    "Sum of item_count of the pickup_orders_buy orders. Order items are never joined.",
  pickup_items_writeoff: "Sum of item_count of the pickup_orders_writeoff orders.",
  inventories_completed: "Inventories with completed_at on the day (server clock), any mode.",
  gtins_added:
    "Products created on the day (server clock). Products deleted while unreferenced are absent, so a historical count can fall.",
};

export async function loadUsageRows(tx: ReportTransaction, input: PlatformReportInput) {
  return reportRows(
    tx,
    sql`
    WITH scans AS MATERIALIZED (
      -- Reach scan_events through the tenant's shifts so the (shift_id, scanned_at) index is used.
      SELECT v.tenant_id, v.shift_id, s.line_id, v.terminal_id, v.operator_id,
        ${localDay(sql`v.scanned_at`, input)} AS local_day
      FROM shifts s
      JOIN scan_events v ON v.shift_id = s.id AND v.tenant_id = s.tenant_id
      WHERE ${tenantScope(sql`s.tenant_id`, input)}
        AND v.verdict = 'ok'
        AND ${inWindow(sql`v.scanned_at`, input)}
    ), closed_boxes AS MATERIALIZED (
      SELECT b.tenant_id, b.shift_id, s.line_id, b.terminal_id, b.operator_id, b.sscc,
        ${localDay(sql`b.closure_received_at`, input)} AS local_day
      FROM boxes b
      JOIN shifts s ON s.id = b.shift_id AND s.tenant_id = b.tenant_id
      WHERE ${tenantScope(sql`b.tenant_id`, input)}
        AND ${inWindow(sql`b.closure_received_at`, input)}
    ), activity AS (
      SELECT tenant_id, local_day, shift_id, line_id, terminal_id, operator_id FROM scans
      UNION ALL
      SELECT tenant_id, local_day, shift_id, line_id, terminal_id, operator_id FROM closed_boxes
    ), pickup AS MATERIALIZED (
      SELECT o.tenant_id, ${localDay(sql`o.created_at`, input)} AS local_day,
        o.reason::text AS reason, o.source_kind, o.item_count
      FROM pickup_orders o
      WHERE ${tenantScope(sql`o.tenant_id`, input)}
        AND o.status::text <> 'cancelled'
        AND ${inWindow(sql`o.created_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'accepted_units' AS metric, count(*)::numeric AS n
        FROM scans GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'shifts_active', count(DISTINCT shift_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_lines', count(DISTINCT line_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_devices', count(DISTINCT terminal_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_operators', count(DISTINCT operator_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'boxes_closed', count(*)::numeric
        FROM closed_boxes GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'sscc_boxes', count(sscc)::numeric
        FROM closed_boxes GROUP BY tenant_id, local_day
      UNION ALL SELECT b.tenant_id, ${localDay(sql`b.print_verified_at`, input)}, 'print_confirmed_boxes', count(*)::numeric
        FROM boxes b
        WHERE ${tenantScope(sql`b.tenant_id`, input)} AND ${inWindow(sql`b.print_verified_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.closure_received_at`, input)}, 'production_pallets_closed', count(*)::numeric
        FROM pallets p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND p.kind = 'production'
          AND ${inWindow(sql`p.closure_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.closure_received_at`, input)}, 'warehouse_pallets_closed', count(*)::numeric
        FROM pallets p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND p.kind = 'warehouse'
          AND ${inWindow(sql`p.closure_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_buy', count(*) FILTER (WHERE reason = 'buy')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_writeoff', count(*) FILTER (WHERE reason = 'writeoff')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_kiosk', count(*) FILTER (WHERE source_kind = 'kiosk')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_handheld', count(*) FILTER (WHERE source_kind = 'handheld')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_items_buy', coalesce(sum(item_count) FILTER (WHERE reason = 'buy'), 0)::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_items_writeoff', coalesce(sum(item_count) FILTER (WHERE reason = 'writeoff'), 0)::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.completed_at`, input)}, 'inventories_completed', count(*)::numeric
        FROM inventories i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.completed_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.created_at`, input)}, 'gtins_added', count(*)::numeric
        FROM products p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.created_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(USAGE_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
