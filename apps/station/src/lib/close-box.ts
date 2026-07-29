import { buildSscc } from "@markiro/domain";
import { closeBox, currentBox } from "./boxes.js";
import type { SqlExecutor } from "./mirror.js";
import { burnSerial } from "./sscc-pool.js";

/**
 * Extension digit reserved for transport-box serial ranges. Pallet ranges
 * (slice 06d) use 1 -- see `sscc-pool.ts`'s doc comment on why the two must
 * never mix.
 */
const BOX_EXTENSION_DIGIT = 0;

export type CloseBoxResult =
  | { status: "closed"; sscc: string; itemCount: number }
  | { status: "no-serials" }
  | { status: "empty" };

export interface CloseBoxDeps {
  exec: SqlExecutor;
  /** This device's 9-digit GS1 issuer prefix (`StationBundle.sscc.issuerPrefix`). */
  issuerPrefix: string;
  /** Epoch millis; overridable so tests don't depend on the wall clock. */
  now?: () => number;
}

/**
 * Closes the shift's current open box: burns one serial from this device's
 * local pool, builds the box's SSCC, and writes both onto `boxes_mirror`.
 *
 * Refuses -- burning nothing -- for two distinct, non-exceptional reasons a
 * caller must tell apart: `empty` (no box is open, or the open box has no
 * items scanned into it yet) and `no-serials` (this issuer prefix's pool is
 * dry). Both happen routinely on a factory floor: an operator closes an
 * empty box by mistake, or the server's grant runs out before restock. The
 * emptiness check runs BEFORE burning, so an empty box never costs a
 * serial, and the serial is burned only once `burnSerial` itself succeeds --
 * never pre-emptively -- so a box abandoned mid-shift (operator error,
 * shift end) also costs nothing. This is why the serial is burned here, at
 * close, and not when the box was opened.
 */
export async function closeCurrentBox(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
): Promise<CloseBoxResult> {
  const box = await currentBox(deps.exec, shiftId);
  if (!box || box.itemCount === 0) return { status: "empty" };

  const serial = await burnSerial(deps.exec, deps.issuerPrefix, BOX_EXTENSION_DIGIT);
  if (serial === null) return { status: "no-serials" };

  const sscc = buildSscc(BOX_EXTENSION_DIGIT, deps.issuerPrefix, serial);
  const closedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  await closeBox(deps.exec, box.boxId, sscc, closedAt, operatorId);

  return { status: "closed", sscc, itemCount: box.itemCount };
}
