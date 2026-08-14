import { buildSscc, DomainError } from "@markiro/domain";
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
  | { status: "empty" }
  /**
   * CodeRabbit PR33 review, Finding 4: the burned serial cannot be turned
   * into a valid SSCC -- `buildSscc` threw `SSCC_RANGE`. This can only
   * happen if this device's local pool holds a range that reaches beyond
   * the issuer prefix's own capacity, which should never occur once the
   * server-side allocation fix (`SsccService.allocate`) is in place; this
   * is defense in depth for a range mirrored before that fix, or a
   * corrupted local pool. The serial that produced this is already burned
   * -- `burnSerial` is one atomic SQL statement, by design (see its own doc
   * comment), so there is no clean way to give it back -- and is accepted
   * as lost, the same way an abandoned box already costs a burned serial.
   * Surfaced as its own status so the caller can tell the operator plainly,
   * rather than a silent `console.error` repeating on every retry until the
   * whole (invalid) block is exhausted.
   */
  | { status: "invalid-serial" };

export interface CloseBoxDeps {
  exec: SqlExecutor;
  /** This device's 9-digit GS1 issuer prefix (`StationBundle.sscc.issuerPrefix`). */
  issuerPrefix: string;
  /** Epoch millis; overridable so tests don't depend on the wall clock. */
  now?: () => number;
}

/**
 * Closes the shift's current open box: burns one serial from this device's
 * local pool, builds the box's SSCC, and writes the identity, closure, and
 * pending print state onto `boxes_mirror` in one SQLite statement.
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

  let sscc: string;
  try {
    sscc = buildSscc(BOX_EXTENSION_DIGIT, deps.issuerPrefix, serial);
  } catch (err) {
    if (err instanceof DomainError && err.code === "SSCC_RANGE") {
      // See `invalid-serial`'s own doc comment above: the serial is already
      // burned and cannot be un-burned, and this box's row is left untouched
      // (still open, no sscc/closedAt written) so the operator can simply
      // try closing it again.
      return { status: "invalid-serial" };
    }
    throw err;
  }
  const closedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  await closeBox(deps.exec, box.boxId, sscc, closedAt, operatorId);

  return { status: "closed", sscc, itemCount: box.itemCount };
}
