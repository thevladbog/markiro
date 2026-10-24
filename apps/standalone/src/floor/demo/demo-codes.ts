import { z } from "zod";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { scannedCode } from "../facts.js";
import { readScan } from "../work/scan-pipeline.js";

/**
 * The wizard's demo data on the station (spec 2026-10-21): a demo shift's number is drawn from
 * the host's `DEMO` counter (decision Д3), so the number alone says it — on a planned copy, a
 * card of the hub and the header alike.
 */
export const DEMO_SHIFT_PREFIX = "DEMO-";

export function isDemoShiftNumber(number: string | null | undefined): boolean {
  return number?.startsWith(DEMO_SHIFT_PREFIX) ?? false;
}

/** The group separator a code of marking carries between its parts. */
const GS = "\u001d";

/**
 * Demo code of marking `n` (from 1) of the demo product: AI 01 the GTIN, AI 21 a serial
 * `DEMO` + 9 digits, then the crypto tail's AI 91 and 92 behind group separators, as a real
 * code reads. It is no code of any real product (the GTIN is of restricted circulation) and
 * goes into no document for ГИС МТ.
 */
export function demoMarkingCode(gtin14: string, n: number): string {
  const number = String(n).padStart(9, "0");
  const signature = `DEMOSIGNATURE${number}`.padEnd(44, "A");
  return `01${gtin14}21DEMO${number}${GS}91DEMO${GS}92${signature}`;
}

/** How many demo codes the button walks before it gives up: far beyond any demo shift. */
export const MAX_DEMO_CODES = 9_999;

const usedRow = z.object({ used: z.number() });

/**
 * The first demo code this station holds no scan of (`floor_codes` of the pairing, any shift):
 * «Демо-код» never offers a code the station already took. `null` past `MAX_DEMO_CODES`.
 */
export async function nextDemoCode(
  local: LocalExecutor,
  pairing: Pairing,
  gtin14: string,
): Promise<string | null> {
  for (let n = 1; n <= MAX_DEMO_CODES; n += 1) {
    const raw = demoMarkingCode(gtin14, n);
    const reading = readScan(raw);
    if (reading.kind !== "km") return null;
    const used = await local.query(
      "SELECT 1 AS used FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ?",
      [pairing.hostId, pairing.deviceId, scannedCode(reading.km).codeHash],
      usedRow,
    );
    if (used.length === 0) return raw;
  }
  return null;
}
