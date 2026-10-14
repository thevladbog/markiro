import { compareText } from "./document-text-encoding.js";

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
  "INVALID_ORGANIZATION_INN" | "INVALID_SSCC" | "EMPTY_SOURCE";

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
