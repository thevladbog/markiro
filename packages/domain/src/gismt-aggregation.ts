import { DomainError } from "./errors.js";
import { parseKmSegments } from "./gs1/km.js";
import { formatSsccWithAi } from "./gs1/sscc.js";

export interface GismtAggregationBox {
  sscc: string;
  codes: readonly string[];
}

export interface GismtAggregationRenderResult {
  bytes: Uint8Array;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
}

export const GISMT_AGGREGATION_OVERHEAD_LINE_COUNT = 10;

export type GismtAggregationErrorCode = "ORG_INN_MISSING" | "INVALID_SSCC" | "INVALID_CIS";

export class GismtAggregationError extends Error {
  constructor(readonly code: GismtAggregationErrorCode) {
    super(code);
    this.name = "GismtAggregationError";
  }
}

const textEncoder = new TextEncoder();
const XML_PROHIBITED_CIS_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function gismtAggregationBoxLineCount(box: GismtAggregationBox): number {
  return 3 + box.codes.length;
}

export function renderGismtAggregationXml(input: {
  organizationInn: string;
  boxes: readonly GismtAggregationBox[];
}): GismtAggregationRenderResult {
  const organizationInn = input.organizationInn.trim();
  if (organizationInn === "") throw new GismtAggregationError("ORG_INN_MISSING");

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<unit_pack>",
    "    <Document>",
    "        <organisation>",
    "            <id_info>",
    `                <LP_info LP_TIN="${xmlAttribute(organizationInn)}" />`,
    "            </id_info>",
    "        </organisation>",
    ...input.boxes.flatMap((box) => [
      "        <pack_content>",
      `            <pack_code>${xmlText(formatGismtAggregationSscc(box.sscc))}</pack_code>`,
      ...box.codes.map((code) => `            <cis>${xmlText(stripKmCryptoTail(code))}</cis>`),
      "        </pack_content>",
    ]),
    "    </Document>",
    "</unit_pack>",
  ];

  return {
    bytes: textEncoder.encode(`${lines.join("\n")}\n`),
    physicalLineCount:
      GISMT_AGGREGATION_OVERHEAD_LINE_COUNT +
      input.boxes.reduce((count, box) => count + gismtAggregationBoxLineCount(box), 0),
    codeCount: input.boxes.reduce((count, box) => count + box.codes.length, 0),
    boxCount: input.boxes.length,
  };
}

export function formatGismtAggregationSscc(sscc: string): string {
  try {
    return formatSsccWithAi(sscc);
  } catch (error) {
    if (error instanceof DomainError) throw new GismtAggregationError("INVALID_SSCC");
    throw error;
  }
}

function stripKmCryptoTail(code: string): string {
  try {
    const segments = parseKmSegments(code);
    const cis = `01${segments.gtin14}21${segments.serial}`;
    if (XML_PROHIBITED_CIS_CHARACTERS.test(cis)) throw new GismtAggregationError("INVALID_CIS");
    return cis;
  } catch (error) {
    if (error instanceof DomainError || error instanceof GismtAggregationError) {
      throw new GismtAggregationError("INVALID_CIS");
    }
    throw error;
  }
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string): string {
  return xmlText(value).replaceAll('"', "&quot;");
}
