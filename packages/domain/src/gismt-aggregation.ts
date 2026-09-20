import { DomainError } from "./errors.js";
import { parseKmSegments } from "./gs1/km.js";
import { formatSsccWithAi } from "./gs1/sscc.js";

export interface GismtAggregationBox {
  sscc: string;
  codes: readonly string[];
}

/**
 * A pallet aggregate: its own SSCC plus the SSCCs of the boxes stacked on it.
 * Rendered as a second `pack_content` whose children are `<sscc>`, never
 * `<cis>` -- the boxes it names are aggregated elsewhere, in their OWN
 * `pack_content` blocks (see the ordering note on `renderGismtAggregationXml`).
 */
export interface GismtAggregationPallet {
  sscc: string;
  boxSsccs: readonly string[];
}

/**
 * The document-level facts the `Формирование упаковки` XSD (v1.03) demands as
 * attributes. Every one of them is `use="required"`, so a document that omits
 * any is rejected by the ЧЗ portal with «Передаваемый файл XML не
 * соответствует XSD-схеме» before its contents are read at all.
 *
 * `organizationInn` is NOT here: it stays a top-level render input because a
 * caller that has no document metadata yet still has to fail on a missing INN
 * for its own reasons.
 */
export interface GismtAggregationDocument {
  /** `document_id` -- identifies the FILE. Unique per submitted file. */
  documentId: string;
  /** `document_number` -- the participant's own document number. */
  documentNumber: string;
  /** `file_date_time` -- canonical ISO instant the file was formed. */
  fileDateTime: string;
  /** `operation_date_time` -- canonical ISO instant the aggregation happened. */
  operationDateTime: string;
  /** `org_name` -- the participant's full name. */
  organizationName: string;
}

export interface GismtAggregationRenderResult {
  bytes: Uint8Array;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
}

export const GISMT_AGGREGATION_OVERHEAD_LINE_COUNT = 10;

export type GismtAggregationErrorCode =
  | "ORG_INN_MISSING"
  | "INVALID_ORG_INN"
  | "INVALID_DOCUMENT_METADATA"
  | "INVALID_SSCC"
  | "INVALID_CIS";

export class GismtAggregationError extends Error {
  constructor(readonly code: GismtAggregationErrorCode) {
    super(code);
    this.name = "GismtAggregationError";
  }
}

const textEncoder = new TextEncoder();
const XML_PROHIBITED_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function gismtAggregationBoxLineCount(box: GismtAggregationBox): number {
  return 3 + box.codes.length;
}

/** The open/close wrapper lines plus one `<sscc>` line per member box. */
export function gismtAggregationPalletLineCount(pallet: GismtAggregationPallet): number {
  return 3 + pallet.boxSsccs.length;
}

export function renderGismtAggregationXml(input: {
  organizationInn: string;
  document: GismtAggregationDocument;
  boxes: readonly GismtAggregationBox[];
  pallets?: readonly GismtAggregationPallet[];
}): GismtAggregationRenderResult {
  const organizationInn = input.organizationInn.trim();
  if (organizationInn === "") throw new GismtAggregationError("ORG_INN_MISSING");
  // `LP_TIN_type` is the ten-digit legal-entity form. A twelve-digit sole
  // proprietor INN belongs under `SP_info`, which this renderer does not
  // emit (it has no surname/first name to put there), so such a tenant is
  // refused here rather than handed a file the portal will reject.
  if (!/^(?:\d[1-9]|[1-9]\d)\d{8}$/.test(organizationInn)) {
    throw new GismtAggregationError("INVALID_ORG_INN");
  }
  const document = validateDocument(input.document);

  const pallets = input.pallets ?? [];

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<unit_pack document_id="${xmlAttribute(document.documentId)}" VerForm="1.03" file_date_time="${xmlAttribute(document.fileDateTime)}" action_id="30" version="1">`,
    `    <Document operation_date_time="${xmlAttribute(document.operationDateTime)}" document_number="${xmlAttribute(document.documentNumber)}">`,
    "        <organisation>",
    "            <id_info>",
    `                <LP_info org_name="${xmlAttribute(document.organizationName)}" LP_TIN="${xmlAttribute(organizationInn)}" />`,
    "            </id_info>",
    "        </organisation>",
    ...input.boxes.flatMap((box) => [
      "        <pack_content>",
      `            <pack_code>${xmlText(formatGismtAggregationSscc(box.sscc))}</pack_code>`,
      ...box.codes.map((code) => `            <cis>${xmlText(stripKmCryptoTail(code))}</cis>`),
      "        </pack_content>",
    ]),
    // Boxes first, pallets last. An aggregate cannot be nested before it
    // exists, and the parts of a split document are submitted in
    // part-number order -- so a pallet naming a box SSCC must never precede
    // that box's own pack_content. The XSD permits either child (`cis` or
    // `sscc`) under pack_content; the ORDER is ours to get right.
    ...pallets.flatMap((pallet) => [
      "        <pack_content>",
      `            <pack_code>${xmlText(formatGismtAggregationSscc(pallet.sscc))}</pack_code>`,
      ...pallet.boxSsccs.map(
        (sscc) => `            <sscc>${xmlText(formatGismtAggregationSscc(sscc))}</sscc>`,
      ),
      "        </pack_content>",
    ]),
    "    </Document>",
    "</unit_pack>",
  ];

  return {
    bytes: textEncoder.encode(`${lines.join("\n")}\n`),
    physicalLineCount:
      GISMT_AGGREGATION_OVERHEAD_LINE_COUNT +
      input.boxes.reduce((count, box) => count + gismtAggregationBoxLineCount(box), 0) +
      pallets.reduce((count, pallet) => count + gismtAggregationPalletLineCount(pallet), 0),
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

/**
 * Trims and checks every document attribute against the XSD's own limits:
 * `document_id` and `document_number` are 1..150, `org_name` is 1..1000, and
 * both timestamps must satisfy `datetimeoffset` -- for which a canonical
 * `toISOString()` value is the safe subset.
 */
function validateDocument(document: GismtAggregationDocument): GismtAggregationDocument {
  const documentId = document.documentId.trim();
  const documentNumber = document.documentNumber.trim();
  const organizationName = document.organizationName.trim();

  if (
    !isWithinLength(documentId, 150) ||
    !isWithinLength(documentNumber, 150) ||
    !isWithinLength(organizationName, 1000) ||
    !isCanonicalIsoTimestamp(document.fileDateTime) ||
    !isCanonicalIsoTimestamp(document.operationDateTime)
  ) {
    throw new GismtAggregationError("INVALID_DOCUMENT_METADATA");
  }

  return {
    documentId,
    documentNumber,
    organizationName,
    fileDateTime: document.fileDateTime,
    operationDateTime: document.operationDateTime,
  };
}

function isWithinLength(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && !XML_PROHIBITED_CHARACTERS.test(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function stripKmCryptoTail(code: string): string {
  try {
    const segments = parseKmSegments(code);
    const cis = `01${segments.gtin14}21${segments.serial}`;
    if (XML_PROHIBITED_CHARACTERS.test(cis)) throw new GismtAggregationError("INVALID_CIS");
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
