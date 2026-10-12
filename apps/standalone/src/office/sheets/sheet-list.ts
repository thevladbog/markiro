import { z } from "zod";

import {
  buildPalletSheetPresets,
  isPalletSheetSpec,
  parsePalletSheetSpec,
  parseStoredLabelJson,
  serializeStoredLabelJson,
  type PalletSheetPreset,
  type PalletSheetSpecV2,
} from "@markiro/domain";

import { HostError } from "../../host/client.js";
import type { PalletSheet } from "../../host/protocol.js";

/**
 * The largest sheet file the office reads (the domain's own bound for a
 * template JSON): the file is untrusted, so a larger one is refused unread.
 */
export const MAX_SHEET_FILE_BYTES = 256 * 1024;

/** A sheet's layout as the domain reads it, or `null` for one this build cannot read. */
export function readSheetSpec(spec: unknown): PalletSheetSpecV2 | null {
  try {
    return parsePalletSheetSpec(spec);
  } catch {
    return null;
  }
}

/** The words of a sheet's page: portrait, landscape, or two A5 copies on landscape A4. */
export function sheetLayoutKey(spec: unknown): "portrait" | "landscape" | "twoA5" | null {
  const read = readSheetSpec(spec);
  if (read === null) return null;
  if (read.page.copies === 2) return "twoA5";
  return read.page.orientation;
}

/** The stock sheets (`buildPalletSheetPresets`) whose key no sheet carries yet. */
export function missingPresets(sheets: readonly PalletSheet[]): PalletSheetPreset[] {
  const keys = new Set(sheets.map((sheet) => sheet.presetKey));
  return buildPalletSheetPresets().filter((preset) => !keys.has(preset.key));
}

/**
 * A sheet as a portable JSON file (#702's export): `{ name, purpose, spec }`,
 * no id, revision or organization — the domain's own serializer.
 */
export function sheetExport(sheet: PalletSheet): string {
  const spec = readSheetSpec(sheet.spec);
  if (spec === null) throw new Error("the sheet's layout is not readable");
  return serializeStoredLabelJson({ name: sheet.name, purpose: "pallet", spec });
}

/**
 * A sheet from a JSON file: the domain's strict reading (`parseStoredLabelJson`
 * never strips an unknown field of a V2 sheet); a label template, a bare
 * layout, an unknown version or a broken file throws. The name is kept trimmed.
 */
export function sheetImport(text: string): { name: string; spec: PalletSheetSpecV2 } {
  const parsed = parseStoredLabelJson(text);
  if (!isPalletSheetSpec(parsed.spec)) throw new Error("not an A4 sheet");
  return { name: parsed.name.trim(), spec: parsed.spec };
}

/** The `ru.json` key of why a write of a sheet failed. */
export function sheetFailureKey(error: unknown): string {
  if (error instanceof HostError) {
    if (error.code === "conflict") {
      const constraint = error.details["constraint"];
      if (constraint === "template_is_default") return "office.palletSheets.errors.isDefault";
      if (constraint === "template_in_use") return "office.palletSheets.errors.inUse";
    }
    if (error.code === "stale_revision") return "office.palletSheets.errors.stale";
    if (error.code === "validation_failed") return "office.palletSheets.errors.invalid";
    if (error.code === "not_found") return "office.palletSheets.errors.missing";
  }
  return "office.palletSheets.errors.failed";
}

const SHIFT_IDS = z.array(z.string().min(1));

/**
 * The planned shifts that name the sheet, from a refused delete
 * (`conflict` with `constraint: template_in_use` and `shiftIds`); `null` when
 * the refusal is any other. A refusal that lists nothing readable is still an
 * «in use» refusal, with an empty list.
 */
export function inUseShiftIds(error: unknown): string[] | null {
  if (
    !(error instanceof HostError) ||
    error.code !== "conflict" ||
    error.details["constraint"] !== "template_in_use"
  ) {
    return null;
  }
  const ids = SHIFT_IDS.safeParse(error.details["shiftIds"]);
  return ids.success ? ids.data : [];
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru");
}

/**
 * The names that more than one sheet carries (the host does not keep names
 * unique, and a shift's choice lists sheets by name), as the first sheet
 * spells them, in the list's order.
 */
export function duplicateSheetNames(sheets: readonly PalletSheet[]): string[] {
  const seen = new Map<string, { name: string; count: number }>();
  for (const sheet of sheets) {
    const key = nameKey(sheet.name);
    const entry = seen.get(key);
    if (entry === undefined) seen.set(key, { name: sheet.name.trim(), count: 1 });
    else entry.count += 1;
  }
  return [...seen.values()].filter((entry) => entry.count > 1).map((entry) => entry.name);
}

/** Whether another sheet than `exceptId` already carries `name`. */
export function sheetNameTaken(
  sheets: readonly PalletSheet[],
  name: string,
  exceptId: string | null,
): boolean {
  const key = nameKey(name);
  return sheets.some((sheet) => sheet.id !== exceptId && nameKey(sheet.name) === key);
}

// eslint-disable-next-line no-control-regex -- control characters are what a file name must not keep
const UNSAFE_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** The name a downloaded sheet is saved under: its own, without what a file name cannot hold. */
export function sheetFileName(name: string): string {
  const safe = name.trim().replace(UNSAFE_FILE_NAME, "_");
  return `${safe === "" ? "лист" : safe}.json`;
}
