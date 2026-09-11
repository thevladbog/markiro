import { buildSscc, DomainError } from "@markiro/domain";
import { closeBox, currentBox } from "./boxes.js";
import { closeCurrentPallet, type ClosePalletResult } from "./close-pallet.js";
import type { SqlExecutor } from "./mirror.js";
import { currentPallet, joinPallet, openPallet } from "./pallets.js";
import { burnSerial } from "./sscc-pool.js";

/**
 * Extension digit reserved for transport-box serial ranges. Pallet ranges
 * (slice 06d) use 1 -- see `sscc-pool.ts`'s doc comment on why the two must
 * never mix.
 */
const BOX_EXTENSION_DIGIT = 0;

/**
 * Returned by `closeCurrentBox` so the caller knows whether to print a
 * pallet label too. `closedAt` is the exact timestamp written to
 * `boxes_mirror.closed_at`, returned so the caller stamps the label from
 * the box's OWN closure moment rather than calling `new Date()` again at
 * render time. A later recovery print reads the same value back off the row
 * (`findUnresolvedBoxPrint`), so both labels for one SSCC always carry the
 * same «Дата производства» and «Годен до».
 *
 * `pallet` is non-null exactly when this box's closure also closed (or
 * tried to close) the pallet it just joined -- i.e. this was the box that
 * brought the pallet to capacity. It is null both when the shift has no
 * pallets (`palletBoxCapacity === null`) and when the box joined a pallet
 * that is still below capacity.
 */
export interface CloseBoxResultClosed {
  status: "closed";
  sscc: string;
  itemCount: number;
  closedAt: string;
  pallet: ClosePalletResult | null;
}

export type CloseBoxResult =
  | CloseBoxResultClosed
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
  /**
   * The shift's pallet capacity in boxes (`shift_mirror.palletBoxCapacity`),
   * or null when the shift has no pallets at all. This is the ONLY signal
   * `closeCurrentBox` uses to decide whether a closed box joins a pallet --
   * there is no separate `palletsEnabled` flag here, mirroring the server's
   * own shape where a non-null capacity already implies pallets are on.
   */
  palletBoxCapacity: number | null;
  /**
   * This device's current terminal id, stamped onto a pallet it opens
   * (`openPallet`'s own `terminalId` column) -- the pallet equivalent of
   * `openBox`'s `terminalId` capture, and read back by
   * `findUnresolvedPalletPrint` the same way.
   */
  terminalId: string | null;
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

  // A box joins a pallet at CLOSE, never at open: an open box is not yet on
  // any physical stack.
  let pallet: ClosePalletResult | null = null;
  if (deps.palletBoxCapacity !== null) {
    let open = await currentPallet(deps.exec, shiftId);
    if (open === null) {
      const palletId = await openPallet(deps.exec, shiftId, deps.terminalId, closedAt);
      open = {
        palletId,
        shiftId,
        terminalId: deps.terminalId,
        openedAt: closedAt,
        boxCount: 0,
      };
    }
    await joinPallet(deps.exec, box.boxId, open.palletId);
    if (open.boxCount + 1 >= deps.palletBoxCapacity) {
      pallet = await closeCurrentPallet(deps, shiftId, operatorId);
      // `no-serials` leaves this same pallet open and over capacity. The next
      // box joins it rather than opening a second one nobody can number, and
      // it closes as soon as a bundle brings a block. Exhaustion blocks
      // closing a pallet, never scanning -- the box rule one level up.
    }
  }

  return { status: "closed", sscc, itemCount: box.itemCount, closedAt, pallet };
}
