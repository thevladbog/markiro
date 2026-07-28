import type { OrderConflict } from "../api/types.js";
import { STORE_JOURNAL, withCursor, withStore } from "./db.js";

/** One server reply to a synced order, kept for the service screen. */
export interface JournalEntry {
  at: string;
  deviceSeq: number;
  orderNo: string;
  conflicts: OrderConflict[];
}

export async function appendJournal(entry: JournalEntry): Promise<void> {
  await withStore(STORE_JOURNAL, "readwrite", (s) => s.add(entry));
}

/**
 * The last `limit` entries, most-recent-first: a `withCursor` walk over the
 * autoIncrement key order in reverse (`prev`), stopping once `limit` entries
 * have been visited.
 */
export async function readJournal(limit: number): Promise<JournalEntry[]> {
  if (limit <= 0) return [];
  let seen = 0;
  return withCursor<JournalEntry>(STORE_JOURNAL, "prev", (cursor, stop) => {
    seen += 1;
    if (seen < limit) {
      cursor.continue();
    } else {
      stop();
    }
  });
}
