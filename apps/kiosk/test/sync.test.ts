import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheAge,
  flushQueue,
  refreshSnapshot,
  STALE_BLOCK_MS,
  STALE_WARN_MS,
} from "../src/sync/worker.js";
import { enqueueOrder, listQueue } from "../src/store/queue.js";
import * as journalStore from "../src/store/journal.js";
import { readSnapshot, replaceSnapshot } from "../src/store/cache.js";
import type { KioskBootstrapDto } from "../src/api/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
});

describe("flushQueue", () => {
  it("submits in deviceSeq order and drops each order only after the server acknowledges it", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
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
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
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

  it("journals the server's verdict and only then drops the order", async () => {
    await enqueueOrder({ deviceSeq: 4, badgeCode: "B", reason: "buy", items: [{ rawKm: "01…" }] });
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => ({
        orderNo: "ORD-26-0004",
        status: "pending",
        itemCount: 0,
        conflicts: [{ rawKm: "01…", reason: "duplicate" }],
      })),
    };

    await flushQueue(client as never, () => new Date("2026-07-28T07:00:00.000Z"));

    expect(await journalStore.readJournal(10)).toEqual([
      {
        at: "2026-07-28T07:00:00.000Z",
        deviceSeq: 4,
        orderNo: "ORD-26-0004",
        conflicts: [{ rawKm: "01…", reason: "duplicate" }],
      },
    ]);
    expect(await listQueue()).toEqual([]);
  });

  it("keeps the order queued when journalling fails, so a crash mid-flight replays instead of losing it", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] });
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
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
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
});
