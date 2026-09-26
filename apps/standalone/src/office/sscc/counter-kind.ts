import type { SsccCounter } from "../../host/protocol.js";

/** The i18n key naming what a counter numbers: extension 0 boxes, 1 pallets. */
export function counterKindKey(counter: Pick<SsccCounter, "extension">): string {
  if (counter.extension === 0) return "office.sscc.kinds.box";
  if (counter.extension === 1) return "office.sscc.kinds.pallet";
  return "office.sscc.kinds.other";
}
