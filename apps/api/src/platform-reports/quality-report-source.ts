import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { loadInventoryRows } from "./inventory-report-source";
import { REPORT_MAX_ROWS, type ReportRow } from "./report-definitions";
import {
  inWindow,
  localDay,
  pivotMetrics,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const QUALITY_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "accepted_scans",
  "duplicate_scans",
  "wrong_gtin_scans",
  "invalid_scans",
  "code_conflicts_detected",
  "code_conflicts_reviewed",
  "box_disassemblies",
  "pallet_disassemblies",
  "box_closure_lag_clock_ahead",
  "box_closure_lag_lt_1h",
  "box_closure_lag_lt_24h",
  "box_closure_lag_lt_7d",
  "box_closure_lag_ge_7d",
  "box_closure_lag_unknown",
  "sync_quarantined_records",
  "inventories_completed_with_snapshot",
  "inventory_expected_current",
  "inventory_missing_expected_current",
] as const;
const INVENTORY_COLUMNS_MERGED = [
  "inventories_completed_with_snapshot",
  "inventory_expected_current",
  "inventory_missing_expected_current",
] as const;
const SQL_METRICS = QUALITY_COLUMNS.slice(3).filter(
  (column) => !(INVENTORY_COLUMNS_MERGED as readonly string[]).includes(column),
);

export const QUALITY_DEFINITIONS: Record<string, string> = {
  accepted_scans:
    "scan_events with verdict=ok at scanned_at (device clock). Accepted unit scan evidence, not current registry ownership.",
  duplicate_scans: "scan_events with verdict=duplicate at scanned_at (device clock).",
  wrong_gtin_scans: "scan_events with verdict=wrong_gtin at scanned_at (device clock).",
  invalid_scans: "scan_events with verdict=invalid at scanned_at (device clock).",
  code_conflicts_detected:
    "code_conflicts at detected_at (server clock), counted for the losing shift's tenant. The shift report counts conflicts per losing shift; the two are not reconciled.",
  code_conflicts_reviewed: "code_conflicts at reviewed_at (server clock).",
  box_disassemblies:
    "Boxes with disassembly_received_at on the day (server clock at receipt). boxes.disassembled_at is the operator's device clock and is not used here, so this differs from the shift report's disassembled_boxes.",
  pallet_disassemblies:
    "pallet_exceptions with kind=disassemble at recorded_at (server clock). pallets.disassembled_at is a device clock and is not used.",
  box_closure_lag_clock_ahead:
    "Boxes received on the day whose device closed_at is later than the server closure_received_at (negative lag, the device clock ran ahead).",
  box_closure_lag_lt_1h:
    "Boxes received on the day with 0 <= closure_received_at - closed_at < 1 hour.",
  box_closure_lag_lt_24h:
    "Boxes received on the day with 1 hour <= lag < 24 hours. Bucket bounds are half-open.",
  box_closure_lag_lt_7d: "Boxes received on the day with 24 hours <= lag < 7 days.",
  box_closure_lag_ge_7d: "Boxes received on the day with lag of 7 days or more.",
  box_closure_lag_unknown: "Boxes received on the day whose device closed_at is null.",
  sync_quarantined_records:
    "station_sync_quarantine rows at quarantined_at (server clock). Quarantine rows have no resolved flag, so this counts records quarantined, not records still unresolved.",
  inventories_completed_with_snapshot:
    "Inventories with completed_at on the day (server clock) that have an active snapshot.",
  inventory_expected_current:
    "Sum of the active snapshot expected_count of those inventories. A current projection at generation time, not an event-time reconstruction.",
  inventory_missing_expected_current:
    "Sum of the current missing-expected count of those inventories (expected minus current expected-classified results of the snapshot, floored at zero). A current projection at generation time, not an event-time reconstruction.",
};

function add(row: ReportRow, column: string, amount: number): void {
  const current = row[column];
  row[column] = (typeof current === "number" ? current : 0) + amount;
}

function byTenantDay(a: ReportRow, b: ReportRow): number {
  const left = `${String(a.tenant_id)}|${String(a.day)}`;
  const right = `${String(b.tenant_id)}|${String(b.day)}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Joins the SQL fact rows to completed inventories. `completions` has one row per completed
 * inventory (tenant_id, tenant_name, inventory_id, day, has_snapshot); `projections` are the rows
 * of the existing inventory report, whose current_* values are read as they are.
 */
export function mergeInventoryCompletions(
  factRows: ReportRow[],
  completions: ReportRow[],
  projections: ReportRow[],
): ReportRow[] {
  const rows = new Map<string, ReportRow>();
  const key = (tenantId: unknown, day: unknown) => `${String(tenantId)}|${String(day)}`;
  for (const row of factRows) {
    rows.set(key(row.tenant_id, row.day), {
      ...row,
      inventories_completed_with_snapshot: 0,
      inventory_expected_current: 0,
      inventory_missing_expected_current: 0,
    });
  }
  const projection = new Map(projections.map((row) => [key(row.tenant_id, row.inventory_id), row]));
  for (const done of completions) {
    const rowKey = key(done.tenant_id, done.day);
    let row = rows.get(rowKey);
    if (!row) {
      row = {
        tenant_id: done.tenant_id ?? null,
        tenant_name: done.tenant_name ?? null,
        day: done.day ?? null,
      };
      for (const column of QUALITY_COLUMNS.slice(3)) row[column] = 0;
      rows.set(rowKey, row);
    }
    if (done.has_snapshot === 1) add(row, "inventories_completed_with_snapshot", 1);
    const current = projection.get(key(done.tenant_id, done.inventory_id));
    if (typeof current?.current_expected === "number")
      add(row, "inventory_expected_current", current.current_expected);
    if (typeof current?.current_missing_expected === "number")
      add(row, "inventory_missing_expected_current", current.current_missing_expected);
  }
  return [...rows.values()].sort(byTenantDay);
}

export async function loadQualityRows(tx: ReportTransaction, input: PlatformReportInput) {
  const factRows = await reportRows(
    tx,
    sql`
    WITH scans AS MATERIALIZED (
      -- Reach scan_events through the tenant's shifts so the (shift_id, scanned_at) index is used.
      SELECT v.tenant_id, v.verdict, ${localDay(sql`v.scanned_at`, input)} AS local_day
      FROM shifts s
      JOIN scan_events v ON v.shift_id = s.id AND v.tenant_id = s.tenant_id
      WHERE ${tenantScope(sql`s.tenant_id`, input)}
        AND v.verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')
        AND ${inWindow(sql`v.scanned_at`, input)}
    ), closures AS MATERIALIZED (
      SELECT b.tenant_id, ${localDay(sql`b.closure_received_at`, input)} AS local_day,
        CASE
          WHEN b.closed_at IS NULL THEN 'unknown'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 0 THEN 'clock_ahead'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 3600 THEN 'lt_1h'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 86400 THEN 'lt_24h'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 604800 THEN 'lt_7d'
          ELSE 'ge_7d'
        END AS bucket
      FROM boxes b
      WHERE ${tenantScope(sql`b.tenant_id`, input)}
        AND ${inWindow(sql`b.closure_received_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'accepted_scans' AS metric, count(*)::numeric AS n
        FROM scans WHERE verdict = 'ok' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'duplicate_scans', count(*)::numeric
        FROM scans WHERE verdict = 'duplicate' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'wrong_gtin_scans', count(*)::numeric
        FROM scans WHERE verdict = 'wrong_gtin' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invalid_scans', count(*)::numeric
        FROM scans WHERE verdict = 'invalid' GROUP BY tenant_id, local_day
      UNION ALL SELECT c.tenant_id, ${localDay(sql`c.detected_at`, input)}, 'code_conflicts_detected', count(*)::numeric
        FROM code_conflicts c
        WHERE ${tenantScope(sql`c.tenant_id`, input)} AND ${inWindow(sql`c.detected_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT c.tenant_id, ${localDay(sql`c.reviewed_at`, input)}, 'code_conflicts_reviewed', count(*)::numeric
        FROM code_conflicts c
        WHERE ${tenantScope(sql`c.tenant_id`, input)} AND ${inWindow(sql`c.reviewed_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT b.tenant_id, ${localDay(sql`b.disassembly_received_at`, input)}, 'box_disassemblies', count(*)::numeric
        FROM boxes b
        WHERE ${tenantScope(sql`b.tenant_id`, input)} AND ${inWindow(sql`b.disassembly_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT x.tenant_id, ${localDay(sql`x.recorded_at`, input)}, 'pallet_disassemblies', count(*)::numeric
        FROM pallet_exceptions x
        WHERE ${tenantScope(sql`x.tenant_id`, input)} AND x.kind = 'disassemble'
          AND ${inWindow(sql`x.recorded_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'box_closure_lag_' || bucket, count(*)::numeric
        FROM closures GROUP BY tenant_id, local_day, bucket
      UNION ALL SELECT q.tenant_id, ${localDay(sql`q.quarantined_at`, input)}, 'sync_quarantined_records', count(*)::numeric
        FROM station_sync_quarantine q
        WHERE ${tenantScope(sql`q.tenant_id`, input)} AND ${inWindow(sql`q.quarantined_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(SQL_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
  const completions = await reportRows(
    tx,
    sql`
    SELECT i.tenant_id, o.name AS tenant_name, i.id::text AS inventory_id,
      ${localDay(sql`i.completed_at`, input)}::text AS day,
      (i.active_snapshot_id IS NOT NULL)::int AS has_snapshot
    FROM inventories i
    JOIN organization o ON o.id = i.tenant_id
    WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.completed_at`, input)}
    ORDER BY i.tenant_id, i.id
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
  // The projection is the existing inventory report's own; it is only read when something completed.
  const projections = completions.length > 0 ? await loadInventoryRows(tx, input) : [];
  return mergeInventoryCompletions(factRows, completions, projections);
}
