import { GismtAggregationError, renderGismtAggregationXml } from "./gismt-aggregation.js";
import {
  sanitizeShiftExportFilenameSegment,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "./shift-exports.js";

export type PalletExportFormatId = "pallet_xml_gismt_aggregation";

export interface PalletExportFormatDescriptor {
  id: PalletExportFormatId;
  version: 1;
  label: string;
  extension: "xml";
  mimeType: "application/xml; charset=utf-8";
}

/**
 * One pallet → its box SSCCs, as a GIS MT aggregation document. The boxes'
 * own unit codes are NOT repeated: they were reported by their shifts'
 * aggregation exports, and a second `<cis>` aggregation of the same codes
 * would be a second aggregation of those units.
 */
export const PALLET_EXPORT_FORMATS = Object.freeze([
  Object.freeze({
    id: "pallet_xml_gismt_aggregation",
    version: 1,
    label: "[XML][ГИСМТ] Агрегация паллеты",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
  } as const),
] as const satisfies readonly PalletExportFormatDescriptor[]);

export function getPalletExportFormat(
  formatId: string,
  formatVersion: number,
): PalletExportFormatDescriptor {
  const descriptor = PALLET_EXPORT_FORMATS.find(
    (candidate) => candidate.id === formatId && candidate.version === formatVersion,
  );
  if (!descriptor) throw new ShiftExportDomainError("FORMAT_NOT_FOUND");
  return descriptor;
}

export interface RenderPalletAggregationExportInput {
  formatId: PalletExportFormatId;
  formatVersion: number;
  organizationInn: string | null;
  productName: string;
  /** Civil date the pallet closed, YYYY-MM-DD, for the filename. */
  closedDate: string;
  pallet: { sscc: string; boxSsccs: readonly string[] };
}

export function renderPalletAggregationExport(
  input: RenderPalletAggregationExportInput,
): ShiftExportPart {
  const descriptor = getPalletExportFormat(input.formatId, input.formatVersion);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.closedDate)) throw new Error("Invalid closed date");
  if (input.pallet.boxSsccs.length === 0) throw new ShiftExportDomainError("EMPTY_SOURCE");
  const organizationInn = input.organizationInn?.trim() ?? "";
  if (organizationInn === "") throw new ShiftExportDomainError("ORG_INN_MISSING");

  let rendered;
  try {
    rendered = renderGismtAggregationXml({
      organizationInn,
      // No `boxes`: this document aggregates BOXES ONTO A PALLET, never units
      // into a box, so it carries exactly one `pack_content` and no `<cis>`.
      boxes: [],
      pallets: [{ sscc: input.pallet.sscc, boxSsccs: input.pallet.boxSsccs }],
    });
  } catch (error) {
    if (error instanceof GismtAggregationError) {
      throw new ShiftExportDomainError(
        error.code === "INVALID_SSCC" ? "INVALID_BOX_SSCC" : error.code,
      );
    }
    throw error;
  }

  const boxCount = input.pallet.boxSsccs.length;
  const productName = sanitizeShiftExportFilenameSegment(input.productName);
  return {
    partNumber: 1,
    physicalLineCount: rendered.physicalLineCount,
    // The pallet names boxes, not unit codes; `boxCount` is the pallet's own
    // members, which `renderGismtAggregationXml` counts as 0 because it
    // received no `boxes` of its own.
    codeCount: 0,
    boxCount,
    palletCount: 1,
    filename: `${productName}_${input.closedDate}_паллета_00${input.pallet.sscc}_${boxCount}_коробов.${descriptor.extension}`,
    mimeType: descriptor.mimeType,
    bytes: rendered.bytes,
  };
}
