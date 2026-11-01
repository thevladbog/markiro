import { classifyScan, kmHash, parseShiftTaskBarcode } from "@markiro/domain";

import {
  officeSearchRequestSchema,
  type OfficeSearchRequest,
  type OfficeSearchTarget,
} from "../../host/office-search.js";
import { shiftCardPath } from "../shifts/shift-card.js";

export type SearchReading =
  { ok: true; request: OfficeSearchRequest } | { ok: false; reason: "empty" | "invalid" };

export function readOfficeSearch(raw: string): SearchReading {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (raw.length > 4096 || raw.includes("\uFFFD")) return { ok: false, reason: "invalid" };
  const token = text.replace(/^\][A-Za-z][0-9]/, "");
  const shift = parseShiftTaskBarcode(token);
  if (shift !== null) return { ok: true, request: { kind: "shift", id: shift } };
  if (token.startsWith("markiro:")) return { ok: false, reason: "invalid" };
  const scan = classifyScan(text);
  if (scan.kind === "km") return { ok: true, request: { kind: "code", codeHash: kmHash(scan.km) } };
  if (scan.kind === "sscc") return { ok: true, request: { kind: "sscc", sscc: scan.sscc } };
  if (scan.kind === "gtin") return { ok: true, request: { kind: "gtin", gtin14: scan.gtin14 } };
  // A failed barcode parse must not expose a marking code through metadata text.
  // This only blocks the fallback; domain classification owns barcode validation.
  if (/^(?:01(?:\d{14}|.{14}21)|\(01\))/u.test(token)) return { ok: false, reason: "invalid" };
  const query = officeSearchRequestSchema.safeParse({ kind: "text", text });
  return query.success ? { ok: true, request: query.data } : { ok: false, reason: "invalid" };
}

export function officeSearchHref(target: OfficeSearchTarget): string {
  const id = (value: string) => encodeURIComponent(value);
  switch (target.kind) {
    case "shift":
      return target.source === "cloud"
        ? `/cloud-shifts/${id(target.id)}`
        : shiftCardPath(target.id);
    case "box":
      return target.source === "cloud"
        ? `/cloud-boxes/${id(target.id)}`
        : `/codes/box/${id(target.id)}`;
    case "pallet":
      return target.source === "cloud"
        ? `/cloud-pallets/${id(target.id)}`
        : `/codes/pallet/${id(target.id)}`;
    case "warehouse_pallet":
      return `/codes/warehouse-pallet/${id(target.id)}`;
    case "product":
      return `/products?product=${id(target.id)}`;
    case "disaggregation":
      return `/disaggregation/${id(target.id)}`;
    case "code":
      return `/codes?${new URLSearchParams({ codeHash: target.codeHash, source: target.source, period: "all" })}`;
    case "document": {
      if (target.targetType === "shift" && target.source === "local")
        return shiftCardPath(target.targetId, { tab: "exports" });
      const kind =
        target.targetType === "disaggregation_document" ? "disaggregation" : target.targetType;
      const owner =
        kind === "warehouse_pallet" || kind === "disaggregation"
          ? ({ kind, id: target.targetId } as const)
          : ({ kind, id: target.targetId, source: target.source } as const);
      return `${officeSearchHref(owner)}#stored-files`;
    }
  }
}
