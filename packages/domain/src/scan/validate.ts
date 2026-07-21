import { kmKey } from "../gs1/km.js";
import { classifyScan } from "./classify.js";

export type ScanVerdict =
  | { status: "ok"; key: string }
  | { status: "duplicate"; key: string }
  | { status: "wrong_gtin"; expectedGtin14: string; actualGtin14: string }
  | { status: "invalid"; raw: string };

export interface ShiftScanContext {
  expectedGtin14: string;
  /** Injected dedup lookup: SQLite on the station, Postgres on the server. */
  isDuplicate(key: string): boolean;
}

export function validateShiftScan(raw: string, ctx: ShiftScanContext): ScanVerdict {
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { status: "invalid", raw };
  if (scan.km.gtin14 !== ctx.expectedGtin14) {
    return {
      status: "wrong_gtin",
      expectedGtin14: ctx.expectedGtin14,
      actualGtin14: scan.km.gtin14,
    };
  }
  const key = kmKey(scan.km);
  return ctx.isDuplicate(key)
    ? { status: "duplicate", key }
    : { status: "ok", key };
}
