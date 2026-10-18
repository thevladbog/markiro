import type { SsccCounter } from "../../host/protocol.js";

/**
 * Whether a counter has no serial left: the host moves it past its last
 * serial when it issues the last block (`nextSerial` = `maxSerial` + 1), and
 * then answers `sscc_exhausted`. Nothing can move it on.
 */
export function isExhausted(counter: Pick<SsccCounter, "nextSerial" | "maxSerial">): boolean {
  return counter.nextSerial > counter.maxSerial;
}

/** The i18n key naming what a counter numbers: extension 0 boxes, 1 pallets. */
export function counterKindKey(counter: Pick<SsccCounter, "extension">): string {
  if (counter.extension === 0) return "office.sscc.kinds.box";
  if (counter.extension === 1) return "office.sscc.kinds.pallet";
  return "office.sscc.kinds.other";
}
