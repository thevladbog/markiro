import { useCallback, useEffect, useRef, useState } from "react";
import { readShiftJournalCounts, type ShiftJournalCounts } from "./journal.js";
import type { SqlExecutor } from "./mirror.js";

interface ReadState {
  mounted: boolean;
  active: boolean;
  trailing: boolean;
}

const EMPTY: ShiftJournalCounts = { accepted: 0, errors: 0, duplicates: 0 };

/**
 * The shift's durable counts, re-read on demand. Overlapping requests
 * coalesce into one trailing read -- the same discipline the work screen's
 * recent-operations read uses -- so a burst of scans never queues a read per
 * scan and an older snapshot is never published after a newer request.
 */
export function useShiftJournalCounts(
  exec: SqlExecutor,
  shiftId: string,
): { counts: ShiftJournalCounts; refresh: () => void } {
  const [counts, setCounts] = useState<ShiftJournalCounts>(EMPTY);
  const readState = useRef<ReadState>({ mounted: false, active: false, trailing: false });

  const refresh = useCallback((): void => {
    const state = readState.current;
    if (!state.mounted) return;
    if (state.active) {
      state.trailing = true;
      return;
    }
    state.active = true;
    void readShiftJournalCounts(exec, shiftId)
      .then((next) => {
        if (readState.current === state && state.mounted && !state.trailing) setCounts(next);
      })
      .catch((error: unknown) => {
        if (readState.current === state && state.mounted) {
          console.error("station: failed to read shift journal counts", error);
        }
      })
      .finally(() => {
        if (readState.current !== state || !state.mounted) return;
        state.active = false;
        if (state.trailing) {
          state.trailing = false;
          refresh();
        }
      });
  }, [exec, shiftId]);

  useEffect(() => {
    const state: ReadState = { mounted: true, active: false, trailing: false };
    readState.current = state;
    refresh();
    return () => {
      state.mounted = false;
      state.trailing = false;
    };
  }, [refresh]);

  return { counts, refresh };
}
