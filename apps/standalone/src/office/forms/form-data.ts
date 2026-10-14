import type {
  BoxReportData,
  PalletPlacardData,
  PalletReportData,
  ReportOrg,
  ShiftTaskFormData,
} from "@markiro/domain";

import type {
  BoxReportRows,
  CounterpartyRecord,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
  PalletReportRows,
} from "../../host/protocol.js";

/**
 * The cloud's form inputs from the host's rows (plan О-Ф). The forms are the
 * cloud's own (`@markiro/domain`'s `print-forms`), so what makes a standalone
 * form the cloud's for the same facts is this mapping: each function says
 * which loader of the cloud it stands for (`CodeSearchService.boxReportData`
 * and its neighbours, `ShiftsService.taskFormData`), and
 * `test/forms-parity.test.ts` holds it to the bytes the cloud's controllers
 * answer for the shared cases.
 */

type Pallet = PalletReportRows["pallets"][number];

/** The 20-character machine form `00…` the forms take; the host keeps the bare 18 digits. */
export function machineSscc(sscc: string | null): string | null {
  return sscc === null ? null : `00${sscc}`;
}

/** The organization as the forms name it: the standalone has no logo (pilot question П15). */
function reportOrg(organization: { name: string; inn: string | null }): ReportOrg {
  return { name: organization.name, inn: organization.inn, logo: null };
}

/** A box's or a pallet's state, as the cloud's loaders derive it. */
function lifecycle(
  closedAt: string | null,
  disassembledAt: string | null,
): "open" | "closed" | "disassembled" {
  return disassembledAt !== null ? "disassembled" : closedAt !== null ? "closed" : "open";
}

function at(value: string): Date;
function at(value: string | null): Date | null;
function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** «Состав короба» of one box (`CodeSearchService.boxReportData`). */
export function boxReportData(rows: BoxReportRows): BoxReportData {
  return {
    sscc: machineSscc(rows.sscc),
    status: lifecycle(rows.closedAt, rows.disassembledAt),
    productName: rows.productName,
    org: reportOrg(rows.organization),
    openedAt: at(rows.openedAt),
    closedAt: at(rows.closedAt),
    disassembledAt: at(rows.disassembledAt),
    codes: rows.items.map((item) => ({
      gtin14: item.gtin14,
      serial: item.serial,
      rawKm: item.canonical,
    })),
  };
}

/**
 * «Состав паллеты» of one pallet of the shift (`CodeSearchService.palletReportData`),
 * or `null` when the rows have no such pallet. A box taken apart keeps its
 * place and its time; the form neither prints nor counts its units.
 */
export function palletReportData(
  rows: PalletReportRows,
  palletId: string,
): PalletReportData | null {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  if (pallet === undefined) return null;
  return {
    sscc: machineSscc(pallet.sscc),
    status: lifecycle(pallet.closedAt, pallet.disassembledAt),
    productName: rows.shift.productName,
    org: reportOrg(rows.organization),
    openedAt: at(pallet.openedAt),
    closedAt: at(pallet.closedAt),
    disassembledAt: at(pallet.disassembledAt),
    boxes: pallet.boxes.map((box) => ({
      sscc: machineSscc(box.sscc),
      codeCount: box.units,
      disassembledAt: at(box.disassembledAt),
    })),
  };
}

/**
 * Whether a pallet has a placard: closed and with an SSCC, as the cloud's
 * `palletPlacardData` refuses any other (`PALLET_NOT_CLOSED`). A pallet taken
 * apart has one, printed with the cloud's watermark.
 */
export function hasPlacard(pallet: Pick<Pallet, "closedAt" | "sscc">): boolean {
  return pallet.closedAt !== null && pallet.sscc !== null;
}

function placard(rows: PalletReportRows, pallet: Pallet): PalletPlacardData {
  return {
    sscc: machineSscc(pallet.sscc),
    status: pallet.disassembledAt !== null ? "disassembled" : "closed",
    productName: rows.shift.productName,
    gtin14: rows.shift.gtin14,
    shelfLifeDays: rows.shift.shelfLifeDays,
    org: reportOrg(rows.organization),
    // Every box of a standalone pallet is of its own shift, so each carries
    // the shift's declared production date (the host's date is never empty).
    boxes: pallet.boxes.map((box) => ({
      productionDate: rows.shift.productionDate,
      codeCount: box.units,
      disassembledAt: at(box.disassembledAt),
    })),
  };
}

/** «Ярлык паллеты» of one pallet (`CodeSearchService.palletPlacardData`), or `null` without one. */
export function palletPlacardData(
  rows: PalletReportRows,
  palletId: string,
): PalletPlacardData | null {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  return pallet === undefined || !hasPlacard(pallet) ? null : placard(rows, pallet);
}

/**
 * The pallets «Ярлыки паллет смены» prints (`CodeSearchService.shiftPlacardsData`):
 * closed, not taken apart, with an SSCC, closed first first (then by id).
 */
export function placardPallets(rows: PalletReportRows): Pallet[] {
  return rows.pallets
    .filter((pallet) => hasPlacard(pallet) && pallet.disassembledAt === null)
    .sort((a, b) => byText(a.closedAt ?? "", b.closedAt ?? "") || byText(a.id, b.id));
}

/** Code-unit order: a device's instants (`…T06:05:12.031Z`) and ids sort as text. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * «Ярлыки паллет смены»: the shift's number and a placard of each pallet
 * `placardPallets` names, or `null` when there is none (the cloud's
 * `SHIFT_HAS_NO_PALLETS`).
 */
export function shiftPlacardsData(
  rows: PalletReportRows,
): { shiftNumber: string; pallets: PalletPlacardData[] } | null {
  const pallets = placardPallets(rows);
  if (pallets.length === 0) return null;
  return { shiftNumber: rows.shift.number, pallets: pallets.map((each) => placard(rows, each)) };
}

/** What «Бланк смены» is drawn from: records the office reads already. */
export interface TaskFormInputs {
  shift: OfficeShift;
  product: OfficeProduct;
  line: OfficeLine;
  counterparty: CounterpartyRecord | null;
  organization: OrgProfile;
}

/**
 * «Бланк смены» (`ShiftsService.taskFormData`), or `null` for a closed shift
 * (the cloud's `SHIFT_TASK_FORM_CLOSED`). The standalone shift has one date
 * (stage 2a spec, question В3), so it is both the shift's date and its
 * production date; the product has no photo; a validation shift's duplicate
 * print is its own policy (plan РЕЖ part B: none when the host sends none);
 * the standalone neither reprocesses earlier codes nor issues SSCCs under a
 * counterparty's prefix yet.
 */
export function taskFormData(inputs: TaskFormInputs, generatedAt: Date): ShiftTaskFormData | null {
  const { shift, product, line, counterparty, organization } = inputs;
  if (shift.status === "closed") return null;
  const duplicate = shift.validationPrint?.mode === "duplicate_dm" ? shift.validationPrint : null;
  return {
    shiftId: shift.id,
    shiftNumber: shift.number,
    status: shift.status,
    mode: shift.mode,
    organizationName: organization.name,
    productId: product.id,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    imageChecksum: null,
    lineName: line.name,
    plannedDate: shift.productionDate,
    productionDate: shift.productionDate,
    plannedQty: shift.plannedQty,
    boxCapacity: shift.boxCapacity,
    palletsEnabled: shift.palletsEnabled,
    palletBoxCapacity: shift.palletBoxCapacity,
    counterpartyName: counterparty?.name ?? null,
    ssccIssuerName: null,
    validationPrintMode: duplicate === null ? "none" : "duplicate_dm",
    validationPrintVerification: duplicate?.verification ?? "none",
    allowPreviouslyAcceptedCodes: false,
    generatedAt,
  };
}
