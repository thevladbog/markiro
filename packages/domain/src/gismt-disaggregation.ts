import { compareText } from "./document-text-encoding.js";
import { canonicalizeKm, kmKey } from "./gs1/km.js";
import { formatSsccWithAi } from "./gs1/sscc.js";

/**
 * ГИС МТ «Расформирование упаковки» (`<disaggregation action_id="31" version="2">`):
 * the bytes the inventory's `inventory_xml_gismt_disaggregation` writes, now
 * shared with the standalone office's disaggregation document (plan ДЗГ-О).
 * One `<packing>` a package, its code the bare 18-digit SSCC in CDATA, each
 * once, sorted by `compareText`. No valid empty document exists for this
 * schema (`packing` is `minOccurs="1"`), so an empty set is refused; the
 * inventory writes its zero-byte part before it calls this.
 */

export type GismtDisaggregationErrorCode =
  "INVALID_ORGANIZATION_INN" | "INVALID_SSCC" | "INVALID_SET_CODE" | "EMPTY_SOURCE";

export class GismtDisaggregationError extends Error {
  constructor(readonly code: GismtDisaggregationErrorCode) {
    super(code);
    this.name = "GismtDisaggregationError";
  }
}

export interface GismtDisaggregationInput {
  organizationInn: string;
  /** Bare 18-digit SSCCs; duplicates are allowed and named once. */
  ssccs: readonly string[];
}

export interface RenderedGismtDisaggregation {
  bytes: Uint8Array;
  physicalLineCount: number;
  packingCount: number;
}

const encoder = new TextEncoder();

/**
 * Shared "is this shaped like a usable organization/participant INN" predicate.
 * Accepts the 9-digit, 10-digit (legal entity), and 12-digit (individual
 * entrepreneur) forms used by the ГИС МТ disaggregation `trade_participant_inn`
 * field. Aggregation is stricter — it only accepts the 10-digit legal-entity
 * form (see the inline regex in `validateAggregationMetadata`) — so a value
 * that passes this predicate can still be rejected by the aggregation
 * generator.
 */
export function isParticipantInn(value: string): boolean {
  return /^\d{9}$/.test(value) || /^(?:\d[1-9]|[1-9]\d)(?:\d{8}|\d{10})$/.test(value);
}

export function renderGismtDisaggregationXml(
  input: GismtDisaggregationInput,
): RenderedGismtDisaggregation {
  if (!isParticipantInn(input.organizationInn)) {
    throw new GismtDisaggregationError("INVALID_ORGANIZATION_INN");
  }
  const packings = [...new Set(input.ssccs)].sort(compareText);
  if (packings.some((sscc) => !/^\d{18}$/.test(sscc))) {
    throw new GismtDisaggregationError("INVALID_SSCC");
  }
  if (packings.length === 0) throw new GismtDisaggregationError("EMPTY_SOURCE");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<disaggregation action_id="31" version="2">',
    `    <trade_participant_inn>${input.organizationInn}</trade_participant_inn>`,
    "    <packings_list>",
    ...packings.flatMap((sscc) => [
      "        <packing>",
      `            <kitu><![CDATA[${sscc}]]></kitu>`,
      "        </packing>",
    ]),
    "    </packings_list>",
    "</disaggregation>",
  ];
  return {
    bytes: encoder.encode(`${lines.join("\n")}\n`),
    physicalLineCount: lines.length,
    packingCount: packings.length,
  };
}

export interface GismtDisaggregationJsonInput {
  organizationInn: string;
  packings: readonly ({ sscc: string } | { setCode: string })[];
}

function disaggregationIdentifier(packing: GismtDisaggregationJsonInput["packings"][number]) {
  if ("sscc" in packing) {
    if (!/^\d{18}$/u.test(packing.sscc)) throw new GismtDisaggregationError("INVALID_SSCC");
    return formatSsccWithAi(packing.sscc);
  }
  const { setCode } = packing;
  try {
    if (kmKey(canonicalizeKm(setCode)) === setCode) return setCode;
  } catch {
    // The input must already be a normalized KI.
  }
  throw new GismtDisaggregationError("INVALID_SET_CODE");
}

/** True API document body for `DISAGGREGATION_DOCUMENT` (format MANUAL). */
export function renderGismtDisaggregationJson(
  input: GismtDisaggregationJsonInput,
): Pick<RenderedGismtDisaggregation, "bytes" | "packingCount"> {
  if (!isParticipantInn(input.organizationInn)) {
    throw new GismtDisaggregationError("INVALID_ORGANIZATION_INN");
  }
  const packings = [...new Set(input.packings.map(disaggregationIdentifier))].sort(compareText);
  if (packings.length === 0) throw new GismtDisaggregationError("EMPTY_SOURCE");
  const document = {
    participant_inn: input.organizationInn,
    products_list: packings.map((uitu) => ({ uitu })),
  };
  return {
    bytes: encoder.encode(`${JSON.stringify(document, null, 2)}\n`),
    packingCount: packings.length,
  };
}
