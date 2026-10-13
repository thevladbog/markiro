import type { TFunction } from "i18next";

import type { OfficeProduct, PalletSheets, TemplateDefaults } from "../host/protocol.js";
import { byNameThenId } from "./records.js";
import { readSheetSpec } from "./sheets/sheet-list.js";

export interface SheetChoice {
  value: string;
  label: string;
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru");
}

/**
 * The choices of an A4 sheet chosen by default (an organization's, a
 * category's or a product's): `noneLabel` (`""`), then every enabled sheet
 * this build can read, by name (a name two sheets share carries the start of
 * the sheet's id). Each id in `kept` that is not among them stays a choice of
 * its own, marked: switched off, unreadable, or missing from the list (by the
 * start of its id while the list is not loaded), so a select never shows
 * another sheet for a value it holds. `lists` is `undefined` while the sheets
 * are not loaded.
 */
export function sheetChoices(
  lists: PalletSheets | undefined,
  kept: readonly string[],
  noneLabel: string,
  t: TFunction,
): SheetChoice[] {
  const sheets = lists?.sheets ?? [];
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const sheet of sheets) {
    const key = nameKey(sheet.name);
    if (seen.has(key)) shared.add(key);
    seen.add(key);
  }
  const named = (sheet: { id: string; name: string }) =>
    shared.has(nameKey(sheet.name))
      ? t("office.sheetChoice.shared", { name: sheet.name.trim(), id: sheet.id.slice(0, 8) })
      : sheet.name.trim();
  const usable = sheets
    .filter((sheet) => sheet.enabled && readSheetSpec(sheet.spec) !== null)
    .sort(byNameThenId);
  const choices: SheetChoice[] = [
    { value: "", label: noneLabel },
    ...usable.map((sheet) => ({ value: sheet.id, label: named(sheet) })),
  ];
  for (const id of kept) {
    if (id === "" || choices.some((choice) => choice.value === id)) continue;
    const sheet = sheets.find((each) => each.id === id);
    const short = id.slice(0, 8);
    choices.push({
      value: id,
      label:
        sheet !== undefined
          ? t(sheet.enabled ? "office.sheetChoice.unreadable" : "office.sheetChoice.off", {
              name: named(sheet),
            })
          : lists === undefined
            ? t("office.sheetChoice.id", { id: short })
            : t("office.sheetChoice.missing", { id: short }),
    });
  }
  return choices;
}

/**
 * The sheet a shift of `product` with pallets gets when it names none, as
 * the host resolves it (`pallet_sheets::PRODUCT_SHEET_SQL`): the product's
 * preferred sheet while it is enabled, else its category's default sheet,
 * else the organization's, each only while enabled; `null` for none or while
 * a list it needs is not loaded.
 */
export function defaultSheetFor(
  product: Pick<OfficeProduct, "defaultPalletSheetId" | "chzProductGroupCode"> | undefined,
  defaults: Pick<TemplateDefaults, "palletSheetCategories"> | undefined,
  lists: PalletSheets | undefined,
): string | null {
  if (lists === undefined) return null;
  const enabled = (id: string | null | undefined): id is string =>
    id !== null &&
    id !== undefined &&
    lists.sheets.some((sheet) => sheet.id === id && sheet.enabled);
  const own = product?.defaultPalletSheetId;
  if (enabled(own)) return own;
  const code = product?.chzProductGroupCode ?? null;
  const category =
    code === null
      ? undefined
      : defaults?.palletSheetCategories.find((entry) => entry.chzProductGroupCode === code)
          ?.sheetId;
  if (enabled(category)) return category;
  // The organization's default: the sheets' own list names it (the same column
  // as the document's), so it holds even when the document did not load.
  return enabled(lists.defaultId) ? lists.defaultId : null;
}
