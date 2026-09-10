import type { PlatformReportInput } from "@markiro/platform-contracts";
import { zipSync } from "fflate";
import {
  applyReportPrivacy,
  PlatformReportSourceError,
  REPORT_MAX_BYTES,
  REPORT_MAX_ROWS,
  type PlatformReportSource,
} from "./report-definitions";

function csvCell(value: string | number | null, column: string): string {
  let text = value === null ? "" : String(value);
  let formulaCandidate = text.trimStart();
  while (formulaCandidate.length > 0 && formulaCandidate.charCodeAt(0) < 32) {
    formulaCandidate = formulaCandidate.slice(1).trimStart();
  }
  if (
    typeof value === "string" &&
    (/^[=+@-]/u.test(formulaCandidate) || /(?:gtin|sscc)/i.test(column))
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function renderPlatformReport(
  input: PlatformReportInput,
  rawSource: PlatformReportSource,
): { body: Buffer; filename: string; rowCount: number } {
  if (rawSource.rows.length > REPORT_MAX_ROWS)
    throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
  const source = applyReportPrivacy(input, rawSource);
  const { operatorId, ...parameters } = input;
  const metadata = Buffer.from(
    JSON.stringify(
      {
        formatVersion: 1,
        snapshotAt: source.snapshotAt.toISOString(),
        parameters: input.privacy === "identified" ? input : parameters,
        operatorFilterApplied: operatorId !== undefined,
        rowCount: source.rows.length,
        columns: source.columns,
        definitions: source.definitions,
        csv: {
          encoding: "UTF-8 BOM",
          lineEnding: "CRLF",
          delimiter: ",",
          nullValue: "empty cell",
          identifierTextPrefix: "apostrophe",
          formulaProtection: "leading apostrophe",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  let size = metadata.byteLength + 3;
  const chunks: string[] = ["\ufeff"];
  const append = (line: string) => {
    size += Buffer.byteLength(line);
    if (size > REPORT_MAX_BYTES) throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
    chunks.push(line);
  };
  append(`${source.columns.map((column) => csvCell(column, "")).join(",")}\r\n`);
  for (const row of source.rows)
    append(`${source.columns.map((column) => csvCell(row[column] ?? null, column)).join(",")}\r\n`);
  const body = Buffer.from(
    zipSync(
      { "data.csv": Buffer.from(chunks.join(""), "utf8"), "metadata.json": metadata },
      { level: 6 },
    ),
  );
  return {
    body,
    filename: `${input.reportType}-${input.fromDate}-${input.toDate}.zip`,
    rowCount: source.rows.length,
  };
}
