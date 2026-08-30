import { compareText } from "../document-text-encoding.js";
import { DomainError } from "../errors.js";
import { GismtAggregationError, renderGismtAggregationXml } from "../gismt-aggregation.js";
import { parseKmSegments } from "../gs1/km.js";
import { formatSsccWithAi } from "../gs1/sscc.js";
import { selectEligibleInventoryFinalBoxes } from "./document-selection.js";

export interface InventoryDocumentGenerationMetadata {
  documentId: string;
  inventoryNumber: string;
  fileDateTime: string;
  operationDateTime: string;
  organizationName: string;
  organizationInn: string;
}

export interface InventoryDocumentGenerationSource {
  writeOffCandidates: readonly { codeHash: string; canonicalRaw: string }[];
  verified: readonly {
    codeHash: string;
    canonicalRaw: string;
    observedProductionDate: string | null;
  }[];
  protected: readonly { codeHash: string; canonicalRaw: string; parentSscc: string | null }[];
  oldBoxes: readonly { sscc: string }[];
  newBoxes: readonly {
    sscc: string;
    oldSsccContext: string | null;
    state: "open" | "closed" | "invalidated";
    printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
    productionDate: string;
    codeHashes: readonly string[];
  }[];
}

export interface InventoryDocumentGeneratedPart {
  partNumber: number;
  filename: string;
  mimeType:
    | "application/pdf"
    | "application/xml; charset=utf-8"
    | "text/csv; charset=utf-8"
    | "text/plain; charset=utf-8";
  bytes: Uint8Array;
  rowCount: number;
  codeCount: number;
  boxCount: number;
}

export type InventoryDocumentGenerationErrorCode =
  | "EMPTY_SOURCE"
  | "INVALID_CIS"
  | "INVALID_DOCUMENT_METADATA"
  | "INVALID_ORGANIZATION_INN"
  | "INVALID_SSCC"
  | "VERIFIED_PRODUCTION_DATE_MISSING";

export class InventoryDocumentGenerationError extends Error {
  constructor(readonly code: InventoryDocumentGenerationErrorCode) {
    super(code);
    this.name = "InventoryDocumentGenerationError";
  }
}

const XML_MIME_TYPE = "application/xml; charset=utf-8" as const;
const encoder = new TextEncoder();
const XML_PROHIBITED =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function generateInventoryAggregationXml(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  validateAggregationMetadata(metadata);
  const boxes = frozenAggregationV1Boxes(source);
  const filename = `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-aggregation.xml`;
  if (boxes.length === 0) {
    return [emptyPart(filename)];
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<unit_pack document_id="${xmlAttribute(metadata.documentId)}" VerForm="1.03" file_date_time="${xmlAttribute(metadata.fileDateTime)}" action_id="30" version="1">`,
    `    <Document operation_date_time="${xmlAttribute(metadata.operationDateTime)}" document_number="${xmlAttribute(metadata.inventoryNumber)}">`,
    "        <organisation>",
    "            <id_info>",
    `                <LP_info org_name="${xmlAttribute(metadata.organizationName)}" LP_TIN="${metadata.organizationInn}" />`,
    "            </id_info>",
    "        </organisation>",
    ...boxes.flatMap((box) => [
      "        <pack_content>",
      `            <pack_code>${box.sscc}</pack_code>`,
      ...box.codes.map((code) => `            <cis>${xmlText(code)}</cis>`),
      "        </pack_content>",
    ]),
    "    </Document>",
    "</unit_pack>",
  ];
  return [
    part(
      filename,
      lines,
      boxes.reduce((count, box) => count + box.codes.length, 0),
      boxes.length,
    ),
  ];
}

export function generateInventoryAggregationXmlV2(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  validateAggregationMetadata(metadata);
  const boxes = selectEligibleInventoryFinalBoxes(source);
  const filename = `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-aggregation.xml`;
  if (boxes.length === 0) {
    return [emptyPart(filename)];
  }

  try {
    const rendered = renderGismtAggregationXml({
      organizationInn: metadata.organizationInn,
      boxes: boxes.map((box) => ({
        sscc: box.sscc,
        codes: box.codes.map((code) => code.canonicalRaw),
      })),
    });
    return [
      {
        partNumber: 1,
        filename,
        mimeType: XML_MIME_TYPE,
        bytes: rendered.bytes,
        rowCount: rendered.physicalLineCount,
        codeCount: rendered.codeCount,
        boxCount: rendered.boxCount,
      },
    ];
  } catch (error) {
    if (error instanceof GismtAggregationError) {
      throw new InventoryDocumentGenerationError(
        error.code === "INVALID_CIS"
          ? "INVALID_CIS"
          : error.code === "INVALID_SSCC"
            ? "INVALID_SSCC"
            : "INVALID_ORGANIZATION_INN",
      );
    }
    throw error;
  }
}

export function generateInventoryDisaggregationXml(
  source: InventoryDocumentGenerationSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryDocumentGeneratedPart[] {
  validateCommonMetadata(metadata);
  if (!isParticipantInn(metadata.organizationInn)) {
    throw new InventoryDocumentGenerationError("INVALID_ORGANIZATION_INN");
  }
  const protectedParents = new Set(
    source.protected.flatMap((code) => (code.parentSscc === null ? [] : [code.parentSscc])),
  );
  const boxes = [
    ...new Set(selectEligibleInventoryFinalBoxes(source).map((box) => box.oldSsccContext)),
  ]
    .filter((sscc): sscc is string => sscc !== null)
    .filter((sscc) => !protectedParents.has(sscc))
    .sort(compareText)
    .map(validateSscc);
  const filename = `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-disaggregation.xml`;
  if (boxes.length === 0) {
    return [emptyPart(filename)];
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<disaggregation action_id="31" version="2">',
    `    <trade_participant_inn>${metadata.organizationInn}</trade_participant_inn>`,
    "    <packings_list>",
    ...boxes.flatMap((sscc) => [
      "        <packing>",
      `            <kitu><![CDATA[${sscc}]]></kitu>`,
      "        </packing>",
    ]),
    "    </packings_list>",
    "</disaggregation>",
  ];
  return [part(filename, lines, 0, boxes.length)];
}

function frozenAggregationV1Boxes(source: InventoryDocumentGenerationSource): {
  sscc: string;
  oldSsccContext: string | null;
  codes: string[];
}[] {
  const protectedHashes = new Set(source.protected.map((code) => code.codeHash));
  const verified = new Map(source.verified.map((code) => [code.codeHash, code.canonicalRaw]));
  return [...source.newBoxes]
    .sort((left, right) => compareText(left.sscc, right.sscc))
    .flatMap((box) => {
      if (
        box.state !== "closed" ||
        box.printState !== "printed" ||
        box.codeHashes.length === 0 ||
        box.codeHashes.some((hash) => protectedHashes.has(hash) || !verified.has(hash))
      ) {
        return [];
      }
      const codes: string[] = [];
      for (const hash of [...box.codeHashes].sort(compareText)) {
        const canonicalRaw = verified.get(hash);
        if (canonicalRaw === undefined) {
          throw new InventoryDocumentGenerationError("INVALID_CIS");
        }
        codes.push(stripKmCryptoTail(canonicalRaw));
      }
      return [{ sscc: formatSscc(box.sscc), oldSsccContext: box.oldSsccContext, codes }];
    });
}

function part(
  filename: string,
  lines: readonly string[],
  codeCount: number,
  boxCount: number,
): InventoryDocumentGeneratedPart {
  return {
    partNumber: 1,
    filename,
    mimeType: XML_MIME_TYPE,
    bytes: encoder.encode(`${lines.join("\n")}\n`),
    rowCount: lines.length,
    codeCount,
    boxCount,
  };
}

/**
 * A valid "empty" XML document does not exist for these ЧЗ schemas (both
 * `pack_content` and `packing` are `minOccurs="1"`), so zero actionable
 * boxes render a genuine zero-byte artifact instead of a schema-invalid
 * skeleton root element — matching the precedent set by the zero-byte TXT
 * formats.
 */
function emptyPart(filename: string): InventoryDocumentGeneratedPart {
  return {
    partNumber: 1,
    filename,
    mimeType: XML_MIME_TYPE,
    bytes: new Uint8Array(0),
    rowCount: 0,
    codeCount: 0,
    boxCount: 0,
  };
}

function validateAggregationMetadata(metadata: InventoryDocumentGenerationMetadata): void {
  validateCommonMetadata(metadata);
  if (!/^(?:\d[1-9]|[1-9]\d)\d{8}$/.test(metadata.organizationInn)) {
    throw new InventoryDocumentGenerationError("INVALID_ORGANIZATION_INN");
  }
}

function validateCommonMetadata(metadata: InventoryDocumentGenerationMetadata): void {
  if (
    metadata.documentId.trim().length === 0 ||
    metadata.documentId.length > 150 ||
    metadata.inventoryNumber.trim().length === 0 ||
    metadata.inventoryNumber.length > 150 ||
    metadata.organizationName.trim().length === 0 ||
    metadata.organizationName.length > 1000 ||
    !isCanonicalIsoTimestamp(metadata.fileDateTime) ||
    !isCanonicalIsoTimestamp(metadata.operationDateTime) ||
    [metadata.documentId, metadata.inventoryNumber, metadata.organizationName].some((value) =>
      XML_PROHIBITED.test(value),
    )
  ) {
    throw new InventoryDocumentGenerationError("INVALID_DOCUMENT_METADATA");
  }
}

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

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validateSscc(value: string): string {
  if (!/^\d{18}$/.test(value)) throw new InventoryDocumentGenerationError("INVALID_SSCC");
  return value;
}

function formatSscc(value: string): string {
  try {
    return formatSsccWithAi(validateSscc(value));
  } catch (error) {
    if (error instanceof DomainError || error instanceof InventoryDocumentGenerationError) {
      throw new InventoryDocumentGenerationError("INVALID_SSCC");
    }
    throw error;
  }
}

function stripKmCryptoTail(code: string): string {
  try {
    const parsed = parseKmSegments(code);
    const cis = `01${parsed.gtin14}21${parsed.serial}`;
    if (XML_PROHIBITED.test(cis)) throw new InventoryDocumentGenerationError("INVALID_CIS");
    return cis;
  } catch (error) {
    if (error instanceof DomainError || error instanceof InventoryDocumentGenerationError) {
      throw new InventoryDocumentGenerationError("INVALID_CIS");
    }
    throw error;
  }
}

export function inventoryDocumentFilenamePrefix(inventoryNumber: string): string {
  const sanitized = inventoryNumber
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `inventory-${sanitized || "document"}`;
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string): string {
  return xmlText(value).replaceAll('"', "&quot;");
}
