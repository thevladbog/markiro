import { DomainError } from "../errors.js";
import { buildSscc } from "../gs1/sscc.js";
import { boxLabelFields, type BoxLabelInput } from "./box-label.js";
import type { LabelField } from "./model.js";

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
  input: BoxLabelInput;
  fields: Record<LabelField, string>;
}

export interface BoxLabelFixtures {
  /**
   * The zone the field cases were generated in. `localIsoDate` resolves a
   * stored UTC instant against the machine's own zone, so these cases are
   * reproducible only when the reader applies the same one. The export script
   * pins it; the Kotlin test applies it.
   */
  timeZone: string;
  sscc: SsccCase[];
  fields: FieldCase[];
}

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

function field(
  name: string,
  overrides: Partial<BoxLabelInput> & Pick<BoxLabelInput, "closedAt">,
): FieldCase {
  const input: BoxLabelInput = {
    ...product,
    shelfLifeDays: 365,
    productionDate: null,
    ...overrides,
  };
  return { name, input, fields: boxLabelFields(input) };
}

/**
 * What the handheld's Kotlin port of SSCC construction and box-label dates is
 * pinned against. A disagreement means a device printing a number that will
 * not reconcile at the receiver, or an expiry a day off the rest of the
 * platform's.
 */
export function buildBoxLabelFixtures(): BoxLabelFixtures {
  return {
    timeZone: "UTC",
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
    ],
  };
}
