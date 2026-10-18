import type { TFunction } from "i18next";

import type { PalletSheets } from "../../host/protocol.js";
import { byNameThenId } from "../records.js";
import { readSheetSpec } from "../sheets/sheet-list.js";

export interface SheetOption {
  value: string;
  label: string;
}

/**
 * The choices of a shift's «Лист А4» (plan А4):
 *
 * - «По умолчанию для товара (…)» (`""`), always: a new shift takes the
 *   default sheet for its product (the product's, its category's or the
 *   organization's, `defaultSheetFor`, passed as `defaultId`; without it the
 *   organization's), and a planned one that holds a sheet goes back to it
 *   (`ShiftUpdate.palletSheetTemplateId: null`; the host resolves the
 *   default when it takes the edit, so a later change of it does not reach
 *   the shift).
 * - the sheets in use that this build can read, by name; a name two sheets
 *   share carries the start of the sheet's id, so the two can be told apart.
 * - the sheet the shift already holds, and the one the form holds, even when
 *   it was switched off, cannot be read, or the list lacks it (deleted
 *   behind a shift that is already open): marked, so a select never shows
 *   another sheet for a value it cannot hold.
 *
 * `lists` is `undefined` while the sheets did not load.
 */
export function sheetOptions(
  lists: PalletSheets | undefined,
  ownId: string | null,
  chosenId: string,
  t: TFunction,
  defaultId?: string | null,
): SheetOption[] {
  const sheets = lists?.sheets ?? [];
  const mainId = defaultId === undefined ? lists?.defaultId : defaultId;
  const main = sheets.find((sheet) => sheet.id === mainId && sheet.enabled);
  const options: SheetOption[] = [];
  options.push({
    value: "",
    label: t("office.shifts.palletSheetDefault", {
      name: main?.name ?? t("office.shifts.palletSheetNoDefault"),
    }),
  });
  const sharedNames = new Set<string>();
  const seen = new Set<string>();
  for (const sheet of sheets) {
    const key = sheet.name.trim().toLocaleLowerCase("ru");
    if (seen.has(key)) sharedNames.add(key);
    seen.add(key);
  }
  const named = (sheet: { id: string; name: string }) =>
    sharedNames.has(sheet.name.trim().toLocaleLowerCase("ru"))
      ? t("office.shifts.palletSheetShared", {
          name: sheet.name.trim(),
          id: sheet.id.slice(0, 8),
        })
      : sheet.name.trim();
  const usable = sheets
    .filter((sheet) => sheet.enabled && readSheetSpec(sheet.spec) !== null)
    .sort(byNameThenId);
  for (const sheet of usable) options.push({ value: sheet.id, label: named(sheet) });
  for (const id of [ownId ?? "", chosenId]) {
    if (id === "" || options.some((option) => option.value === id)) continue;
    const sheet = sheets.find((each) => each.id === id);
    options.push({
      value: id,
      label:
        sheet === undefined
          ? t("office.shifts.palletSheetId", { id: id.slice(0, 8) })
          : t(
              sheet.enabled
                ? "office.shifts.palletSheetUnreadable"
                : "office.shifts.palletSheetOff",
              { name: named(sheet) },
            ),
    });
  }
  return options;
}
