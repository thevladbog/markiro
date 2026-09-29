import { useCallback, useEffect, useRef } from "react";

import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
import { DeviceError } from "../host/device.js";
import type { ChangesResponse, DeviceStatus } from "../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../local/executor.js";
import {
  createSyncScheduler,
  readQuarantineCount,
  syncReferences,
} from "../local/reference-sync.js";
import { deviceRejection, shellActionFor, type ShellAction, type SyncFailure } from "./shell.js";

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

export interface HostLinkOptions {
  /** The paired host; `null` while unpaired, rejected or stopped at another host. */
  hostId: string | null;
  connection: ConnectionApi;
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  /** `DeviceApi.refresh`: this device's record, read again with the office's line. */
  refresh: () => Promise<DeviceStatus>;
  dispatch: (action: ShellAction) => void;
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
 * of its own. Returns a function that asks for a sync and a read now.
 */
export function useHostLink({
  hostId,
  connection,
  local,
  changes,
  refresh,
  dispatch,
}: HostLinkOptions): () => void {
  const syncNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (hostId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
    let active = true;
    // The link's latest status is `online`: only then is a retry worth it.
    let online = false;
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
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
      // Any run — a revision's, a request's or the retry itself — replaces
      // the pending retry.
      cancelRetry();
      running = true;
      dispatch({ type: "sync_started" });
      try {
        const result = await syncReferences({ changes, local, hostId });
        if (!active) return;
        failures = 0;
        if (result.kind === "other_host") {
          // A run a revision already queued during this one must not also
          // reach that host: the effect's cleanup (`active = false`, which
          // also stops the scheduler) only runs after React re-renders with
          // `hostId: null`, and that is later than this microtask chain.
          scheduler.stop();
          refresher.stop();
        }
        dispatch({ type: "sync_finished", result });
      } catch (error) {
        if (!active) return;
        // A rejected key or a changed certificate needs a new pairing.
        const action = shellActionFor(error, null);
        if (action) {
          // Same reasoning as above: nothing more should reach a host that
          // just refused this device's key or presented another certificate.
          scheduler.stop();
          refresher.stop();
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
          scheduler.stop();
          refresher.stop();
          cancelRetry();
          cancelRefreshRetry();
          dispatch({ type: "device_rejected", reason });
          return;
        }
        // No pairing: the shell is about to drop the link, and there is
        // nothing to read again.
        if (error instanceof DeviceError && error.code === "not_paired") return;
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
    syncNow.current = () => {
      scheduler.trigger();
      refresher.trigger();
    };
    let unwatch: (() => void) | null = null;
    connection
      .watch({
        onStatus: (status) => {
          if (!active) return;
          dispatch({ type: "link_status", status });
          online = status.state === "online";
          if (!online) {
            // Nothing to retry against: the first revision event after the
            // reconnect syncs and reads the device again.
            cancelRetry();
            cancelRefreshRetry();
            return;
          }
          if (failures > 0 && !running && retry === null) {
            // Back online after a failed run whose retry the lost link
            // dropped: no need to wait for the revision event.
            scheduler.trigger();
          }
          // The same for a failed read of this device.
          if (refreshFailures > 0 && refreshRetry === null) refresher.trigger();
        },
        onRevision: (rev) => {
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
          refresher.trigger();
        },
      })
      .then(
        (stop) => {
          if (!active) {
            stop();
            return;
          }
          unwatch = stop;
          // Sync only now: revisions announced before `watch` resolved are
          // not replayed, so a sync started earlier could miss a commit that
          // landed between its fetch and the listener.
          scheduler.trigger();
          refresher.trigger();
        },
        () => {
          // Without events the copies still sync once here and on request, and
          // the device is read once. `online` never becomes true, so neither a
          // failed sync nor a failed read is retried on its own.
          if (!active) return;
          scheduler.trigger();
          refresher.trigger();
        },
      );
    return () => {
      active = false;
      syncNow.current = () => undefined;
      scheduler.stop();
      refresher.stop();
      cancelRetry();
      cancelRefreshRetry();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, refresh, dispatch]);
  return useCallback(() => syncNow.current(), []);
}
