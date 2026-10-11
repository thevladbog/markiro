import type {
  ShiftExportFormatDescriptor,
  ShiftExportPalletGroup,
  ShiftExportSource,
} from "@markiro/domain";

import type { ShiftExportRows } from "../../host/protocol.js";

/**
 * The cloud's export source (`apps/api/src/modules/shift-exports/shift-export-source.service.ts`,
 * `loadFromTransaction` and `loadPallet`) ported over the host's rows (plan
 * ЧЗ): the same checks in the same order, the same order of codes, boxes and
 * pallets, the same grouping. Nothing here is the standalone's own rule but
 * the operation instant (`shiftOperationDateTime`) and the count of pallets
 * taken apart, which only warns. `packages/domain/test/fixtures/shift-export-parity`
 * holds the cases both products must render to the same bytes; the cloud's
 * test and `test/export-parity.test.ts` read them. A change of the cloud's
 * rules is a change here, in the same commit as a regenerated golden.
 *
 * Left out, with the reason: `SHIFT_DATE_MISSING` (a host shift always has
 * its production date) and the validation reprocessings the flat formats add
 * in the cloud (validation is stage 3).
 */

/** The cloud's refusals of an export's source (`ShiftExportSourceErrorCode`), less `SHIFT_DATE_MISSING`. */
export type ExportSourceRefusal =
  | "SHIFT_NOT_CLOSED"
  | "SHIFT_HAS_NO_CODES"
  | "BOX_COVERAGE_INCOMPLETE"
  | "SHIFT_HAS_NO_PALLETS"
  | "PALLET_NOT_CLOSED"
  | "PALLET_DISASSEMBLED"
  | "ORG_INN_MISSING"
  | "ORG_NAME_MISSING";

export type SourceResult<T> = { ok: true; value: T } | { ok: false; refusal: ExportSourceRefusal };

/** What a shift's export renders from: the cloud's `ShiftExportSnapshot` with its instants as ISO text. */
export interface ShiftExportSnapshot {
  productName: string;
  shiftDate: string;
  shiftNumber: string;
  /** `operation_date_time` of the ЧЗ document. */
  operationDateTime: string;
  organizationInn: string | null;
  organizationName: string | null;
  /** Boxes written on no pallet only because their pallet has not closed (the cloud keeps it in its audit). */
  openPalletSuppressedBoxCount: number;
  /**
   * Pallets taken apart that a pallets format still writes as pallets, with
   * their boxes: the cloud's export does not leave them out (its pallet query
   * reads no `disassembled_at`), so neither does the port. The office warns.
   */
  disassembledPalletCount: number;
  source: ShiftExportSource;
}

/** What one pallet's export renders from: the cloud's `PalletExportSnapshot`. */
export interface PalletExportSnapshot {
  productName: string;
  /** The pallet's close as a UTC civil date, as the cloud names the file. */
  closedDate: string;
  operationDateTime: string;
  organizationInn: string | null;
  organizationName: string | null;
  pallet: { sscc: string; boxSsccs: readonly string[] };
}

type ShiftFormat = Pick<ShiftExportFormatDescriptor, "boxMode" | "extension">;

interface Authoritative {
  codeHash: string;
  time: number;
  canonical: string;
}

interface EligibleBox {
  sscc: string;
  palletId: string | null;
  codes: string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAuthoritative(left: Authoritative, right: Authoritative): number {
  return left.time - right.time || compareCodeUnits(left.codeHash, right.codeHash);
}

/** Ascending by an instant; a null (never once a group exists) first. */
function compareNullableInstants(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return Date.parse(left) - Date.parse(right);
}

/** The cloud's `loadOrganization`: trimmed, and `null` when blank. */
function organization(rows: ShiftExportRows): { inn: string | null; name: string | null } {
  return {
    inn: rows.organization.inn?.trim() || null,
    name: rows.organization.name.trim() || null,
  };
}

/**
 * `operation_date_time` of a shift's document. The cloud writes the shift's
 * `closed_at`, which for a station's close is the station's own instant; the
 * host keeps whole seconds in `closedAt` and the station's instant as
 * `stationClosedAt`, so that one comes first. The office's close is the
 * host's instant. `formedAt` stands in only for a closed shift without
 * either, as the cloud's snapshot instant does.
 */
export function shiftOperationDateTime(shift: ShiftExportRows["shift"], formedAt: string): string {
  return new Date(shift.stationClosedAt ?? shift.closedAt ?? formedAt).toISOString();
}

/** The cloud's `loadFromTransaction` over the host's rows. */
export function shiftExportSnapshot(
  rows: ShiftExportRows,
  format: ShiftFormat,
  formedAt: string,
): SourceResult<ShiftExportSnapshot> {
  const { shift } = rows;
  if (shift.status !== "closed") return { ok: false, refusal: "SHIFT_NOT_CLOSED" };
  let organizationInn: string | null = null;
  let organizationName: string | null = null;
  if (format.extension === "xml") {
    const org = organization(rows);
    organizationInn = org.inn;
    organizationName = org.name;
    if (organizationInn === null) return { ok: false, refusal: "ORG_INN_MISSING" };
    if (organizationName === null) return { ok: false, refusal: "ORG_NAME_MISSING" };
  }
  const authoritative = rows.codes
    .map((code) => ({
      codeHash: code.codeHash,
      time: Date.parse(code.scannedAt),
      canonical: code.canonical,
    }))
    .sort(compareAuthoritative);
  if (authoritative.length === 0) return { ok: false, refusal: "SHIFT_HAS_NO_CODES" };

  let source: ShiftExportSource;
  let openPalletSuppressedBoxCount = 0;
  let disassembledPalletCount = 0;
  if (format.boxMode === "flat") {
    source = { mode: "flat", codes: authoritative.map((code) => code.canonical) };
  } else {
    const eligible = eligibleBoxes(rows, authoritative);
    if (eligible === null) return { ok: false, refusal: "BOX_COVERAGE_INCOMPLETE" };
    if (format.boxMode === "boxes") {
      source = {
        mode: "boxes",
        boxes: [...eligible]
          .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
          .map((box) => ({ sscc: box.sscc, codes: box.codes })),
      };
    } else {
      const pallets = palletsSource(rows, eligible);
      if (pallets === null) return { ok: false, refusal: "SHIFT_HAS_NO_PALLETS" };
      source = pallets.source;
      openPalletSuppressedBoxCount = pallets.openPalletSuppressedBoxCount;
      disassembledPalletCount = pallets.disassembledPalletCount;
    }
  }
  return {
    ok: true,
    value: {
      productName: shift.productName,
      shiftDate: shift.productionDate,
      shiftNumber: shift.number,
      operationDateTime: shiftOperationDateTime(shift, formedAt),
      organizationInn,
      organizationName,
      openPalletSuppressedBoxCount,
      disassembledPalletCount,
      source,
    },
  };
}

/**
 * The cloud's `loadEligibleBoxes`: every closed box with an SSCC, not taken
 * apart, whose live items cover the shift's codes exactly — each code in
 * exactly one such box, no item of a code the shift does not own, one SSCC
 * a box. `null` is `BOX_COVERAGE_INCOMPLETE`. The host sends live items only,
 * the cloud's first filter.
 */
function eligibleBoxes(
  rows: ShiftExportRows,
  authoritative: readonly Authoritative[],
): EligibleBox[] | null {
  const boxById = new Map(rows.boxes.map((box) => [box.id, box]));
  const eligible = rows.items.flatMap((item) => {
    const box = boxById.get(item.boxId);
    return box !== undefined &&
      box.closedAt !== null &&
      box.sscc !== null &&
      box.disassembledAt === null
      ? [{ boxId: box.id, sscc: box.sscc, palletId: box.palletId, codeHash: item.codeHash }]
      : [];
  });
  const authoritativeByHash = new Map(authoritative.map((code) => [code.codeHash, code]));
  const membershipCounts = new Map<string, number>();
  for (const row of eligible) {
    membershipCounts.set(row.codeHash, (membershipCounts.get(row.codeHash) ?? 0) + 1);
  }
  const coverageIsExact =
    eligible.length === authoritative.length &&
    eligible.every((row) => authoritativeByHash.has(row.codeHash)) &&
    authoritative.every((code) => membershipCounts.get(code.codeHash) === 1);
  if (!coverageIsExact) return null;

  const rowsByBox = new Map<
    string,
    { sscc: string; palletId: string | null; codes: Authoritative[] }
  >();
  for (const row of eligible) {
    const code = authoritativeByHash.get(row.codeHash);
    // The backstop of the coverage check above (every item's code is one the shift owns): were
    // its `every` conditions ever loosened, this line alone still refuses an unowned item.
    if (code === undefined) return null;
    const existing = rowsByBox.get(row.boxId);
    if (existing) {
      if (existing.sscc !== row.sscc) return null;
      existing.codes.push(code);
    } else {
      rowsByBox.set(row.boxId, { sscc: row.sscc, palletId: row.palletId, codes: [code] });
    }
  }
  return [...rowsByBox.values()].map((box) => ({
    sscc: box.sscc,
    palletId: box.palletId,
    codes: [...box.codes].sort(compareAuthoritative).map((code) => code.canonical),
  }));
}

/**
 * The cloud's `toPalletsSource`: a box on a closed pallet (one with an
 * SSCC) joins that pallet's group; pallets by their close, then their SSCC;
 * their boxes by SSCC; a box on no pallet, or on a pallet still open, is
 * loose, after every pallet, and one on an open pallet counts as suppressed.
 * `null` when no group exists (`SHIFT_HAS_NO_PALLETS`).
 */
function palletsSource(
  rows: ShiftExportRows,
  eligible: readonly EligibleBox[],
): {
  source: ShiftExportSource;
  openPalletSuppressedBoxCount: number;
  disassembledPalletCount: number;
} | null {
  const palletById = new Map(rows.pallets.map((pallet) => [pallet.id, pallet]));
  const groups = new Map<
    string,
    {
      sscc: string;
      closedAt: string | null;
      disassembled: boolean;
      boxes: { sscc: string; codes: string[] }[];
    }
  >();
  const looseBoxes: { sscc: string; codes: string[] }[] = [];
  let openPalletSuppressedBoxCount = 0;
  for (const box of eligible) {
    if (box.palletId === null) {
      looseBoxes.push({ sscc: box.sscc, codes: box.codes });
      continue;
    }
    const pallet = palletById.get(box.palletId);
    if (pallet === undefined || pallet.sscc === null) {
      if (pallet !== undefined) openPalletSuppressedBoxCount += 1;
      looseBoxes.push({ sscc: box.sscc, codes: box.codes });
      continue;
    }
    const existing = groups.get(box.palletId);
    if (existing) {
      existing.boxes.push({ sscc: box.sscc, codes: box.codes });
    } else {
      groups.set(box.palletId, {
        sscc: pallet.sscc,
        closedAt: pallet.closedAt,
        disassembled: pallet.disassembledAt !== null,
        boxes: [{ sscc: box.sscc, codes: box.codes }],
      });
    }
  }
  if (groups.size === 0) return null;
  const ordered = [...groups.values()].sort(
    (left, right) =>
      compareNullableInstants(left.closedAt, right.closedAt) ||
      compareCodeUnits(left.sscc, right.sscc),
  );
  const pallets: ShiftExportPalletGroup[] = ordered.map((group) => ({
    sscc: group.sscc,
    boxes: [...group.boxes].sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
  }));
  return {
    source: {
      mode: "pallets",
      pallets,
      looseBoxes: looseBoxes.sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
    },
    openPalletSuppressedBoxCount,
    disassembledPalletCount: ordered.filter((group) => group.disassembled).length,
  };
}

/**
 * The cloud's `loadPallet` over the host's rows: a pallet that is unknown,
 * not closed or without an SSCC is `PALLET_NOT_CLOSED`, one taken apart
 * `PALLET_DISASSEMBLED`; its boxes are its closed boxes not taken apart, by
 * their close, then their id, as the cloud's SQL orders them. The shift
 * need not be closed (the cloud exports a closed pallet of an active shift).
 */
export function palletExportSnapshot(
  rows: ShiftExportRows,
  palletId: string,
): SourceResult<PalletExportSnapshot> {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  if (pallet === undefined || pallet.sscc === null || pallet.closedAt === null) {
    return { ok: false, refusal: "PALLET_NOT_CLOSED" };
  }
  if (pallet.disassembledAt !== null) return { ok: false, refusal: "PALLET_DISASSEMBLED" };
  const boxes = rows.boxes
    .flatMap((box) =>
      box.palletId === palletId && box.closedAt !== null && box.disassembledAt === null
        ? [{ id: box.id, sscc: box.sscc, closedAt: box.closedAt }]
        : [],
    )
    .sort(
      (left, right) =>
        Date.parse(left.closedAt) - Date.parse(right.closedAt) ||
        compareCodeUnits(left.id, right.id),
    );
  const org = organization(rows);
  const closedAt = new Date(pallet.closedAt).toISOString();
  return {
    ok: true,
    value: {
      productName: rows.shift.productName,
      closedDate: closedAt.slice(0, 10),
      operationDateTime: closedAt,
      organizationInn: org.inn,
      organizationName: org.name,
      pallet: {
        sscc: pallet.sscc,
        boxSsccs: boxes.flatMap((box) => (box.sscc === null ? [] : [box.sscc])),
      },
    },
  };
}
