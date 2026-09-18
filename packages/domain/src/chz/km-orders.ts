/**
 * Chestny ZNAK order-management station (СУЗ, OMS API 3.0) rules that are
 * independent of transport: which KM template a product group emits for
 * `cisType: UNIT`, the exact bytes of an order body, and the files an issue
 * is exported as. The API signs and sends the body produced here verbatim.
 */

/**
 * `templateId` for `cisType: "UNIT"` per СУЗ table 270, keyed by the
 * `chz_product_groups.alias` the True API uses. Only groups with exactly one
 * UNIT template are listed; a group with two (for example `otp` 14/15) needs
 * a per-product choice this phase does not offer, so it is deliberately absent.
 */
export const CHZ_UNIT_TEMPLATE_ID_BY_GROUP: Readonly<Record<string, number>> = {
  beer: 18,
  nabeer: 28,
  water: 16,
  milk: 20,
  tobacco: 4,
  ncp: 22,
  lp: 10,
  shoes: 1,
  perfumery: 9,
  tires: 7,
  electronics: 8,
  bicycle: 11,
  wheelchairs: 12,
  softdrinks: 29,
  vetpharma: 50,
};

export function chzUnitTemplateIdFor(productGroupAlias: string): number | null {
  return Object.hasOwn(CHZ_UNIT_TEMPLATE_ID_BY_GROUP, productGroupAlias)
    ? (CHZ_UNIT_TEMPLATE_ID_BY_GROUP[productGroupAlias] ?? null)
    : null;
}

export interface ChzKmOrderBodyInput {
  productGroupAlias: string;
  gtin14: string;
  quantity: number;
  templateId: number;
  contactPerson?: string | undefined;
  /** Our own order id; СУЗ echoes it back as `productionOrderId`. */
  productionOrderId: string;
}

/**
 * The bytes that get signed AND sent. Key order is fixed by construction
 * (object literal order), so the same input always yields the same string;
 * the runner persists this string and never re-serialises it.
 */
export function buildChzKmOrderBody(input: ChzKmOrderBodyInput): string {
  const attributes: Record<string, string> = { releaseMethodType: "PRODUCTION" };
  if (input.contactPerson !== undefined && input.contactPerson.length > 0) {
    attributes.contactPerson = input.contactPerson;
  }
  attributes.productionOrderId = input.productionOrderId;
  return JSON.stringify({
    productGroup: input.productGroupAlias,
    products: [
      {
        gtin: input.gtin14,
        quantity: input.quantity,
        serialNumberType: "OPERATOR",
        templateId: input.templateId,
        cisType: "UNIT",
      },
    ],
    attributes,
  });
}

const encoder = new TextEncoder();

/** One full code per LF-terminated line, raw GS byte, UTF-8 without BOM — the shape of ЧЗ's own files. */
export function serializeKmCodesTxt(codes: readonly string[]): Uint8Array {
  return encoder.encode(codes.map((code) => `${code}\n`).join(""));
}

/** Single `code` column, every value quoted, quotes doubled. */
export function serializeKmCodesCsv(codes: readonly string[]): Uint8Array {
  const lines = codes.map((code) => `"${code.replaceAll('"', '""')}"\n`);
  return encoder.encode(`code\n${lines.join("")}`);
}

export function kmOrderIssueFileName(
  gtin14: string,
  fromSeq: number,
  toSeq: number,
  format: "txt" | "csv",
): string {
  return `km-${gtin14}-${fromSeq}-${toSeq}.${format}`;
}
