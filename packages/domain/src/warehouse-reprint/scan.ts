import { isValidSscc, parseScannedSscc } from "../gs1/sscc.js";
import { kmHash } from "../gs1/km.js";
import { classifyScan } from "../scan/classify.js";
import { compareDuplicateKm } from "../product-labels/km.js";

export type WarehouseScanRepair = "legacy_tspl_fnc1_literal";
export type WarehouseReprintScan =
  | { kind: "box"; sscc: string; repair: WarehouseScanRepair | null }
  | { kind: "unit"; codeHash: string }
  | { kind: "invalid" };

/** Recovery of a known historical printer defect, limited to reprint lookup. */
export function resolveWarehouseReprintScan(raw: string): WarehouseReprintScan {
  const trimmed = raw.trim();
  const legacy = /^(?:\]C[01])?!100(\d{18})$/.exec(trimmed);
  const sscc = legacy?.[1];
  if (sscc && isValidSscc(sscc)) return { kind: "box", sscc, repair: "legacy_tspl_fnc1_literal" };
  if (/^(?:\]C[01])?!1/.test(trimmed)) return { kind: "invalid" };
  const scan = classifyScan(raw);
  if (scan.kind === "sscc") return { kind: "box", sscc: scan.sscc, repair: null };
  if (scan.kind === "km") return { kind: "unit", codeHash: kmHash(scan.km) };
  return { kind: "invalid" };
}

/** The damaged old label must never verify the corrected physical output. */
export function compareWarehouseReprintLabel(
  expected: { kind: "box"; sscc: string } | { kind: "unit"; canonicalRaw: string },
  raw: string,
): "match" | "mismatch" | "invalid" {
  if (expected.kind === "unit") return compareDuplicateKm(expected.canonicalRaw, raw);
  const sscc = parseScannedSscc(raw.trim());
  return sscc === null ? "invalid" : sscc === expected.sscc ? "match" : "mismatch";
}
