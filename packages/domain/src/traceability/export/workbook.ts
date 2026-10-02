import { isTraceabilityCivilDate } from "../civil-date.js";
import { FDA_SORTABLE_REGISTRY_V1, type TraceExportField } from "./registry-v1.js";
import { compareExportRowIdentity, type CanonicalExportRow } from "./rows.js";
import {
  rowFinding,
  validateUsExportSource,
  type ExportFinding,
  type ExportWorkbookInput,
  type ExportWorkbookMode,
} from "./validation.js";

export type { ExportFinding, ExportWorkbookInput, ExportWorkbookMode } from "./validation.js";

/** The writer must preserve these kinds. A date is a civil day, never an instant. */
export type WorkbookCell =
  | { readonly kind: "blank"; readonly value: null }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "number"; readonly value: number; readonly sourceValue: string };
export interface WorkbookColumn {
  readonly key: string;
  readonly header: string;
}
export interface WorkbookRow {
  readonly sourceRecord: string;
  readonly cells: readonly WorkbookCell[];
}
export interface WorkbookSheet {
  readonly name: string;
  readonly columns: readonly WorkbookColumn[];
  readonly rows: readonly WorkbookRow[];
  readonly freezeHeader: true;
  readonly autoFilter: boolean;
}
export interface WorkbookModel {
  readonly mode: ExportWorkbookMode;
  readonly sheets: readonly WorkbookSheet[];
}
export interface ExportArtifactFailure {
  readonly code: "CELL_LIMIT_EXCEEDED" | "CELL_VALUE_UNREPRESENTABLE";
  readonly sourceRecord: string;
  readonly fieldKey: string;
}
export interface ExportWorkbookResult {
  readonly model: WorkbookModel | null;
  readonly findings: readonly ExportFinding[];
  readonly failure: ExportArtifactFailure | null;
}

const textCell = (value: string): WorkbookCell => ({ kind: "text", value });
function scalar(value: string | number | null): WorkbookCell {
  return value === null
    ? { kind: "blank", value: null }
    : typeof value === "number"
      ? { kind: "number", value, sourceValue: String(value) }
      : textCell(value);
}
function sheet(
  name: string,
  columns: readonly WorkbookColumn[],
  rows: readonly WorkbookRow[],
): WorkbookSheet {
  return { name, columns, rows, freezeHeader: true, autoFilter: name !== "Metadata" };
}
function columns(entries: readonly (readonly [string, string])[]): WorkbookColumn[] {
  return entries.map(([key, header]) => ({ key, header }));
}

function numericCell(
  value: string,
  row: CanonicalExportRow,
  field: TraceExportField,
  findings: ExportFinding[],
): WorkbookCell {
  const numeric = Number(value);
  const digits = value.replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  // Excel stores at most 15 significant decimal digits. Preserve the original lexeme as well.
  if (
    !/^[+-]?\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(numeric) ||
    Math.abs(numeric) > Number.MAX_SAFE_INTEGER ||
    // Excel does not retain subnormal doubles; Number() can also round them before writing.
    (numeric !== 0 && Math.abs(numeric) < 2 ** -1022) ||
    digits.length > 15 ||
    (numeric === 0 && /[1-9]/.test(value))
  ) {
    findings.push(
      rowFinding(
        row,
        field.key,
        "NUMERIC_PRECISION_PRESERVED_AS_TEXT",
        "info",
        "The exact numeric source value is retained as text to avoid precision loss.",
      ),
    );
    return textCell(value);
  }
  if (String(numeric) !== value) {
    findings.push(
      rowFinding(
        row,
        field.key,
        "NUMERIC_LEXEME_PRESERVED_AS_TEXT",
        "info",
        "The exact numeric source spelling is retained as text to avoid normalization.",
      ),
    );
    return textCell(value);
  }
  return { kind: "number", value: numeric, sourceValue: value };
}
function dataCell(
  value: string | null,
  row: CanonicalExportRow,
  field: TraceExportField,
  findings: ExportFinding[],
): WorkbookCell {
  if (value === null || value.trim() === "") return value === null ? scalar(null) : textCell(value);
  if (field.type === "date") return { kind: "date", value };
  if (field.type === "decimal" || field.type === "integer")
    return numericCell(value, row, field, findings);
  return textCell(value);
}

function metadataSheet(input: ExportWorkbookInput, mode: ExportWorkbookMode): WorkbookSheet {
  const { metadata: meta } = input;
  const entries: readonly (readonly [string, string | number])[] = [
    ["mode", mode],
    ["requested_mode", input.mode],
    ["scope_label", meta.scopeLabel],
    ["tenant_id", input.tenantId],
    ["profile", meta.profile],
    ["time_zone", meta.timeZone],
    ["generated_at", meta.generatedAt],
    ["baseline_id", meta.baselineId],
    ["input_schema_version", input.schemaVersion],
    ["registry_id", meta.registryId],
    ["registry_version", meta.registryVersion],
    ["registry_hash", meta.registryHash],
    ["api_version", meta.build.apiVersion],
    ["git_sha", meta.build.gitSha],
    ["dirty", String(meta.build.dirty)],
    [
      "assessment",
      mode === "available_records_incomplete"
        ? "Available records — incomplete"
        : "Export-ready candidate — request gates not assessed",
    ],
  ];
  return sheet(
    "Metadata",
    columns([
      ["field", "Field"],
      ["value", "Value"],
    ]),
    entries.map(([key, value]) => ({
      sourceRecord: "metadata",
      cells: [textCell(key), scalar(value)],
    })),
  );
}

function definitionsSheet(
  selected: readonly (typeof FDA_SORTABLE_REGISTRY_V1.sheets)[number][],
): WorkbookSheet {
  return sheet(
    "Definitions",
    columns([
      ["sheet", "CTE / tab"],
      ["field_key", "Field key"],
      ["header", "English header"],
      ["kde_group", "KDE group"],
      ["required", "Required"],
      ["type", "Cell type"],
      ["snapshot_path", "Captured source path"],
      ["source_section", "Source section"],
      ["source_url", "Source URL"],
      ["version", "Mapping version"],
    ]),
    selected.flatMap((entry) =>
      entry.fields.map((field) => ({
        sourceRecord: `definition:${entry.key}:${field.key}`,
        cells: [
          entry.name,
          field.key,
          field.header,
          field.kdeGroup,
          field.required,
          field.type,
          field.snapshotPath,
          field.sourceSection,
          field.sourceUrl,
          field.version,
        ].map(scalar),
      })),
    ),
  );
}

function validationSheet(
  findings: readonly ExportFinding[],
  rows: readonly CanonicalExportRow[],
  input: ExportWorkbookInput,
): WorkbookSheet {
  return sheet(
    "Validation",
    columns([
      ["severity", "Severity"],
      ["code", "Code"],
      ["sheet", "CTE / tab"],
      ["field_key", "Field key"],
      ["event_id", "Event ID"],
      ["revision", "Event revision"],
      ["line_no", "Line number"],
      ["lot_id", "Lot ID"],
      ["source_record", "Source record"],
      ["message", "Message"],
    ]),
    findings.map((finding) => {
      const row = rows.find((entry) => entry.sourceRecord === finding.sourceRecord);
      const event = input.events.find(
        (entry) => entry.eventId === finding.eventId && entry.revision === finding.revision,
      );
      const tab = FDA_SORTABLE_REGISTRY_V1.sheets.find(
        (entry) => entry.key === (row?.sheet ?? event?.type),
      );
      return {
        sourceRecord: finding.sourceRecord,
        cells: [
          finding.severity,
          finding.code,
          tab?.name ?? null,
          finding.fieldKey ?? null,
          finding.eventId ?? null,
          finding.revision ?? null,
          finding.lineNo ?? null,
          row?.lotId ?? null,
          finding.sourceRecord,
          finding.message,
        ].map(scalar),
      };
    }),
  );
}

function hasUnrepresentableCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      ((code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff)
    )
      return true;
  }
  return false;
}

function artifactFailure(sheets: readonly WorkbookSheet[]): ExportArtifactFailure | null {
  for (const tab of sheets)
    for (const row of tab.rows)
      for (const [index, cell] of row.cells.entries()) {
        const fieldKey =
          tab.name === "Metadata"
            ? String(row.cells[0]?.value)
            : (tab.columns[index]?.key ?? "unknown");
        const sourceValue = cell.kind === "number" ? cell.sourceValue : cell.value;
        if (typeof sourceValue === "string" && sourceValue.length > 32767)
          return { code: "CELL_LIMIT_EXCEEDED", sourceRecord: row.sourceRecord, fieldKey };
        if (typeof cell.value === "string" && hasUnrepresentableCharacter(cell.value))
          return { code: "CELL_VALUE_UNREPRESENTABLE", sourceRecord: row.sourceRecord, fieldKey };
        if (
          cell.kind === "date" &&
          (!isTraceabilityCivilDate(cell.value) || cell.value < "1900-01-01")
        )
          return { code: "CELL_VALUE_UNREPRESENTABLE", sourceRecord: row.sourceRecord, fieldKey };
      }
  return null;
}

/** Pure semantic model. No XLSX library, clock, catalog read, request readiness or manifest. */
export function buildUsExportWorkbook(input: ExportWorkbookInput): ExportWorkbookResult {
  const validated = validateUsExportSource(input);
  const rows = [...validated.rows].sort(compareExportRowIdentity);
  const findings = validated.findings;
  const selected = FDA_SORTABLE_REGISTRY_V1.sheets.filter((entry) =>
    input.events.some((event) => event.type === entry.key),
  );
  const data = selected.map((entry) =>
    sheet(
      entry.name,
      entry.fields.map(({ key, header }) => ({ key, header })),
      rows
        .filter((row) => row.sheet === entry.key)
        .map((row) => ({
          sourceRecord: row.sourceRecord,
          cells: entry.fields.map((field) =>
            dataCell(row.values[field.key] ?? null, row, field, findings),
          ),
        })),
    ),
  );
  const findingKey = (finding: ExportFinding): string =>
    JSON.stringify([
      finding.sourceRecord,
      finding.eventId,
      finding.revision,
      finding.lineNo,
      finding.fieldKey,
      finding.severity,
      finding.code,
      finding.message,
    ]);
  findings.sort((left, right) => {
    const a = findingKey(left);
    const b = findingKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const mode =
    input.mode === "available_records_incomplete" ||
    findings.some((finding) => finding.severity === "error")
      ? "available_records_incomplete"
      : "export_ready_candidate";
  const sheets = [
    metadataSheet(input, mode),
    definitionsSheet(selected),
    ...data,
    validationSheet(findings, rows, input),
  ];
  const failure = artifactFailure(sheets);
  return { model: failure ? null : { mode, sheets }, findings, failure };
}
