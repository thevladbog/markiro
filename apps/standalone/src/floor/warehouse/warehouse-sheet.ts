import { parsePalletSheetSpec, type PalletSheetSpecV2 } from "@markiro/domain";
import { z } from "zod";

import type { PalletSheet, PalletSheets } from "../../host/protocol.js";
import { loadBundledMarkiroLogo, sheetLogoOf } from "../../labels/logo.js";
import { rasterizeSheetText } from "../../labels/rasterizer.js";
import { renderSheetBytes } from "../../labels/sheet-render.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { LabelFields } from "../print/label-render.js";
import { EGAIS_NOT_ON_SHEET_LINE, type ShiftRenderDeps } from "../print/shift-render.js";
import { readKnownOrganizationLogo } from "./warehouse-logo.js";

/**
 * A pallet's A4 sheet in a warehouse reprint (beta 3.2, owner feedback «Перепечатка:
 * выбран принтер с А4, а выбор шаблонов дал только этикетки»). The sheet is a host
 * document, not a label template: a session of reprints holds its choice in the
 * pallet's template place with a prefix, `sheet:auto` (the sheet the product of each
 * pallet gets: its own, its category's, the organization's) or `sheet:<id>`; the printer
 * assigned to pallets decides whether the place means a sheet or a label template.
 */
export const SHEET_AUTO = "sheet:auto";
const SHEET_PREFIX = "sheet:";

/** A session's pallet choice as a sheet's: «по умолчанию товара» or one sheet. */
export type SheetChoice = { kind: "auto" } | { kind: "sheet"; id: string };

/** The stored choice of a sheet, or `null` for anything else (a label template's id, or none). */
export function parseSheetChoice(value: string | null): SheetChoice | null {
  if (value === null || !value.startsWith(SHEET_PREFIX)) return null;
  const id = value.slice(SHEET_PREFIX.length);
  return id === "auto" ? { kind: "auto" } : id === "" ? null : { kind: "sheet", id };
}

/** The stored form of the choice of sheet `id`. */
export function sheetChoiceOf(id: string): string {
  return `${SHEET_PREFIX}${id}`;
}

/** The sheet a choice names among the sheets the host listed, `null` when it is gone or off. */
export function chosenSheet(sheets: PalletSheets, choice: SheetChoice): PalletSheet | null {
  const id = choice.kind === "auto" ? sheets.defaultId : choice.id;
  if (id === null) return null;
  return sheets.sheets.find((sheet) => sheet.id === id && sheet.enabled) ?? null;
}

/**
 * What a stored pallet choice names, for the session's lines: `null` for none (or a label
 * template's id), `auto`, or a sheet with its name when the host's list is known.
 */
export function sheetChoiceName(
  value: string | null,
  sheets: PalletSheets | null,
): { kind: "auto" } | { kind: "sheet"; name: string | null } | null {
  const choice = parseSheetChoice(value);
  if (choice === null) return null;
  if (choice.kind === "auto") return { kind: "auto" };
  const found = sheets?.sheets.find((sheet) => sheet.id === choice.id) ?? null;
  return { kind: "sheet", name: found === null ? null : found.name };
}

/** The layout of a sheet, or `null` when this build cannot read it. */
export function sheetSpecOf(sheet: PalletSheet): PalletSheetSpecV2 | null {
  try {
    return parsePalletSheetSpec(sheet.spec);
  } catch {
    return null;
  }
}

const organizationRow = z.object({ name: z.string(), inn: z.string().nullable() });
const LABEL_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** `DD.MM.YYYY` of a label field as `YYYY-MM-DD`, or `null`. */
function isoOfLabelDate(text: string): string | null {
  const parts = LABEL_DATE.exec(text);
  return parts === null ? null : `${parts[3]}-${parts[2]}-${parts[1]}`;
}

/** The days a shelf life counts from the printed dates: the expiry is the last day, the production day the first. */
function shelfLifeOf(production: string | null, expiryText: string): number | null {
  const expiry = isoOfLabelDate(expiryText);
  if (production === null || expiry === null) return null;
  const days =
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${production}T00:00:00Z`)) / 86_400_000;
  return Number.isInteger(days) && days >= 0 ? days + 1 : null;
}

/** A count of a pallet label's fields; anything but digits is a label that does not belong. */
function count(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw new Error("a pallet label's count is not a number");
  return Number(text);
}

/**
 * A pallet's sheet for a warehouse reprint, from the label fields the job froze
 * (`palletLabelFields`: the SSCC, the product, the dates, the counts, the shift's number) and
 * the organization as this station knows it now (`ref_org`, its logo from the newest shift
 * snapshot that froze one, else the bundled Markiro logo). The production date and the shelf
 * life come back from the printed dates, so a retry draws the same sheet the first attempt did.
 */
export async function renderWarehouseSheet(
  local: LocalExecutor,
  pairing: Pairing,
  spec: PalletSheetSpecV2,
  fields: LabelFields,
  deps: ShiftRenderDeps = {},
): Promise<Uint8Array> {
  const [organization] = await local.query("SELECT name, inn FROM ref_org", [], organizationRow);
  if (organization === undefined) throw new Error("the copies hold no organization");
  const ownLogo = await readKnownOrganizationLogo(local, pairing).catch(() => null);
  const bitmap = ownLogo ?? (await (deps.loadMarkiro ?? loadBundledMarkiroLogo)());
  const productionDate = isoOfLabelDate(fields.date);
  // A frozen code of another form never stops the sheet: it prints without it (the shift's rule).
  const frozen = fields["product.egais"] === "" ? null : fields["product.egais"];
  const egaisCode = frozen !== null && /^\d{19}$/u.test(frozen) ? frozen : null;
  if (frozen !== null && egaisCode === null) {
    (deps.report ?? ((line: string) => console.error(line)))(EGAIS_NOT_ON_SHEET_LINE);
  }
  return renderSheetBytes(
    spec,
    {
      sscc: fields.sscc,
      productPrintName: fields["product.printName"],
      gtin14: fields["product.gtin"],
      egaisCode,
      productionDate,
      shelfLifeDays: shelfLifeOf(productionDate, fields.expiry),
      boxCount: count(fields["qty.boxes"]),
      itemCount: count(fields.qty),
      shiftNumber: fields["shift.no"] === "" ? null : fields["shift.no"],
      organizationName: organization.name,
      organizationInn: organization.inn,
      logo: sheetLogoOf(bitmap, ownLogo === null ? "markiro" : "organization"),
    },
    deps.sheetRasterize ?? rasterizeSheetText,
  );
}
