import { describe, expect, it } from "vitest";
import type { KioskBootstrapDto } from "../src/api/types.js";
import {
  countTakenToday,
  effectivePickupPolicy,
  startOfUtcDay,
  takenTodayElsewhere,
  utcDayOf,
} from "../src/session/day-count.js";
import type { JournalEntry } from "../src/store/journal.js";
import type { QueuedOrder } from "../src/store/queue.js";

const ME = "e1";
const SOMEBODY_ELSE = "e2";
const TODAY = "2026-07-28";
/** The gate this device is bound to, as `KioskConfig.kioskId` holds it. */
const THIS_KIOSK = "k-here";
/** The gate it used to be bound to, before somebody re-paired the tablet. */
const OTHER_KIOSK = "k-there";

const journalled = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  at: "2026-07-28T09:00:01.000Z",
  createdAt: "2026-07-28T09:00:00.000Z",
  kioskId: THIS_KIOSK,
  deviceSeq: 1,
  orderNo: "ORD-26-0001",
  conflicts: [],
  employeeId: ME,
  acceptedCount: 1,
  ...over,
});

const queued = (
  over: Partial<Omit<QueuedOrder, "body">> & { items?: number; createdAt?: string } = {},
): QueuedOrder => ({
  deviceSeq: over.deviceSeq ?? 1,
  employeeId: over.employeeId ?? ME,
  body: {
    deviceSeq: over.deviceSeq ?? 1,
    badgeDigest: "BADGE-1",
    reason: "buy",
    items: Array.from({ length: over.items ?? 1 }, (_, i) => ({ rawKm: `01…${i}` })),
    createdAt: over.createdAt ?? "2026-07-28T09:00:00.000Z",
  },
});

const count = (
  journal: JournalEntry[],
  queue: QueuedOrder[] = [],
  boundKioskId: string | null = THIS_KIOSK,
): number =>
  countTakenToday({ employeeId: ME, today: TODAY, boundKioskId, journal, queued: queue });

describe("utcDayOf", () => {
  /**
   * UTC, deliberately, because `applyDayLimit` compares
   * `(created_at at time zone 'utc')::date` — a device that counted by its own
   * local midnight would disagree with the server for the hours between the
   * two boundaries, in whichever direction the kiosk's timezone offset points.
   *
   * Both edges are asserted: an implementation reading local calendar fields
   * gets the 23:30 instant wrong in any timezone ahead of UTC and the 00:30
   * one wrong in any timezone behind it.
   */
  it("reads the UTC calendar day, not the device's own", () => {
    expect(utcDayOf(new Date("2026-07-28T23:30:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T00:30:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T00:00:00.000Z"))).toBe("2026-07-28");
    expect(utcDayOf(new Date("2026-07-28T23:59:59.999Z"))).toBe("2026-07-28");
  });

  it("starts the day at UTC midnight", () => {
    expect(startOfUtcDay(new Date("2026-07-28T23:30:00.000Z")).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(startOfUtcDay(new Date("2026-07-28T00:00:00.000Z")).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
  });
});

describe("countTakenToday", () => {
  it("is zero on a device that has handed out nothing", () => {
    expect(count([])).toBe(0);
  });

  it("adds up what the server accepted from this employee's orders today", () => {
    expect(
      count([
        journalled({ deviceSeq: 1, acceptedCount: 2 }),
        journalled({ deviceSeq: 2, acceptedCount: 1 }),
      ]),
    ).toBe(3);
  });

  // A refused item never counted against the worker server-side, so it must
  // not count here either: `acceptedCount` is the server's own number, not the
  // length of what the device scanned.
  it("counts what the server accepted, not what was scanned", () => {
    expect(
      count([
        journalled({
          acceptedCount: 1,
          conflicts: [
            { rawKm: "01…a", reason: "duplicate" },
            { rawKm: "01…b", reason: "over_limit" },
          ],
        }),
      ]),
    ).toBe(1);
  });

  it("ignores another employee's orders", () => {
    expect(count([journalled({ employeeId: SOMEBODY_ELSE, acceptedCount: 4 })])).toBe(0);
  });

  /**
   * The boundary the server draws. `applyDayLimit` counts orders whose
   * `created_at` falls on the UTC date of THIS order's `created_at`, so an
   * order stamped 23:59:59.999Z yesterday is spent allowance the worker gets
   * back one millisecond later, and one stamped 00:00:00.000Z today is not.
   */
  it("counts the UTC day of the order's own scan time and nothing either side of it", () => {
    expect(
      count([
        journalled({ deviceSeq: 1, createdAt: "2026-07-27T23:59:59.999Z", acceptedCount: 9 }),
        journalled({ deviceSeq: 2, createdAt: "2026-07-28T00:00:00.000Z" }),
        journalled({ deviceSeq: 3, createdAt: "2026-07-28T23:59:59.999Z" }),
        journalled({ deviceSeq: 4, createdAt: "2026-07-29T00:00:00.000Z", acceptedCount: 9 }),
      ]),
    ).toBe(2);
  });

  // The scan time, not the sync time: an order queued through an outage is
  // filed by the server under the moment it was taken, and `at` — when the
  // device finally got an answer — can be days later.
  it("places an order by when it was taken, not by when it synced", () => {
    expect(
      count([
        journalled({ at: "2026-07-28T09:00:00.000Z", createdAt: "2026-07-26T09:00:00.000Z" }),
      ]),
    ).toBe(0);
    expect(
      count([
        journalled({ at: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-28T09:00:00.000Z" }),
      ]),
    ).toBe(1);
  });

  it("counts a still-queued order in full — the server has not yet said what it accepts", () => {
    expect(count([], [queued({ items: 3 })])).toBe(3);
  });

  it("counts a queued twelve-bottle box by its enqueue-time estimate", () => {
    const boxOrder = queued({ items: 0 });
    boxOrder.body.boxes = [{ sscc: "346006820000000021" }];
    boxOrder.estimatedBottleCount = 12;

    expect(count([], [boxOrder])).toBe(12);
  });

  it("falls back to loose item count for a queue record written by the previous bundle", () => {
    const legacy = queued({ items: 3 });
    delete legacy.estimatedBottleCount;

    expect(count([], [legacy])).toBe(3);
  });

  it("ignores a corrupt oversized bottle estimate instead of refusing allowance", () => {
    const corrupt = queued({ items: 2 });
    corrupt.estimatedBottleCount = 1_000_000;

    expect(count([], [corrupt])).toBe(2);
  });

  it("ignores a queued order belonging to somebody else, or to another day", () => {
    expect(
      count(
        [],
        [
          queued({ deviceSeq: 1, employeeId: SOMEBODY_ELSE, items: 3 }),
          queued({ deviceSeq: 2, createdAt: "2026-07-27T23:59:59.999Z", items: 3 }),
        ],
      ),
    ).toBe(0);
  });

  /**
   * `flushQueue` journals BEFORE it dequeues, so a crash — or a failing
   * `dequeueOrder` — leaves one order in both places at once. Counting it twice
   * would charge a worker for bottles they took once, which is the one
   * direction this count must never lean.
   */
  it("counts an order once when it is both journalled and still queued", () => {
    expect(
      count([journalled({ deviceSeq: 7, acceptedCount: 1 })], [queued({ deviceSeq: 7 })]),
    ).toBe(1);
  });

  it("counts a replayed order once, however often its verdict was journalled", () => {
    expect(
      count([
        journalled({ deviceSeq: 7 }),
        journalled({ deviceSeq: 7 }),
        journalled({ deviceSeq: 7 }),
      ]),
    ).toBe(1);
  });

  /**
   * Records written before this change carry no employee and no accepted
   * count. They cannot be attributed to anyone, so they are skipped — never
   * charged to whoever happens to badge in next, and never allowed to throw on
   * the path that opens a worker's cart.
   */
  it("skips a journal entry written before the journal carried an employee", () => {
    const legacy = {
      at: "2026-07-28T09:00:00.000Z",
      deviceSeq: 1,
      orderNo: "ORD-26-0001",
      conflicts: [],
    } as unknown as JournalEntry;

    expect(count([legacy])).toBe(0);
    expect(count([legacy, journalled({ deviceSeq: 2, acceptedCount: 2 })])).toBe(2);
  });

  it("skips a queued order left behind by an older app version", () => {
    const legacy = { deviceSeq: 1, body: queued().body } as unknown as QueuedOrder;

    expect(count([], [legacy])).toBe(0);
  });

  it("skips a record it cannot place in time", () => {
    expect(count([journalled({ createdAt: "not-a-date" })])).toBe(0);
    expect(count([journalled({ createdAt: "" })])).toBe(0);
  });

  it("skips a journal entry whose accepted count is not a number", () => {
    expect(count([journalled({ acceptedCount: "2" as unknown as number })])).toBe(0);
  });
});

/**
 * THE RE-PAIRING HOLE, and it was in the identity of "this kiosk" rather than
 * in the arithmetic.
 *
 * The day count is split by SOURCE — this device counts its own gate, the
 * server reports every other one in `takenTodayElsewhere` — but the journal
 * belongs to the DEVICE while the server's exclusion is by KIOSK ID. Nothing
 * clears the journal when a tablet is moved from gate A to gate B, so for the
 * rest of that UTC day gate A's orders were counted twice: once out of the
 * journal here, once in the server's figure, which no longer excludes the gate
 * they were filed at. Over-counting is the unsafe direction — it refuses a
 * worker product they are entitled to, at a machine with nobody to overrule it.
 */
describe("countTakenToday, on a device that has been re-paired", () => {
  it("ignores what it filed at the gate it is no longer bound to", () => {
    expect(count([journalled({ kioskId: OTHER_KIOSK, acceptedCount: 4 })])).toBe(0);
  });

  it("still counts what it filed at the gate it IS bound to", () => {
    expect(
      count([
        journalled({ deviceSeq: 1, kioskId: OTHER_KIOSK, acceptedCount: 4 }),
        journalled({ deviceSeq: 2, acceptedCount: 2 }),
      ]),
    ).toBe(2);
  });

  /**
   * THE UPGRADE PATH, and the one judgement call in this change.
   *
   * An entry written by the build before this one names no kiosk at all, and
   * neither does the config of a device that has not paired since. Those two
   * unknowns MATCH: the device has not moved, so its whole journal is its
   * current gate's, and refusing to count it would switch the local half of the
   * day limit off across the entire installed base.
   *
   * The moment the device pairs — the only moment its gate can change — the
   * config carries an id and every unstamped entry stops matching it. So the
   * event that used to open the double count is exactly the event that orphans
   * the records it would have double counted.
   */
  it("counts an entry that names no kiosk only while the device's own binding names none either", () => {
    const unstamped = journalled({ acceptedCount: 2 });
    delete (unstamped as Partial<JournalEntry>).kioskId;

    expect(count([unstamped], [], null)).toBe(2);
    expect(count([unstamped], [], THIS_KIOSK)).toBe(0);
  });

  /** Checked rather than trusted, like every other field read back out of
   * IndexedDB: a stamp that is not a plain non-empty string names no kiosk, and
   * an unnamed kiosk is not the one this device is bound to. */
  it("reads a stamp that is not a plain non-empty string as no kiosk at all", () => {
    expect(count([journalled({ kioskId: "" })])).toBe(0);
    expect(count([journalled({ kioskId: 7 as unknown as string })])).toBe(0);
    expect(count([journalled({ kioskId: "" })], [], null)).toBe(1);
  });

  /**
   * THE QUEUE HALF IS NOT STAMPED, and must not be.
   *
   * A queued order has not been filed anywhere yet. When it finally drains it
   * goes out under whatever token the device holds THEN, so the server files it
   * under the gate the device is bound to at that moment — which is this one.
   * Stamping the record at enqueue time and filtering on it would drop an order
   * that this gate really is about to file, and the server would not report it
   * in `takenTodayElsewhere` either, because that is the figure with this gate
   * excluded. It would be counted nowhere.
   */
  it("counts a queued order under whichever gate is about to file it", () => {
    expect(count([], [queued({ items: 2 })], THIS_KIOSK)).toBe(2);
    expect(count([], [queued({ items: 2 })], OTHER_KIOSK)).toBe(2);
    expect(count([], [queued({ items: 2 })], null)).toBe(2);
  });

  /**
   * `deviceSeq` IS ONLY UNIQUE WITHIN A KIOSK. The server's idempotency key is
   * `(tenantId, kioskId, deviceSeq)` and a freshly paired kiosk restarts the
   * counter, so seq 3 here is a different order from seq 3 at the gate this
   * tablet came from. The merge that stops one order being counted twice must
   * therefore never reach across gates — an entry from the old gate cancelling
   * a queued order that happens to share its sequence would silently swallow a
   * real withdrawal.
   */
  it("does not let the old gate's entry cancel a queued order that reuses its sequence", () => {
    expect(
      count(
        [journalled({ deviceSeq: 3, kioskId: OTHER_KIOSK, acceptedCount: 5 })],
        [queued({ deviceSeq: 3, items: 1 })],
      ),
    ).toBe(1);
  });
});

describe("takenTodayElsewhere", () => {
  const bootstrap = (employees: unknown): KioskBootstrapDto =>
    ({ employees }) as unknown as KioskBootstrapDto;

  const roster = bootstrap([
    { id: ME, fullName: "Я", role: null, badgeHash: null, takenTodayElsewhere: 3 },
    { id: SOMEBODY_ELSE, fullName: "Не я", role: null, badgeHash: null, takenTodayElsewhere: 7 },
  ]);

  it("reads the employee's own figure off the snapshot", () => {
    expect(takenTodayElsewhere(roster, ME)).toBe(3);
    expect(takenTodayElsewhere(roster, SOMEBODY_ELSE)).toBe(7);
  });

  it("is zero for somebody the snapshot does not list, and with no snapshot at all", () => {
    expect(takenTodayElsewhere(roster, "nobody")).toBe(0);
    expect(takenTodayElsewhere(null, ME)).toBe(0);
  });

  /**
   * THE UPGRADE PATH, and the reason this is a checked read rather than a
   * property access. `KioskBootstrapDto` is a cast over `res.json()`, not a
   * schema — nothing validates a bootstrap at runtime — so an older server, or
   * a snapshot this device cached before the field existed, delivers a roster
   * row without it. Zero, not `NaN` and not a crash: an unattended kiosk must
   * keep handing out product, and under-counting is the safe direction (the
   * server re-decides the limit and its `conflicts[]` win).
   */
  it("treats an older server's missing field as zero", () => {
    const older = bootstrap([{ id: ME, fullName: "Я", role: null, badgeHash: null }]);
    expect(takenTodayElsewhere(older, ME)).toBe(0);
  });

  /**
   * Anything that is not a plain non-negative count reads as zero for the same
   * reason. `count(*)` comes back from Postgres as bigint, which node-postgres
   * renders as a STRING unless it is cast — so `"3"` is the shape a regression
   * on the server would actually take, and `+"3"` would quietly paper over it.
   */
  it("refuses a figure that is not a real count", () => {
    const rowWith = (value: unknown) =>
      bootstrap([
        { id: ME, fullName: "Я", role: null, badgeHash: null, takenTodayElsewhere: value },
      ]);
    expect(takenTodayElsewhere(rowWith("3"), ME)).toBe(0);
    expect(takenTodayElsewhere(rowWith(null), ME)).toBe(0);
    expect(takenTodayElsewhere(rowWith(Number.NaN), ME)).toBe(0);
    expect(takenTodayElsewhere(rowWith(Number.POSITIVE_INFINITY), ME)).toBe(0);
    expect(takenTodayElsewhere(rowWith(-2), ME)).toBe(0);
    expect(takenTodayElsewhere(rowWith(1.5), ME)).toBe(0);
  });

  /**
   * The whole point of the split. This number is what the worker took at OTHER
   * kiosks; `countTakenToday` is what they took at this one. They come from
   * disjoint sources, so they ADD — and no watermark is needed to keep them
   * from overlapping, because neither can contain the other's orders.
   */
  it("adds to this device's own count rather than replacing it", () => {
    expect(count([journalled({ acceptedCount: 2 })]) + takenTodayElsewhere(roster, ME)).toBe(5);
  });
});

describe("effectivePickupPolicy", () => {
  const bootstrap = (value: unknown): KioskBootstrapDto => value as KioskBootstrapDto;

  it("combines the tenant limit switch with the employee policy", () => {
    const snapshot = bootstrap({
      pickupPolicy: { limitsEnabled: true },
      config: { dayLimitPerEmployee: 5, showPrices: true },
      employees: [
        {
          id: ME,
          limitMode: "limited",
          dayLimit: 3,
          canWriteoff: true,
        },
      ],
    });

    expect(effectivePickupPolicy(snapshot, ME)).toEqual({
      limited: true,
      dayLimit: 3,
      canWriteoff: true,
    });

    const tenantOff = bootstrap({
      ...snapshot,
      pickupPolicy: { limitsEnabled: false },
    });
    expect(effectivePickupPolicy(tenantOff, ME)).toEqual({
      limited: false,
      dayLimit: 3,
      canWriteoff: true,
    });
  });

  it("does not apply a limit for an explicitly unlimited employee", () => {
    const snapshot = bootstrap({
      pickupPolicy: { limitsEnabled: true },
      config: { dayLimitPerEmployee: 5, showPrices: true },
      employees: [
        {
          id: ME,
          limitMode: "unlimited",
          dayLimit: 1,
          canWriteoff: false,
        },
      ],
    });
    expect(effectivePickupPolicy(snapshot, ME)).toEqual({
      limited: false,
      dayLimit: 1,
      canWriteoff: false,
    });
  });

  it("reads an old snapshot conservatively without granting unlimited or writeoff", () => {
    const oldSnapshot = bootstrap({
      config: { dayLimitPerEmployee: 4, showPrices: true },
      employees: [{ id: ME }],
    });
    expect(effectivePickupPolicy(oldSnapshot, ME)).toEqual({
      limited: true,
      dayLimit: 4,
      canWriteoff: false,
    });
  });

  it("does not grant employee privileges when the tenant policy field is missing", () => {
    const partial = bootstrap({
      config: { dayLimitPerEmployee: 4, showPrices: true },
      employees: [
        {
          id: ME,
          limitMode: "unlimited",
          dayLimit: 1,
          canWriteoff: true,
        },
      ],
    });
    expect(effectivePickupPolicy(partial, ME)).toEqual({
      limited: true,
      dayLimit: 4,
      canWriteoff: false,
    });
  });

  it("does not disable limits when only the tenant policy field is present", () => {
    const partial = bootstrap({
      pickupPolicy: { limitsEnabled: false },
      config: { dayLimitPerEmployee: 4, showPrices: true },
      employees: [{ id: ME }],
    });
    expect(effectivePickupPolicy(partial, ME)).toEqual({
      limited: true,
      dayLimit: 4,
      canWriteoff: false,
    });
  });

  it.each([
    {
      what: "tenant switch is not boolean",
      pickupPolicy: { limitsEnabled: "false" },
      employee: { limitMode: "unlimited", dayLimit: 1, canWriteoff: true },
    },
    {
      what: "limit mode is unknown",
      pickupPolicy: { limitsEnabled: false },
      employee: { limitMode: "forever", dayLimit: 1, canWriteoff: true },
    },
    {
      what: "day limit is not a positive integer",
      pickupPolicy: { limitsEnabled: false },
      employee: { limitMode: "unlimited", dayLimit: 0, canWriteoff: true },
    },
    {
      what: "writeoff flag is missing",
      pickupPolicy: { limitsEnabled: false },
      employee: { limitMode: "unlimited", dayLimit: 1 },
    },
  ])("falls back atomically when $what", ({ pickupPolicy, employee }) => {
    const malformed = bootstrap({
      pickupPolicy,
      config: { dayLimitPerEmployee: 6, showPrices: true },
      employees: [{ id: ME, ...employee }],
    });
    expect(effectivePickupPolicy(malformed, ME)).toEqual({
      limited: true,
      dayLimit: 6,
      canWriteoff: false,
    });
  });

  it("uses a deny-all limit when the legacy fallback is not a positive integer", () => {
    const malformed = bootstrap({
      config: { dayLimitPerEmployee: 0, showPrices: true },
      employees: [{ id: ME, limitMode: "unlimited", dayLimit: 1, canWriteoff: true }],
    });
    expect(effectivePickupPolicy(malformed, ME)).toEqual({
      limited: true,
      dayLimit: 0,
      canWriteoff: false,
    });
  });

  it("returns null for an employee absent from the snapshot", () => {
    const snapshot = bootstrap({ pickupPolicy: { limitsEnabled: true }, employees: [] });
    expect(effectivePickupPolicy(snapshot, ME)).toBeNull();
  });
});
