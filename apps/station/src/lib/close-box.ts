import { buildSscc, DomainError } from "@markiro/domain";
import { closeBox, currentBox } from "./boxes.js";
import {
  closeCurrentPallet,
  closeCurrentPalletWithOfflineGrant,
  type ClosePalletResult,
} from "./close-pallet.js";
import type { SqlExecutor } from "./mirror.js";
import { currentPallet, openPallet, type DevicePallet } from "./pallets.js";
import { burnSerial } from "./sscc-pool.js";
import type { CredentialGeneration } from "./credential-recovery.js";
import { acquireCredentialCommitLease } from "./credential-recovery.js";
import {
  StationGrantAdmission,
  stationOperatorIsCurrentlyActive,
} from "./offline-grants/admission.js";
import { sampleGrantClock, type GrantClockSample } from "./offline-grants/clock.js";
import { readShiftExecutionProjection } from "./offline-grants/semantic.js";
import { OfflineGrantDeniedError } from "./journal.js";

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
  | { status: "invalid-serial" }
  /**
   * `closeBox`'s `closed_at IS NULL` guard matched nothing: another call
   * already closed THIS box, with a different SSCC (and possibly a
   * different pallet), between the `currentBox` read above and the UPDATE
   * -- a genuine double close, mirroring `closeCurrentPallet`'s own
   * `already-closed` status exactly (see its doc comment in
   * `close-pallet.ts`). Two terminals can race this because the "current
   * box" is scoped by shift only, not by terminal -- unlike a pallet. The
   * serial burned by THIS losing call cannot be un-burned and never reached
   * a stored record, so it is accepted as lost, the same trade
   * `invalid-serial` already makes. If this call opened a fresh, still-empty
   * pallet before losing the race (see `closeCurrentBox`), that pallet is
   * left open: harmless, since `closeCurrentPallet` closes an empty pallet
   * as `empty` without burning a serial, and the next box closed for this
   * shift/terminal reuses it via `currentPallet` rather than opening a
   * second one.
   */
  | { status: "already-closed" };

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
async function closeCurrentBoxLegacy(
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

  // A box joins a pallet at CLOSE, never at open: an open box is not yet on
  // any physical stack. Resolved (or opened) HERE, before `closeBox`, so
  // `pallet_id` lands in the SAME guarded UPDATE as `closed_at` -- see
  // `closeBox`'s own doc comment for why closure and membership must commit
  // as one fact (Task 14 review, Finding 1). This happens after the
  // empty/no-serials/invalid-serial refusals above, all of which return
  // before touching a pallet at all -- exactly as before this fix, so none
  // of them can leave a freshly opened, empty pallet behind. `openPallet`
  // is not wrapped in a try/catch here: `pallets_mirror_open_terminal_uk`
  // still enforces one open pallet per shift/terminal, and a concurrent open
  // racing this same terminal must still surface as a thrown error, not be
  // silently swallowed.
  let joiningPallet: DevicePallet | null = null;
  if (deps.palletBoxCapacity !== null) {
    joiningPallet = await currentPallet(deps.exec, shiftId, deps.terminalId);
    if (joiningPallet === null) {
      const palletId = await openPallet(deps.exec, shiftId, deps.terminalId, closedAt);
      joiningPallet = {
        palletId,
        shiftId,
        terminalId: deps.terminalId,
        openedAt: closedAt,
        boxCount: 0,
        lastBoxSscc: null,
      };
    }
  }

  const closed = await closeBox(
    deps.exec,
    box.boxId,
    sscc,
    closedAt,
    operatorId,
    joiningPallet?.palletId ?? null,
  );
  if (!closed) return { status: "already-closed" };

  let pallet: ClosePalletResult | null = null;
  if (joiningPallet !== null && deps.palletBoxCapacity !== null) {
    if (joiningPallet.boxCount + 1 >= deps.palletBoxCapacity) {
      pallet = await closeCurrentPallet(deps, shiftId, operatorId);
      // `no-serials` leaves this same pallet open and over capacity. The next
      // box joins it rather than opening a second one nobody can number, and
      // it closes as soon as a bundle brings a block. Exhaustion blocks
      // closing a pallet, never scanning -- the box rule one level up.
    }
  }

  return { status: "closed", sscc, itemCount: box.itemCount, closedAt, pallet };
}

/** Legacy entry point cannot bypass an installed grant owner. */
export async function closeCurrentBox(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
): Promise<CloseBoxResult> {
  const [active] = await deps.exec.all<{ active: number }>(
    "SELECT 1 active FROM offline_grant_install_state WHERE id=1",
  );
  if (active?.active === 1) throw new OfflineGrantDeniedError("grant_aware_owner_required");
  return closeCurrentBoxLegacy(deps, shiftId, operatorId);
}

/** Grant-aware box owner: allowance, optional pallet open, serial CAS and close are atomic. */
export async function closeCurrentBoxWithOfflineGrant(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
  generation: CredentialGeneration,
  clock: () => Promise<GrantClockSample> = sampleGrantClock,
): Promise<CloseBoxResult> {
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new OfflineGrantDeniedError("stale_credential");
  try {
    const [state] = await deps.exec.all<{
      tenant_id: string;
      device_id: string;
      owner_kind: "station";
      credential_epoch: number;
    }>(
      "SELECT tenant_id,device_id,owner_kind,credential_epoch FROM offline_grant_install_state WHERE id=1",
    );
    if (!state) return closeCurrentBoxLegacy(deps, shiftId, operatorId);
    if (!operatorId) throw new OfflineGrantDeniedError("operator_unauthorized");
    if (!(await stationOperatorIsCurrentlyActive(deps.exec, operatorId)))
      throw new OfflineGrantDeniedError("operator_unauthorized");
    const box = await currentBox(deps.exec, shiftId);
    if (!box || box.itemCount === 0) return { status: "empty" };
    const [pool] = await deps.exec.all<{ rowid: number; serial: number }>(
      "SELECT rowid,next_serial serial FROM sscc_pool WHERE issuer_prefix=? AND extension_digit=? AND next_serial<=to_serial ORDER BY from_serial LIMIT 1",
      [deps.issuerPrefix, BOX_EXTENSION_DIGIT],
    );
    if (!pool) return { status: "no-serials" };
    let sscc: string;
    try {
      sscc = buildSscc(BOX_EXTENSION_DIGIT, deps.issuerPrefix, pool.serial);
    } catch (error) {
      if (error instanceof DomainError && error.code === "SSCC_RANGE")
        return { status: "invalid-serial" };
      throw error;
    }
    const closedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
    let pallet =
      deps.palletBoxCapacity === null
        ? null
        : await currentPallet(deps.exec, shiftId, deps.terminalId);
    const newPallet =
      deps.palletBoxCapacity !== null && pallet === null
        ? { palletId: crypto.randomUUID(), terminalId: deps.terminalId }
        : null;
    const palletId = pallet?.palletId ?? newPallet?.palletId ?? null;
    const [binding] = await deps.exec.all<{ snapshot_digest: string }>(
      "SELECT json_extract(grant_json,'$.snapshotDigest') snapshot_digest FROM offline_grant_grants WHERE json_extract(grant_json,'$.kindOfGrant')='task' AND json_extract(grant_json,'$.taskKind')='shift' AND json_extract(grant_json,'$.taskId')=? ORDER BY installed_sequence DESC LIMIT 1",
      [shiftId],
    );
    const eventId = crypto.randomUUID();
    const result: CloseBoxResultClosed = {
      status: "closed",
      sscc,
      itemCount: box.itemCount,
      closedAt,
      pallet: null,
    };
    const committed = await new StationGrantAdmission(deps.exec, clock).commitCompletion({
      operatorId,
      intent: {
        owner: {
          tenantId: state.tenant_id,
          deviceId: state.device_id,
          kind: state.owner_kind,
          credentialEpoch: state.credential_epoch,
        },
        capability: "shift.start.v1",
        taskId: shiftId,
        snapshotDigest: binding?.snapshot_digest ?? "missing",
        eventId,
        eventType: "shift.box.close.v1",
        cost: {},
      },
      execution: await readShiftExecutionProjection(deps.exec, shiftId),
      event: {
        eventId,
        shiftId,
        boxId: box.boxId,
        sscc,
        itemCount: box.itemCount,
        closedAt,
        operatorId,
        palletId,
        terminalId: deps.terminalId,
      },
      facts: { containers: 1 },
      result,
      wrapCommand(command) {
        return {
          sql: "INSERT INTO offline_grant_box_close_commands(event_id,payload_json) VALUES(?,?)",
          values: [
            eventId,
            JSON.stringify({
              grantCommand: JSON.parse(String(command.values[1])) as unknown,
              poolRowId: pool.rowid,
              serial: pool.serial,
              shiftId,
              boxId: box.boxId,
              sscc,
              closedAt,
              operatorId,
              palletId,
              pallet: newPallet,
            }),
          ],
        };
      },
    });
    if (!committed.decision.allow)
      throw new OfflineGrantDeniedError(committed.decision.reason ?? "denied");
    pallet =
      pallet ??
      (newPallet
        ? { ...newPallet, shiftId, openedAt: closedAt, boxCount: 0, lastBoxSscc: null }
        : null);
    if (
      pallet &&
      deps.palletBoxCapacity !== null &&
      pallet.boxCount + 1 >= deps.palletBoxCapacity
    ) {
      result.pallet = await closeCurrentPalletWithOfflineGrant(
        deps,
        shiftId,
        operatorId,
        generation,
        clock,
      );
    }
    return result;
  } finally {
    lease.release();
  }
}
