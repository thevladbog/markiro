import {
  GismtDisaggregationError,
  renderGismtDisaggregationXml,
  sanitizeShiftExportFilenameSegment,
} from "@markiro/domain";

import {
  DISAGGREGATION_XML_FORMAT_ID,
  type DisaggregationReportRows,
} from "../../host/disaggregation.js";
import { exportFolder } from "../exports/export-checks.js";

/** Why the office does not form the file; each has its text in `office.disaggregation.xml.refusals`. */
export type DisaggregationXmlRefusal =
  "DOCUMENT_NOT_APPLIED" | "ORG_INN_MISSING" | "INVALID_ORG_INN" | "INVALID_SSCC" | "NO_PACKINGS";

export interface DisaggregationXmlFile {
  name: string;
  bytes: Uint8Array;
  /** The packages the file names: each distinct SSCC of the document once. */
  packingCount: number;
}

export type DisaggregationXmlResult =
  { ok: true; file: DisaggregationXmlFile } | { ok: false; refusal: DisaggregationXmlRefusal };

/**
 * The ЧЗ file of an applied disaggregation document (plan ДЗГ-О, owner
 * decision ПР-2): ГИС МТ «Расформирование упаковки», drawn by
 * `@markiro/domain`'s `renderGismtDisaggregationXml` — the inventory's own
 * generator — from every SSCC of the document, boxes and pallets. An empty
 * INN is refused here, as an export refuses it; the INN's form is the
 * generator's rule (9, 10 or 12 digits), not the shift XML's 10.
 */
export function formDisaggregationXml(rows: DisaggregationReportRows): DisaggregationXmlResult {
  if (rows.status !== "applied") return { ok: false, refusal: "DOCUMENT_NOT_APPLIED" };
  const inn = rows.organization.inn?.trim() ?? "";
  if (inn === "") return { ok: false, refusal: "ORG_INN_MISSING" };
  if (rows.lines.length === 0) return { ok: false, refusal: "NO_PACKINGS" };
  try {
    const rendered = renderGismtDisaggregationXml({
      organizationInn: inn,
      ssccs: rows.lines.map((line) => line.sscc),
    });
    return {
      ok: true,
      file: {
        name: disaggregationXmlFileName(rows.docNo),
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
      case "EMPTY_SOURCE":
        return { ok: false, refusal: "NO_PACKINGS" };
    }
    throw error;
  }
}

export function disaggregationXmlFileName(docNo: string): string {
  return `disaggregation-${sanitizeShiftExportFilenameSegment(docNo)}.xml`;
}

/** `Выгрузки\Дезагрегация\<номер>\<дата_время>_disaggregation_xml_gismt`, four segments. */
export function disaggregationXmlFolder(
  docNo: string,
  formedAt: string,
  timeZone: string,
): string[] {
  return [
    "Выгрузки",
    "Дезагрегация",
    ...exportFolder(docNo, DISAGGREGATION_XML_FORMAT_ID, formedAt, timeZone).slice(1),
  ];
}
