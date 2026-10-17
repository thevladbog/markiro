import type { PalletPlacardData, PalletReportData } from "@markiro/domain";
import type { CloudPalletRows } from "../../host/cloud-history-read.js";
import { machineSscc } from "./form-data.js";

export function cloudPalletReportData(rows: CloudPalletRows): PalletReportData {
  const { pallet } = rows;
  return {
    sscc: machineSscc(pallet.sscc),
    status:
      pallet.disassembledAt !== null
        ? "disassembled"
        : pallet.closedAt !== null
          ? "closed"
          : "open",
    productName: pallet.productName,
    org: { ...rows.organization, logo: null },
    openedAt: new Date(pallet.openedAt),
    closedAt: pallet.closedAt === null ? null : new Date(pallet.closedAt),
    disassembledAt: pallet.disassembledAt === null ? null : new Date(pallet.disassembledAt),
    boxes: rows.boxes.map(({ pack, units }) => ({
      sscc: machineSscc(pack.sscc),
      codeCount: units,
      disassembledAt: pack.disassembledAt === null ? null : new Date(pack.disassembledAt),
    })),
  };
}

export function cloudPalletPlacardData(rows: CloudPalletRows): PalletPlacardData | null {
  const { pallet } = rows;
  if (pallet.closedAt === null || pallet.sscc === null) return null;
  return {
    sscc: machineSscc(pallet.sscc),
    status: pallet.disassembledAt === null ? "closed" : "disassembled",
    productName: pallet.productName,
    gtin14: pallet.gtin14,
    shelfLifeDays: pallet.shelfLifeDays,
    org: { ...rows.organization, logo: null },
    boxes: rows.boxes.map(({ pack, units, productionDate }) => ({
      productionDate,
      codeCount: units,
      disassembledAt: pack.disassembledAt === null ? null : new Date(pack.disassembledAt),
    })),
  };
}
