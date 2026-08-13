import { isDeviceRevoked, isUnreachable, KioskApiError, type KioskClient } from "../api/client.js";
import { isValidSscc } from "@markiro/domain";
import type {
  BoxConflict,
  BoxConflictReason,
  CreateOrderAdmissionDto,
  CreateOrderDto,
} from "../api/types.js";
import {
  assertMeasurableGeneratedAt,
  replaceSnapshot,
  type CachedSnapshot,
} from "../store/cache.js";
import { readConfig } from "../store/config.js";
import { appendJournal } from "../store/journal.js";
import {
  activateBoxRegistryPage,
  beginBoxRegistryStage,
  discardBoxRegistryStage,
  readBoxRegistryMeta,
  stageBoxRegistryPage,
} from "../store/box-registry.js";
import {
  attestQueuedOrder,
  dequeueOrder,
  listQueue,
  persistAdmissionNonce,
  quarantineOrder,
  type QueuedOrder,
} from "../store/queue.js";

/**
 * How often a paired kiosk pulls a fresh bootstrap. Every authenticated call
 * bumps `kiosks.last_seen_at` server-side, so this doubles as the heartbeat.
 */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Past this the UI warns that the dataset is ageing, but work continues. */
export const STALE_WARN_MS = 24 * 60 * 60_000;

/** Past this the device refuses to hand anything out until it syncs again. */
export const STALE_BLOCK_MS = 7 * 24 * 60 * 60_000;

export type CacheAge = "fresh" | "warn" | "blocked";

/**
 * How much the cached dataset can still be trusted.
 *
 * Measured against `generatedAt` — the SERVER's stamp — and deliberately not
 * against the snapshot's own `fetchedAt`, which is written from the device's
 * clock: an unattended tablet at a factory gate is the least trustworthy clock
 * in the system, and gating a lockout on it would let a drifted clock either
 * brick a healthy kiosk or keep a week-old roster in service.
 *
 * A `generatedAt` in the future (the tablet lagging the server, which happens
 * routinely after a cold boot with no NTP) reads `fresh`: the age is negative,
 * so neither threshold trips. Comparing magnitude instead of signed age would
 * lock out a device whose only fault is a slow clock.
 *
 * FAILS CLOSED. An unparseable stamp makes `ageMs` NaN, and every comparison
 * against NaN is false — so without the guard below this returns `fresh`
 * forever, and one edited character in a stolen tablet's IndexedDB disables
 * the seven-day lockout permanently. A gate that cannot establish freshness
 * must not assert it. `assertMeasurableGeneratedAt` already refuses to persist
 * such a stamp on both write paths (this refresh and pairing), so this branch
 * is defence in depth for one that reached the store by another route.
 */
export function cacheAge(generatedAt: string, now: Date): CacheAge {
  return ageVerdict(now.getTime() - Date.parse(generatedAt));
}

/** The two thresholds, applied to an age that has already been measured — one
 * rule behind all three doors into it (`cacheAge`, `snapshotAge`). */
function ageVerdict(ageMs: number): CacheAge {
  if (Number.isNaN(ageMs)) return "blocked";
  if (ageMs >= STALE_BLOCK_MS) return "blocked";
  if (ageMs >= STALE_WARN_MS) return "warn";
  return "fresh";
}

/**
 * WHAT TIME THE SERVER THINKS IT IS, reconstructed on the device.
 *
 * The snapshot holds both halves of one instant: `generatedAt` is the SERVER's
 * stamp for it, `fetchedAt` the DEVICE's stamp for receiving it. Their
 * difference is this device's offset from the server's clock, established the
 * last time the two were provably in contact, and adding it to the device
 * clock cancels a constant skew out of everything downstream.
 *
 * TWO BUGS SHARE THIS ROOT, and both are fixed by measuring through the offset
 * rather than by subtracting two absolute clocks:
 *
 *  - a tablet more than seven days FAST used to read a bootstrap generated
 *    seconds ago as older than `STALE_BLOCK_MS`, so every successful refresh
 *    left an otherwise healthy kiosk on the Blocked screen — «обратитесь к
 *    администратору» about a network that is working perfectly;
 *  - and the same skew, applied to an order's `createdAt`, moved the withdrawal
 *    into a UTC day the worker had not spent yet, which is a fresh daily
 *    allowance for anyone who can reach the tablet's date setting.
 *
 * An UNMEASURABLE offset yields an Invalid Date rather than the raw device
 * clock, and every caller treats that as "cannot establish the time" — the same
 * fail-closed rule `cacheAge` applies to an unparseable stamp. Falling back to
 * the device's own clock would hand back exactly the trust this exists to
 * remove.
 */
export function serverNow(snapshot: CachedSnapshot | null, now: Date): Date {
  if (!snapshot) return new Date(Number.NaN);
  const offsetMs = Date.parse(snapshot.bootstrap.generatedAt) - Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(offsetMs)) return new Date(Number.NaN);
  return new Date(now.getTime() + offsetMs);
}

/**
 * The same gate, asked of what the device actually holds.
 *
 * Asked in SERVER time (`serverNow` above), which is what makes this measure
 * how long ago the dataset was fetched rather than how far apart the two clocks
 * are. The arithmetic reduces to `now - fetchedAt` — two readings of the SAME
 * clock — so a device hours or years off the server's time still ages its
 * snapshot at one second per second, and any successful refresh re-establishes
 * the offset.
 *
 * That does not put the device's clock back in charge of the lockout. The
 * measurement is a DIFFERENCE between two device readings, so a constant skew
 * cancels; only a clock moved BACKWARDS between refreshes can shorten it, and
 * that direction already read `fresh` when the age was measured against
 * `generatedAt` (see the future-stamp rule above). What it removes is the
 * failure in the other direction, where a fast clock bricked a working kiosk.
 *
 * NO SNAPSHOT IS `blocked`, and that is the second half of the fail-closed
 * rule above: a paired device with nothing cached cannot say how old its data
 * is, and a gate that cannot establish freshness must not assert it. The two
 * halves belong together — one answers "the stamp is unreadable", the other
 * "there is no stamp" — and both used to be true only for as long as an
 * untested `snapshot ? … : "blocked"` in the shell's wiring kept saying so.
 *
 * `null` is the normal state of a device between pairing and its first
 * bootstrap, which routes to the pairing screen anyway; this answer only
 * matters for a device that IS paired and has somehow lost its dataset.
 */
export function snapshotAge(snapshot: CachedSnapshot | null, now: Date): CacheAge {
  const ageMs = snapshotAgeMs(snapshot, now);
  // `null` is the fail-closed answer — no snapshot, or a stamp that cannot be
  // read — and it is `blocked` for the same reason either way.
  return ageMs === null ? "blocked" : ageVerdict(ageMs);
}

/**
 * The same measurement, handed back as a NUMBER rather than as a verdict.
 *
 * The strip needs it to say «Данные обновлялись 30 ч назад» (design 2026-07-24
 * §7) instead of the threshold-shaped «больше суток назад», which reads
 * identically on the second day and on the sixth — and the sixth is the one
 * where the kiosk is about to stop.
 *
 * `null` WHEREVER THE GATE WOULD BLOCK, and that is the point of deriving one
 * from the other: an unreadable stamp must not become a confident number on a
 * plaque, and the two answers can never drift apart because there is only one
 * arithmetic. `serverNow` reduces this to `now - fetchedAt`, two readings of
 * the same clock, so a skewed tablet still ages its snapshot at one second per
 * second — see `snapshotAge` above.
 */
export function snapshotAgeMs(snapshot: CachedSnapshot | null, now: Date): number | null {
  if (!snapshot) return null;
  const ageMs = serverNow(snapshot, now).getTime() - Date.parse(snapshot.bootstrap.generatedAt);
  return Number.isFinite(ageMs) ? ageMs : null;
}

/** How the plaque says «N назад»: a unit and a whole number, never a suffix. */
export interface AgeLabel {
  unit: "hours" | "days";
  n: number;
}

/**
 * «N назад», coarsely — whole hours up to two days, whole days after that.
 *
 * COARSE ON PURPOSE, for two reasons. Nobody standing at a kiosk acts
 * differently on 30 h than on 30 h 40 min; and the precision would cost the one
 * thing this copy cannot afford, which is a Russian plural. i18next's RU
 * categories (`_one/_few/_many/_other`) have no EN counterpart and the two
 * files must carry identical key sets, so the unit is chosen HERE and the copy
 * names it with an indeclinable abbreviation («ч», «сут») — the same dodge
 * `cart.total` already uses for «{{n}} шт».
 *
 * Rounds DOWN, like every «N ago» anywhere, and never below zero: a device
 * whose clock moved backwards between two refreshes must not be told its data
 * is minus four hours old.
 */
export function humaniseAge(ageMs: number): AgeLabel {
  const hours = Math.max(0, Math.floor(ageMs / (60 * 60_000)));
  return hours < 48 ? { unit: "hours", n: hours } : { unit: "days", n: Math.floor(hours / 24) };
}

/**
 * The drain currently owed — the tail of the chain, not merely a busy flag.
 *
 * Task 14 triggers a flush from both a periodic interval and an `online`
 * handler, which can fire close enough together that a second drain reads the
 * queue before the first has dequeued what it already submitted. Resubmitting
 * is harmless on the server — it is idempotent on
 * `(tenantId, kioskId, deviceSeq)` — but the second acknowledgement appends a
 * duplicate journal entry to the service screen's log. The invariant belongs
 * here rather than in the caller: it is this module's, and every future caller
 * would otherwise have to rederive it.
 *
 * A PROMISE rather than a boolean, because a second caller must WAIT rather
 * than be turned away — see `flushQueue`.
 */
let draining: Promise<void> | null = null;

/**
 * THE FIRST RETRY AFTER A DEAD LINK, and the floor for every later one.
 *
 * A drain that stops on a transport failure used to wait for whatever came
 * first: the five-minute refresh tick, or an `online` event. So a blink that
 * cleared in two seconds still cost a worker's order up to five minutes in the
 * queue — and `online` never fires at all for the commonest outage of the lot,
 * an API that is down behind a Wi-Fi link that is perfectly up. One second is
 * short enough that such a blink costs a blink.
 */
export const RETRY_BASE_MS = 1_000;

/**
 * And the ceiling, deliberately well below `REFRESH_INTERVAL_MS`.
 *
 * A kiosk left over a weekend outage must not spin, but it must also never
 * back off to LONGER than the refresh tick that used to be the only retry —
 * that would make this change a regression for exactly the long outage it is
 * least about. One attempt a minute is the compromise: negligible traffic, and
 * a queue that starts moving within a minute of the link returning.
 */
export const RETRY_MAX_MS = 60_000;

let retryDelayMs = RETRY_BASE_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Bumped by `cancelFlushRetry`, and read by a drain that was already running
 * when it was called. Without it the unmount race stays open: the shell cancels,
 * the in-flight drain then reaches its own `finally` and arms a retry holding
 * the client of a React tree that no longer exists.
 */
let retryEpoch = 0;

/** Clears the armed retry and puts the schedule back to the base — the ordinary
 * "the link works again" reset, with no bearing on drains in flight. */
function resetRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_BASE_MS;
}

/**
 * Disowns the retry entirely: the armed one is dropped, the schedule is reset,
 * and any drain still in flight is barred from arming a replacement.
 *
 * The shell calls this when it unmounts. The retry closes over the CLIENT that
 * shell built — the one recording the reply for the order `submitCart` awaits —
 * so one left armed past an unmount posts under a React tree that is gone, and
 * on a device re-paired in between would post under a token it no longer holds.
 */
export function cancelFlushRetry(): void {
  retryEpoch += 1;
  resetRetry();
}

/**
 * Arms the next attempt and doubles the wait, capped.
 *
 * ONE PENDING RETRY AT A TIME. Several drains can stop on the same outage — the
 * refresh tick, an `online` handler and a worker's own submit all reach here —
 * and each arming its own would turn a backoff into a burst, growing with the
 * length of the outage. The first one owns the slot; the rest are already
 * covered by it.
 */
function scheduleRetry(client: KioskClient, now: () => Date): void {
  if (retryTimer !== null) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // Through `flushQueue`, never straight into `drainOnce`: the retry has to
    // respect the same no-overlap chain as every other caller.
    void flushQueue(client, now);
  }, delay);
}

/**
 * Drains the offline queue oldest-first. NEVER REJECTS — every failure, from
 * the network down to IndexedDB itself, leaves the affected order queued for
 * the next drain instead of surfacing here. Task 14 calls this from a
 * `setInterval` and an `online` handler, neither of which can catch anything,
 * so no caller needs a `.catch()`. `refreshSnapshot` deliberately does the
 * opposite: its caller has to learn that the device is offline.
 *
 * Two invariants, both load-bearing:
 *
 *  - **Acknowledge, then remove.** The order leaves the queue only after the
 *    server's answer is durably journalled. A crash in between therefore
 *    replays the order rather than losing it, and a replay is harmless because
 *    the server is idempotent on `(tenantId, kioskId, deviceSeq)` — it returns
 *    the original order instead of creating a second one. The reverse order
 *    (remove, then journal) would silently drop a worker's pickup on any crash
 *    between the two writes.
 *  - **The first failure aborts the whole drain**, it does not skip ahead.
 *    Orders carry a monotonic `deviceSeq` and the server records them in
 *    arrival order; letting a later order overtake a stuck earlier one would
 *    reorder a worker's history and break the day-limit accounting that
 *    depends on it.
 *
 *    The one exception is an order the server refuses PERMANENTLY, which is
 *    not "stuck" but "answered": see `isTerminalRejection` below. It is moved
 *    aside so the drain can carry on, and moving it aside cannot reorder
 *    anything, because it is never going to be filed at all.
 *
 * KNOWN LIMITATION — a double journal entry. "Acknowledge, then remove" is the
 * right trade in the other direction too: if `dequeueOrder` fails after the
 * journal write succeeded, the order replays and its verdict is journalled a
 * second time. The alternative loses the pickup entirely, so this stays. It
 * costs one duplicate line in a service-screen log that nothing computes from.
 *
 * CONCURRENT CALLERS ARE QUEUED, NOT TURNED AWAY, and the difference is a
 * worker's confirmation. Two drains must never run at once (see `draining`
 * above), but the interval and the `online` handler are not the only callers:
 * `submitCart` awaits its own drain to learn whether THIS order reached the
 * server, and «Заявка № … передана» is the whole point of the confirmation. An
 * early return would resolve that await having done nothing, and the kiosk
 * would tell an ONLINE worker their order is queued with no number — precisely
 * during backlog recovery, when the `online` handler is draining an outage and
 * workers are submitting again.
 *
 * Handing the second caller the promise already in flight would be simpler and
 * is wrong for one reason: `listQueue` below is read ONCE, before the first
 * submission, so a drain already running snapshotted a queue that this caller's
 * order was never in. Awaiting it would resolve having delivered everything
 * EXCEPT the one order somebody is standing there waiting on. So each call gets
 * a drain of its own, chained behind whatever is already owed — which keeps the
 * no-overlap invariant (the chain is sequential) and makes the resolution mean
 * "the queue as of your call has been attempted".
 *
 * The chained drain uses the CLIENT ITS OWN CALLER PASSED, which the shell
 * depends on: that client is the one recording the reply for the order being
 * awaited.
 *
 * AND IT RE-ARMS ITSELF after a pass that reached nothing — an exponential
 * backoff from `RETRY_BASE_MS` to `RETRY_MAX_MS`, reset by the first delivery
 * that lands. Callers therefore own no retry schedule of their own, and the
 * shell owns exactly one obligation in return: `cancelFlushRetry` on unmount.
 */
export function flushQueue(client: KioskClient, now: () => Date): Promise<void> {
  // Started synchronously when nothing is in flight, so a lone caller reads the
  // queue at call time exactly as it always did.
  const run =
    draining === null ? drainOnce(client, now) : draining.then(() => drainOnce(client, now));
  // `drainOnce` never rejects, so the catch is unreachable today; it is here so
  // that a future one could not poison every drain queued behind it. Clearing
  // the tail when it is still ours keeps an idle device from holding a chain of
  // settled promises.
  const tail: Promise<void> = run
    .catch(() => {})
    .then(() => {
      if (draining === tail) draining = null;
    });
  draining = tail;
  return tail;
}

/**
 * The statuses that mean THIS ORDER will never be accepted, however many times
 * it is offered — the only failures allowed to take an order out of the queue
 * without the server having filed it.
 *
 * TWO ARE REACHABLE, and both are the same shape: something the cabinet
 * changed while the order sat in an offline queue.
 *
 *  - 400 — a write-off whose reason an administrator archived before the kiosk
 *    synced (`resolveWriteoffReasonId`, «Unknown or archived writeoff reason»);
 *  - 422 — a badge that no longer resolves to an active employee, deleted or
 *    archived server-side after the scan (`createFromKiosk` step 2, «Unknown or
 *    inactive badge»).
 *
 * Without a quarantine either one parks at the head of the queue and every
 * later purchase sits behind it while the kiosk goes on cheerfully accepting
 * and confirming new ones.
 *
 * THE 422 IS THE SERVER'S HALF OF THIS RULE and was hard-won: an unknown badge
 * used to answer 401, which is the one status this list must never contain, so
 * that order was undeliverable AND unquarantinable and blocked the queue
 * permanently. The device cannot repair that from here — a status is all it
 * gets, and sniffing the message string would be worse — so the fix is that the
 * server no longer describes a bad ORDER with the device's own credential
 * status. Keep the two apart: adding 401 here to "handle" a bad badge would
 * trade a stalled queue for an emptied one.
 *
 * DELIBERATELY AN ALLOWLIST, not "any 4xx". The two statuses that would be
 * catastrophic to include are both 4xx:
 *
 *  - 401 is the DEVICE's credential, not the order — a revoked or archived
 *    kiosk answers every request with it, so quarantining on it would empty a
 *    whole queue on a revocation instead of routing the device back to pairing
 *    (`isDeviceRevoked`, handled in the shell's refresh);
 *  - 404 is overwhelmingly a MISCONFIGURED SERVER URL or a reverse proxy that
 *    has lost the route, and a kiosk pointed at the wrong host would otherwise
 *    quarantine every order it ever took, one by one, while the network is
 *    perfectly healthy.
 *
 * 408 and 429 are transport back-pressure and retry by definition. A status
 * left off this list costs only a stalled queue that recovers; one wrongly on
 * it costs orders that could have been delivered — so the list stays the three
 * statuses the server actually raises against a body it will never take.
 *
 * Subscription expiry is the one coded exception. A 403 by itself remains
 * retryable: it may describe an authorization policy that changes when an
 * administrator repairs the device or user. The exact
 * `subscription_read_only` code instead means this record's claimed occurrence
 * is after the subscription ended. Replaying the same immutable record cannot
 * change that verdict, while later queue records may still be eligible because
 * they carry an earlier validated occurrence and a different device sequence.
 */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 422]);

export function isTerminalRejection(err: unknown): boolean {
  return (
    err instanceof KioskApiError &&
    (TERMINAL_STATUSES.has(err.status) ||
      (err.status === 403 && err.code === "subscription_read_only"))
  );
}

function admissionRequest(body: CreateOrderDto): CreateOrderAdmissionDto {
  const content: CreateOrderDto = { ...body };
  delete content.admissionProof;
  delete content.createdAt;
  return content;
}

/**
 * An admission route can legitimately be absent (rolling back to an old
 * server) or unnecessary (an unmanaged/perpetual tenant). An exact
 * subscription 403 means the reservation window closed while this order was
 * pending; submitting the proofless body is intentional because the negotiated
 * order endpoint then returns the durable terminal verdict the worker can
 * quarantine. Other 403s remain retryable and keep the pending record intact.
 */
function maySubmitWithoutAttestation(err: unknown): boolean {
  return (
    err instanceof KioskApiError &&
    (err.status === 404 ||
      (err.status === 403 && err.code === "subscription_read_only") ||
      (err.status === 409 && err.code === "kiosk_admission_not_required"))
  );
}

/**
 * Moves a permanently refused order aside. NOTHING IS DROPPED — the whole
 * record, raw marking codes and all, goes to the quarantine store, which is
 * never pruned, and the refusal is journalled where the service screen already
 * reads verdicts from.
 *
 * CUSTODY BEFORE REMOVAL, the same invariant the success path keeps: the order
 * leaves the queue only once its body is durable elsewhere. A crash in between
 * replays the submit, collects the same refusal and re-parks it — harmless,
 * because the quarantine store is keyed by `deviceSeq` and a second `put`
 * overwrites the first.
 *
 * Answers whether the drain may CONTINUE. A store that refused the hand-over
 * leaves the order exactly where it was, and the caller stops rather than
 * skipping it — an order still in the queue must not be overtaken.
 */
async function quarantine(
  order: QueuedOrder,
  err: KioskApiError,
  now: () => Date,
  kioskId: string | null,
): Promise<boolean> {
  const at = now().toISOString();
  const boxConflicts = safeBoxConflicts(err.details);
  try {
    await quarantineOrder({
      ...order,
      at,
      status: err.status,
      message: err.message,
      ...(boxConflicts.length > 0 ? { boxConflicts } : {}),
    });
  } catch (storeErr) {
    console.error("kiosk: a refused order could not be set aside", storeErr);
    return false;
  }
  try {
    await appendJournal({
      at,
      // The scan time, as on the success path: a refusal has to be readable
      // beside the day it belongs to, not the day it was finally answered.
      createdAt: order.body.createdAt ?? at,
      // The gate that refused it, which is the gate it was offered to. A
      // refusal counts nothing against the worker, so this only ever keeps the
      // line legible beside its neighbours on the service screen.
      kioskId,
      deviceSeq: order.deviceSeq,
      // The vocabulary `Done` already uses for an order the server refused
      // outright, so the service screen needs no new state to read one.
      orderNo: "",
      employeeId: order.employeeId,
      // Nothing was accepted, so nothing is charged to the worker — the same
      // rule the success path applies to a refused ITEM, applied to the order.
      acceptedCount: 0,
      conflicts: [],
    });
  } catch (journalErr) {
    // Best effort: the quarantine record is the custody, the journal is the
    // log. Losing the log line must not put the order back in the queue.
    console.warn("kiosk: a refused order could not be journalled", journalErr);
  }
  try {
    await dequeueOrder(order.deviceSeq);
  } catch (storeErr) {
    console.error("kiosk: a refused order could not leave the queue", storeErr);
    return false;
  }
  return true;
}

const BOX_CONFLICT_REASONS: ReadonlySet<BoxConflictReason> = new Set([
  "unknown_box",
  "box_not_closed",
  "box_disassembled",
  "box_contents_changed",
  "mixed_product_box",
  "duplicate",
  "over_limit",
]);

/** Copies only the public box verdict fields out of an untrusted error body. */
function safeBoxConflicts(details: unknown): BoxConflict[] {
  if (!details || typeof details !== "object") return [];
  const raw = (details as { boxConflicts?: unknown }).boxConflicts;
  if (!Array.isArray(raw) || raw.length > 100) return [];
  const conflicts: BoxConflict[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { sscc?: unknown; bottleCount?: unknown; reason?: unknown };
    if (
      typeof candidate.sscc !== "string" ||
      !isValidSscc(candidate.sscc) ||
      !(
        candidate.bottleCount === null ||
        (Number.isInteger(candidate.bottleCount) &&
          (candidate.bottleCount as number) > 0 &&
          (candidate.bottleCount as number) <= 500)
      ) ||
      typeof candidate.reason !== "string" ||
      !BOX_CONFLICT_REASONS.has(candidate.reason as BoxConflictReason)
    ) {
      return [];
    }
    conflicts.push({
      sscc: candidate.sscc,
      bottleCount: candidate.bottleCount as number | null,
      reason: candidate.reason as BoxConflictReason,
    });
  }
  return conflicts;
}

/**
 * One pass over the queue. Never rejects, never overlaps another — the
 * serialisation is `flushQueue`'s, which is the only caller.
 *
 * AND IT SCHEDULES ITS OWN FOLLOW-UP when it stopped because nothing was
 * reached. See `RETRY_BASE_MS` for why, and `scheduleRetry` for the shape.
 */
async function drainOnce(client: KioskClient, now: () => Date): Promise<void> {
  const startedAt = retryEpoch;
  /** The server answered at least once in this pass — so the link works, and
   * whatever the backoff had climbed to describes an outage that is over. */
  let delivered = false;
  /** This pass stopped on a failure that never reached the APPLICATION — no
   * answer at all, or a gateway answering for an upstream it could not talk to
   * (`isUnreachable`). The only kind a fast retry can fix, and the only kind
   * that arms one. */
  let unreachable = false;
  try {
    /**
     * WHICH KIOSK EVERYTHING THIS PASS DELIVERS WILL BE FILED AT.
     *
     * The token in `client` is this kiosk's, so the server files every order
     * below under this id — including one queued at a gate the tablet has since
     * been moved from. Read ONCE per pass, and read from the store rather than
     * taken as an argument, so it is the binding as of the drain and not as of
     * whenever the caller was built (`flushQueue` has 30-odd call sites; a
     * parameter would be a stale copy at most of them).
     *
     * Inside the try on purpose: a config the store will not hand over aborts
     * the pass and leaves the orders queued, exactly as a failing `listQueue`
     * does. Journalling them under a guessed `null` instead would file today's
     * withdrawals under "no kiosk" on a device that has one, and the day count
     * would stop seeing them.
     */
    const kioskId = (await readConfig())?.kioskId ?? null;
    const queued = await listQueue(); // ascending deviceSeq
    for (const order of queued) {
      /** Whether THIS order's failure came from the wire or from the store
       * beneath the journal write — the two are indistinguishable by the error
       * alone (neither carries a status) and mean opposite things here. */
      let answered = false;
      try {
        let submittedOrder = order;
        if (order.admissionState === "pending_attestation") {
          let attestedBody = order.body;
          try {
            const admissionNonce = order.admissionNonce ?? crypto.randomUUID().replaceAll("-", "");
            if (
              !order.admissionNonce &&
              !(await persistAdmissionNonce(order.deviceSeq, admissionNonce))
            ) {
              continue;
            }
            const admission = await client.attestOrder({
              ...admissionRequest(order.body),
              admissionNonce,
            });
            const submitBody = admissionRequest(order.body);
            delete submitBody.admissionNonce;
            attestedBody = {
              ...submitBody,
              createdAt: admission.claimedAt,
              admissionProof: admission.admissionProof,
            };
          } catch (error) {
            if (!maySubmitWithoutAttestation(error)) throw error;
          }
          // The cursor update is conditional on this exact pending record
          // still existing. A concurrent removal wins; never submit from the
          // stale in-memory snapshot or put it back after the response.
          if (!(await attestQueuedOrder(order.deviceSeq, attestedBody))) continue;
          submittedOrder = { ...order, body: attestedBody };
          delete submittedOrder.admissionState;
        }
        const result = await client.submitOrder(submittedOrder.body);
        answered = true;
        delivered = true;
        const at = now().toISOString();
        await appendJournal({
          at,
          // The order's own scan time, which is what the server files it under
          // (`createFromKiosk`: `when = dto.createdAt ?? new Date()`). The
          // fallback mirrors that second branch — with no `createdAt` in the
          // body the server stamps the order as it arrives, which is this
          // moment. Journalling the sync time instead would move an order
          // queued through an outage into the wrong day for the day count.
          createdAt: submittedOrder.body.createdAt ?? at,
          // The kiosk the server just filed it under — the one whose token
          // carried it, not the one it was scanned at. An order queued at gate
          // A and delivered after a re-pairing to gate B belongs to B, and the
          // day count has to agree with the server about which.
          kioskId,
          deviceSeq: order.deviceSeq,
          orderNo: result.orderNo,
          // Whom the DEVICE opened the session for; the server re-resolves the
          // badge and may disagree, which is one of several reasons the local
          // day count is best-effort.
          employeeId: order.employeeId,
          // What the server ACCEPTED. A refused item never counted against the
          // worker server-side, so it must not count against them here.
          acceptedCount: result.itemCount,
          conflicts: result.conflicts,
        });
      } catch (err) {
        // A verdict the order can never come back from is not a stall: park it
        // and carry on, so one poisoned record cannot hold a day's pickups.
        // A timeout is deliberately NOT one of these — `KioskTimeoutError`
        // carries no status, so an aborted request stays retryable and the
        // order stays queued.
        if (
          isTerminalRejection(err) &&
          (await quarantine(order, err as KioskApiError, now, kioskId))
        ) {
          continue;
        }
        // AN ANSWER FROM THE APPLICATION IS NOT AN OUTAGE — BUT AN ANSWER FROM
        // A GATEWAY IS. The backoff is for a link that carried nothing to the
        // API, because that is the only failure a fast retry can fix. A 500 or
        // a 429 has been reached, and hammering a struggling server every
        // second is the opposite of back-pressure; a 401 is a revoked device,
        // which the shell answers by returning to pairing and which no retry
        // can repair. Those wait for the ordinary refresh tick, as they always
        // did.
        //
        // A 502/503/504 is neither: the proxy is answering for an application
        // it could not reach (`isUnreachable`), so the queue is stalled by an
        // outage after all and used to wait out the full five-minute tick
        // before trying again — the whole reason the backoff exists.
        //
        // And a failure raised AFTER the submit resolved is the journal's
        // store, not the wire — the order is owed, but the network is
        // demonstrably fine.
        unreachable = !answered && isUnreachable(err);
        // Offline, rejected, or the journal write failed — either way this
        // order is still owed. Stop here so the next drain retries it in place.
        return;
      }
      await dequeueOrder(order.deviceSeq);
    }
  } catch {
    // The store itself failed (`listQueue`, `dequeueOrder`). Nothing is lost:
    // an order only leaves the queue after a durable acknowledgement, so the
    // next drain picks up wherever this one stopped. Swallowed to keep the
    // never-rejects contract above true for the timer that drives it.
  } finally {
    // A cancel that landed WHILE this pass ran disowns it: the shell it belongs
    // to has gone, so neither half of the bookkeeping below is its business any
    // more, least of all arming a timer that would outlive the tree.
    if (retryEpoch === startedAt) {
      // Order matters: the reset clears whatever the outage had armed and puts
      // the schedule back to the base, and the arming below then starts from
      // that base. A pass that delivered and then lost the link is making
      // progress and is not the same outage.
      if (delivered) resetRetry();
      if (unreachable) scheduleRetry(client, now);
    }
  }
}

/**
 * Pulls a fresh bootstrap and swaps it in wholesale.
 *
 * `replaceSnapshot` runs only after `bootstrap()` resolves, so a failed
 * refresh leaves the cached dataset exactly as it was — a kiosk that wiped its
 * cache whenever the network blinked would brick itself, which is the opposite
 * of what an offline-first device is for.
 *
 * REJECTS ON FAILURE, unlike `flushQueue`, and the asymmetry is deliberate: a
 * failed drain is invisible to the user (the order is simply still queued),
 * whereas a failed refresh is the one signal that tells the status strip the
 * device is offline and lets `cacheAge` start counting against the snapshot it
 * still holds. Callers must handle the rejection.
 *
 * AND MUST NOT READ EVERY REJECTION AS AN OUTAGE. A `KioskApiError` with status
 * 401 (`isDeviceRevoked`) is the server ANSWERING — the kiosk archived, or a
 * replacement device having redeemed a new token — and the device that treats
 * it as a blink goes on admitting employees for the seven days its cached
 * roster takes to age out. The shell's `revoke` handles it.
 *
 * A bootstrap whose `generatedAt` cannot be parsed is refused rather than
 * stored (`assertMeasurableGeneratedAt`, shared with the pairing screen, which
 * writes a snapshot too), down the same path as a dead network — so the device
 * keeps its last-known-good snapshot and ages fresh → warn → blocked over seven
 * days (a six-day warning window) instead of locking out on the spot.
 *
 * Only `generatedAt` is checked, not the whole payload. `zod` is a declared
 * dependency but nothing in `src/` validates responses yet; full response
 * validation is a separate concern and does not belong in this guard.
 */
const BOX_REGISTRY_RESTARTS = 3;
const BOX_REGISTRY_PAGE_LIMIT = 250;
const BOX_REGISTRY_MAX_PAGES = 10_000;

async function refreshBoxRegistry(
  client: KioskClient,
  fetchedAt: Date,
  wait: (milliseconds: number) => Promise<void>,
  maxPages: number,
): Promise<void> {
  let since = (await readBoxRegistryMeta())?.version;
  for (let attempt = 0; attempt < BOX_REGISTRY_RESTARTS; attempt += 1) {
    try {
      let until: string | undefined;
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let pages = 0;
      do {
        pages += 1;
        if (pages > maxPages) throw new Error("box registry page limit exceeded");
        const page = await client.boxRegistryPage!({
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          limit: BOX_REGISTRY_PAGE_LIMIT,
        });
        if (
          !page ||
          typeof page !== "object" ||
          typeof page.until !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/.test(page.until) ||
          BigInt(page.until) > 9_223_372_036_854_775_807n ||
          !Array.isArray(page.items) ||
          !(
            page.nextCursor === undefined ||
            (typeof page.nextCursor === "string" &&
              page.nextCursor.length > 0 &&
              page.nextCursor.length <= 1_024)
          )
        ) {
          throw new Error("invalid box registry page");
        }
        if (until === undefined) {
          until = page.until;
          await beginBoxRegistryStage(since ?? null, until);
        } else if (page.until !== until) {
          throw new Error("box registry page changed its until revision");
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) throw new Error("box registry cursor cycle");
          seenCursors.add(cursor);
        }
        if (cursor !== undefined) {
          await stageBoxRegistryPage(since ?? null, until, page.items);
        } else {
          await activateBoxRegistryPage(since ?? null, until, page.items, fetchedAt);
        }
      } while (cursor !== undefined);
      return;
    } catch (error) {
      try {
        await discardBoxRegistryStage();
      } catch (storeError) {
        // Revocation is the one verdict storage trouble must never hide: the
        // shell has to stop admitting workers immediately.
        if (isDeviceRevoked(error)) throw error;
        throw storeError;
      }
      if (
        error instanceof KioskApiError &&
        error.status === 409 &&
        error.code === "registry_snapshot_changed" &&
        attempt + 1 < BOX_REGISTRY_RESTARTS
      ) {
        since = (await readBoxRegistryMeta())?.version;
        await wait(250 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

export async function refreshSnapshot(
  client: KioskClient,
  now: () => Date,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  registryMaxPages = BOX_REGISTRY_MAX_PAGES,
): Promise<void> {
  const bootstrap = await client.bootstrap();
  assertMeasurableGeneratedAt(bootstrap);
  const fetchedAt = now();
  await replaceSnapshot(bootstrap, fetchedAt);
  // Older test doubles and old custom clients have no registry method. A real
  // current client does; registry failure never rolls back a good bootstrap.
  if (typeof client.boxRegistryPage !== "function") return;
  try {
    await refreshBoxRegistry(client, fetchedAt, wait, registryMaxPages);
  } catch (error) {
    if (isDeviceRevoked(error)) throw error;
    console.warn("kiosk: the box registry could not be refreshed", error);
  }
}
