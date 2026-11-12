import type { SetReportCode } from "@markiro/domain";

import type {
  OfficeShift,
  OfficeShiftSets,
  ScannedCode,
  ShiftExportRows,
} from "../../host/protocol.js";
import { isKnownTimeZone } from "../../lib/civil-date.js";
import { isAssembledSet, setExportRefusal } from "../exports/export-source.js";
import { groupSetContents, setIdentificationCode } from "../shifts/set-contents.js";
import type { FormRequest } from "./render-form.js";

export interface SetFormSources {
  shift: OfficeShift;
  exportRows: ShiftExportRows;
  sets: OfficeShiftSets;
}

function reportCode(scan: ScannedCode): SetReportCode {
  return { identification: setIdentificationCode(scan), rawKm: scan.canonical };
}

export function setFormRequest(sources: SetFormSources, timeZone: string): FormRequest | null {
  const { shift, exportRows, sets } = sources;
  if (setExportRefusal(shift.status, sets) !== null) return null;
  const { organization } = exportRows;
  const hostZone = organization.timeZone;
  return {
    kind: "sets",
    timeZone: hostZone !== undefined && isKnownTimeZone(hostZone) ? hostZone : timeZone,
    data: {
      shiftNumber: shift.number,
      productName: exportRows.shift.productName,
      closedAt: shift.closedAt === null ? null : new Date(shift.closedAt),
      org: { name: organization.name, inn: organization.inn, logo: null },
      sets: sets.filter(isAssembledSet).map((set) => ({
        code: reportCode(set.setCode),
        groups: groupSetContents(set.items, shift.setItems).map((group) => ({
          ...group,
          codes: group.codes.map(reportCode),
        })),
      })),
    },
  };
}
