import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheAge,
  boxRegistryAge,
  cancelFlushRetry,
  flushQueue,
  humaniseAge,
  isTerminalRejection,
  refreshSnapshot,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  serverNow,
  snapshotAge,
  snapshotAgeMs,
  STALE_BLOCK_MS,
  STALE_WARN_MS,
} from "../src/sync/worker.js";
import { dequeueOrder, enqueueOrder, listQuarantine, listQueue } from "../src/store/queue.js";
import * as queueStore from "../src/store/queue.js";
import * as journalStore from "../src/store/journal.js";
import * as configStore from "../src/store/config.js";
import { writeConfig } from "../src/store/config.js";
import { readSnapshot, replaceSnapshot, type CachedSnapshot } from "../src/store/cache.js";
import {
  activateBoxRegistryPage,
  beginBoxRegistryStage,
  lookupBox,
  readBoxRegistryMeta,
} from "../src/store/box-registry.js";
import {
  createKioskClient,
  KioskApiError,
  KioskTimeoutError,
  SUBMIT_TIMEOUT_MS,
} from "../src/api/client.js";
import type { KioskBootstrapDto } from "../src/api/types.js";
import { findOldestUnviewedOutcome } from "../src/store/outcomes.js";

const OUTCOME_KIOSK_ID = "11111111-1111-4111-8111-111111111111";
const OUTCOME_EMPLOYEE_ID = "22222222-2222-4222-8222-222222222222";

async function outcomeOwner() {
  const config = await writeConfig({
    serverUrl: "https://tenant.example/api",
    token: "token",
    kioskId: OUTCOME_KIOSK_ID,
    kioskName: "Gate",
    place: null,
    nextDeviceSeq: 2,
  });
  return {
    serverUrl: config.serverUrl,
    kioskId: config.kioskId!,
    credentialGeneration: config.credentialGeneration!,
  };
}

afterEach(() => {
  // FIRST, and while the fake timers are still installed: a drain that stopped
  // on a transport failure leaves a retry armed, and this module holds it —
  // `clearTimeout` has to reach the same timer implementation that set it.
  // Without this a pending retry would fire into the NEXT test, against a
  // client that test never built.
  cancelFlushRetry();
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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
  it("persists an accepted result before dequeue and upserts it on replay", async () => {
    const owner = await outcomeOwner();
    await enqueueOrder(
      { deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [{ rawKm: "loose" }] },
      OUTCOME_EMPLOYEE_ID,
      undefined,
      13,
    );
    vi.spyOn(queueStore, "dequeueOrder").mockRejectedValueOnce(new Error("crash window"));
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-1",
        status: "pending" as const,
        itemCount: 13,
        conflicts: [],
        acceptedBoxes: [{ sscc: "346006820000000021", bottleCount: 12 }],
      })),
    };

    await flushQueue(client as never, () => new Date("2026-08-13T12:00:00.000Z"));
    await flushQueue(client as never, () => new Date("2026-08-13T12:01:00.000Z"));

    await expect(findOldestUnviewedOutcome(owner, OUTCOME_EMPLOYEE_ID)).resolves.toMatchObject({
      kind: "accepted",
      orderNo: "ORD-1",
      acceptedCount: 13,
      acceptedBoxes: [{ sscc: "346006820000000021", bottleCount: 12 }],
    });
  });

  it("persists a safe rejected result for a terminal response", async () => {
    const owner = await outcomeOwner();
    const orderCommitted = vi.fn();
    await enqueueOrder(
      { deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [{ rawKm: "secret-prefix-ABC123" }] },
      OUTCOME_EMPLOYEE_ID,
      undefined,
      13,
    );
    await flushQueue(
      {
        ...refusingClient(
          new KioskApiError(422, "rejected", "order_rejected", {
            conflicts: [{ rawKm: "secret-prefix-ABC123", reason: "duplicate" }],
            boxConflicts: [
              { sscc: "346006820000000021", bottleCount: 12, reason: "duplicate", members: ["no"] },
            ],
          }),
        ),
        orderCommitted,
      } as never,
      () => new Date("2026-08-13T12:00:00.000Z"),
    );

    const result = await findOldestUnviewedOutcome(owner, OUTCOME_EMPLOYEE_ID);
    expect(result).toMatchObject({ kind: "rejected", acceptedCount: 0 });
    expect(JSON.stringify(result)).not.toContain("secret-prefix");
    expect(JSON.stringify(result)).not.toContain("members");
    expect(result?.rejected).toEqual([
      { kind: "loose", codeTail: "…ABC123", reason: "duplicate" },
      { kind: "box", sscc: "346006820000000021", bottleCount: 12, reason: "duplicate" },
    ]);
    expect(orderCommitted).toHaveBeenCalledTimes(1);
  });
  it("serializes a crash-safe pending attestation before submit even when the response crosses expiry", async () => {
    let resolveAdmission!: (value: { claimedAt: string; admissionProof: string }) => void;
    const admission = new Promise<{ claimedAt: string; admissionProof: string }>((resolve) => {
      resolveAdmission = resolve;
    });
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeDigest: "B",
        reason: "buy",
        items: [{ rawKm: "01…reserved-before-expiry" }],
        createdAt: "2026-08-10T11:59:59.000Z",
      },
      "e1",
      "pending_attestation",
    );
    const client = {
      bootstrap: vi.fn(),
      downloadProductImage: vi.fn(),
      attestOrder: vi.fn(() => admission),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0001",
        status: "pending" as const,
        itemCount: 1,
        conflicts: [],
      })),
    };

    const draining = flushQueue(client, () => new Date("2026-08-10T12:00:01.000Z"));
    await vi.waitFor(() => {
      expect(client.attestOrder.mock.calls.length + client.submitOrder.mock.calls.length).toBe(1);
    });
    expect(client.attestOrder).toHaveBeenCalledOnce();
    expect(client.attestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ admissionNonce: expect.any(String) }),
    );
    expect((await listQueue())[0]?.admissionNonce).toEqual(expect.any(String));
    expect(client.submitOrder).not.toHaveBeenCalled();

    resolveAdmission({
      claimedAt: "2026-08-10T11:59:59.500Z",
      admissionProof: "opaque-admission",
    });
    await draining;

    expect(client.submitOrder).toHaveBeenCalledWith({
      deviceSeq: 1,
      badgeDigest: "B",
      reason: "buy",
      items: [{ rawKm: "01…reserved-before-expiry" }],
      createdAt: "2026-08-10T11:59:59.500Z",
      admissionProof: "opaque-admission",
    });
    expect(await listQueue()).toEqual([]);
  });

  it("does not submit or resurrect a pending order removed before its delayed attestation arrives", async () => {
    let resolveAdmission!: (value: { claimedAt: string; admissionProof: string }) => void;
    const admission = new Promise<{ claimedAt: string; admissionProof: string }>((resolve) => {
      resolveAdmission = resolve;
    });
    await enqueueOrder(
      { deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] },
      "e1",
      "pending_attestation",
    );
    const client = {
      bootstrap: vi.fn(),
      downloadProductImage: vi.fn(),
      attestOrder: vi.fn(() => admission),
      submitOrder: vi.fn(async () => ({
        orderNo: "must-not-submit",
        status: "pending" as const,
        itemCount: 0,
        conflicts: [],
      })),
    };

    const draining = flushQueue(client, () => new Date());
    await vi.waitFor(() => {
      expect(client.attestOrder.mock.calls.length + client.submitOrder.mock.calls.length).toBe(1);
    });
    expect(client.attestOrder).toHaveBeenCalledOnce();
    await dequeueOrder(1);
    resolveAdmission({
      claimedAt: "2026-08-10T11:59:59.500Z",
      admissionProof: "opaque-admission",
    });
    await draining;

    expect(client.submitOrder).not.toHaveBeenCalled();
    expect(await listQueue()).toEqual([]);
  });

  it("submits in deviceSeq order and drops each order only after the server acknowledges it", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
        badgeDigest: "B",
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
        // No config was written in this test, so the device cannot say which
        // kiosk it is — see the test below for the stamp that matters.
        kioskId: null,
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

  /**
   * THE STAMP THAT KEEPS THE DAY COUNT'S TWO HALVES DISJOINT.
   *
   * The device counts its own gate's orders out of this journal and takes every
   * other gate's from the server's `takenTodayElsewhere`, which is the figure
   * with THIS gate excluded. The journal, though, belongs to the DEVICE — a
   * tablet re-paired from gate A to gate B keeps A's entries — so each entry has
   * to name the gate it was filed at or the two halves overlap and a worker is
   * charged twice for one bottle.
   *
   * The binding is read at DRAIN time, not carried on the queued record: the
   * token this client holds is the one the server files under, so an order
   * queued at the old gate and delivered after the re-pairing belongs to the
   * new one.
   */
  it("stamps the entry with the kiosk the device is bound to when the server answers", async () => {
    const filedKioskId = "33333333-3333-4333-8333-333333333333";
    await writeConfig({
      serverUrl: "/api",
      token: "tok",
      kioskId: filedKioskId,
      kioskName: "Проходная Б",
      place: null,
      nextDeviceSeq: 2,
    });
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeDigest: "B",
        reason: "buy",
        items: [{ rawKm: "01…" }],
        createdAt: "2026-07-28T06:00:00.000Z",
      },
      OUTCOME_EMPLOYEE_ID,
    );
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0001",
        status: "pending",
        itemCount: 1,
        conflicts: [],
      })),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    expect((await journalStore.readJournal(10))[0]).toMatchObject({ kioskId: filedKioskId });
  });

  // With no `createdAt` in the body the server stamps the order as it arrives
  // (`when = dto.createdAt ?? new Date()`), so the device journals that same
  // moment rather than leaving the day count with nothing to place it by.
  it("falls back to the sync moment for an order that carries no scan time", async () => {
    await enqueueOrder({ deviceSeq: 9, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 2, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
        badgeDigest: "B",
        reason: "writeoff",
        writeoffReasonId: "r-archived",
        items: [{ rawKm: "01…poison" }],
        createdAt: "2026-07-27T20:00:00.000Z",
      },
      "e1",
    );
    for (const deviceSeq of [2, 3]) {
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
          badgeDigest: "B",
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
        badgeDigest: "B",
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
        // The gate it was offered to and refused at. Nothing is charged to the
        // worker either way — this only keeps the line legible on the service
        // screen beside the entries around it.
        kioskId: null,
        deviceSeq: 1,
        orderNo: "",
        employeeId: "e1",
        acceptedCount: 0,
        conflicts: [],
      },
    ]);
  });

  it("quarantines only sanitized box verdicts from structured terminal details", async () => {
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeDigest: "B",
        reason: "buy",
        items: [],
        boxes: [{ sscc: "346006820000000021" }],
        createdAt: "2026-07-28T07:00:00.000Z",
      },
      "e1",
      undefined,
      12,
    );
    const details = {
      boxConflicts: [
        {
          sscc: "346006820000000021",
          bottleCount: 12,
          reason: "duplicate",
          extra: "drop-me",
        },
      ],
      conflicts: [{ rawKm: "response-secret", reason: "duplicate" }],
      rawSecret: "do-not-persist",
    };

    await flushQueue(
      refusingClient(new KioskApiError(422, "rejected", "order_rejected", details)) as never,
      () => new Date("2026-07-28T07:01:00.000Z"),
    );

    const parked = (await listQuarantine())[0]!;
    expect(parked.boxConflicts).toEqual([
      { sscc: "346006820000000021", bottleCount: 12, reason: "duplicate" },
    ]);
    expect(JSON.stringify(parked)).not.toContain("response-secret");
    expect(JSON.stringify(parked)).not.toContain("drop-me");
    expect(parked.body.boxes).toEqual([{ sscc: "346006820000000021" }]);
  });

  it("persists no structured box verdict when one entry is invalid", async () => {
    await enqueueOrder(
      { deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [{ rawKm: "wire" }] },
      "e1",
    );
    await flushQueue(
      refusingClient(
        new KioskApiError(422, "rejected", "order_rejected", {
          boxConflicts: [{ sscc: "000000000000000000", bottleCount: 900, reason: "duplicate" }],
        }),
      ) as never,
      () => new Date(),
    );
    expect((await listQuarantine())[0]).not.toHaveProperty("boxConflicts");
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
        badgeDigest: "GONE",
        reason: "buy",
        items: [{ rawKm: "01…orphaned" }],
        createdAt: "2026-07-27T20:00:00.000Z",
      },
      "e-deleted",
    );
    for (const deviceSeq of [2, 3]) {
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
          badgeDigest: "GONE",
          reason: "buy",
          items: [{ rawKm: "01…orphaned" }],
          createdAt: "2026-07-27T20:00:00.000Z",
        },
      },
    ]);
  });

  it("sets aside one post-expiry order and drains later eligible records", async () => {
    await enqueueOrder(
      {
        deviceSeq: 1,
        badgeDigest: "B",
        reason: "buy",
        items: [{ rawKm: "01…late" }],
        createdAt: "2026-08-10T12:00:00.000Z",
      },
      "e1",
    );
    for (const deviceSeq of [2, 3]) {
      await enqueueOrder(
        {
          deviceSeq,
          badgeDigest: "B",
          reason: "buy",
          items: [],
          createdAt: "2026-08-09T12:00:00.000Z",
        },
        "e1",
      );
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        if (body.deviceSeq === 1) {
          throw new KioskApiError(403, "Subscription is read-only", "subscription_read_only");
        }
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date("2026-08-10T12:01:00.000Z"));

    expect(client.submitOrder.mock.calls.map(([body]) => body.deviceSeq)).toEqual([1, 2, 3]);
    expect(await listQueue()).toEqual([]);
    expect(await listQuarantine()).toMatchObject([
      {
        deviceSeq: 1,
        status: 403,
        message: "Subscription is read-only",
      },
    ]);
  });

  it("uses the real API error body to quarantine an expired head and submit the next record", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder(
        {
          deviceSeq,
          badgeDigest: "B",
          reason: "buy",
          items: [],
          createdAt: `2026-08-0${deviceSeq + 8}T12:00:00.000Z`,
        },
        "e1",
      );
    }
    const submitted: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as { deviceSeq?: number };
        submitted.push(body.deviceSeq ?? -1);
        return body.deviceSeq === 1
          ? jsonResponse(403, { code: "subscription_read_only" })
          : jsonResponse(201, {
              orderNo: "ORD-26-0002",
              status: "pending",
              itemCount: 0,
              conflicts: [],
            });
      }),
    );

    await flushQueue(
      createKioskClient({ token: "tok", serverUrl: "http://srv" }),
      () => new Date("2026-08-10T12:01:00.000Z"),
    );

    expect(submitted).toEqual([1, 2]);
    expect(await listQueue()).toEqual([]);
    expect(await listQuarantine()).toMatchObject([
      { deviceSeq: 1, status: 403, message: "HTTP 403" },
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
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
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
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
    await enqueueOrder({ deviceSeq: 2, badgeDigest: "B", reason: "buy", items: [] }, "e1");
    vi.spyOn(queueStore, "quarantineOrder").mockRejectedValueOnce(new Error("indexeddb refused"));
    const client = refusingClient(new KioskApiError(400, "bad body"));

    await expect(flushQueue(client as never, () => new Date())).resolves.toBeUndefined();

    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
    // Stopped rather than skipped: an order still in the queue must not be
    // overtaken by the one behind it.
    expect(client.submitOrder).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE BACKOFF, and the gap it closes.
 *
 * A drain that stops on a dead network used to wait for whatever came first:
 * the five-minute refresh tick or an `online` event. A blink that clears in two
 * seconds therefore cost a worker's order up to five minutes in the queue —
 * and `online` never fires at all for the commonest outage of the lot, an API
 * that is down behind a Wi-Fi link that is perfectly up.
 *
 * Every test here drives the clock with fake timers. `setImmediate` is left
 * REAL because `fake-indexeddb` schedules every transaction step through it,
 * and the stores are mocked out besides — a schedule measured through a real
 * IndexedDB round trip would be measuring the store, not the backoff. That is
 * not merely tidier: a retry armed on the fake clock resolves inside
 * `advanceTimersByTimeAsync`, which pumps microtasks but not a real
 * `setImmediate`, so a drain awaiting a genuine store read there never gets
 * past it and the attempt is simply never made.
 */
describe("flushQueue backoff", () => {
  /** The queue and everything else the drain reads, answered from memory: see
   * the note above. */
  function queueOf(...deviceSeqs: number[]): void {
    vi.spyOn(queueStore, "listQueue").mockResolvedValue(
      deviceSeqs.map((deviceSeq) => ({
        deviceSeq,
        employeeId: "e1",
        body: { deviceSeq, badgeDigest: "B", reason: "buy" as const, items: [] },
      })),
    );
    vi.spyOn(queueStore, "dequeueOrder").mockResolvedValue(undefined);
    vi.spyOn(journalStore, "appendJournal").mockResolvedValue(undefined);
    // The drain reads the device's binding once a pass, to stamp the journal
    // with the kiosk the server is filing under.
    vi.spyOn(configStore, "readConfig").mockResolvedValue(null);
  }

  function useSyncFakeTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  /** Every submission this drain attempted, by the fake clock. */
  function attemptRecorder(fail: () => unknown) {
    const at: number[] = [];
    return {
      at,
      gaps: () => {
        let previous = at[0] ?? 0;
        return at.slice(1).map((moment) => {
          const gap = moment - previous;
          previous = moment;
          return gap;
        });
      },
      client: {
        bootstrap: vi.fn(),
        submitOrder: vi.fn(async () => {
          at.push(Date.now());
          const err = fail();
          if (err) throw err;
          return { orderNo: "ORD-26-0001", status: "pending", itemCount: 0, conflicts: [] };
        }),
      },
    };
  }

  it("retries a drain the network refused, doubling the wait and never exceeding the cap", async () => {
    useSyncFakeTimers();
    queueOf(1);
    const recorder = attemptRecorder(() => new TypeError("Failed to fetch"));

    await flushQueue(recorder.client as never, () => new Date());
    await vi.advanceTimersByTimeAsync(190_000);

    // 1 s doubling to a one-minute ceiling: fast enough that a blink which
    // clears in seconds costs the worker seconds, and bounded well below the
    // five-minute refresh tick so a night-long outage is one attempt a minute
    // rather than a spin.
    expect(recorder.gaps()).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(recorder.gaps()[0]).toBe(RETRY_BASE_MS);
    expect(Math.max(...recorder.gaps())).toBe(RETRY_MAX_MS);
  });

  it("keeps exactly one retry armed, however many drains stop on the same outage", async () => {
    useSyncFakeTimers();
    queueOf(1);
    const recorder = attemptRecorder(() => new TypeError("Failed to fetch"));

    await flushQueue(recorder.client as never, () => new Date());
    await flushQueue(recorder.client as never, () => new Date());
    await flushQueue(recorder.client as never, () => new Date());

    expect(vi.getTimerCount()).toBe(1);
  });

  it("resets the wait once a delivery lands, so the next outage starts from the base again", async () => {
    useSyncFakeTimers();
    queueOf(1);
    let offline = true;
    const recorder = attemptRecorder(() => (offline ? new TypeError("Failed to fetch") : null));

    await flushQueue(recorder.client as never, () => new Date());
    await vi.advanceTimersByTimeAsync(1_000); // second attempt
    await vi.advanceTimersByTimeAsync(2_000); // third — the wait is now 4 s
    expect(recorder.at).toHaveLength(3);

    // The link comes back and the fourth attempt goes through.
    offline = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(recorder.at).toHaveLength(4);
    // Nothing is owed, so nothing is armed.
    expect(vi.getTimerCount()).toBe(0);

    // And when it dies again the schedule starts over rather than resuming at
    // the 8 s it had climbed to — the whole point of resetting on success.
    offline = true;
    await flushQueue(recorder.client as never, () => new Date());
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(recorder.at).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(recorder.at).toHaveLength(6);
  });

  /**
   * A STATUS IS AN ANSWER, AND AN ANSWER IS NOT AN OUTAGE.
   *
   * The backoff exists for the case where nothing was reached at all. A server
   * that replies 500 or 429 has been reached, and hammering it every second
   * while it is struggling is the opposite of back-pressure; a 401 is a revoked
   * device, which the shell handles by returning to pairing and which no number
   * of retries can fix. Both wait for the ordinary refresh tick, exactly as
   * they did before.
   */
  it.each([
    ["a server fault", new KioskApiError(500, "boom")],
    ["back-pressure", new KioskApiError(429, "Too Many Requests")],
    ["a lost route", new KioskApiError(404, "Not Found")],
    ["a revoked device", new KioskApiError(401, "Unauthorized")],
  ])("arms no retry for %s — the server answered", async (_label, err) => {
    useSyncFakeTimers();
    queueOf(1);

    await flushQueue(refusingClient(err) as never, () => new Date());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms no retry for an order the server refused for good — it is parked, not owed", async () => {
    useSyncFakeTimers();
    queueOf(1);
    vi.spyOn(queueStore, "quarantineOrder").mockResolvedValue(undefined);

    await flushQueue(
      refusingClient(new KioskApiError(422, "Unknown or inactive badge")) as never,
      () => new Date(),
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * THE OUTAGE THE BACKOFF USED TO SIT OUT: A GATEWAY.
   *
   * Every test above models an outage as a `fetch` that REJECTS, which is what
   * a dropped connection looks like — and is the only shape any of them had.
   * An API that is down behind a proxy that is up looks like the opposite: the
   * request is ANSWERED, `502`, and the drain read that as "the application
   * replied", armed nothing, and left a worker's order in the queue until the
   * five-minute refresh tick. A live smoke run found it; nothing here could.
   *
   * Driven through the REAL client over a stubbed `fetch` that RESOLVES,
   * because the status has to survive the trip through `fetchJson` for any of
   * this to mean anything.
   */
  describe("behind a gateway that cannot reach the API", () => {
    /** A proxy answering `statusNow()`, or passing the request through to an
     * application that accepts it when that answer is `null`. */
    function gatewayClient(statusNow: () => number | null) {
      const at: number[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          at.push(Date.now());
          const status = statusNow();
          return status === null
            ? ({
                ok: true,
                status: 201,
                json: async () => ({
                  orderNo: "ORD-26-0001",
                  status: "pending",
                  itemCount: 0,
                  conflicts: [],
                }),
              } as Response)
            : ({
                ok: false,
                status,
                statusText: "Bad Gateway",
                json: async () => ({ message: "no upstream available" }),
              } as Response);
        }),
      );
      return { at, client: createKioskClient({ token: "tok", serverUrl: "http://srv" }) };
    }

    it.each([502, 503, 504])("arms the backoff when the gateway answers %i", async (status) => {
      useSyncFakeTimers();
      queueOf(1);
      const gateway = gatewayClient(() => status);

      await flushQueue(gateway.client, () => new Date());

      // Armed, and armed at the base — this is a fresh outage, not a struggling
      // application asking to be left alone.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
      expect(gateway.at).toHaveLength(2);
    });

    it("resets the wait once the API returns from behind the gateway", async () => {
      useSyncFakeTimers();
      queueOf(1);
      let down = true;
      const gateway = gatewayClient(() => (down ? 502 : null));

      await flushQueue(gateway.client, () => new Date());
      await vi.advanceTimersByTimeAsync(1_000); // second attempt
      await vi.advanceTimersByTimeAsync(2_000); // third — the wait is now 4 s
      expect(gateway.at).toHaveLength(3);

      // The application comes back up behind the same proxy.
      down = false;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(gateway.at).toHaveLength(4);
      // Delivered, so nothing is owed and nothing is armed.
      expect(vi.getTimerCount()).toBe(0);

      // And the next outage starts from the base rather than resuming at the
      // 8 s this one had climbed to.
      down = true;
      await flushQueue(gateway.client, () => new Date());
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
      expect(gateway.at).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.at).toHaveLength(6);
    });

    /**
     * A 504 IS THE ONE THAT MAY ALREADY HAVE BEEN FILED — the gateway gave up
     * waiting on an upstream that was answering it, not on one that was absent
     * — so it is the same shape as `KioskTimeoutError`: no verdict on the
     * order, and a replay that is safe only because the server is idempotent on
     * `(tenantId, kioskId, deviceSeq)`. What it must never be is a verdict.
     */
    it.each([502, 503, 504])(
      "never quarantines on a %i — a gateway judges nothing",
      async (status) => {
        useSyncFakeTimers();
        const quarantined = vi.spyOn(queueStore, "quarantineOrder").mockResolvedValue(undefined);
        queueOf(1);
        const gateway = gatewayClient(() => status);

        await flushQueue(gateway.client, () => new Date());

        expect(quarantined).not.toHaveBeenCalled();
        expect(queueStore.dequeueOrder).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * NO TIMER MAY OUTLIVE THE SHELL. The retry holds the client the shell built,
   * and that client records the reply for the order `submitCart` is awaiting —
   * so a retry left armed past an unmount fires into a React tree that is gone.
   */
  it("drops a pending retry on cancelFlushRetry, and the schedule starts over afterwards", async () => {
    useSyncFakeTimers();
    queueOf(1);
    const recorder = attemptRecorder(() => new TypeError("Failed to fetch"));

    await flushQueue(recorder.client as never, () => new Date());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorder.at).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);

    cancelFlushRetry();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(recorder.at).toHaveLength(2);
  });

  /**
   * The same guarantee against the race that makes it hard: the cancel lands
   * while a drain is still in flight, so the drain arms its retry AFTER the
   * shell has already gone. A flag checked only at cancel time would miss this
   * one, and it is precisely the unmount-during-an-outage case.
   */
  it("arms nothing when the cancel lands mid-drain", async () => {
    useSyncFakeTimers();
    queueOf(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => {
        await held;
        throw new TypeError("Failed to fetch");
      }),
    };

    const drained = flushQueue(client as never, () => new Date());
    cancelFlushRetry();
    release();
    await drained;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isTerminalRejection", () => {
  it.each([400, 409, 413, 422])(
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
  it.each([401, 403, 404, 408, 429, 500, 502, 503, 504])("keeps %i retryable", (status) => {
    expect(isTerminalRejection(new KioskApiError(status, "refused"))).toBe(false);
  });

  it("treats only the exact subscription read-only 403 as a per-record verdict", () => {
    expect(
      isTerminalRejection(
        new KioskApiError(403, "Subscription is read-only", "subscription_read_only"),
      ),
    ).toBe(true);
    expect(isTerminalRejection(new KioskApiError(403, "Forbidden", "some_other_code"))).toBe(false);
  });

  it("keeps a transport failure retryable — it carries no verdict at all", () => {
    expect(isTerminalRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isTerminalRejection(new KioskTimeoutError(15_000))).toBe(false);
  });
});

const bootstrap = (generatedAt: string): KioskBootstrapDto => ({
  generatedAt,
  subscription: {
    access: "managed",
    status: "active",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-31T00:00:00.000Z",
  },
  branding: { organizationName: "ООО Маяк", logoUrl: null, logoRevision: null },
  pickupPolicy: { limitsEnabled: true },
  config: { dayLimitPerEmployee: 5, showPrices: true },
  badgeSalt: "c2FsdA==",
  reasons: [],
  products: [],
  employees: [
    {
      id: "e1",
      fullName: "A",
      role: null,
      badgeHash: null,
      limitMode: "limited",
      dayLimit: 5,
      canWriteoff: true,
      takenTodayElsewhere: 0,
    },
  ],
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

/**
 * The same measurement the gate makes, handed back as a NUMBER — which is what
 * the strip needs to say «Данные обновлялись 30 ч назад» instead of the
 * threshold-shaped «больше суток назад» (design 2026-07-24 §7).
 *
 * `null` rather than a guess wherever the age cannot be established, which is
 * the same fail-closed rule `snapshotAge` states as `blocked`: the two answers
 * are two readings of one arithmetic, so the strip can never claim an age for a
 * dataset the gate has refused to date.
 */
describe("snapshotAgeMs", () => {
  const SERVER = "2026-07-28T00:00:00.000Z";
  const HOUR = 60 * 60_000;

  it("measures elapsed time since the fetch", () => {
    const snap: CachedSnapshot = { bootstrap: bootstrap(SERVER), fetchedAt: SERVER };
    expect(snapshotAgeMs(snap, new Date(Date.parse(SERVER) + 30 * HOUR))).toBe(30 * HOUR);
  });

  // Two readings of the SAME clock, so a tablet whose date is years out still
  // ages its snapshot at one second per second — exactly as `snapshotAge` does.
  it("cancels a skewed device clock out, like the gate above it", () => {
    const skew = 40 * STALE_BLOCK_MS;
    const snap: CachedSnapshot = {
      bootstrap: bootstrap(SERVER),
      fetchedAt: new Date(Date.parse(SERVER) + skew).toISOString(),
    };
    expect(snapshotAgeMs(snap, new Date(Date.parse(SERVER) + skew + 30 * HOUR))).toBe(30 * HOUR);
  });

  it("refuses to date a snapshot it cannot measure", () => {
    expect(snapshotAgeMs(null, new Date(SERVER))).toBeNull();
    expect(
      snapshotAgeMs({ bootstrap: bootstrap("not-a-date"), fetchedAt: SERVER }, new Date(SERVER)),
    ).toBeNull();
    expect(
      snapshotAgeMs({ bootstrap: bootstrap(SERVER), fetchedAt: "not-a-date" }, new Date(SERVER)),
    ).toBeNull();
  });
});

/**
 * «N назад», coarsely — hours, then days.
 *
 * Coarse on purpose. Nobody standing at a kiosk acts differently on 30 h than
 * on 30 h 40 min, and the precision would cost the one thing this copy cannot
 * afford: a Russian plural. i18next's RU categories (`_one/_few/_many/_other`)
 * have no EN counterpart, and the two files must carry identical key sets — so
 * the unit is chosen here and the copy names it with an indeclinable
 * abbreviation («ч», «сут»), the way `cart.total` already says «{{n}} шт».
 */
describe("humaniseAge", () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  it("counts whole hours below two days", () => {
    expect(humaniseAge(24 * HOUR)).toEqual({ unit: "hours", n: 24 });
    expect(humaniseAge(30 * HOUR + 59 * 60_000)).toEqual({ unit: "hours", n: 30 });
    expect(humaniseAge(2 * DAY - 1)).toEqual({ unit: "hours", n: 47 });
  });

  it("switches to whole days at two, where the hour count stops meaning anything", () => {
    expect(humaniseAge(2 * DAY)).toEqual({ unit: "days", n: 2 });
    expect(humaniseAge(6 * DAY + 23 * HOUR)).toEqual({ unit: "days", n: 6 });
    expect(humaniseAge(9 * DAY)).toEqual({ unit: "days", n: 9 });
  });

  // Rounds DOWN, like every «N ago» anywhere: 30 h 59 min is «30 ч назад».
  // Never below zero either — a device whose clock ran backwards between two
  // refreshes must not be told its data is minus four hours old.
  it("never counts backwards", () => {
    expect(humaniseAge(0)).toEqual({ unit: "hours", n: 0 });
    expect(humaniseAge(-5 * HOUR)).toEqual({ unit: "hours", n: 0 });
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

  it("uses server-generated bootstrap time for registry freshness despite device clock skew", async () => {
    const serverGeneratedAt = "2026-07-28T07:00:00.000Z";
    const skewedFetchedAt = new Date("2036-07-28T07:00:03.000Z");
    await writeConfig({
      serverUrl: "https://one.example/api",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const client = {
      bootstrap: vi.fn(async () => bootstrap(serverGeneratedAt)),
      boxRegistryPage: vi.fn(async () => ({ until: "1", items: [] })),
      submitOrder: vi.fn(),
    };

    await refreshSnapshot(client as never, () => skewedFetchedAt);

    const meta = await readBoxRegistryMeta({
      serverUrl: "https://one.example/api",
      kioskId: "k-1",
    });
    const cached = await readSnapshot();
    expect(meta?.generatedAt).toBe(serverGeneratedAt);
    expect(
      boxRegistryAge(meta, cached, new Date(skewedFetchedAt.getTime() + 30 * 60 * 60_000)),
    ).toBe("warn");
  });

  it("single-flights overlapping refreshes for the same installation", async () => {
    await writeConfig({
      serverUrl: "https://one.example/api",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markPageStarted!: () => void;
    const pageStarted = new Promise<void>((resolve) => {
      markPageStarted = resolve;
    });
    const client = {
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:00:00.000Z")),
      boxRegistryPage: vi.fn(async () => {
        markPageStarted();
        await held;
        return { until: "1", items: [] };
      }),
      submitOrder: vi.fn(),
    };

    const first = refreshSnapshot(client as never, () => new Date("2026-07-28T07:00:03Z"));
    await pageStarted;
    const second = refreshSnapshot(client as never, () => new Date("2026-07-28T07:00:04Z"));
    await Promise.resolve();
    expect(client.boxRegistryPage).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(client.boxRegistryPage).toHaveBeenCalledTimes(1);
  });

  it("lets a new credential refresh win while an old same-binding client is held", async () => {
    const binding = { serverUrl: "https://one.example/api", kioskId: "k-1" };
    const oldConfig = await writeConfig({
      ...binding,
      token: "old-token",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    let releaseOld!: () => void;
    const heldOld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldPageStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      oldPageStarted = resolve;
    });
    const oldSscc = "346006820000000021";
    const newSscc = "346006820000000014";
    const change = (sscc: string) => ({
      kind: "upsert" as const,
      boxId: "00000000-0000-4000-8000-000000000001",
      sscc,
      productId: "00000000-0000-4000-8000-000000000002",
      bottleCount: 1,
      contentKeys: [`member-${sscc}`],
      updatedAt: "2026-07-28T07:00:00Z",
    });
    const oldClient = {
      registryOwner: {
        binding,
        credentialGeneration: oldConfig.credentialGeneration!,
      },
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:00:00.000Z")),
      boxRegistryPage: vi.fn(async () => {
        oldPageStarted();
        await heldOld;
        return { until: "1", items: [change(oldSscc)] };
      }),
      submitOrder: vi.fn(),
    };

    const oldRefresh = refreshSnapshot(oldClient as never, () => new Date("2026-07-28T07:00:01Z"));
    await oldStarted;
    const newConfig = await writeConfig({
      ...binding,
      token: "new-token",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const newClient = {
      registryOwner: {
        binding,
        credentialGeneration: newConfig.credentialGeneration!,
      },
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:01:00.000Z")),
      boxRegistryPage: vi.fn(async () => ({ until: "2", items: [change(newSscc)] })),
      submitOrder: vi.fn(),
    };

    await refreshSnapshot(newClient as never, () => new Date("2026-07-28T07:01:01Z"));
    releaseOld();
    await oldRefresh;

    expect(newClient.boxRegistryPage).toHaveBeenCalledTimes(1);
    expect(await lookupBox(binding, newSscc)).not.toBeNull();
    expect(await lookupBox(binding, oldSscc)).toBeNull();
    expect(await readBoxRegistryMeta(binding)).toMatchObject({
      credentialGeneration: newConfig.credentialGeneration,
      version: "2",
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

  it("keeps a successful bootstrap when a bounded registry refresh exhausts snapshot-change retries", async () => {
    const fresh = bootstrap("2026-07-28T07:00:00.000Z");
    await writeConfig({
      serverUrl: "http://srv",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const client = {
      binding: { serverUrl: "http://srv", kioskId: "k-1" },
      bootstrap: vi.fn(async () => fresh),
      boxRegistryPage: vi.fn(async () => {
        throw new KioskApiError(409, "changed", "registry_snapshot_changed");
      }),
      submitOrder: vi.fn(),
    };

    await expect(
      refreshSnapshot(
        client as never,
        () => new Date("2026-07-28T07:00:03.000Z"),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    expect(client.boxRegistryPage).toHaveBeenCalledTimes(3);
    expect(await readSnapshot()).toEqual({
      bootstrap: fresh,
      fetchedAt: "2026-07-28T07:00:03.000Z",
    });
  });

  it("restarts a changed multi-page registry from the old active version", async () => {
    const fresh = bootstrap("2026-07-28T07:00:00.000Z");
    await writeConfig({
      serverUrl: "http://srv",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const queries: unknown[] = [];
    const responses = [
      { until: "2", items: [], nextCursor: "page-2" },
      new KioskApiError(409, "changed", "registry_snapshot_changed"),
      { until: "3", items: [], nextCursor: undefined },
    ];
    const client = {
      binding: { serverUrl: "http://srv", kioskId: "k-1" },
      bootstrap: vi.fn(async () => fresh),
      boxRegistryPage: vi.fn(async (query: unknown) => {
        queries.push(query);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next!;
      }),
      submitOrder: vi.fn(),
    };

    await refreshSnapshot(
      client as never,
      () => new Date("2026-07-28T07:00:03.000Z"),
      async () => {},
    );

    expect(queries).toEqual([
      { limit: 250 },
      { until: "2", cursor: "page-2", limit: 250 },
      { limit: 250 },
    ]);
  });

  it("does not hide revocation between bootstrap and registry fetch", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const client = {
      binding: { serverUrl: "http://srv", kioskId: "k-1" },
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:00:00.000Z")),
      boxRegistryPage: vi.fn(async () => {
        throw new KioskApiError(401, "revoked");
      }),
      submitOrder: vi.fn(),
    };

    await expect(refreshSnapshot(client as never, () => new Date())).rejects.toMatchObject({
      status: 401,
    });
  });

  it("bounds an untrusted cursor cycle and keeps the old active cut", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "token",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const client = {
      binding: { serverUrl: "http://srv", kioskId: "k-1" },
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:00:00.000Z")),
      boxRegistryPage: vi.fn(async () => ({ until: "2", items: [], nextCursor: "same" })),
      submitOrder: vi.fn(),
    };

    await refreshSnapshot(
      client as never,
      () => new Date(),
      async () => {},
    );

    expect(client.boxRegistryPage).toHaveBeenCalledTimes(2);
  });

  it("bounds unique malicious cursors and discards the incomplete cut", async () => {
    const sscc = "346006820000000021";
    const binding = { serverUrl: "https://one.example/api", kioskId: "k-1" };
    const config = await writeConfig({
      ...binding,
      token: "token",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 0,
    });
    const seed = {
      binding,
      credentialGeneration: config.credentialGeneration!,
      owner: "seed",
      since: null,
      until: "1",
    };
    await beginBoxRegistryStage(seed);
    await activateBoxRegistryPage(
      seed,
      [
        {
          kind: "upsert",
          boxId: "00000000-0000-4000-8000-000000000001",
          sscc,
          productId: "00000000-0000-4000-8000-000000000002",
          bottleCount: 1,
          contentKeys: ["member"],
          updatedAt: "2026-07-28T06:00:00Z",
        },
      ],
      "2026-07-28T06:00:00Z",
    );
    let cursor = 0;
    const client = {
      bootstrap: vi.fn(async () => bootstrap("2026-07-28T07:00:00.000Z")),
      boxRegistryPage: vi.fn(async () => ({
        until: "2",
        items: [],
        nextCursor: `cursor-${(cursor += 1)}`,
      })),
      submitOrder: vi.fn(),
    };

    await refreshSnapshot(
      client as never,
      () => new Date(),
      async () => {},
      2,
    );

    expect(client.boxRegistryPage).toHaveBeenCalledTimes(2);
    expect(await readBoxRegistryMeta(binding)).toMatchObject({ version: "1" });
    expect(await lookupBox(binding, sscc)).toMatchObject({
      boxId: "00000000-0000-4000-8000-000000000001",
    });
  });
});
