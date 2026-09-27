import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { hostRevisionSchema, hostStatusSchema, type HostStatus } from "./protocol.js";

/** Events of the shell's connection task (`src-tauri/src/connection.rs`). */
export const HOST_STATUS_EVENT = "standalone://host-status";
export const HOST_REVISION_EVENT = "standalone://host-revision";

/**
 * Function-typed properties, not methods: `watch` destructures them, and
 * `@typescript-eslint/unbound-method` refuses to destructure methods.
 */
export interface ConnectionHandlers {
  /** The current status first, then every newer one. */
  onStatus: (status: HostStatus) => void;
  /** The host committed revision `rev`: time to sync reference data. */
  onRevision: (rev: number) => void;
}

/** The link to the host, as the shell's connection task reports it. */
export interface ConnectionApi {
  /** Follow the link until the returned function is called. */
  watch: (handlers: ConnectionHandlers) => Promise<() => void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/**
 * Subscribes first and asks for the current status second, so no status is
 * lost in between; `seq` orders the answer against events that raced it.
 */
export function createTauriConnectionApi(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
): ConnectionApi {
  return {
    async watch({ onStatus, onRevision }) {
      let newest = -1;
      const accept = (status: HostStatus) => {
        if (status.seq <= newest) return;
        newest = status.seq;
        onStatus(status);
      };
      const stops = await Promise.all([
        subscribe(HOST_STATUS_EVENT, (event) => {
          const parsed = hostStatusSchema.safeParse(event.payload);
          if (parsed.success) accept(parsed.data);
        }),
        subscribe(HOST_REVISION_EVENT, (event) => {
          const parsed = hostRevisionSchema.safeParse(event.payload);
          if (parsed.success) onRevision(parsed.data.rev);
        }),
      ]);
      const stop = () => {
        for (const unlisten of stops) unlisten();
      };
      try {
        accept(hostStatusSchema.parse(await call("connection_status", {})));
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    },
  };
}
