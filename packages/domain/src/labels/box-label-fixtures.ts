import { DomainError } from "../errors.js";
import { buildSscc } from "../gs1/sscc.js";
import { boxLabelFields, type BoxLabelInput } from "./box-label.js";
import type { LabelField } from "./model.js";
import { palletLabelFields, type PalletLabelInput } from "./pallet-label.js";

export interface SsccCase {
  extensionDigit: number;
  gs1Prefix: string;
  serial: number;
  /** The 18-digit result, or null when the domain refuses the input. */
  sscc: string | null;
  /** The `DomainError` code when `sscc` is null. */
  error: string | null;
}

export interface FieldCase {
  name: string;
  /**
   * The zone this case was generated in. `localIsoDate` resolves a stored UTC
   * instant against the ambient zone, so a case that exercises the fallback is
   * only reproducible when the reader applies the same one.
   */
  timeZone: string;
  input: BoxLabelInput;
  fields: Record<LabelField, string>;
}

/**
 * Same shape as `FieldCase`, for `palletLabelFields` instead of `boxLabelFields`.
 *
 * Kept in this file rather than a `pallet-label-fixtures.ts` of its own: the
 * handheld's Kotlin port already reads `box-label-fixtures.json` for the SSCC
 * and box-date parity it needs, and a pallet's own date arithmetic is the same
 * shared code under a different field builder, not a second rule to pin.
 */
export interface PalletFieldCase {
  name: string;
  timeZone: string;
  input: PalletLabelInput;
  fields: Record<LabelField, string>;
}

export interface BoxLabelFixtures {
  sscc: SsccCase[];
  fields: FieldCase[];
  palletFields: PalletFieldCase[];
}

/**
 * Runs `build` with the ambient timezone set to `tz`, then restores it.
 *
 * Supplied by the caller rather than implemented here: this package's sources
 * are dependency-free and run in a browser as well as in Node, so they must not
 * reach for `process`. The export script and the drift test each pass their own.
 */
export type InZone = <T>(tz: string, build: () => T) => T;

function sscc(extensionDigit: number, gs1Prefix: string, serial: number): SsccCase {
  try {
    return {
      extensionDigit,
      gs1Prefix,
      serial,
      sscc: buildSscc(extensionDigit, gs1Prefix, serial),
      error: null,
    };
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    return { extensionDigit, gs1Prefix, serial, sscc: null, error: err.code };
  }
}

const product: Omit<BoxLabelInput, "closedAt" | "productionDate" | "shelfLifeDays"> = {
  sscc: "046800899000000000",
  itemCount: 20,
  productName: "Вода питьевая негазированная 0,5 л",
  productPrintName: "Вода 0,5 л",
  gtin14: "04680089900000",
  egaisCode: null,
  operatorName: "Иванов И.",
  counterpartyName: "ООО «Завод»",
  shiftNumber: "SEP26-003",
};

function fieldCase(
  inZone: InZone,
  name: string,
  overrides: Partial<BoxLabelInput> & Pick<BoxLabelInput, "closedAt">,
  timeZone = "UTC",
): FieldCase {
  const input: BoxLabelInput = {
    ...product,
    shelfLifeDays: 365,
    productionDate: null,
    ...overrides,
  };
  return { name, timeZone, input, fields: inZone(timeZone, () => boxLabelFields(input)) };
}

const palletProduct: Omit<
  PalletLabelInput,
  "closedAt" | "productionDate" | "shelfLifeDays" | "sscc" | "boxCount" | "itemCount"
> = {
  productName: "Вода питьевая негазированная 0,5 л",
  productPrintName: "Вода 0,5 л",
  gtin14: "04680089900000",
  egaisCode: null,
  operatorName: "Иванов И.",
  counterpartyName: "ООО «Завод»",
  shiftNumber: "SEP26-003",
};

function palletFieldCase(
  inZone: InZone,
  name: string,
  overrides: Partial<PalletLabelInput> & Pick<PalletLabelInput, "closedAt">,
  timeZone = "UTC",
): PalletFieldCase {
  const input: PalletLabelInput = {
    ...palletProduct,
    // A pallet SSCC (extension digit 1), so a disagreement between the
    // domain and the Kotlin port would also show up in whichever byte the
    // label happens to bind, not only in the dedicated SSCC cases below.
    sscc: "103460068200000004",
    boxCount: 12,
    itemCount: 240,
    shelfLifeDays: 365,
    productionDate: null,
    ...overrides,
  };
  return { name, timeZone, input, fields: inZone(timeZone, () => palletLabelFields(input)) };
}

/**
 * What the handheld's Kotlin port of SSCC construction and box-label dates is
 * pinned against. A disagreement means a device printing a number that will
 * not reconcile at the receiver, or an expiry a day off the rest of the
 * platform's.
 */
export function buildBoxLabelFixtures(inZone: InZone): BoxLabelFixtures {
  const field = (
    name: string,
    overrides: Partial<BoxLabelInput> & Pick<BoxLabelInput, "closedAt">,
    timeZone?: string,
  ) => fieldCase(inZone, name, overrides, timeZone);
  const palletField = (
    name: string,
    overrides: Partial<PalletLabelInput> & Pick<PalletLabelInput, "closedAt">,
    timeZone?: string,
  ) => palletFieldCase(inZone, name, overrides, timeZone);
  return {
    sscc: [
      sscc(0, "468008990", 0),
      sscc(0, "468008990", 1),
      sscc(0, "468008990", 4_242),
      // The last serial a 9-digit prefix can carry.
      sscc(0, "468008990", 9_999_999),
      // Pallets, so the two extension digits are proven not to share a shape.
      sscc(1, "468008990", 7),
      sscc(0, "4600000", 123_456_789),
      sscc(0, "4600", 0),
      // Refusals, each by its own code.
      sscc(0, "468008990", 10_000_000),
      sscc(0, "468008990", -1),
      sscc(10, "468008990", 5),
      sscc(0, "460", 0),
    ],
    fields: [
      field("declared production date", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
      }),
      field("close date stands in for an undeclared production date", {
        closedAt: "2026-09-10T21:30:00.000Z",
      }),
      field("one-day shelf life expires on the production day", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        shelfLifeDays: 1,
      }),
      field("leap day", {
        closedAt: "2028-02-29T08:00:00.000Z",
        productionDate: "2028-02-29",
        shelfLifeDays: 366,
      }),
      field("crossing a year boundary", {
        closedAt: "2026-12-31T08:00:00.000Z",
        productionDate: "2026-12-31",
        shelfLifeDays: 30,
      }),
      field("no shelf life leaves the expiry empty", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        shelfLifeDays: null,
      }),
      field("an impossible declared date yields empty dates", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-02-30",
      }),
      field("no print name falls back to the full name", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        productPrintName: null,
      }),
      field("absent optionals become empty strings", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        operatorName: null,
        counterpartyName: null,
        shiftNumber: null,
        egaisCode: null,
      }),
      field("a single unit still prints its count", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        itemCount: 1,
      }),
      // The local-date fallback in a zone where the instant has already rolled
      // over: 21:30Z on the 10th is the 11th in Moscow, and the label carries the
      // day the person reading it is living in, not the day UTC is on.
      field(
        "an undeclared production date takes the device's local day, not UTC's",
        { closedAt: "2026-09-10T21:30:00.000Z" },
        "Europe/Moscow",
      ),
    ],
    palletFields: [
      palletField("prints units in qty and boxes in qty.boxes", {
        closedAt: "2026-09-11T07:00:00.000Z",
        productionDate: "2026-09-11",
        shelfLifeDays: 30,
        boxCount: 12,
        itemCount: 240,
      }),
      palletField("one-day shelf life expires on the production day", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        shelfLifeDays: 1,
      }),
      palletField("leap day", {
        closedAt: "2028-02-29T08:00:00.000Z",
        productionDate: "2028-02-29",
        shelfLifeDays: 366,
      }),
      palletField("no print name falls back to the full name", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        productPrintName: null,
      }),
      palletField("absent optionals become empty strings", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-09-10",
        operatorName: null,
        counterpartyName: null,
        shiftNumber: null,
        egaisCode: null,
      }),
      palletField("an impossible declared date yields empty dates", {
        closedAt: "2026-09-10T08:00:00.000Z",
        productionDate: "2026-02-30",
      }),
      // Same local-date fallback as the box case, through the pallet's own
      // field builder: 21:30Z on the 10th is already the 11th in Moscow.
      palletField(
        "an undeclared production date takes the device's local day, not UTC's",
        { closedAt: "2026-09-10T21:30:00.000Z" },
        "Europe/Moscow",
      ),
    ],
  };
}
