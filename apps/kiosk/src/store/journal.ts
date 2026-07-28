import type { OrderConflict } from "../api/types.js";
import { open, STORE_JOURNAL, withStore } from "./db.js";

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
 * The last `limit` entries, most-recent-first. `withStore` can't drive this:
 * it wires a single `onsuccess` to capture one result, but a cursor fires
 * `onsuccess` once per step, so this runs its own transaction over the
 * autoIncrement key order in reverse (`prev`) and stops after `limit` steps.
 */
export async function readJournal(limit: number): Promise<JournalEntry[]> {
  const db = await open();
  return new Promise<JournalEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE_JOURNAL, "readonly");
    const entries: JournalEntry[] = [];
    const request = tx.objectStore(STORE_JOURNAL).openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && entries.length < limit) {
        entries.push(cursor.value as JournalEntry);
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(entries);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
  });
}
