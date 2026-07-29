import type { KioskBootstrapDto } from "../api/types.js";
import { kioskIdOf } from "../store/config.js";
import type { JournalEntry } from "../store/journal.js";
import type { QueuedOrder } from "../store/queue.js";

/**
 * The UTC calendar day of an instant, `YYYY-MM-DD`.
 *
 * UTC and NOT the device's own midnight, deliberately: the server counts the
 * day limit with `(created_at at time zone 'utc')::date`
 * (`PickupOrdersService.applyDayLimit`), so a kiosk that rolled over at its
 * local midnight would disagree with the authority for however many hours its
 * timezone is offset — refusing scans the server would accept in the evening,
 * or handing out a second allowance in the morning. The device mirrors the
 * server's boundary rather than the room's.
 */
export function utcDayOf(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** Midnight UTC of the day `when` falls in — the instant the day count reads
 * the journal from. */
export function startOfUtcDay(when: Date): Date {
  return new Date(`${utcDayOf(when)}T00:00:00.000Z`);
}

export interface TakenTodayInput {
  employeeId: string;
  /** The UTC day being counted, from `utcDayOf`. */
  today: string;
  /**
   * WHICH KIOSK THIS DEVICE IS BOUND TO RIGHT NOW — `KioskConfig.kioskId`, and
   * the identity that decides which of the journal's entries are "this kiosk's".
   *
   * `null` for a device that cannot say (a config written before the field
   * existed), which matches the entries that cannot say either.
   */
  boundKioskId: string | null;
  /** The journal, as `readJournalSince(startOfUtcDay(now))` returned it. */
  journal: readonly JournalEntry[];
  /** Everything still waiting to sync, from `listQueue()`. */
  queued: readonly QueuedOrder[];
}

/**
 * How much of their daily allowance this employee has already spent, as far as
 * THIS DEVICE can tell.
 *
 * BEST EFFORT, and the design says so: the spec makes the local day limit
 * «best-effort по локальному журналу заявок киоска (сервер остаётся
 * авторитетом)» (design 2026-07-24 §7). It exists so a worker learns at the
 * scanner that they are out of allowance, instead of finding out after the
 * order is filed. `POST /kiosk/orders` re-decides the limit against live data
 * and its `conflicts[]` win; nothing here may suppress them.
 *
 * ONE-SIDED. The count can only MISS withdrawals — history older than the
 * journal's retention window, a journal that was lost or truncated — never
 * invent one this device did not file. Missing them makes the device offer
 * allowance the server then refuses as `over_limit`, which is the safe failure:
 * the server is still the gate. Over-counting would be the unsafe one, refusing
 * a worker product they are entitled to with nobody around to overrule it,
 * which is why the two sources below are merged by `deviceSeq` rather than
 * added up.
 *
 * THIS KIOSK ONLY, and that boundary is now load-bearing rather than merely
 * unavoidable. What the worker took at OTHER kiosks arrives separately, from
 * the server, in `employees[].takenTodayElsewhere` — read by
 * `takenTodayElsewhere` below and ADDED to this number. Splitting the day count
 * by SOURCE is what makes the sum safe without a watermark: this function sees
 * exactly the orders this device filed, that field sees exactly the ones it did
 * not, and no order can be in both. Widening either side to overlap the other
 * reintroduces double counting, which is the unsafe direction above.
 *
 * AND "THIS KIOSK" IS NOW A KIOSK ID, not merely "whatever this device
 * remembers". The journal belongs to the DEVICE while the server's exclusion is
 * by KIOSK ID, and nothing clears the journal when a tablet is re-paired — the
 * documented recovery path for a device nobody can sign into. So a tablet moved
 * from gate A to gate B used to count gate A's orders here AND receive them in
 * `takenTodayElsewhere`, double counted until UTC midnight: exactly the failure
 * the split was built to make impossible. Each entry therefore carries the
 * kiosk it was filed at (`JournalEntry.kioskId`, stamped when the server's
 * answer is journalled) and only the entries matching `boundKioskId` are
 * counted here. The rest are the server's to report, and it does.
 *
 * ENTRIES THAT NAME NO KIOSK — written by the build before that stamp existed —
 * are counted only while the DEVICE'S OWN BINDING names none either. It is the
 * one judgement call here, and it is decided by which unknown is which: an
 * unstamped journal on a config that is equally unstamped is a device that has
 * not paired since the upgrade, so it has not moved and its history really is
 * this gate's; skipping it would switch the local half of the day limit off
 * across the whole installed base for nothing. And a device that HAS paired
 * since carries a real id, so those same entries stop matching — the very event
 * that could have moved the tablet is the event that orphans them. Counting
 * them unconditionally is what leaves the double count open; skipping them
 * unconditionally under-counts a legitimate same-gate history. Matching unknown
 * to unknown takes the safe side of each.
 *
 * Both sources are counted because both are withdrawals the worker has already
 * walked away with:
 *
 *  - the JOURNAL contributes what the server accepted, which is what actually
 *    counted against them server-side, at the gate it was accepted for;
 *  - the QUEUE contributes everything scanned, because the server has not yet
 *    said which of those it accepts. The moment the order syncs, its journal
 *    entry replaces the estimate.
 *
 * THE QUEUE HALF CARRIES NO KIOSK AND IS NOT FILTERED, deliberately. A queued
 * order has not been filed anywhere yet; it goes out under whatever token the
 * device holds when the drain reaches it, so the server files it under the gate
 * the device is bound to THEN — which is the gate asking this question. An
 * enqueue-time stamp would be a claim about the past that the delivery can
 * falsify, and filtering on it would drop an order this gate really is about to
 * file while `takenTodayElsewhere` (this gate excluded) does not report it
 * either: counted nowhere.
 *
 * Records this device cannot attribute are SKIPPED — entries written before
 * the journal carried an employee, orders queued by an older app version, a
 * stamp that will not parse. Skipping is what "cannot know" looks like; the
 * alternative is charging one worker's bottles to whoever badges in next.
 */
export function countTakenToday({
  employeeId,
  today,
  boundKioskId,
  journal,
  queued,
}: TakenTodayInput): number {
  // Keyed by `deviceSeq` — the order's own identity — because one order can
  // legitimately appear more than once. `flushQueue` journals BEFORE it
  // dequeues, so a crash in between leaves an order in both stores at once and
  // journals its verdict again on replay. Summing the rows would charge the
  // worker twice for bottles they took once.
  //
  // The key is only unique WITHIN one kiosk (`(tenantId, kioskId, deviceSeq)` is
  // the server's idempotency key, and a freshly paired kiosk restarts the
  // counter), which the filter below is what makes true here: every key in this
  // map belongs to `boundKioskId`.
  const perOrder = new Map<number, number>();

  // The journal first: where both stores hold the same order, the server's
  // accepted count is the better answer than the queue's estimate.
  for (const entry of journal) {
    // Another gate's order — the server counts it in `takenTodayElsewhere`, so
    // counting it here too is the double count this filter exists to close.
    if (kioskIdOf(entry) !== boundKioskId) continue;
    const taken = attributedEntry(entry);
    if (!taken) continue;
    if (taken.employeeId !== employeeId || utcDayOfStamp(taken.takenAt) !== today) continue;
    if (!perOrder.has(taken.deviceSeq)) perOrder.set(taken.deviceSeq, taken.items);
  }

  for (const order of queued) {
    const taken = attributedOrder(order);
    if (!taken) continue;
    if (taken.employeeId !== employeeId || utcDayOfStamp(taken.takenAt) !== today) continue;
    if (!perOrder.has(taken.deviceSeq)) perOrder.set(taken.deviceSeq, taken.items);
  }

  let total = 0;
  for (const items of perOrder.values()) total += items;
  return total;
}

/**
 * The OTHER half of this employee's day count: what they took today at every
 * kiosk except this one, as the last bootstrap reported it.
 *
 * The device cannot see another kiosk's orders at all — they never touch its
 * journal or its queue — so before this the worker was simply offered a second
 * allowance here, took it, and was told «Заявка передана» while the server
 * refused the overflow into a `conflicts[]` that an offline submit gives nobody
 * to read.
 *
 * ADDED to `countTakenToday`, never substituted for it, and the two can be
 * added precisely because they are split by SOURCE: the server excludes this
 * kiosk from the figure, this device counts only this kiosk. No watermark, no
 * timestamp comparison, no `deviceSeq` high-water mark — nothing that can be
 * slightly wrong in the direction that costs a worker their allowance.
 *
 * CHECKED, NOT TRUSTED, for the same reason `attributedEntry` below checks a
 * stored record: nothing validates a bootstrap at runtime (`KioskBootstrapDto`
 * is a cast over `res.json()`, not a schema) and IndexedDB holds whatever
 * snapshot any past server sent. A payload from a server that predates the
 * field, or one whose count is not a plain non-negative integer, reads as ZERO
 * — the safe direction, and the one that keeps an unattended kiosk handing out
 * product instead of printing «осталось NaN».
 */
export function takenTodayElsewhere(
  bootstrap: KioskBootstrapDto | null,
  employeeId: string,
): number {
  const employee = bootstrap?.employees?.find((one) => one.id === employeeId);
  const taken = (employee as { takenTodayElsewhere?: unknown } | undefined)?.takenTodayElsewhere;
  // `Number.isInteger` alone rejects NaN, Infinity and the bigint-as-string
  // Postgres hands back for an uncast `count(*)`; the bound rejects a negative,
  // which could only ever cancel out withdrawals this device really made.
  if (!Number.isInteger(taken) || (taken as number) < 0) return 0;
  return taken as number;
}

/** One withdrawal, reduced to the three things the count needs. */
interface Withdrawal {
  deviceSeq: number;
  employeeId: string;
  /** The order's `createdAt`: when the worker took it, which is the stamp the
   * server files the order under. */
  takenAt: string;
  items: number;
}

/**
 * The stored record, checked rather than trusted.
 *
 * Both stores are read back through types that describe what TODAY's app
 * writes, while IndexedDB holds whatever every past version wrote — so these
 * guards are the upgrade path, and the reason a device with an old journal
 * counts zero instead of throwing on the way into a worker's cart.
 */
function attributedEntry(entry: JournalEntry): Withdrawal | null {
  const record = entry as Partial<JournalEntry>;
  if (typeof record.deviceSeq !== "number") return null;
  if (typeof record.employeeId !== "string" || record.employeeId === "") return null;
  if (typeof record.createdAt !== "string") return null;
  if (!Number.isInteger(record.acceptedCount) || (record.acceptedCount as number) < 0) return null;
  return {
    deviceSeq: record.deviceSeq,
    employeeId: record.employeeId,
    takenAt: record.createdAt,
    items: record.acceptedCount as number,
  };
}

function attributedOrder(order: QueuedOrder): Withdrawal | null {
  const record = order as Partial<QueuedOrder>;
  if (typeof record.deviceSeq !== "number") return null;
  if (typeof record.employeeId !== "string" || record.employeeId === "") return null;
  const body = record.body;
  if (!body || !Array.isArray(body.items)) return null;
  if (typeof body.createdAt !== "string") return null;
  return {
    deviceSeq: record.deviceSeq,
    employeeId: record.employeeId,
    takenAt: body.createdAt,
    items: body.items.length,
  };
}

/** The UTC day of a stored stamp, or `null` when it cannot be read — an
 * order the device cannot place in time is one it must not count. */
function utcDayOfStamp(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return utcDayOf(new Date(ms));
}
