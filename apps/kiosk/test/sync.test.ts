import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheAge,
  flushQueue,
  isTerminalRejection,
  refreshSnapshot,
  serverNow,
  snapshotAge,
  STALE_BLOCK_MS,
  STALE_WARN_MS,
} from "../src/sync/worker.js";
import { enqueueOrder, listQuarantine, listQueue } from "../src/store/queue.js";
import * as queueStore from "../src/store/queue.js";
import * as journalStore from "../src/store/journal.js";
import { readSnapshot, replaceSnapshot, type CachedSnapshot } from "../src/store/cache.js";
import {
  createKioskClient,
  KioskApiError,
  KioskTimeoutError,
  SUBMIT_TIMEOUT_MS,
} from "../src/api/client.js";
import type { KioskBootstrapDto } from "../src/api/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A client whose every submit fails the same way — the shape most of the
 * failure tests below need, and the only thing they vary. */
function refusingClient(err: unknown) {
  return {
    bootstrap: vi.fn(),
    submitOrder: vi.fn(async () => {
      throw err;
    }),
  };
}

describe("cacheAge", () => {
  const base = "2026-07-28T00:00:00.000Z";
  // Instants are derived from the exported thresholds rather than hand-written
  // so these tests follow if the gates ever move.
  const at = (offsetMs: number): Date => new Date(Date.parse(base) + offsetMs);

  it("is fresh within a day", () => {
    expect(cacheAge(base, new Date("2026-07-28T10:00:00.000Z"))).toBe("fresh");
  });
  it("warns after a day", () => {
    expect(cacheAge(base, new Date("2026-07-29T01:00:00.000Z"))).toBe("warn");
  });
  it("blocks after a week", () => {
    expect(cacheAge(base, new Date("2026-08-05T00:00:00.000Z"))).toBe("blocked");
  });

  it("is still fresh one millisecond before the warning threshold", () => {
    expect(cacheAge(base, at(STALE_WARN_MS - 1))).toBe("fresh");
  });
  it("warns exactly at the warning threshold", () => {
    expect(cacheAge(base, at(STALE_WARN_MS))).toBe("warn");
  });
  it("warns one millisecond past the warning threshold", () => {
    expect(cacheAge(base, at(STALE_WARN_MS + 1))).toBe("warn");
  });

  it("still only warns one millisecond before the blocking threshold", () => {
    expect(cacheAge(base, at(STALE_BLOCK_MS - 1))).toBe("warn");
  });
  it("blocks exactly at the blocking threshold", () => {
    expect(cacheAge(base, at(STALE_BLOCK_MS))).toBe("blocked");
  });
  it("blocks one millisecond past the blocking threshold", () => {
    expect(cacheAge(base, at(STALE_BLOCK_MS + 1))).toBe("blocked");
  });

  it("treats a future stamp as fresh — the tablet's clock lags the server's, the data is not old", () => {
    // A magnitude-only comparison (Math.abs) would read these as warn/blocked
    // and lock out a kiosk whose only fault is a slow clock.
    expect(cacheAge(base, at(-60_000))).toBe("fresh");
    expect(cacheAge(base, at(-STALE_WARN_MS))).toBe("fresh");
    expect(cacheAge(base, at(-STALE_BLOCK_MS * 2))).toBe("fresh");
  });

  it("blocks on an unparseable stamp — a gate that cannot establish freshness must never assert it", () => {
    // Date.parse returns NaN and every comparison against NaN is false, so the
    // naive form falls through to "fresh" forever: one edited character in a
    // stolen tablet's IndexedDB would disable the seven-day lockout for good.
    for (const stamp of ["not-a-date", "", "2026-07-28T99:99:99Z"]) {
      expect(cacheAge(stamp, new Date(base))).toBe("blocked");
    }
  });
});

describe("flushQueue", () => {
  it("submits in deviceSeq order and drops each order only after the server acknowledges it", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const seen: number[] = [];
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        seen.push(body.deviceSeq);
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date());

    expect(seen).toEqual([1, 2]);
    expect(await listQueue()).toEqual([]);
  });

  it("stops at the first failure and keeps the rest queued, so ordering is never broken", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await flushQueue(client as never, () => new Date());

    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
  });

  // Asserts both effects landed, not their order: the "acknowledge, then
  // remove" guarantee is claimed only by the replay test below, which is what
  // actually fails if the two writes are swapped.
  it("journals the server's verdict, conflicts and all, and clears the order from the queue", async () => {
    await enqueueOrder(
      {
        deviceSeq: 4,
        badgeCode: "B",
        reason: "buy",
        items: [{ rawKm: "01…" }, { rawKm: "01…dup" }],
        createdAt: "2026-07-27T21:30:00.000Z",
      },
      "e1",
    );
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0004",
        status: "pending",
        itemCount: 1,
        conflicts: [{ rawKm: "01…dup", reason: "duplicate" }],
      })),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    expect(await journalStore.readJournal(10)).toEqual([
      {
        at: "2026-07-28T07:00:00.000Z",
        // The order's own scan time, not the sync stamp above: this order was
        // taken the previous evening and waited out an outage, and it is the
        // day it was TAKEN that the server counts it against.
        createdAt: "2026-07-27T21:30:00.000Z",
        deviceSeq: 4,
        orderNo: "ORD-26-0004",
        employeeId: "e1",
        // What the server accepted — one of the two scanned codes. The refused
        // one never counted against the worker server-side.
        acceptedCount: 1,
        conflicts: [{ rawKm: "01…dup", reason: "duplicate" }],
      },
    ]);
    expect(await listQueue()).toEqual([]);
  });

  // With no `createdAt` in the body the server stamps the order as it arrives
  // (`when = dto.createdAt ?? new Date()`), so the device journals that same
  // moment rather than leaving the day count with nothing to place it by.
  it("falls back to the sync moment for an order that carries no scan time", async () => {
    await enqueueOrder({ deviceSeq: 9, badgeCode: "B", reason: "buy", items: [] }, "e1");
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0009",
        status: "pending",
        itemCount: 0,
        conflicts: [],
      })),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    expect((await journalStore.readJournal(10))[0]).toMatchObject({
      at: "2026-07-28T07:00:00.000Z",
      createdAt: "2026-07-28T07:00:00.000Z",
    });
  });

  it("keeps the order queued when journalling fails, so a crash mid-flight replays instead of losing it", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] }, "e1");
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0001",
        status: "pending",
        itemCount: 0,
        conflicts: [],
      })),
    };
    const appendJournal = vi
      .spyOn(journalStore, "appendJournal")
      .mockRejectedValueOnce(new Error("storage crashed"));

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    // The server took it, but the device never recorded the acknowledgement —
    // so the order must survive to be tried again, not vanish.
    expect(appendJournal).toHaveBeenCalledTimes(1);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1]);

    // The replay is safe precisely because the server is idempotent on
    // (tenantId, kioskId, deviceSeq): resubmitting returns the same order
    // rather than creating a second one.
    await flushQueue(client as never, () => new Date("2026-07-28T07:05:00.000Z"));

    expect(client.submitOrder).toHaveBeenCalledTimes(2);
    expect((await journalStore.readJournal(10)).map((e) => e.orderNo)).toEqual(["ORD-26-0001"]);
    expect(await listQueue()).toEqual([]);
  });

  it("aborts the whole drain at the failing order, leaving it and everything after it queued in order", async () => {
    for (const deviceSeq of [1, 2, 3]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        if (body.deviceSeq === 2) throw new Error("offline");
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    // Order 3 is never even attempted: it must not overtake order 2.
    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2]);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([2, 3]);
    expect((await journalStore.readJournal(10)).map((e) => e.deviceSeq)).toEqual([1]);
  });

  it("resolves even when the store itself fails, so no caller ever has to guard it", async () => {
    // Task 14 drives this from a setInterval and an `online` handler, neither
    // of which can catch a rejection that escapes here.
    const listQueueSpy = vi
      .spyOn(queueStore, "listQueue")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const client = { bootstrap: vi.fn(), submitOrder: vi.fn() };

    await expect(flushQueue(client as never, () => new Date())).resolves.toBeUndefined();

    expect(listQueueSpy).toHaveBeenCalledTimes(1);
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it("resolves when the dequeue fails too, leaving the acknowledged order to replay", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] }, "e1");
    vi.spyOn(queueStore, "dequeueOrder").mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0001",
        status: "pending",
        itemCount: 0,
        conflicts: [],
      })),
    };

    await expect(flushQueue(client as never, () => new Date())).resolves.toBeUndefined();

    // Documented cost of "acknowledge, then remove": the order survives and its
    // verdict gets journalled a second time on replay. A duplicate log line is
    // cheaper than a lost pickup.
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1]);
  });

  /**
   * The overlap invariant, unchanged in substance: two drains never run at the
   * same time, and no order is submitted or journalled twice.
   *
   * What changed is how the second caller is kept out. It used to be TURNED
   * AWAY — an early `return` that resolved at once — which is fine for the
   * interval and the `online` handler, who are watching nothing, and wrong for
   * `submitCart`, which awaits its own drain to learn whether the worker's
   * order reached the server. The second call now WAITS for its turn instead,
   * so what it resolves with is a fact about the queue rather than about who
   * happened to be draining. The test below pins the half that turning away
   * could never give.
   */
  it("serialises an overlapping drain instead of running two at once, and submits nothing twice", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    let reachedSubmit!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      reachedSubmit = resolve;
    });
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    // Two drains are overlapping the moment a second submission opens while
    // the first is still in flight — that is the window where the second drain
    // has read a queue still holding an order the first one already gave the
    // server, and where the duplicate journal entry comes from.
    let inFlight = 0;
    let overlapped = false;
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        reachedSubmit();
        await submitGate;
        inFlight -= 1;
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    const first = flushQueue(client as never, () => new Date());
    // Hand off on a promise rather than a timer: once this resolves the first
    // drain is provably parked inside submitOrder with order 1 still queued,
    // which is exactly the window where a second drain would double-submit.
    await submitStarted;
    const second = flushQueue(client as never, () => new Date());
    releaseSubmit();
    await Promise.all([first, second]);

    expect(overlapped).toBe(false);
    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2]);
    // Most-recent-first, per `readJournal` — and one entry each, which is the
    // duplicate the overlap guard exists to prevent.
    expect((await journalStore.readJournal(10)).map((e) => e.deviceSeq)).toEqual([2, 1]);
    expect(await listQueue()).toEqual([]);
  });

  /**
   * WHY THE SECOND CALLER CANNOT SIMPLY BE HANDED THE DRAIN IN FLIGHT.
   *
   * `flushQueue` reads the queue ONCE, before its first submission, so a drain
   * already running snapshotted a queue that this caller's order was never in.
   * Awaiting that promise would resolve the moment it finished — having
   * delivered everything except the one order the caller is standing there
   * waiting on — and `submitCart` would tell an online worker their order is
   * queued with no number. The second call therefore has to run a drain of its
   * OWN, chained behind the one in flight.
   */
  it("delivers the caller's own order even when it was enqueued after a running drain read the queue", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] }, "e1");
    let reachedSubmit!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      reachedSubmit = resolve;
    });
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        if (body.deviceSeq === 1) {
          reachedSubmit();
          await submitGate;
        }
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    // The backlog drain: parked inside its first submission, queue already read.
    const background = flushQueue(client as never, () => new Date());
    await submitStarted;
    // The worker's order lands after that read — the backlog drain will never
    // see it, whatever it goes on to do.
    await enqueueOrder({ deviceSeq: 2, badgeCode: "B", reason: "buy", items: [] }, "e1");
    const mine = flushQueue(client as never, () => new Date());
    releaseSubmit();
    await mine;

    // The whole contract, in one assertion: when THIS call resolves, THIS
    // caller's order has reached the server.
    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2]);
    // Most-recent-first, per `readJournal`.
    expect((await journalStore.readJournal(10)).map((e) => e.deviceSeq)).toEqual([2, 1]);
    expect(await listQueue()).toEqual([]);
    await background;
  });

  /**
   * THE STALL, END TO END — the real client over a `fetch` that never answers.
   *
   * A fake client that rejects proves nothing here: the failure being closed is
   * a `fetch` that neither resolves NOR rejects, which on a half-open TCP
   * connection or behind a captive portal is what really happens. Without a
   * deadline this drain never settles, so `draining` is owed forever, the
   * `submitCart` awaiting it never reaches the confirmation, and every later
   * drain chains behind the same dead promise. The kiosk stops.
   */
  it("settles on a fetch that never answers, leaving the order queued for the next drain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] }, "e1");
    let requested!: () => void;
    const posted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requested();
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );
    // The REAL client — the deadline lives there, and a hand-rolled fake would
    // be testing the fake.
    const client = createKioskClient({ token: "tok", serverUrl: "http://srv" });

    let settled = false;
    const drained = flushQueue(client, () => new Date()).then(() => {
      settled = true;
    });
    // The drain reads the queue out of IndexedDB before it posts anything, and
    // the deadline is only armed once the POST is under way — advancing the
    // clock before that would move it past a timer that does not exist yet.
    await posted;
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drained;

    expect(settled).toBe(true);
    // Nothing was answered, so nothing may be assumed: the order is still owed
    // and is still first in line — never quarantined, never dropped.
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1]);
    expect(await listQuarantine()).toEqual([]);
    expect(await journalStore.readJournal(10)).toEqual([]);
  });

  /**
   * HEAD-OF-LINE BLOCKING ON A PERMANENT REFUSAL, and the scenario that makes
   * it reachable: a write-off queued offline whose reason an administrator
   * archives before the kiosk syncs. `resolveWriteoffReasonId` then answers 400
   * — every time, forever — and without a quarantine every later purchase sits
   * behind it while the kiosk goes on accepting and confirming new ones.
   */
  it("sets a permanently refused order aside and carries on with the rest of the queue", async () => {
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeCode: "B",
        reason: "writeoff",
        writeoffReasonId: "r-archived",
        items: [{ rawKm: "01…poison" }],
        createdAt: "2026-07-27T20:00:00.000Z",
      },
      "e1",
    );
    for (const deviceSeq of [2, 3]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        if (body.deviceSeq === 1) {
          throw new KioskApiError(400, "Unknown or archived writeoff reason");
        }
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    // The drain got past it in ONE pass — the two behind it are delivered.
    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2, 3]);
    expect(await listQueue()).toEqual([]);

    // And nothing was dropped: the whole record is still inspectable, raw
    // marking codes and all, with the server's own reason beside it.
    expect(await listQuarantine()).toEqual([
      {
        deviceSeq: 1,
        employeeId: "e1",
        at: "2026-07-28T07:00:00.000Z",
        status: 400,
        message: "Unknown or archived writeoff reason",
        body: {
          deviceSeq: 1,
          badgeCode: "B",
          reason: "writeoff",
          writeoffReasonId: "r-archived",
          items: [{ rawKm: "01…poison" }],
          createdAt: "2026-07-27T20:00:00.000Z",
        },
      },
    ]);
  });

  // Surfaced, not merely stored: the journal is what the service screen reads,
  // and `orderNo: ""` is the vocabulary it already has for an order the server
  // refused outright. Nothing was accepted, so nothing is charged to the worker.
  it("journals a quarantined order as a refusal, under the day it was taken", async () => {
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeCode: "B",
        reason: "writeoff",
        items: [{ rawKm: "01…" }],
        createdAt: "2026-07-27T20:00:00.000Z",
      },
      "e1",
    );

    await flushQueue(
      refusingClient(new KioskApiError(400, "Unknown or archived writeoff reason")) as never,
      () => new Date("2026-07-28T07:00:00.000Z"),
    );

    expect(await journalStore.readJournal(10)).toEqual([
      {
        at: "2026-07-28T07:00:00.000Z",
        createdAt: "2026-07-27T20:00:00.000Z",
        deviceSeq: 1,
        orderNo: "",
        employeeId: "e1",
        acceptedCount: 0,
        conflicts: [],
      },
    ]);
  });

  /**
   * THE SECOND WAY THE HEAD OF THE QUEUE GOES BAD, and the one that used to be
   * unreachable from here: a badge the server can no longer resolve — the
   * employee deleted or archived in the cabinet while the order sat in an
   * offline queue. `createFromKiosk` answers 422 («Unknown or inactive badge»),
   * every time, forever.
   *
   * It used to answer 401, and 401 is the one 4xx this drain must never
   * quarantine on (see below), so that order was simultaneously undeliverable
   * and unremovable and the whole queue stopped behind it. The fix is on the
   * server — a bad badge is not a bad device — and this is the device half of
   * it, pinned here so the pair cannot drift apart silently.
   */
  it("sets aside an order the server refuses for a bad badge (422) and drains the rest", async () => {
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeCode: "GONE",
        reason: "buy",
        items: [{ rawKm: "01…orphaned" }],
        createdAt: "2026-07-27T20:00:00.000Z",
      },
      "e-deleted",
    );
    for (const deviceSeq of [2, 3]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        if (body.deviceSeq === 1) throw new KioskApiError(422, "Unknown or inactive badge");
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    // One pass, and the two orders behind the bad one are delivered rather than
    // parked behind it for the life of the device.
    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2, 3]);
    expect(await listQueue()).toEqual([]);
    expect(await listQuarantine()).toEqual([
      {
        deviceSeq: 1,
        employeeId: "e-deleted",
        at: "2026-07-28T07:00:00.000Z",
        status: 422,
        message: "Unknown or inactive badge",
        body: {
          deviceSeq: 1,
          badgeCode: "GONE",
          reason: "buy",
          items: [{ rawKm: "01…orphaned" }],
          createdAt: "2026-07-27T20:00:00.000Z",
        },
      },
    ]);
  });

  /**
   * 401 IS THE DEVICE, NOT THE ORDER. An archived kiosk answers every request
   * with it, so quarantining on a 401 would empty a whole queue on a
   * revocation — orders the device really did take — instead of leaving the
   * shell's refresh to notice and send the device back to pairing.
   *
   * This stays true now that a bad badge answers 422: the two failures are the
   * server's to tell apart, and it does, which is the only reason this drain
   * can keep treating every 401 it sees as "not this device".
   */
  it("never quarantines on a 401: that is a revoked device, not a bad order", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }

    await flushQueue(
      refusingClient(new KioskApiError(401, "Unauthorized")) as never,
      () => new Date(),
    );

    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
    expect(await listQuarantine()).toEqual([]);
  });

  // Everything that is not a per-order verdict stays retryable, and the drain
  // stops in place rather than skipping ahead — the ordering guarantee is
  // unchanged for every failure but the terminal one.
  it.each([
    ["a server fault", new KioskApiError(500, "boom")],
    ["a lost route or a misconfigured server URL", new KioskApiError(404, "Not Found")],
    ["back-pressure", new KioskApiError(429, "Too Many Requests")],
    ["a dead network", new TypeError("Failed to fetch")],
    ["a request that ran out of time", new KioskTimeoutError(SUBMIT_TIMEOUT_MS)],
  ])("keeps the order queued on %s", async (_label, err) => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] }, "e1");
    }
    const client = refusingClient(err);

    await flushQueue(client as never, () => new Date());

    expect(client.submitOrder).toHaveBeenCalledTimes(1);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
    expect(await listQuarantine()).toEqual([]);
  });

  // Custody before removal, the same invariant the success path keeps: an order
  // may leave the queue only once its body is durable somewhere else.
  it("leaves a refused order queued when it cannot be set aside", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] }, "e1");
    await enqueueOrder({ deviceSeq: 2, badgeCode: "B", reason: "buy", items: [] }, "e1");
    vi.spyOn(queueStore, "quarantineOrder").mockRejectedValueOnce(new Error("indexeddb refused"));
    const client = refusingClient(new KioskApiError(400, "bad body"));

    await expect(flushQueue(client as never, () => new Date())).resolves.toBeUndefined();

    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
    // Stopped rather than skipped: an order still in the queue must not be
    // overtaken by the one behind it.
    expect(client.submitOrder).toHaveBeenCalledTimes(1);
  });
});

describe("isTerminalRejection", () => {
  it.each([400, 409, 422])(
    "treats %i as a verdict this order can never come back from",
    (status) => {
      expect(isTerminalRejection(new KioskApiError(status, "refused"))).toBe(true);
    },
  );

  /**
   * The allowlist is deliberately narrow. 401 is the device's credential rather
   * than the order, and 404 is overwhelmingly a misconfigured server URL or a
   * proxy that has lost the route — a kiosk pointed at the wrong host would
   * otherwise quarantine every order it ever took while the network is fine.
   */
  it.each([401, 403, 404, 408, 429, 500, 503])("keeps %i retryable", (status) => {
    expect(isTerminalRejection(new KioskApiError(status, "refused"))).toBe(false);
  });

  it("keeps a transport failure retryable — it carries no verdict at all", () => {
    expect(isTerminalRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isTerminalRejection(new KioskTimeoutError(15_000))).toBe(false);
  });
});

const bootstrap = (generatedAt: string): KioskBootstrapDto => ({
  generatedAt,
  config: { dayLimitPerEmployee: 5, showPrices: true },
  badgeSalt: "c2FsdA==",
  reasons: [],
  products: [],
  employees: [{ id: "e1", fullName: "A", role: null, badgeHash: null }],
  operators: [],
});

/**
 * THE DEVICE CLOCK IS NOT THE MEASUREMENT — the offset between the two clocks
 * is, and it is established every time the device and the server are provably
 * in contact.
 *
 * A snapshot holds both halves of one instant: `generatedAt` is what the server
 * called it, `fetchedAt` what the device called it. Their difference is this
 * tablet's skew, and adding it back cancels that skew out of everything the
 * device dates — the staleness gate and an order's scan time alike.
 */
describe("serverNow", () => {
  const SERVER = "2026-07-28T00:00:00.000Z";
  const DAY = 24 * 60 * 60_000;
  /** A device whose clock runs `skewMs` ahead of the server's, holding a
   * snapshot it fetched `elapsedMs` (of its own clock) ago. */
  const skewed = (skewMs: number, elapsedMs = 0): { snapshot: CachedSnapshot; now: Date } => ({
    snapshot: {
      bootstrap: bootstrap(SERVER),
      fetchedAt: new Date(Date.parse(SERVER) + skewMs).toISOString(),
    },
    now: new Date(Date.parse(SERVER) + skewMs + elapsedMs),
  });

  it("hands back the device's own clock when the two agree", () => {
    const { snapshot, now } = skewed(0, 90_000);
    expect(serverNow(snapshot, now).toISOString()).toBe("2026-07-28T00:01:30.000Z");
  });

  it("subtracts a fast tablet's skew, however large", () => {
    const { snapshot, now } = skewed(9 * DAY, 60_000);
    expect(serverNow(snapshot, now).toISOString()).toBe("2026-07-28T00:01:00.000Z");
  });

  it("adds a slow tablet's skew, which is what a cold boot with no NTP looks like", () => {
    const { snapshot, now } = skewed(-3 * DAY, 60_000);
    expect(serverNow(snapshot, now).toISOString()).toBe("2026-07-28T00:01:00.000Z");
  });

  // Fail closed, both halves. Falling back to the raw device clock would hand
  // back exactly the trust this exists to remove — and every caller reads an
  // Invalid Date as "cannot establish the time".
  it("refuses to guess when either half of the offset is unreadable", () => {
    expect(serverNow(null, new Date(SERVER)).getTime()).toBeNaN();
    expect(
      serverNow(
        { bootstrap: bootstrap("not-a-date"), fetchedAt: SERVER },
        new Date(SERVER),
      ).getTime(),
    ).toBeNaN();
    expect(
      serverNow(
        { bootstrap: bootstrap(SERVER), fetchedAt: "not-a-date" },
        new Date(SERVER),
      ).getTime(),
    ).toBeNaN();
  });
});

describe("snapshotAge", () => {
  const snapshot = (generatedAt: string): CachedSnapshot => ({
    bootstrap: bootstrap(generatedAt),
    fetchedAt: "2026-07-28T00:00:00.000Z",
  });

  // The fail-closed half of the same rule `cacheAge` states for an unparseable
  // stamp, and it lived in the shell's untested wiring until now: a paired
  // device that has no dataset at all cannot say how old its data is, so it
  // must not hand product out on it.
  it("blocks when there is no snapshot at all", () => {
    expect(snapshotAge(null, new Date("2026-07-28T00:00:00.000Z"))).toBe("blocked");
  });

  it("otherwise measures the snapshot's server stamp, exactly as cacheAge does", () => {
    const base = "2026-07-28T00:00:00.000Z";
    const at = (offsetMs: number): Date => new Date(Date.parse(base) + offsetMs);
    expect(snapshotAge(snapshot(base), at(0))).toBe("fresh");
    expect(snapshotAge(snapshot(base), at(STALE_WARN_MS))).toBe("warn");
    expect(snapshotAge(snapshot(base), at(STALE_BLOCK_MS))).toBe("blocked");
  });

  it("blocks a snapshot whose stamp is unparseable, like the bare gate", () => {
    expect(snapshotAge(snapshot("not-a-date"), new Date("2026-07-28T00:00:00.000Z"))).toBe(
      "blocked",
    );
  });

  // The other half of the offset. A `fetchedAt` that cannot be read leaves the
  // elapsed time unmeasurable, and a gate that cannot establish freshness must
  // not assert it — the same rule, applied to the other stamp.
  it("blocks a snapshot whose fetch stamp is unparseable", () => {
    expect(
      snapshotAge(
        { bootstrap: bootstrap("2026-07-28T00:00:00.000Z"), fetchedAt: "not-a-date" },
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).toBe("blocked");
  });

  /**
   * THE SKEW MUST NOT BRICK A HEALTHY KIOSK.
   *
   * Subtracting two absolute clocks made a tablet more than a week fast read a
   * bootstrap generated SECONDS ago as older than `STALE_BLOCK_MS`. Every
   * successful refresh then left the device on the Blocked screen, telling a
   * worker its data was a week old and telling an administrator to check a
   * network that was working perfectly — with no hint that a clock was the
   * cause, and no way out but to fix it.
   */
  it("stays fresh on a kiosk whose clock is years fast but which just synced", () => {
    const server = "2026-07-28T00:00:00.000Z";
    for (const skewMs of [STALE_BLOCK_MS + 1, 30 * STALE_BLOCK_MS, 1000 * STALE_BLOCK_MS]) {
      const device = new Date(Date.parse(server) + skewMs);
      expect(
        snapshotAge({ bootstrap: bootstrap(server), fetchedAt: device.toISOString() }, device),
      ).toBe("fresh");
    }
  });

  /**
   * And the lockout still bites. It is now measured as elapsed time since the
   * refresh — two readings of the SAME clock, so the skew cancels — which means
   * a device that really has been out of contact for a week is blocked whatever
   * its clock says, and one that syncs is not.
   */
  it("still ages fresh → warn → blocked while a skewed device stays out of contact", () => {
    const server = "2026-07-28T00:00:00.000Z";
    const skewMs = 40 * STALE_BLOCK_MS;
    const snap: CachedSnapshot = {
      bootstrap: bootstrap(server),
      fetchedAt: new Date(Date.parse(server) + skewMs).toISOString(),
    };
    const after = (elapsedMs: number) => new Date(Date.parse(server) + skewMs + elapsedMs);

    expect(snapshotAge(snap, after(STALE_WARN_MS - 1))).toBe("fresh");
    expect(snapshotAge(snap, after(STALE_WARN_MS))).toBe("warn");
    expect(snapshotAge(snap, after(STALE_BLOCK_MS - 1))).toBe("warn");
    expect(snapshotAge(snap, after(STALE_BLOCK_MS))).toBe("blocked");
  });
});

describe("refreshSnapshot", () => {
  it("stores what the server returned, stamped with the device's fetch time", async () => {
    const fresh = bootstrap("2026-07-28T07:00:00.000Z");
    const client = { bootstrap: vi.fn(async () => fresh), submitOrder: vi.fn() };

    await refreshSnapshot(client as never, () => new Date("2026-07-28T07:00:03.000Z"));

    expect(await readSnapshot()).toEqual({
      bootstrap: fresh,
      fetchedAt: "2026-07-28T07:00:03.000Z",
    });
  });

  it("leaves the cached snapshot untouched when the fetch fails — a blinking network must not brick the kiosk", async () => {
    const cached = bootstrap("2026-07-28T06:00:00.000Z");
    await replaceSnapshot(cached, new Date("2026-07-28T06:00:01.000Z"));
    const client = {
      bootstrap: vi.fn(async () => {
        throw new Error("offline");
      }),
      submitOrder: vi.fn(),
    };

    await expect(
      refreshSnapshot(client as never, () => new Date("2026-07-28T07:00:00.000Z")),
    ).rejects.toThrow("offline");

    expect(await readSnapshot()).toEqual({
      bootstrap: cached,
      fetchedAt: "2026-07-28T06:00:01.000Z",
    });
  });

  it("refuses a bootstrap whose generatedAt is unparseable and keeps the cached snapshot byte-identical", async () => {
    const cached = bootstrap("2026-07-28T06:00:00.000Z");
    await replaceSnapshot(cached, new Date("2026-07-28T06:00:01.000Z"));
    const before = JSON.stringify(await readSnapshot());
    const client = {
      bootstrap: vi.fn(async () => bootstrap("not-a-date")),
      submitOrder: vi.fn(),
    };

    await expect(
      refreshSnapshot(client as never, () => new Date("2026-07-28T07:00:00.000Z")),
    ).rejects.toThrow(/generatedAt/);

    // Same failure path as a dead network on purpose: the kiosk keeps its
    // last-known-good dataset and ages fresh → warn → blocked over seven days,
    // rather than persisting a stamp whose freshness can never be established.
    expect(JSON.stringify(await readSnapshot())).toBe(before);
  });
});
