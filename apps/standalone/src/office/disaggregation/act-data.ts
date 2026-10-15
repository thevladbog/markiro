import type { DisaggregationReportData } from "@markiro/domain";

import type { DisaggregationReportRows } from "../../host/disaggregation.js";
import { machineSscc } from "../forms/form-data.js";

/**
 * «Акт дезагрегации»'s input from the host's rows, as the cloud's
 * `DisaggregationService.reportData` builds it: SSCCs with `00`, a line's
 * number by its place, the box's codes and the pallet's boxes as read
 * (empty for «только короба»), no logo (pilot question П15, as every
 * office form unless `logo`, the organization's print logo as a data URL
 * (custom branding), is given). `test/disaggregation-act.test.ts` holds it to the cloud's
 * bytes.
 */
export function actData(
  rows: DisaggregationReportRows,
  logo: string | null = null,
): DisaggregationReportData {
  return {
    docNo: rows.docNo,
    status: rows.status,
    createdAt: new Date(rows.createdAt),
    appliedAt: rows.appliedAt === null ? null : new Date(rows.appliedAt),
    org: { name: rows.organization.name, inn: rows.organization.inn, logo },
    createdByName: rows.createdByName,
    appliedByName: rows.appliedByName,
    reasonName: rows.reasonName,
    comment: rows.comment,
    includeContents: rows.variant === "full",
    lines: rows.lines.map((line, index) => ({
      n: index + 1,
      sscc: `00${line.sscc}`,
      productName: line.productName,
      codeCount: line.codeCount,
      codes: line.items.map((item) => ({
        gtin14: item.gtin14,
        serial: item.serial,
        rawKm: item.canonical,
      })),
      boxes: line.boxes.map((box) => ({ sscc: machineSscc(box.sscc), codeCount: box.units })),
    })),
  };
}
