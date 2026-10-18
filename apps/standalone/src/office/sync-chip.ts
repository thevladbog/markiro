import { useEffect, useRef, useState } from "react";

import type { SyncState } from "../app/shell.js";

export type ChipTone = "ok" | "warn" | "info" | "neutral" | "error";

export interface SyncChipModel {
  tone: ChipTone;
  labelKey: string;
  /** «12:04», for the `at` label only. */
  time: string | null;
}

/**
 * What the sync chip of the top bar says: nothing where the shell's sync is unknown (office tests);
 * a failure (or another host at the address) in amber; the clock time only for a sync the office
 * saw finish — a sync already done when the office opened has no known time, and none is made up.
 */
export function syncChipModel(sync: SyncState | null, doneAt: string | null): SyncChipModel | null {
  if (sync === null) return null;
  if (sync.kind === "failed" || sync.kind === "other_host" || sync.failure !== null) {
    return { tone: "warn", labelKey: "office.header.sync.failed", time: null };
  }
  if (sync.kind === "running") {
    return { tone: "info", labelKey: "office.header.sync.running", time: null };
  }
  if (sync.kind === "done") {
    return doneAt === null
      ? { tone: "ok", labelKey: "office.header.sync.done", time: null }
      : { tone: "ok", labelKey: "office.header.sync.at", time: doneAt };
  }
  return { tone: "neutral", labelKey: "office.header.sync.idle", time: null };
}

const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/**
 * The clock time of the last sync that finished while the office was open (`HH:MM` on this PC's
 * clock), or `null` while none did.
 */
export function useLastSyncTime(sync: SyncState | null): string | null {
  const [time, setTime] = useState<string | null>(null);
  const previous = useRef<SyncState | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = sync;
    if (sync?.kind === "done" && before !== null && before.kind !== "done") {
      setTime(CLOCK.format(new Date()));
    }
  }, [sync]);
  return time;
}
