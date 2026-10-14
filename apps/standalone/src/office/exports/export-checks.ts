import {
  sanitizeShiftExportFilenameSegment,
  SHIFT_EXPORT_FORMATS,
  shiftExportFormatRequiresPallets,
  type ShiftExportFormatDescriptor,
} from "@markiro/domain";

import type { OfficePallet, ShiftExportRows, ShiftMode } from "../../host/protocol.js";
import {
  palletExportSnapshot,
  shiftExportSnapshot,
  type ExportSourceRefusal,
  type ShiftExportSnapshot,
  type SourceResult,
} from "./export-source.js";

/**
 * What the export dialog shows before anything is formed (plan ЧЗ): each
 * format the cloud would offer this shift with the refusal its source would
 * give now, each pallet with whether its own document can be formed, the
 * shift's counts and the warnings that change no byte of a file. A refusal
 * the domain gives only while rendering (`INVALID_CIS`, a line limit, the
 * INN's form) comes from `runExport` when the user forms the file.
 */

export interface FormatOffer {
  format: ShiftExportFormatDescriptor;
  /** `null`: the source allows it now. */
  refusal: ExportSourceRefusal | null;
}

export interface PalletOffer {
  palletId: string;
  sscc: string | null;
  closedAt: string | null;
  /** Its closed boxes not taken apart: what its document names. */
  boxes: number;
  /** `PALLET_NOT_CLOSED` or `PALLET_DISASSEMBLED`; `null`: its document can be formed. */
  refusal: ExportSourceRefusal | null;
}

export interface ExportCounts {
  /** Codes the shift owns. */
  codes: number;
  /** Of them, codes in a closed box not taken apart: what a box format can write. */
  codesInClosedBoxes: number;
  /** Closed boxes not taken apart. */
  closedBoxes: number;
  /** Closed pallets not taken apart. */
  closedPallets: number;
}

export type ExportWarning =
  /** Facts arrived after the close (the cloud's `stale`): an earlier export is out of date. */
  | { kind: "late_data"; at: string }
  /** Pallets formats: boxes written on no pallet because their pallet has not closed. */
  | { kind: "open_pallets"; boxes: number }
  /** Pallets formats: pallets taken apart that the document still names, as the cloud's does. */
  | { kind: "disassembled_pallets"; pallets: number }
  /**
   * A box the document writes on a pallet closed an instant after the pallet
   * did: it joined silently (minors item 8 of plan ПЛ-Х), and the pallet's
   * own label, printed at its close, does not know it.
   */
  | { kind: "late_boxes"; boxes: number }
  /** Pallets whose live box count differs from what the station counted at the close. */
  | { kind: "pallet_count_mismatch"; pallets: number }
  /**
   * Code conflicts of the shift nobody reviewed (plan КНФ): a box where a scan lost may
   * differ from what the file writes. A warning, never a refusal (ПР-12).
   */
  | { kind: "unreviewed_conflicts"; conflicts: number };

/** The shift's unreviewed conflicts as a warning of every shift format (plan КНФ, ПР-12). */
export function conflictWarnings(unreviewed: number): ExportWarning[] {
  return unreviewed > 0 ? [{ kind: "unreviewed_conflicts", conflicts: unreviewed }] : [];
}

/**
 * The formats the cloud's dialog offers this shift (`ShiftExportsDialog`:
 * the pallets formats only for a shift with pallets), each with its
 * source's refusal now. A validation shift (plan РЕЖ, Р11) is offered the
 * flat TXT and CSV alone: it has no box, so a format with boxes or pallets
 * would only be refused (the cloud offers them and fails later).
 */
export function formatOffers(
  rows: ShiftExportRows,
  formedAt: string,
  mode: ShiftMode,
): FormatOffer[] {
  return offeredFormats(rows, mode).map((format) => {
    const snapshot = shiftExportSnapshot(rows, format, formedAt);
    return { format, refusal: snapshot.ok ? null : snapshot.refusal };
  });
}

/** The formats of `formatOffers`, without the work of checking them. */
export function offeredFormats(
  rows: ShiftExportRows,
  mode: ShiftMode,
): ShiftExportFormatDescriptor[] {
  if (mode === "validation") {
    return SHIFT_EXPORT_FORMATS.filter((format) => format.boxMode === "flat");
  }
  return SHIFT_EXPORT_FORMATS.filter(
    (format) => rows.shift.palletsEnabled || !shiftExportFormatRequiresPallets(format),
  );
}

/** A format's offer with its warnings, both from one snapshot of the shift. */
export interface FormatCheck extends FormatOffer {
  warnings: ExportWarning[];
}

/**
 * `formatOffers`' offer and `exportWarnings`' warnings of one format from one
 * pass over the shift's rows: the dialog checks every format of a large
 * shift, one turn each, and a snapshot of 200 000 codes is not made twice.
 */
export function formatCheck(
  rows: ShiftExportRows,
  format: ShiftExportFormatDescriptor,
  formedAt: string,
): FormatCheck {
  const snapshot = shiftExportSnapshot(rows, format, formedAt);
  return {
    format,
    refusal: snapshot.ok ? null : snapshot.refusal,
    warnings: warningsOf(rows, format, () => snapshot),
  };
}

/** Every pallet of the shift, closed ones first by their close, then by SSCC; open ones last. */
export function palletOffers(rows: ShiftExportRows): PalletOffer[] {
  return [...rows.pallets]
    .sort((left, right) => {
      if (left.closedAt === null || right.closedAt === null) {
        return Number(left.closedAt === null) - Number(right.closedAt === null);
      }
      const leftSscc = left.sscc ?? "";
      const rightSscc = right.sscc ?? "";
      return (
        Date.parse(left.closedAt) - Date.parse(right.closedAt) ||
        (leftSscc < rightSscc ? -1 : leftSscc > rightSscc ? 1 : 0)
      );
    })
    .map((pallet) => {
      const snapshot = palletExportSnapshot(rows, pallet.id);
      return {
        palletId: pallet.id,
        sscc: pallet.sscc,
        closedAt: pallet.closedAt,
        boxes: snapshot.ok
          ? snapshot.value.pallet.boxSsccs.length
          : rows.boxes.filter((box) => box.palletId === pallet.id && box.disassembledAt === null)
              .length,
        refusal: snapshot.ok ? null : snapshot.refusal,
      };
    });
}

/** The shift's counts as the export sees them, the coordinator's «in closed boxes» among them. */
export function exportCounts(rows: ShiftExportRows): ExportCounts {
  const closedBox = new Set(
    rows.boxes
      .filter((box) => box.closedAt !== null && box.sscc !== null && box.disassembledAt === null)
      .map((box) => box.id),
  );
  const owned = new Set(rows.codes.map((code) => code.codeHash));
  return {
    codes: rows.codes.length,
    codesInClosedBoxes: new Set(
      rows.items
        .filter((item) => closedBox.has(item.boxId) && owned.has(item.codeHash))
        .map((item) => item.codeHash),
    ).size,
    closedBoxes: closedBox.size,
    closedPallets: rows.pallets.filter(
      (pallet) => pallet.closedAt !== null && pallet.disassembledAt === null,
    ).length,
  };
}

/**
 * The warnings of `format` now: late data for every format; for a pallets
 * format, the boxes its document writes on no pallet and the pallets taken
 * apart it still names (both 0 when the source refuses).
 */
export function exportWarnings(
  rows: ShiftExportRows,
  format: ShiftExportFormatDescriptor,
  formedAt: string,
): ExportWarning[] {
  return warningsOf(rows, format, () => shiftExportSnapshot(rows, format, formedAt));
}

/** The warnings of `format`; the snapshot is asked for only by a pallets format. */
function warningsOf(
  rows: ShiftExportRows,
  format: ShiftExportFormatDescriptor,
  snapshotOf: () => SourceResult<ShiftExportSnapshot>,
): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  if (rows.shift.lateDataAt !== null) {
    warnings.push({ kind: "late_data", at: rows.shift.lateDataAt });
  }
  if (!shiftExportFormatRequiresPallets(format)) return warnings;
  const snapshot = snapshotOf();
  if (!snapshot.ok) return warnings;
  if (snapshot.value.openPalletSuppressedBoxCount > 0) {
    warnings.push({ kind: "open_pallets", boxes: snapshot.value.openPalletSuppressedBoxCount });
  }
  if (snapshot.value.disassembledPalletCount > 0) {
    warnings.push({
      kind: "disassembled_pallets",
      pallets: snapshot.value.disassembledPalletCount,
    });
  }
  const late = lateBoxes(rows, null, true);
  if (late > 0) warnings.push({ kind: "late_boxes", boxes: late });
  return warnings;
}

/**
 * The warnings of one pallet's own document: the boxes it names that closed
 * after the pallet (none while its document cannot be formed).
 */
export function palletWarnings(rows: ShiftExportRows, palletId: string): ExportWarning[] {
  if (!palletExportSnapshot(rows, palletId).ok) return [];
  const late = lateBoxes(rows, palletId, false);
  return late > 0 ? [{ kind: "late_boxes", boxes: late }] : [];
}

/**
 * Pallets (the office's list of a shift's pallets) whose live box count is
 * not what the station counted when it closed them. A pallet taken apart is
 * left out: its count is stale by design.
 */
export function reportedCountWarnings(pallets: readonly OfficePallet[]): ExportWarning[] {
  const differing = pallets.filter(
    (pallet) =>
      pallet.disassembledAt === null &&
      pallet.boxCountReported !== null &&
      pallet.boxCountReported !== pallet.boxes,
  ).length;
  return differing > 0 ? [{ kind: "pallet_count_mismatch", pallets: differing }] : [];
}

/**
 * Boxes on a closed pallet (of `palletId`, or of any pallet) whose close is
 * after the pallet's, to the millisecond. `needCodes`: a shift export writes
 * only boxes that hold codes; one pallet's document writes every closed box.
 */
function lateBoxes(rows: ShiftExportRows, palletId: string | null, needCodes: boolean): number {
  const palletById = new Map(rows.pallets.map((pallet) => [pallet.id, pallet]));
  // Only a shift export reads it, and it takes a pass over every code of the shift: a pallet's
  // own document asks for each pallet of a large shift in turn.
  const withCodes = needCodes ? new Set(rows.items.map((item) => item.boxId)) : null;
  return rows.boxes.filter((box) => {
    if (box.palletId === null || (palletId !== null && box.palletId !== palletId)) return false;
    if (box.closedAt === null || box.disassembledAt !== null) return false;
    if (withCodes !== null && !withCodes.has(box.id)) return false;
    const owner = palletById.get(box.palletId);
    if (owner === undefined || owner.sscc === null || owner.closedAt === null) return false;
    return Date.parse(box.closedAt) > Date.parse(owner.closedAt);
  }).length;
}

/**
 * Where an export's files go, as the shell's segments under
 * `Документы\Markiro`: `Выгрузки\<номер смены>\<дата_время>_<формат>`, the
 * number as the domain writes a file name's segment (`OCT26-004/S` is
 * `OCT26-004_S`), the moment in the organization's time zone. One folder an
 * export, so a later export with fewer parts never leaves an older part
 * beside it; the shell adds « (2)» to a folder that exists.
 */
export function exportFolder(
  shiftNumber: string,
  formatId: string,
  formedAt: string,
  timeZone: string,
): string[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(formedAt));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((each) => each.type === type)?.value ?? "00";
  const stamp = `${part("year")}-${part("month")}-${part("day")}_${part("hour")}-${part("minute")}-${part("second")}`;
  return ["Выгрузки", sanitizeShiftExportFilenameSegment(shiftNumber), `${stamp}_${formatId}`];
}
