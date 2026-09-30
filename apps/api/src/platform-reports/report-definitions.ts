import {
  isPlatformEvidenceReportType,
  type PlatformReportInput,
  type platformReportErrorCodeSchema,
} from "@markiro/platform-contracts";
import type { z } from "zod";

export type ReportRow = Record<string, string | number | null>;
export interface PlatformReportSource {
  snapshotAt: Date;
  columns: string[];
  rows: ReportRow[];
  definitions: Record<string, string>;
}
export const REPORT_MAX_ROWS = 100_000;
export const REPORT_MAX_BYTES = 32 * 1024 * 1024;
export class PlatformReportSourceError extends Error {
  constructor(readonly code: z.infer<typeof platformReportErrorCodeSchema>) {
    super(code);
    this.name = "PlatformReportSourceError";
  }
}

export const REPORT_DEFINITIONS: Record<string, string> = {
  record_type:
    "Summary contains separate shift and inventory rows in one CSV with their own metrics; non-applicable fields are null. CommerceML distinguishes session and event rows, which must not be summed as one activity count.",
  current_found_expected:
    "Current code-result rows with classification=expected, across the selected inventory, irrespective of scan period.",
  current_found_protected:
    "Current code-result rows with classification=protected, irrespective of scan period.",
  current_ineligible:
    "Current code-result rows with classification=ineligible, irrespective of scan period.",
  current_unknown:
    "Current code-result rows with classification=unknown, irrespective of scan period.",
  current_voided:
    "Current code-result rows with classification=voided, irrespective of scan period.",
  period_rejected_events:
    "Source scan events scanned in period whose current authoritative_verdict=rejected, irrespective of local verdict.",
  selection:
    "Inclusive local calendar dates, implemented as [local midnight fromDate, local midnight after toDate). Events select entities with lifecycle or reported facts in that window; each metric uses its own event timestamp. production_date selects only explicit shift production_date, then all facts of those shifts regardless of timestamp.",
  identity:
    "Names and status are current at source snapshot, not asserted historical names or states. GTIN is current product GTIN for shifts and fixed gtin14_snapshot for inventories. Blank CSV cells represent unavailable/null, not zero.",
  privacy:
    "Pseudonymous and aggregate reports do not guarantee legal anonymization; production identifiers may permit inference. Aggregate removes person rows and first/last person event timestamps.",
  shift_number:
    "Immutable number_month_key-number_seq, sequence padded to at least three digits without truncation; /S for station origin.",
  accepted_scans:
    "scan_events with verdict=ok; accepted unit scan evidence, not current registry ownership.",
  duplicate_scans: "scan_events with verdict=duplicate.",
  wrong_gtin_scans: "scan_events with verdict=wrong_gtin.",
  invalid_scans: "scan_events with verdict=invalid.",
  boxes:
    "Boxes with closed_at in the selected fact scope, including subsequently disassembled boxes; scanned units and boxes are aggregated independently.",
  sscc_assigned_boxes: "Closed boxes with non-null SSCC; reserved offline SSCC pools are excluded.",
  print_confirmed_boxes:
    "Boxes with print_verified_at in the fact scope; this is print confirmation, not a reprint request.",
  reprint_requests:
    "box_exceptions kind=reprint at occurred_at; requests including attempts, not confirmed printed labels.",
  disassembled_boxes:
    "Boxes with actual disassembled_at in the fact scope; exception attempts do not count.",
  conflicts:
    "code_conflicts for losing shift at detected_at; unavailable on person rows or with operator filter because conflicts have no operator attribution.",
  first_event_at:
    "Earliest selected scan time or box opened_at/closed_at, each independently windowed. opened_at may be server receipt time, closed_at is a device timestamp. Null operator is retained as unknown.",
  last_event_at:
    "Latest selected scan time or box opened_at/closed_at, independently windowed; mixed server receipt and device timestamps are not a measured working duration.",
  inventory_projection:
    "current_* fields describe the active snapshot and current code-result classifications at generation time, never an event-time reconstruction. Period scan verdicts and per-code claim outcomes also reflect their CURRENT authoritative state for source events scanned inside the period.",
  current_expected: "Active snapshot expected_count; null when no active snapshot.",
  current_protected: "Active snapshot protected_count; null when no active snapshot.",
  current_missing_expected:
    "Active snapshot expected_count minus current expected-classified results belonging to that snapshot, floored at zero; only available for completed inventories with active snapshot.",
  period_item_accepted:
    "Item events scanned in period whose current authoritative_verdict=applied; excludes known_box, old_box, repack_action, pending and rejected.",
  period_duplicate_events:
    "Source scan events in period with current authoritative_verdict=duplicate; one event can expand multiple per-code claims.",
  period_claimed_codes:
    "Current claimed per-code outcomes joined to source events scanned in period; separate from scan-event counts.",
  period_duplicate_codes:
    "Current duplicate per-code outcomes joined to source events scanned in period.",
  period_repack_closed: "Repack boxes with closed_at in period, regardless of current state.",
  period_repack_invalidated: "Repack boxes with invalidated_at in period.",
  period_initial_printed:
    "Append-only initial print attempts result=printed at completed_at in period.",
  period_initial_failed:
    "Append-only initial print attempts result=failed at completed_at in period.",
  period_reprint_printed:
    "Append-only reprint attempts result=printed at completed_at in period; separate from shift reprint requests.",
  period_reprint_failed: "Append-only reprint attempts result=failed at completed_at in period.",
  commerceml:
    "Only channel commerceml. Session rows selected by started_at or finished_at in period; event rows by at in period. Outcome filter applies independently at row grain. Session timestamps/outcome are current facts. Error categories are finite allowlisted categories; raw messages/details/summary/cookies/uploads are never exported.",
  current_upload_chunks:
    "Number of temporary exchange_uploads chunks present at snapshot for a selected session, not historical archive availability; null on event rows.",
  retention:
    "CommerceML item-grain journal retention is 14 days, session-grain/session retention 90 days. Completeness of older activity is unknown; zero retained rows is not proof of zero real activity.",
};

/** Bumped whenever a formula or clock basis of that report type changes. */
export const REPORT_DEFINITIONS_VERSION: Record<PlatformReportInput["reportType"], string> = {
  shifts: "1",
  shift_operators: "1",
  inventories: "1",
  summary: "1",
  commerceml: "1",
  usage: "1",
  quality: "1",
  commercial: "1",
};

export const EVIDENCE_TENANT_FIELDS = ["tenant_id", "tenant_name"] as const;

export const EVIDENCE_COMMON_DEFINITIONS: Record<string, string> = {
  grain:
    "One row per tenant and local calendar day in the selected IANA timezone. In aggregate mode the tenant dimension is removed and each row is one local day summed across the selected tenants. A day appears only if at least one fact of this report was recorded for that tenant on that day; a missing row means no recorded fact, not a measured zero. Every numeric column is an additive count or sum, so rows can be summed across days.",
  day: "Local calendar date (YYYY-MM-DD) of the fact's own timestamp in the selected timezone. Each metric names its clock in its own definition.",
  tenant_id:
    "Tenant identifier. Replaced by an export-local label in pseudonymous mode and removed in aggregate mode.",
  tenant_name:
    "Current organization name at the snapshot, not an asserted historical name. Replaced or removed like tenant_id.",
  selection:
    "Inclusive local calendar dates, implemented as [local midnight fromDate, local midnight after toDate) in the selected timezone. No optional filters are supported.",
  restatement:
    "Late device synchronisation can add facts to past days, so the same parameters run later can return different numbers. Compare exports by snapshotAt and definitionsVersion.",
  privacy:
    "Pseudonymous and aggregate output is not legal anonymization: a distinctive volume or a small tenant selection can still identify a tenant. Aggregate removes the tenant columns and sums days across the selected tenants.",
};

function labelTenants(rows: ReportRow[]): Map<string, string> {
  const ids = [
    ...new Set(
      rows.map((row) => row.tenant_id).filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  return new Map(ids.map((id, index) => [id, `tenant-${String(index + 1).padStart(2, "0")}`]));
}

export function applyReportPrivacy(
  input: PlatformReportInput,
  source: PlatformReportSource,
): PlatformReportSource {
  if (input.privacy === "identified") return source;
  const tenantLabelled = isPlatformEvidenceReportType(input.reportType);
  const labels = new Map<string, string>();
  const tenantLabels = tenantLabelled ? labelTenants(source.rows) : new Map<string, string>();
  const personFields = new Set(["operator_id", "operator_name"]);
  const removed = new Set(
    input.privacy === "aggregate"
      ? [
          ...personFields,
          "first_event_at",
          "last_event_at",
          ...(tenantLabelled ? EVIDENCE_TENANT_FIELDS : []),
        ]
      : [],
  );
  const columns = source.columns.filter((column) => !removed.has(column));
  const rows = source.rows.map((row) => {
    const result: ReportRow = {};
    for (const column of columns) result[column] = row[column] ?? null;
    if (input.privacy === "pseudonymous" && columns.includes("operator_id")) {
      const id = row.operator_id;
      const key = `${row.tenant_id}:${id}`;
      if (typeof id === "string" && !labels.has(key))
        labels.set(key, `operator-${String(labels.size + 1).padStart(3, "0")}`);
      result.operator_id = id === null ? null : (labels.get(key) ?? null);
      result.operator_name = id === null ? "unknown" : (labels.get(key) ?? null);
    }
    if (input.privacy === "pseudonymous" && tenantLabelled && columns.includes("tenant_id")) {
      const label = tenantLabels.get(String(row.tenant_id)) ?? null;
      result.tenant_id = label;
      if (columns.includes("tenant_name")) result.tenant_name = label;
    }
    return result;
  });
  const definitions = Object.fromEntries(
    Object.entries(source.definitions).filter(([key]) => !removed.has(key)),
  );
  // A source should aggregate in SQL. Also collapse person rows defensively for callers of the renderer.
  if (input.privacy === "aggregate") {
    const grouped = new Map<string, ReportRow>();
    for (const row of rows) {
      const key = JSON.stringify(
        columns
          .filter((column) => typeof row[column] !== "number")
          .map((column) => [column, row[column]]),
      );
      const previous = grouped.get(key);
      if (!previous) grouped.set(key, { ...row });
      else
        for (const column of columns)
          if (typeof row[column] === "number" && typeof previous[column] === "number")
            previous[column] += row[column];
    }
    return { ...source, columns, rows: [...grouped.values()], definitions };
  }
  return { ...source, columns, rows, definitions };
}
