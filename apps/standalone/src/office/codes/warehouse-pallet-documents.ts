import {
  renderPalletAggregationExport,
  renderPalletPlacardHtml,
  renderPalletReportHtml,
  type PalletPlacardData,
  type PalletReportData,
  type PlacardFormat,
} from "@markiro/domain";
import type { OfficeWarehousePalletDetail } from "../../host/office-pallet-create.js";
import { civilToday } from "../../lib/civil-date.js";
import { machineSscc } from "../forms/form-data.js";

function date(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}
export function warehousePalletReportData(
  pallet: OfficeWarehousePalletDetail,
  logo: string | null,
): PalletReportData {
  return {
    sscc: machineSscc(pallet.sscc),
    status:
      pallet.disassembledAt !== null
        ? "disassembled"
        : pallet.closedAt !== null
          ? "closed"
          : "open",
    productName: pallet.productName,
    org: { ...pallet.organization, logo },
    openedAt: new Date(pallet.openedAt),
    closedAt: date(pallet.closedAt),
    disassembledAt: date(pallet.disassembledAt),
    boxes: pallet.members.map((box) => ({
      sscc: machineSscc(box.sscc),
      codeCount: box.units,
      disassembledAt: date(box.disassembledAt ?? box.removedAt),
    })),
  };
}
export function warehousePalletPlacardData(
  pallet: OfficeWarehousePalletDetail,
  logo: string | null,
): PalletPlacardData {
  return {
    ...warehousePalletReportData(pallet, logo),
    gtin14: pallet.gtin14,
    shelfLifeDays: pallet.shelfLifeDays,
    boxes: pallet.members.map((box) => ({
      productionDate: box.productionDate,
      codeCount: box.units,
      disassembledAt: date(box.disassembledAt ?? box.removedAt),
    })),
  };
}
export function warehousePalletForm(
  pallet: OfficeWarehousePalletDetail,
  kind: "pallet" | "placard",
  format: PlacardFormat,
  logo: string | null,
) {
  const html =
    kind === "pallet"
      ? renderPalletReportHtml(
          warehousePalletReportData(pallet, logo),
          pallet.organization.timeZone,
        )
      : renderPalletPlacardHtml(warehousePalletPlacardData(pallet, logo), format);
  const demoHtml = html
    .replace(
      "</head>",
      "<style>.warehouse-demo-mark{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%) rotate(-30deg);font-size:90pt;font-weight:700;color:rgba(0,0,0,.16);z-index:10;pointer-events:none;}</style></head>",
    )
    .replace("<body>", '<body><div class="warehouse-demo-mark">ДЕМО</div>');
  return {
    kind,
    fileName: `${pallet.demo ? "DEMO_" : ""}${kind === "pallet" ? "Состав палета" : "Ярлык палета"}_${pallet.sscc ?? pallet.id}.html`,
    html: pallet.demo ? demoHtml : html,
  };
}
export function warehousePalletXml(
  pallet: OfficeWarehousePalletDetail,
  documentId: string,
  generatedAt: string,
) {
  if (pallet.demo) throw new Error("DEMO_SHIFT");
  if (pallet.disassembledAt !== null) throw new Error("PALLET_DISASSEMBLED");
  if (pallet.closedAt === null || pallet.sscc === null) throw new Error("PALLET_NOT_CLOSED");
  return renderPalletAggregationExport({
    formatId: "pallet_xml_gismt_aggregation",
    formatVersion: 1,
    organizationInn: pallet.organization.inn,
    organizationName: pallet.organization.name,
    productName: pallet.productName,
    closedDate: civilToday(pallet.organization.timeZone, new Date(pallet.closedAt)),
    documentId,
    fileDateTime: generatedAt,
    operationDateTime: new Date(pallet.closedAt).toISOString(),
    pallet: {
      sscc: pallet.sscc,
      boxSsccs: pallet.members
        .filter((box) => box.removedAt === null && box.disassembledAt === null && box.sscc !== null)
        .map((box) => box.sscc ?? ""),
    },
  });
}
