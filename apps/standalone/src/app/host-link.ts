import { useEffect } from "react";

import type { ConnectionApi } from "../host/connection.js";
import type { ChangesResponse } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { createSyncScheduler, syncReferences } from "../local/reference-sync.js";
import { shellActionFor, type ShellAction } from "./shell.js";

export interface HostLinkOptions {
  /** The paired host; `null` while unpaired, rejected or stopped at another host. */
  hostId: string | null;
  connection: ConnectionApi;
  local: LocalExecutor;
  /** `HostApi.getChanges`. */
  changes: (since: number) => Promise<ChangesResponse>;
  dispatch: (action: ShellAction) => void;
}

/**
 * While a host is paired: follows the shell's link to it and keeps the local
 * reference copies in step with a sync once `watch` has subscribed (or
 * failed to) and after every revision event. The first event after each
 * reconnect carries the host's current
 * revision, so catching up needs nothing more.
 */
export function useHostLink({
  hostId,
  connection,
  local,
  changes,
  dispatch,
}: HostLinkOptions): void {
  useEffect(() => {
    if (hostId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
    let active = true;
    const scheduler = createSyncScheduler(async () => {
      if (!active) return;
      dispatch({ type: "sync_started" });
      try {
        const result = await syncReferences({ changes, local, hostId });
        if (active) dispatch({ type: "sync_finished", result });
      } catch (error) {
        if (!active) return;
        // A rejected key or a changed certificate needs a new pairing.
        const action = shellActionFor(error, null);
        if (action) dispatch(action);
        dispatch({ type: "sync_failed" });
      }
    });
    let unwatch: (() => void) | null = null;
    connection
      .watch({
        onStatus: (status) => {
          if (active) dispatch({ type: "link_status", status });
        },
        onRevision: (rev) => {
          if (!active) return;
          dispatch({ type: "host_revision", rev });
          scheduler.trigger();
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
        },
        () => {
          // Without events the copies still sync once here and on request.
          if (active) scheduler.trigger();
        },
      );
    return () => {
      active = false;
      scheduler.stop();
      unwatch?.();
    };
  }, [hostId, connection, local, changes, dispatch]);
}
