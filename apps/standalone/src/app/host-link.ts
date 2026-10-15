import { useCallback, useEffect, useMemo, useRef } from "react";

import type { HostApi } from "../host/api.js";
import type { KnownBlocksRequest, KnownBlocksResponse } from "../host/backups.js";
import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import { replaceShiftCopies } from "../floor/shifts/shift-copies.js";
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceShift, DeviceStatus, FactReceipt } from "../host/protocol.js";
import { readConflictNotices } from "../local/conflict-notices.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import { sendFactBatch } from "../local/facts-sender.js";
import { syncAllProductPhotos } from "../local/product-photos.js";
import { sendWarehouseBatch } from "../local/warehouse-sender.js";
import {
  createSyncScheduler,
  readQuarantineCount,
  syncReferences,
} from "../local/reference-sync.js";
import { noteRestoreEpoch, reconcileRestore, restoreDue } from "../local/restore-reconcile.js";
import {
  deviceRejection,
  shellActionFor,
  type FactsFailure,
  type ShellAction,
  type SyncFailure,
} from "./shell.js";

/** The waits before the first retries of a failed sync, in milliseconds. */
const RETRY_MS = [2000, 4000, 8000, 16000, 32000] as const;
/** The wait before every later retry. */
const RETRY_CAP_MS = 60_000;

/**
 * How long to wait before retrying after `attempt` failed runs in a row (1
 * after the first): 2 s, 4 s, 8 s, 16 s, 32 s, then 60 s for every later one.
 */
export function nextSyncRetryMs(attempt: number): number {
  return RETRY_MS[attempt - 1] ?? RETRY_CAP_MS;
}

/**
 * How long the outbox waits after the host answered `restore_pending` (plan
 * РК-С): the `Retry-After` of a held answer, `RESTORE_RETRY_AFTER_SECS` in
 * the host's `server.rs` (a test reads it there). The shell passes the
 * webview status and body only, so the number lives on both sides.
 */
export const RESTORE_HOLD_RETRY_MS = 60_000;

/** The host was restored from a copy and holds the stations' facts until the office resumes them. */
function restoreHeld(error: unknown): boolean {
  return error instanceof HostError && error.kind === "api" && error.code === "restore_pending";
}

/**
 * Why a run failed, for the status line: the host could not be reached, or
 * it refused or failed the request (a `HostError`, except an answer this
 * build cannot read); this computer could not write (`LocalDbError`); or the
 * feed could not be applied — an answer from the host this build cannot read
 * (`HostError` `invalid_response`), a `SyncFeedError`, and anything else the
 * run did not expect.
 */
export function syncFailureOf(error: unknown): SyncFailure {
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code === "invalid_response" ? "feed" : "host";
  }
  if (error instanceof LocalDbError) return "local";
  return "feed";
}

/**
 * Why a send of the outbox failed, for the status bar: the host not reached
 * (any transport failure but an answer this build cannot read) is the link's
 * own state; an error the host answered, an answer that does not fit and
 * receipts that do not answer the records are the host's; a failed write of
 * the receipts is this computer's.
 */
export function factsFailureOf(error: unknown): FactsFailure {
  if (restoreHeld(error)) return "held";
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code !== "invalid_response" ? "offline" : "host";
  }
  return error instanceof LocalDbError ? "local" : "host";
}

export interface HostLinkOptions {
  /** The paired host; `null` while unpaired, rejected or stopped at another host. */
  hostId: string | null;
  /** The pairing's device id (`DeviceStatus.deviceId`); `null` exactly when `hostId` is. */
  deviceId: string | null;
  connection: ConnectionApi;
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  /** `DeviceApi.refresh`: this device's record, read again with the office's line. */
  refresh: () => Promise<DeviceStatus>;
  /** `HostApi.getDeviceShifts`: this station's shifts, kept in `floor_shifts`. */
  deviceShifts: () => Promise<DeviceShift[]>;
  /** `HostApi.sendFacts`: the outbox's records to the host, a receipt for each. */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /** `HostApi.registerKnownBlocks`: this station's blocks back to a host restored from a copy. */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  /**
   * `HostApi.sendWarehouseRecords` (plan СКЛ): the warehouse reprint's records go
   * after the facts, by the same delivery; none — they wait.
   */
  sendWarehouseRecords?: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /**
   * `HostApi.conflictStatus` and `HostApi.listDisplacements` (plan КНФ): what
   * the host tells this station of its conflicts; without both, nothing is read.
   */
  conflictStatus?: HostApi["conflictStatus"];
  listDisplacements?: HostApi["listDisplacements"];
  /**
   * `HostApi.getDeviceProductPhoto` (beta 3): the photos the feed's product
   * records name are fetched after every successful sync; without it none is.
   */
  deviceProductPhoto?: HostApi["getDeviceProductPhoto"];
  dispatch: (action: ShellAction) => void;
}

/** What the link offers the screens: a sync and both reads now, and the outbox's delivery now. */
export interface HostLinkControls {
  requestSync: () => void;
  /** Sends the outbox now (after a local write); nothing goes while the link is stopped or not online, or while a failed send's pause runs (its end sends). */
  requestFacts: () => void;
}

/**
 * While a host is paired: follows the shell's link to it and keeps the local
 * reference copies in step with a sync once `watch` has subscribed (or
 * failed to) and after every revision event. The first event after each
 * reconnect carries the host's current revision, so catching up needs
 * nothing more. A failed run — not another host, not a rejected device — is
 * retried while the link is online, after `nextSyncRetryMs`; a lost link
 * drops the pending retry, and the link coming back syncs at once. At the
 * same moments it reads this device's record again (`refresh`): a line the
 * office assigns takes a revision but no feed item, so only the record
 * carries it. A failed read — not a rejected device, not a missing pairing —
 * keeps the line the station has and is retried the same way, with a count
 * of its own. The station's shifts are read at the same moments and the same
 * way (stage 2a spec §5.4): the answer replaces this pairing's copies
 * (`replaceShiftCopies`), and a failed read keeps the copies the station has.
 * The outbox goes to the host at the same moments (stage 2a spec §5.5), a
 * batch at a time (`sendFactBatch`), and whenever a screen asks after a local
 * write — unless a failed send's pause runs, whose end sends (plan ОЧ); a batch of 100 asks for the next at once; a failed send is retried
 * after `nextSyncRetryMs` with a count of its own while the link is online,
 * and at once when the link is back; a refused key ends the link as
 * everywhere. The warehouse reprint's records (plan СКЛ) go after the last
 * batch of facts, with a count and a retry of their own: a failure of theirs
 * neither pauses the facts nor is asked again by a scan before its retry, and
 * the facts' pauses leave that retry alone (only `restore_pending` holds both).
 * It lives exactly as long as the link: a refusal waiting for the
 * operator to leave the shift stops the link (`App`), and the delivery with
 * it. After a restore of the host (plan РК-С) an online status names its new
 * epoch: the pairing notes it and owes the host its blocks, a sync from zero
 * and its recent records again (`reconcileRestore`), at once and at every
 * link event until that is settled, retried like the reads above; no record
 * goes meanwhile, and none goes before the link's first online status has
 * said whether there is an epoch (only when `watch` itself failed does the
 * outbox go without one). While the host holds the facts (`restore_pending`) a send
 * waits `RESTORE_HOLD_RETRY_MS` — no other trigger (a local write, a
 * revision) asks the host again before that — and the floor goes on offline.
 * What the host tells this station of its conflicts (plan КНФ: the office's
 * reviews, its displaced scans) is read at the same moments and retried the
 * same way, with a count of its own; what it keeps refreshes the outbox's
 * counts. Returns the requests for a sync and for the delivery.
 */
export function useHostLink({
  hostId,
  deviceId,
  connection,
  local,
  changes,
  refresh,
  deviceShifts,
  sendFacts,
  registerKnownBlocks,
  sendWarehouseRecords,
  conflictStatus,
  listDisplacements,
  deviceProductPhoto,
  dispatch,
}: HostLinkOptions): HostLinkControls {
  const syncNow = useRef<() => void>(() => undefined);
  const factsNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (hostId === null || deviceId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
    let active = true;
    // The link's latest status is `online`: only then is a retry worth it,
    // and only then does the outbox go (see `factSender`).
    let online = false;
    // `watch` failed: no status will ever come, so the outbox goes without one.
    let watchFailed = false;
    // `watch` resolved: a status before that is followed by `everything()`
    // anyway, so going online need not send the outbox a second time.
    let watching = false;
    let running = false;
    // Failed runs in a row; a successful run starts the count again.
    let failures = 0;
    // The pending retry. It exists only while no run is in flight, the last
    // run failed and the link is online.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const cancelRetry = () => {
      if (retry === null) return;
      clearTimeout(retry);
      retry = null;
    };
    // The same for reading this device's record again: failed reads in a row,
    // and the pending retry, which exists only while no read is in flight,
    // the last read failed and the link is online.
    let refreshFailures = 0;
    let refreshRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelRefreshRetry = () => {
      if (refreshRetry === null) return;
      clearTimeout(refreshRetry);
      refreshRetry = null;
    };
    // And for reading the station's shifts.
    let shiftFailures = 0;
    let shiftRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelShiftRetry = () => {
      if (shiftRetry === null) return;
      clearTimeout(shiftRetry);
      shiftRetry = null;
    };
    // And for sending the outbox.
    let factFailures = 0;
    let factRetry: ReturnType<typeof setTimeout> | null = null;
    // The host holds the facts and the wait it named is running: only that
    // wait's end asks again (it is set exactly when `factRetry` is the
    // hold's wait, and cleared with it).
    let factsHeld = false;
    const cancelFactRetry = () => {
      factsHeld = false;
      if (factRetry === null) return;
      clearTimeout(factRetry);
      factRetry = null;
    };
    // And for the warehouse reprint's records (plan СКЛ): failed sends in a row
    // and the pending retry, both their own. A failure of theirs is not the
    // facts': it never shows as one, never pauses the facts, and a send of the
    // facts (a scan's) neither cancels this retry nor asks the records' route
    // while it runs (final review of plan СКЛ, I2). Only `restore_pending`
    // holds the facts too: the host holds both routes.
    let warehouseFailures = 0;
    let warehouseRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelWarehouseRetry = () => {
      if (warehouseRetry === null) return;
      clearTimeout(warehouseRetry);
      warehouseRetry = null;
    };
    // And for what the host tells this station of its conflicts (plan КНФ).
    let noticeFailures = 0;
    let noticeRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelNoticeRetry = () => {
      if (noticeRetry === null) return;
      clearTimeout(noticeRetry);
      noticeRetry = null;
    };
    // And for settling a restore of the host.
    let reconcileFailures = 0;
    let reconcileRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelReconcileRetry = () => {
      if (reconcileRetry === null) return;
      clearTimeout(reconcileRetry);
      reconcileRetry = null;
    };
    const pairing = { hostId, deviceId };
    // The restore epoch the link's last online status named, and the write of
    // it: a new epoch is written before anything asks whether blocks are owed,
    // so the outbox never goes out ahead of it. The sender and the settling
    // both ask, and share one write per epoch; a failed write is forgotten, so
    // the next ask writes again.
    let epochSeen: string | null = null;
    let noting: { epoch: string; done: Promise<void> } | null = null;
    const noteEpoch = (): Promise<void> => {
      const epoch = epochSeen;
      if (epoch === null) return Promise.resolve();
      if (noting === null || noting.epoch !== epoch) {
        const done = noteRestoreEpoch(local, pairing, epoch, new Date()).then((changed) => {
          // The status bar says what the station owes.
          if (changed && active) dispatch({ type: "outbox_changed" });
        });
        const mine = { epoch, done };
        noting = mine;
        done.catch(() => {
          if (noting === mine) noting = null;
        });
      }
      return noting.done;
    };
    // Nothing more should reach a host that refused this device's key or
    // presented another certificate.
    const stopAll = () => {
      scheduler.stop();
      refresher.stop();
      shiftReader.stop();
      factSender.stop();
      reconciler.stop();
      noticeReader.stop();
      cancelRetry();
      if (photoRetry !== null) {
        clearTimeout(photoRetry);
        photoRetry = null;
      }
      cancelRefreshRetry();
      cancelShiftRetry();
      cancelFactRetry();
      cancelWarehouseRetry();
      cancelReconcileRetry();
      cancelNoticeRetry();
    };
    // The products' photos (beta 3), fetched after a sync: best effort, never
    // a sync failure. A failed pass is tried again after `nextSyncRetryMs`
    // while the link is online; a pass in flight is not started twice.
    let photoFailures = 0;
    let photoRetry: ReturnType<typeof setTimeout> | null = null;
    let photoRunning = false;
    // A sync that finished while a pass was running (a photo set meanwhile)
    // asks for one more run right after it, as the sync scheduler does.
    let photoAgain = false;
    const photoPass = (): void => {
      if (deviceProductPhoto === undefined) return;
      if (photoRunning) {
        photoAgain = true;
        return;
      }
      if (photoRetry !== null) {
        clearTimeout(photoRetry);
        photoRetry = null;
      }
      photoRunning = true;
      photoAgain = false;
      void syncAllProductPhotos({ local, fetchPhoto: deviceProductPhoto }).then(
        () => {
          photoRunning = false;
          photoFailures = 0;
          if (photoAgain && active) photoPass();
        },
        (error: unknown) => {
          photoRunning = false;
          if (!active) return;
          // A refused key or another certificate is the sync's to route, not ours.
          if (shellActionFor(error, null) !== null) return;
          photoFailures += 1;
          if (online) {
            photoRetry = setTimeout(() => {
              photoRetry = null;
              photoPass();
            }, nextSyncRetryMs(photoFailures));
          }
        },
      );
    };
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
      // Any run — a revision's, a request's or the retry itself — replaces
      // the pending retry.
      cancelRetry();
      running = true;
      dispatch({ type: "sync_started" });
      try {
        const result = await syncReferences({ changes, local, hostId, deviceId });
        if (!active) return;
        failures = 0;
        if (result.kind === "other_host") {
          // A run a revision already queued during this one must not also
          // reach that host: the effect's cleanup (`active = false`, which
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          stopAll();
        }
        dispatch({ type: "sync_finished", result });
        if (result.kind === "synced") photoPass();
      } catch (error) {
        if (!active) return;
        // A rejected key or a changed certificate needs a new pairing.
        const action = shellActionFor(error, null);
        if (action) {
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          stopAll();
          dispatch(action);
        }
        // Worth reading only when nothing else is about to reset the sync
        // state on its own (a rejection here, `paired`/`forgotten` on a new
        // pairing): `null` leaves the reducer's last known count alone,
        // instead of a read racing a wipe that is about to happen anyway.
        const quarantined = action === null ? await readQuarantineCount(local) : null;
        if (!active) return;
        dispatch({ type: "sync_failed", failure: syncFailureOf(error), quarantined });
        if (action === null) {
          failures += 1;
          if (online) {
            retry = setTimeout(() => {
              retry = null;
              scheduler.trigger();
            }, nextSyncRetryMs(failures));
          }
        }
      } finally {
        running = false;
      }
    });
    // One read of this device at a time; events during a read ask for
    // exactly one more, as for the sync. A failed read is retried like a
    // failed sync: the station keeps the line it has meanwhile (offline
    // first), but must not stay on one the host no longer has until some
    // unrelated event.
    const refresher = createSyncScheduler(async () => {
      if (!active) return;
      // Any read — an event's, a request's or the retry itself — replaces
      // the pending retry.
      cancelRefreshRetry();
      try {
        const status = await refresh();
        if (!active) return;
        refreshFailures = 0;
        dispatch({ type: "device_refreshed", status });
      } catch (error) {
        if (!active) return;
        // A refused key or a changed certificate needs a new pairing, as on
        // every other host path: nothing more should reach that host.
        const reason = deviceRejection(error);
        if (reason !== null) {
          stopAll();
          dispatch({ type: "device_rejected", reason });
          return;
        }
        // No pairing: the shell is about to drop the link, and there is
        // nothing to read again.
        if (error instanceof DeviceError && error.code === "not_paired") return;
        // The host's answer did not reach `device.json`: the station stays on
        // the line it has, and says so (plan 1d3's open item).
        if (error instanceof DeviceError && error.code === "storage") {
          dispatch({ type: "device_not_saved" });
        }
        // Anything else — the host away, an answer this build cannot read, a
        // failed write of `device.json` — keeps the line this station already
        // has, and the read is tried again while the link is online.
        refreshFailures += 1;
        if (online) {
          refreshRetry = setTimeout(() => {
            refreshRetry = null;
            refresher.trigger();
          }, nextSyncRetryMs(refreshFailures));
        }
      }
    });
    // One read of the station's shifts at a time, retried like the reads
    // above. A refused key ends the link as everywhere; any other failure —
    // the host away, an answer this build cannot read, this computer's
    // database — keeps the copies the station has (offline first).
    const shiftReader = createSyncScheduler(async () => {
      if (!active) return;
      cancelShiftRetry();
      try {
        const shifts = await deviceShifts();
        if (!active) return;
        await replaceShiftCopies(local, { hostId, deviceId }, shifts, Date.now());
        if (!active) return;
        shiftFailures = 0;
        dispatch({ type: "shifts_read", ok: true });
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        shiftFailures += 1;
        dispatch({ type: "shifts_read", ok: false });
        if (online) {
          shiftRetry = setTimeout(() => {
            shiftRetry = null;
            shiftReader.trigger();
          }, nextSyncRetryMs(shiftFailures));
        }
      }
    });
    // One read of the conflict notices at a time, retried like the reads above
    // (plan КНФ): the office's review takes a revision, so a station online
    // hears of it at once; a displacement takes none (the facts are not
    // changed for it) and is heard at the next revision or reconnect. A
    // refused key ends the link as everywhere; anything else keeps what the
    // station has. A host without the routes is no failure (`readConflictNotices`).
    const noticeReader = createSyncScheduler(async () => {
      if (!active || conflictStatus === undefined || listDisplacements === undefined) return;
      cancelNoticeRetry();
      try {
        const { changed } = await readConflictNotices({
          local,
          pairing,
          conflictStatus,
          listDisplacements,
          now: () => new Date(),
        });
        if (!active) return;
        noticeFailures = 0;
        if (changed) dispatch({ type: "outbox_changed" });
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        noticeFailures += 1;
        if (online) {
          noticeRetry = setTimeout(() => {
            noticeRetry = null;
            noticeReader.trigger();
          }, nextSyncRetryMs(noticeFailures));
        }
      }
    });
    // One batch of the outbox at a time, retried like the reads above. A
    // full batch asks for the next one at once; a refused key ends the link.
    const factSender = createSyncScheduler(async () => {
      if (!active) return;
      // The host said when to ask again: nothing else asks before.
      if (factsHeld) return;
      // Only an online status names a restored host's epoch: a record sent
      // before the link knows it could reach the host ahead of the blocks.
      // Going online sends the outbox (`onStatus`).
      if (!online && !watchFailed) return;
      cancelFactRetry();
      try {
        // A restored host gets this station's blocks back first: a box closed
        // with a serial the host lost would be refused for good.
        await noteEpoch();
        if (await restoreDue(local, pairing)) return;
        const { sent, more } = await sendFactBatch(
          local,
          { hostId, deviceId },
          sendFacts,
          () => new Date(),
        );
        if (!active) return;
        // The warehouse records (plan СКЛ) once no fact waits, and not while
        // their own retry runs (its end sends them). Their failure is not the
        // facts': a refused key or a changed certificate still ends the link;
        // anything else keeps them for a retry of their own.
        let warehouse = { sent: 0, more: false };
        let warehouseFailure: unknown = null;
        if (!more && sendWarehouseRecords !== undefined && warehouseRetry === null) {
          try {
            warehouse = await sendWarehouseBatch(
              local,
              { hostId, deviceId },
              sendWarehouseRecords,
              () => new Date(),
            );
            warehouseFailures = 0;
          } catch (error) {
            if (shellActionFor(error, null) !== null) throw error;
            if (!(error instanceof HostError && error.code === "not_paired")) {
              warehouseFailure = error;
            }
          }
          if (!active) return;
        }
        factFailures = 0;
        dispatch({ type: "facts_sent" });
        if (sent > 0 || warehouse.sent > 0) dispatch({ type: "outbox_changed" });
        if (more || warehouse.more) factSender.trigger();
        if (warehouseFailure !== null) {
          warehouseFailures += 1;
          if (online && restoreHeld(warehouseFailure)) {
            // The host holds the stations' records: the facts wait the same
            // minute, exactly as when their own send meets the hold.
            factRetry = setTimeout(() => {
              factRetry = null;
              factsHeld = false;
              factSender.trigger();
            }, RESTORE_HOLD_RETRY_MS);
            factsHeld = true;
          } else if (online) {
            warehouseRetry = setTimeout(() => {
              warehouseRetry = null;
              // A retry of the facts that is running sends the records at its
              // end, after the facts: this one must not cut the facts' pause.
              if (factRetry === null) factSender.trigger();
            }, nextSyncRetryMs(warehouseFailures));
          }
        }
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        dispatch({ type: "facts_failed", failure: factsFailureOf(error) });
        factFailures += 1;
        if (online) {
          const held = restoreHeld(error);
          factRetry = setTimeout(
            () => {
              factRetry = null;
              factsHeld = false;
              factSender.trigger();
            },
            // The host said when to ask again.
            held ? RESTORE_HOLD_RETRY_MS : nextSyncRetryMs(factFailures),
          );
          factsHeld = held;
        }
      }
    });
    // One settling of a restore at a time, retried like the reads above; it
    // asks nothing of the host while nothing is owed.
    const reconciler = createSyncScheduler(async () => {
      if (!active) return;
      cancelReconcileRetry();
      try {
        await noteEpoch();
        const result = await reconcileRestore({
          local,
          pairing,
          register: registerKnownBlocks,
          now: () => new Date(),
        });
        if (!active) return;
        reconcileFailures = 0;
        if (result.kind === "reconciled") {
          // The status bar, the copies from zero and the records waiting again.
          dispatch({ type: "outbox_changed" });
          scheduler.trigger();
          factSender.trigger();
        }
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        reconcileFailures += 1;
        if (online) {
          reconcileRetry = setTimeout(() => {
            reconcileRetry = null;
            reconciler.trigger();
          }, nextSyncRetryMs(reconcileFailures));
        }
      }
    });
    const everything = () => {
      scheduler.trigger();
      refresher.trigger();
      shiftReader.trigger();
      factSender.trigger();
      reconciler.trigger();
      noticeReader.trigger();
    };
    syncNow.current = everything;
    // A screen's request after a local write sends at once, unless a failed
    // send's pause runs: that pause sends, so `attempts` counts retries and not
    // scans (plan ОЧ; final review of plan 2a6, m8). Going online, a revision
    // and the pause's end still send at once.
    factsNow.current = () => {
      if (factRetry !== null) return;
      factSender.trigger();
    };
    let unwatch: (() => void) | null = null;
    connection
      .watch({
        onStatus: (status) => {
          if (!active) return;
          dispatch({ type: "link_status", status });
          const wasOnline = online;
          online = status.state === "online";
          if (!online) {
            // Nothing to retry against: the first revision event after the
            // reconnect syncs and reads the device again.
            cancelRetry();
            cancelRefreshRetry();
            cancelShiftRetry();
            cancelFactRetry();
            cancelWarehouseRetry();
            cancelReconcileRetry();
            cancelNoticeRetry();
            return;
          }
          if (status.restoreEpoch !== undefined && status.restoreEpoch !== epochSeen) {
            epochSeen = status.restoreEpoch;
            reconciler.trigger();
          }
          if (failures > 0 && !running && retry === null) {
            // Back online after a failed run whose retry the lost link
            // dropped: no need to wait for the revision event.
            scheduler.trigger();
          }
          // The same for a failed read of this device and of its shifts.
          if (refreshFailures > 0 && refreshRetry === null) refresher.trigger();
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
          // The outbox waits for the link (`factSender`): going online sends it.
          if ((watching && !wasOnline) || (factFailures > 0 && factRetry === null)) {
            factSender.trigger();
          }
          if (reconcileFailures > 0 && reconcileRetry === null) reconciler.trigger();
          if (noticeFailures > 0 && noticeRetry === null) noticeReader.trigger();
        },
        onRevision: (rev) => {
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          everything();
        },
      })
      .then(
        (stop) => {
          if (!active) {
            stop();
            return;
          }
          unwatch = stop;
          watching = true;
          // Sync only now: revisions announced before `watch` resolved are
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          everything();
        },
        () => {
          // Without events the copies sync and the device and its shifts are
          // read once here, and again on request. `online` never becomes true,
          // so no failed run is retried on its own, and the outbox goes
          // without the link's status: there is none to wait for.
          if (!active) return;
          watchFailed = true;
          everything();
        },
      );
    return () => {
      active = false;
      syncNow.current = () => undefined;
      factsNow.current = () => undefined;
      stopAll();
      unwatch?.();
    };
  }, [
    hostId,
    deviceId,
    connection,
    local,
    changes,
    refresh,
    deviceShifts,
    sendFacts,
    registerKnownBlocks,
    sendWarehouseRecords,
    conflictStatus,
    listDisplacements,
    deviceProductPhoto,
    dispatch,
  ]);
  const requestSync = useCallback(() => syncNow.current(), []);
  const requestFacts = useCallback(() => factsNow.current(), []);
  return useMemo(() => ({ requestSync, requestFacts }), [requestSync, requestFacts]);
}
