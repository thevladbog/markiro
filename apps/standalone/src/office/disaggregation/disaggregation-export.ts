import {
  GismtDisaggregationError,
  renderGismtDisaggregationJson,
  renderGismtDisaggregationXml,
  sanitizeShiftExportFilenameSegment,
} from "@markiro/domain";

import {
  DISAGGREGATION_EXPORT_FORMATS,
  type DisaggregationExportFormat,
  type DisaggregationReportRows,
} from "../../host/disaggregation.js";
import { exportFolder } from "../exports/export-checks.js";

export type DisaggregationExportRefusal =
  | "DOCUMENT_NOT_APPLIED"
  | "SET_LINES_UNSUPPORTED"
  | "ORG_INN_MISSING"
  | "INVALID_ORG_INN"
  | "INVALID_SSCC"
  | "INVALID_SET_CODE"
  | "NO_PACKINGS";

interface DisaggregationExportFile {
  name: string;
  bytes: Uint8Array;
  /** The number of distinct packages the file names. */
  packingCount: number;
}

type DisaggregationExportResult =
  | { ok: true; file: DisaggregationExportFile }
  | { ok: false; refusal: DisaggregationExportRefusal };

/** Forms an applied document's file without dropping any line. */
export function formDisaggregationExport(
  rows: DisaggregationReportRows,
  format: DisaggregationExportFormat,
): DisaggregationExportResult {
  if (rows.status !== "applied") return { ok: false, refusal: "DOCUMENT_NOT_APPLIED" };
  const ssccs = rows.lines.flatMap(({ sscc }) => (sscc === null ? [] : [sscc]));
  if (format === "xml" && ssccs.length !== rows.lines.length) {
    return { ok: false, refusal: "SET_LINES_UNSUPPORTED" };
  }
  const inn = rows.organization.inn?.trim() ?? "";
  if (inn === "") return { ok: false, refusal: "ORG_INN_MISSING" };
  if (rows.lines.length === 0) return { ok: false, refusal: "NO_PACKINGS" };
  try {
    const rendered =
      format === "xml"
        ? renderGismtDisaggregationXml({ organizationInn: inn, ssccs })
        : renderGismtDisaggregationJson({
            organizationInn: inn,
            packings: rows.lines.map((line) =>
              line.sscc === null ? { setCode: line.setCode } : { sscc: line.sscc },
            ),
          });
    return {
      ok: true,
      file: {
        name: disaggregationExportFileName(rows.docNo, format),
        bytes: rendered.bytes,
        packingCount: rendered.packingCount,
      },
    };
  } catch (error) {
    if (!(error instanceof GismtDisaggregationError)) throw error;
    switch (error.code) {
      case "INVALID_ORGANIZATION_INN":
        return { ok: false, refusal: "INVALID_ORG_INN" };
      case "INVALID_SSCC":
        return { ok: false, refusal: "INVALID_SSCC" };
      case "INVALID_SET_CODE":
        return { ok: false, refusal: "INVALID_SET_CODE" };
      case "EMPTY_SOURCE":
        return { ok: false, refusal: "NO_PACKINGS" };
    }
    throw error;
  }
}

export function disaggregationExportFileName(
  docNo: string,
  format: DisaggregationExportFormat,
): string {
  return `disaggregation-${sanitizeShiftExportFilenameSegment(docNo)}.${format}`;
}

export function disaggregationExportFolder(
  docNo: string,
  formedAt: string,
  timeZone: string,
  format: DisaggregationExportFormat,
): string[] {
  return [
    "Выгрузки",
    "Дезагрегация",
    ...exportFolder(docNo, DISAGGREGATION_EXPORT_FORMATS[format], formedAt, timeZone).slice(1),
  ];
}
