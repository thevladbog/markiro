import type { OrderConflict } from "../api/types.js";
import { STORE_JOURNAL, withCursor, withStore } from "./db.js";

/**
 * One server reply to a synced order — kept for the service screen, and read
 * back by `session/day-count.ts` to answer how much of their daily allowance a
 * worker has already spent on this device.
 *
 * NO SCHEMA VERSION BUMP came with the fields below, and none was needed: the
 * store is still `{ autoIncrement: true }` with no index, so its SHAPE is
 * unchanged and `db.ts` had nothing to migrate. What did change is what a
 * record contains, and an entry written by an earlier version of the app
 * carries only `at`, `deviceSeq`, `orderNo` and `conflicts` — or those plus the
 * employee and the accepted count, but no `kioskId`. Such an entry cannot be
 * attributed, so every reader that counts must check rather than trust these
 * fields to be there — see `countTakenToday`, which does exactly that.
 */
export interface JournalEntry {
  /** When the DEVICE received the server's answer. Written from the device's
   * own clock, and the order the store is appended in. */
  at: string;
  /**
   * When the worker actually took the goods — the order's `createdAt`, which
   * is the stamp the SERVER files it under (`createFromKiosk`'s `when`). An
   * order queued through an outage syncs hours or days after it was taken, so
   * this and `at` are genuinely different days, and only this one is the day
   * the limit is counted against.
   */
  createdAt: string;
  /**
   * WHICH KIOSK THIS ORDER WAS FILED AT — the binding the device held when the
   * server answered, which is the kiosk the server filed it under, because the
   * token that carried it is that kiosk's.
   *
   * Stamped at APPEND time and not at scan time, and the difference is the whole
   * point: an order queued at gate A and delivered after the tablet was
   * re-paired to gate B is filed by the server at B, so B is what this entry has
   * to say. `deviceSeq` alone cannot stand in for it — the server's idempotency
   * key is `(tenantId, kioskId, deviceSeq)` and a freshly paired kiosk restarts
   * the counter, so the same sequence names different orders at different gates.
   *
   * `null` where the device cannot say which kiosk it is (a config written
   * before `KioskConfig.kioskId` existed), which is the same answer an entry
   * from before this field gives — see `countTakenToday` for why those two
   * unknowns are made to match.
   */
  kioskId: string | null;
  deviceSeq: number;
  orderNo: string;
  /**
   * Which employee this device attributed the order to. Device-local: the
   * order itself names the badge and the server re-resolves it, so this is
   * what the KIOSK believed, never what the server filed. Held here rather
   * than the badge itself — a journal outlives the order by weeks, and a badge
   * is the credential that authorises a pickup.
   */
  employeeId: string;
  /**
   * How many items the server ACCEPTED (`CreateOrderResultDto.itemCount`), not
   * how many were scanned. A refused item never counted against the worker
   * server-side, so it must not count here either.
   */
  acceptedCount: number;
  conflicts: OrderConflict[];
}

/**
 * How much history the journal keeps.
 *
 * The store is append-only and every entry holds the raw marking codes of
 * whatever the server refused — codes the UI deliberately never renders — so
 * without a bound a kiosk accumulates scanned codes in IndexedDB for the life
 * of the device.
 *
 * Two weeks is far more than the day-limit count needs (it reads today) and
 * enough for a service screen to investigate a sync problem from the week
 * before. It is deliberately a WINDOW rather than an entry cap: a cap would
 * have to be argued against the busiest imaginable kiosk before anyone could
 * be sure today's own orders survive it, whereas an entry stamped today is
 * never inside this horizon.
 */
export const JOURNAL_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * Records the server's verdict, then trims whatever has aged out.
 *
 * The prune runs HERE rather than in the caller so the bound cannot be
 * forgotten by the next writer, and it can never fail the append: `flushQueue`
 * reads a rejection from this function as "the acknowledgement was not
 * durable" and replays the order, so a failed piece of housekeeping would cost
 * a duplicate journal entry — the very growth it was trying to contain.
 */
export async function appendJournal(entry: JournalEntry): Promise<void> {
  await withStore(STORE_JOURNAL, "readwrite", (s) => s.add(entry));
  try {
    await pruneJournal(new Date(entry.at));
  } catch (err) {
    console.warn("kiosk: the journal could not be pruned", err);
  }
}

/**
 * Deletes every entry stamped more than `JOURNAL_RETENTION_MS` before `now`.
 *
 * Entries are appended in `at` order under an autoIncrement key, so the
 * expired ones are a PREFIX of the key range: the walk below stops at the
 * first entry inside the window and one keyed delete removes everything up to
 * there, instead of a read-write cursor stepping over every record.
 *
 * An entry whose `at` cannot be parsed stops the walk and is kept. Erring
 * towards keeping data is right here — the alternative is a single unreadable
 * stamp taking a worker's whole day of history with it.
 */
export async function pruneJournal(now: Date): Promise<void> {
  const horizon = now.getTime() - JOURNAL_RETENTION_MS;
  if (Number.isNaN(horizon)) return;
  const expired: IDBValidKey[] = [];
  await withCursor<JournalEntry>(STORE_JOURNAL, "next", (cursor, stop) => {
    const at = Date.parse((cursor.value as JournalEntry).at);
    if (!Number.isNaN(at) && at < horizon) {
      expired.push(cursor.primaryKey);
      cursor.continue();
    } else {
      stop();
    }
  });
  const last = expired.at(-1);
  if (last === undefined) return;
  await withStore(STORE_JOURNAL, "readwrite", (s) => s.delete(IDBKeyRange.upperBound(last)));
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

/**
 * Every entry the device SYNCED at or after `since`, most-recent-first — the
 * day count's reader, and `readJournal`'s sibling over the same cursor.
 *
 * The window is measured on `at` and not on `createdAt`, which looks like the
 * wrong field for a caller asking "what was taken today" and is the only one
 * that works. The walk can stop early only on a value that is monotonic in the
 * key order, and that is `at`: entries are appended as answers arrive. An
 * order queued through an outage is journalled when it finally syncs, so a
 * three-day-old `createdAt` can sit at the very top of the store with today's
 * orders behind it — a walk that stopped there would miss them and hand the
 * worker their whole allowance back.
 *
 * `at >= createdAt` for every order the same device queued and drained, so
 * "synced since midnight" is a superset of "taken since midnight" and the
 * caller filters it down by `createdAt`. The entry that ENDS the walk is
 * returned too (the cursor collects a value before the stop is decided), which
 * is harmless for the same reason.
 *
 * A device whose clock jumps backwards between taking an order and syncing it
 * can drop out of that superset, and then the count is short by one order.
 * That direction is safe: the server still refuses the overflow.
 */
export async function readJournalSince(since: Date): Promise<JournalEntry[]> {
  const floor = since.getTime();
  if (Number.isNaN(floor)) return [];
  return withCursor<JournalEntry>(STORE_JOURNAL, "prev", (cursor, stop) => {
    const at = Date.parse((cursor.value as JournalEntry).at);
    if (!Number.isNaN(at) && at >= floor) cursor.continue();
    else stop();
  });
}
