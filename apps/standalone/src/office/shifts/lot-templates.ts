import type { HostApi } from "../../host/api.js";
import type { PalletSheet } from "../../host/protocol.js";
import {
  checkSheetLotNumber,
  checkThermalLotNumber,
  type LotTemplateIssue,
} from "../../labels/lot-number-fit.js";
import type { AlertFailure } from "../form-errors.js";
import { readSheetSpec } from "../sheets/sheet-list.js";
import { readSpec } from "../templates/editor-model.js";
import type { ShiftFields } from "./shift-form.js";

interface ShiftLotCheck {
  lotNumber: string;
  values: ShiftFields;
  sheetId: string | null;
  sheets: readonly PalletSheet[] | undefined;
}

function issueFor(issue: LotTemplateIssue, name: string): AlertFailure {
  return { kind: "alert", message: `rules.lotTemplate.${issue}`, values: { name } };
}

/** Verify only the layouts this mode will print, using the exact planned lot number. */
export async function checkShiftLotTemplates(
  api: HostApi,
  token: string,
  { lotNumber, values, sheetId, sheets }: ShiftLotCheck,
): Promise<AlertFailure | null> {
  const validation = values.mode === "validation";
  const thermalIds = validation
    ? values.printDuplicate
      ? [values.duplicateTemplateId]
      : []
    : values.palletsEnabled
      ? [values.boxTemplateId, values.palletTemplateId]
      : [values.boxTemplateId];
  for (const template of await Promise.all(thermalIds.map((id) => api.getTemplate(token, id)))) {
    const spec = readSpec(template.spec);
    const issue = spec === null ? "unavailable" : await checkThermalLotNumber(spec, lotNumber);
    if (issue !== null) return issueFor(issue, template.name);
  }
  if (!validation && values.palletsEnabled) {
    if (sheets === undefined)
      return { kind: "alert", message: "office.shifts.palletSheetsUnavailable" };
    if (sheetId !== null) {
      const sheet = sheets.find((each) => each.id === sheetId);
      const spec = readSheetSpec(sheet?.spec);
      const issue = spec === null ? "unavailable" : await checkSheetLotNumber(spec, lotNumber);
      if (issue !== null) return issueFor(issue, sheet?.name ?? sheetId.slice(0, 8));
    }
  }
  return null;
}
