import { buildSscc, DomainError } from "@markiro/domain";
import { closePallet, currentPallet } from "./pallets.js";
import { burnSerial } from "./sscc-pool.js";
import type { CloseBoxDeps } from "./close-box.js";
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
 * Extension digit for pallet serial ranges. Boxes take 0 -- see
 * `sscc-pool.ts` for why one shared space would put the same number on a
 * box and on the pallet it stands on.
 */
export const PALLET_EXTENSION_DIGIT = 1;

export type ClosePalletResult =
  | { status: "closed"; palletId: string; sscc: string; boxCount: number; closedAt: string }
  | { status: "no-serials" }
  | { status: "empty" }
  /**
   * Mirrors `close-box.ts`'s own `invalid-serial`: the burned serial cannot
   * build a valid SSCC (`buildSscc` threw `SSCC_RANGE`). The serial is
   * already burned -- `burnSerial` is one atomic statement, by design, so
   * there is no way to give it back -- and is accepted as lost, the same
   * way an abandoned pallet already costs a burned serial. The pallet row
   * is left untouched (still open, no sscc/closedAt written) so the
   * operator can simply try closing it again.
   */
  | { status: "invalid-serial" }
  /**
   * `closePallet`'s `closed_at IS NULL` guard matched nothing: another call
   * already closed THIS pallet, with a different SSCC, between the
   * `currentPallet` read above and the UPDATE -- a genuine double close, by
   * two concurrent closers racing for the same pallet. Unlike
   * `invalid-serial`, the row was NOT left untouched: it already carries a
   * different, already-persisted SSCC written by the winning call. A caller
   * must not retry closing "the current pallet" here -- by the time it
   * reads again, this pallet is no longer open, so a naive retry would find
   * a different, not-yet-full pallet (or none) and silently burn another
   * serial against it. The serial burned by THIS losing call cannot be
   * un-burned and never reached a stored record, so it is accepted as lost,
   * the same trade `invalid-serial` already names above.
   */
  | { status: "already-closed" };

/**
 * Closes the shift's current open pallet.
 *
 * The order of the checks is the design, exactly as in `close-box.ts`:
 * emptiness is tested BEFORE burning, so a pallet closed by mistake costs no
 * serial, and the serial is burned only once the pool actually yields one.
 * A pallet abandoned at shift end therefore costs nothing either.
 */
async function closeCurrentPalletLegacy(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
): Promise<ClosePalletResult> {
  const pallet = await currentPallet(deps.exec, shiftId, deps.terminalId);
  if (!pallet || pallet.boxCount === 0) return { status: "empty" };

  const serial = await burnSerial(deps.exec, deps.issuerPrefix, PALLET_EXTENSION_DIGIT);
  if (serial === null) return { status: "no-serials" };

  let sscc: string;
  try {
    sscc = buildSscc(PALLET_EXTENSION_DIGIT, deps.issuerPrefix, serial);
  } catch (err) {
    if (err instanceof DomainError && err.code === "SSCC_RANGE") {
      // The serial is already burned and cannot be given back -- `burnSerial`
      // is one atomic statement by design -- and is accepted as lost, exactly
      // as an abandoned pallet already costs one. The pallet row is left
      // untouched so the operator can try again.
      return { status: "invalid-serial" };
    }
    throw err;
  }

  const closedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const closed = await closePallet(deps.exec, pallet.palletId, sscc, closedAt, operatorId);
  if (!closed) {
    // `closePallet`'s `closed_at IS NULL` guard matched nothing: another
    // call already closed this exact pallet between the `currentPallet`
    // read above and this UPDATE. `closePallet` is one guarded UPDATE, not
    // a multi-statement sequence, so this is NOT the pooled-connection race
    // `apps/station/AGENTS.md` warns about (that hazard is about separate
    // calls landing on different connections inside what should be one
    // transaction). The real cause here is a genuine double close: two
    // concurrent callers both read the same open pallet and both tried to
    // close it. The serial burned above cannot be un-burned and never
    // reached a stored record, so it is accepted as lost -- exactly the
    // trade `invalid-serial` already names above -- but this is reported as
    // its own `already-closed` status rather than `invalid-serial`: the row
    // was NOT left untouched here the way `invalid-serial` promises: it was
    // closed by the winning caller with a different, already-persisted
    // SSCC, so a caller must not retry closing "the current pallet".
    return { status: "already-closed" };
  }
  return { status: "closed", palletId: pallet.palletId, sscc, boxCount: pallet.boxCount, closedAt };
}

/** Legacy entry point cannot bypass an installed grant owner. */
export async function closeCurrentPallet(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
): Promise<ClosePalletResult> {
  const [active] = await deps.exec.all<{ active: number }>(
    "SELECT 1 active FROM offline_grant_install_state WHERE id=1",
  );
  if (active?.active === 1) throw new OfflineGrantDeniedError("grant_aware_owner_required");
  return closeCurrentPalletLegacy(deps, shiftId, operatorId);
}

/** Grant-aware pallet owner: allowance, serial CAS and pending-print close are one command. */
export async function closeCurrentPalletWithOfflineGrant(
  deps: CloseBoxDeps,
  shiftId: string,
  operatorId: string | null,
  generation: CredentialGeneration,
  clock: () => Promise<GrantClockSample> = sampleGrantClock,
): Promise<ClosePalletResult> {
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
    if (!state) return closeCurrentPalletLegacy(deps, shiftId, operatorId);
    if (!operatorId) throw new OfflineGrantDeniedError("operator_unauthorized");
    if (!(await stationOperatorIsCurrentlyActive(deps.exec, operatorId)))
      throw new OfflineGrantDeniedError("operator_unauthorized");
    const pallet = await currentPallet(deps.exec, shiftId, deps.terminalId);
    if (!pallet || pallet.boxCount === 0) return { status: "empty" };
    const [pool] = await deps.exec.all<{ rowid: number; serial: number }>(
      "SELECT rowid,next_serial serial FROM sscc_pool WHERE issuer_prefix=? AND extension_digit=? AND next_serial<=to_serial ORDER BY from_serial LIMIT 1",
      [deps.issuerPrefix, PALLET_EXTENSION_DIGIT],
    );
    if (!pool) return { status: "no-serials" };
    let sscc: string;
    try {
      sscc = buildSscc(PALLET_EXTENSION_DIGIT, deps.issuerPrefix, pool.serial);
    } catch (error) {
      if (error instanceof DomainError && error.code === "SSCC_RANGE")
        return { status: "invalid-serial" };
      throw error;
    }
    const [binding] = await deps.exec.all<{ snapshot_digest: string }>(
      "SELECT json_extract(grant_json,'$.snapshotDigest') snapshot_digest FROM offline_grant_grants WHERE json_extract(grant_json,'$.kindOfGrant')='task' AND json_extract(grant_json,'$.taskKind')='shift' AND json_extract(grant_json,'$.taskId')=? ORDER BY installed_sequence DESC LIMIT 1",
      [shiftId],
    );
    const eventId = crypto.randomUUID();
    const closedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
    const result: ClosePalletResult = {
      status: "closed",
      palletId: pallet.palletId,
      sscc,
      boxCount: pallet.boxCount,
      closedAt,
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
        eventType: "shift.pallet.close.v1",
        cost: {},
      },
      execution: await readShiftExecutionProjection(deps.exec, shiftId),
      event: {
        eventId,
        shiftId,
        palletId: pallet.palletId,
        sscc,
        boxCount: pallet.boxCount,
        closedAt,
        operatorId,
        terminalId: deps.terminalId,
      },
      facts: { containers: 1 },
      result,
      wrapCommand(command) {
        return {
          sql: "INSERT INTO offline_grant_pallet_close_commands(event_id,payload_json) VALUES(?,?)",
          values: [
            eventId,
            JSON.stringify({
              grantCommand: JSON.parse(String(command.values[1])) as unknown,
              poolRowId: pool.rowid,
              serial: pool.serial,
              palletId: pallet.palletId,
              sscc,
              closedAt,
              operatorId,
            }),
          ],
        };
      },
    });
    if (!committed.decision.allow)
      throw new OfflineGrantDeniedError(committed.decision.reason ?? "denied");
    return committed.result as ClosePalletResult;
  } finally {
    lease.release();
  }
}
