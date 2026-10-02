import {
  FDA_SORTABLE_REGISTRY_V1,
  traceExportRegistryHash,
  type TraceExportField,
} from "./registry-v1.js";
import { buildUsExportRows, type CanonicalExportRow, type ExportRowsInput } from "./rows.js";

export type ExportWorkbookMode = "export_ready_candidate" | "available_records_incomplete";
/** Structural view of the upstream contract; domain does not depend on platform-contracts. */
export interface ExportFinding {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly sourceRecord: string;
  readonly eventId?: string | undefined;
  readonly revision?: number | undefined;
  readonly lineNo?: number | undefined;
  readonly fieldKey?: string | undefined;
  readonly message: string;
}
export interface ExportWorkbookInput extends ExportRowsInput {
  readonly schemaVersion: number;
  readonly mode: ExportWorkbookMode;
  readonly tenantId: string;
  readonly findings: readonly ExportFinding[];
  readonly metadata: {
    readonly mode: ExportWorkbookMode;
    readonly profile: string;
    readonly scopeLabel: string;
    readonly timeZone: string;
    readonly generatedAt: string;
    readonly baselineId: string;
    readonly registryId: string;
    readonly registryVersion: number;
    readonly registryHash: string;
    readonly build: {
      readonly apiVersion: string;
      readonly gitSha: string;
      readonly dirty: boolean;
    };
  };
}

/** Execution failure, never a successful incomplete artifact. Strict schema parsing is upstream. */
export class ExportWorkbookInputError extends Error {
  constructor(
    readonly code:
      | "UNSUPPORTED_PROFILE"
      | "UNSUPPORTED_REGISTRY"
      | "INVALID_EXPORT_INPUT"
      | "INVALID_SOURCE_RECORD",
    readonly sourceRecord: string,
  ) {
    super(`${code}: ${sourceRecord}`);
    this.name = "ExportWorkbookInputError";
  }
}

export function rowFinding(
  row: CanonicalExportRow,
  fieldKey: string,
  code: string,
  severity: ExportFinding["severity"],
  message: string,
): ExportFinding {
  return {
    code,
    severity,
    sourceRecord: row.sourceRecord,
    eventId: row.eventId,
    revision: row.revision,
    lineNo: row.lineNo,
    fieldKey,
    message,
  };
}

function missing(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function isRequired(
  field: TraceExportField,
  row: CanonicalExportRow,
  nonFtlInput: boolean,
): boolean {
  // 21 CFR 1.1350 / FDA CTE-KDE guide p10: ingredient KDEs differ from new-food KDEs.
  if (row.sheet === "transformation" && row.lineRole === "input") {
    if (
      field.snapshotPath.startsWith("tlcSource.") ||
      field.snapshotPath.startsWith("transformationLocation.") ||
      field.snapshotPath.startsWith("documents[].") ||
      field.snapshotPath === "event.eventDate"
    )
      return false;
    if (
      nonFtlInput &&
      (field.snapshotPath.startsWith("product.") ||
        field.snapshotPath === "line.tlc" ||
        field.snapshotPath === "line.lotId" ||
        field.snapshotPath === "line.quantity" ||
        field.snapshotPath === "line.unitOfMeasure")
    )
      return false;
  }
  if (field.required === "yes") return true;
  if (field.required === "no") return false;
  if (field.snapshotPath.startsWith("tlcSource.location."))
    return missing(row.values.tlc_source_reference_value);
  if (field.snapshotPath === "tlcSource.referenceKind")
    return !missing(row.values.tlc_source_reference_value);
  if (field.snapshotPath === "tlcSource.referenceValue")
    return !missing(row.values.tlc_source_reference_kind);
  if (field.snapshotPath === "line.tlc" || field.snapshotPath === "line.lotId") return !nonFtlInput;
  if (field.snapshotPath === "line.nonFtlReference") return nonFtlInput;
  return field.snapshotPath === "event.snapshotVersion" && row.values.event_lifecycle !== "draft";
}

function hasMissingValue(field: TraceExportField, row: CanonicalExportRow): boolean {
  const value = row.values[field.key];
  if (missing(value)) return true;
  // A saved draft can have document IDs but no captured type/number; [null] is not a KDE.
  if (field.snapshotPath.startsWith("documents[].") && typeof value === "string") {
    const documents: unknown = JSON.parse(value);
    return (
      !Array.isArray(documents) ||
      documents.length === 0 ||
      documents.some((entry: unknown) => typeof entry !== "string" || missing(entry))
    );
  }
  return false;
}

/** Defensive checks supplement, and do not replace, usExportInputV1Schema.parse at the boundary. */
export function validateUsExportSource(input: ExportWorkbookInput): {
  rows: readonly CanonicalExportRow[];
  findings: ExportFinding[];
} {
  if (input.metadata.profile !== "US_FSMA204_PROCESSOR")
    throw new ExportWorkbookInputError("UNSUPPORTED_PROFILE", "metadata");
  if (
    input.metadata.registryId !== FDA_SORTABLE_REGISTRY_V1.id ||
    input.metadata.registryVersion !== FDA_SORTABLE_REGISTRY_V1.version ||
    input.metadata.registryHash !== traceExportRegistryHash()
  )
    throw new ExportWorkbookInputError("UNSUPPORTED_REGISTRY", "metadata");
  if (input.schemaVersion !== 1 || input.mode !== input.metadata.mode || input.events.length === 0)
    throw new ExportWorkbookInputError("INVALID_EXPORT_INPUT", "input");

  const findings = [...input.findings];
  const seen = new Set<string>();
  const nonFtlInputs = new Set<string>();
  const projected: CanonicalExportRow[] = [];
  for (const event of input.events) {
    const sourceRecord = `${event.type}:${event.eventId}:${event.revision}`;
    const pin = `${event.eventId}:${event.revision}`;
    try {
      if (
        seen.has(pin) ||
        !Number.isSafeInteger(event.revision) ||
        event.revision < 1 ||
        !["receiving", "transformation", "shipping"].includes(event.type) ||
        !["current_finalized", "historical_finalized", "draft", "void"].includes(event.lifecycle) ||
        !event.timeZone ||
        (event.payload.kind !== "frozen" && event.payload.kind !== "saved_draft") ||
        (event.lifecycle.includes("finalized") && event.payload.kind !== "frozen") ||
        (event.lifecycle === "draft" && event.payload.kind !== "saved_draft") ||
        (input.mode === "export_ready_candidate" && event.lifecycle !== "current_finalized") ||
        (event.payload.kind === "frozen" &&
          !(event.type === "receiving" ? [1, 2, 3] : [1]).includes(
            event.payload.snapshot.snapshotVersion,
          ))
      )
        throw new ExportWorkbookInputError("INVALID_SOURCE_RECORD", sourceRecord);
      seen.add(pin);
      const rows = buildUsExportRows({ events: [event] });
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.lineNo) ||
          row.lineNo < 1 ||
          Object.values(row.values).some((value) => value !== null && typeof value !== "string")
        )
          throw new ExportWorkbookInputError("INVALID_SOURCE_RECORD", row.sourceRecord);
        if (event.type === "transformation" && row.lineRole === "input") {
          const capturedLine =
            event.payload.kind === "frozen"
              ? event.payload.snapshot.inputs.find((line) => line.lineNo === row.lineNo)
              : event.payload.draft.inputs[row.lineNo - 1];
          // Only the explicit captured discriminator exempts a line. A missing lot in an FTL draft does not.
          if (capturedLine && "kind" in capturedLine && capturedLine.kind === "non_ftl")
            nonFtlInputs.add(row.sourceRecord);
        }
      }
      projected.push(...rows);
      if (rows.length === 0)
        findings.push({
          code: "SOURCE_RECORD_HAS_NO_LINES",
          severity: "error",
          sourceRecord,
          eventId: event.eventId,
          revision: event.revision,
          message: "The captured source record contains no item lines.",
        });
      if (event.lifecycle !== "current_finalized")
        findings.push({
          code: "SOURCE_RECORD_NOT_CURRENT_FINALIZED",
          severity: "error",
          sourceRecord,
          eventId: event.eventId,
          revision: event.revision,
          message: `The captured source lifecycle is ${event.lifecycle}.`,
        });
    } catch (error) {
      if (error instanceof ExportWorkbookInputError) throw error;
      throw new ExportWorkbookInputError("INVALID_SOURCE_RECORD", sourceRecord);
    }
  }
  for (const row of projected) {
    const registry = FDA_SORTABLE_REGISTRY_V1.sheets.find((entry) => entry.key === row.sheet);
    for (const field of registry?.fields ?? [])
      if (isRequired(field, row, nonFtlInputs.has(row.sourceRecord)) && hasMissingValue(field, row))
        findings.push(
          rowFinding(
            row,
            field.key,
            "REQUIRED_KDE_MISSING",
            "error",
            `Required captured value is missing: ${field.header}.`,
          ),
        );
  }
  return { rows: projected, findings };
}
