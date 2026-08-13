import { describe, expect, it } from "vitest";
import { readSnapshot, replaceSnapshot, UnusableBootstrapError } from "../src/store/cache.js";
import {
  dequeueOrder,
  enqueueOrder,
  listQuarantine,
  listQueue,
  quarantineOrder,
  quarantineQueue,
} from "../src/store/queue.js";
import { readConfig, writeConfig, type KioskConfig } from "../src/store/config.js";
import type { KioskBootstrapDto } from "../src/api/types.js";

const snapshot = (employees: KioskBootstrapDto["employees"]): KioskBootstrapDto => ({
  generatedAt: "2026-07-28T06:00:00.000Z",
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
  employees,
  operators: [],
});

describe("cache", () => {
  it("returns null before anything is stored", async () => {
    await expect(readSnapshot()).resolves.toBeNull();
  });

  it("replaces the snapshot wholesale — an employee removed on the server disappears locally", async () => {
    await replaceSnapshot(
      snapshot([
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
        {
          id: "e2",
          fullName: "B",
          role: null,
          badgeHash: null,
          limitMode: "limited",
          dayLimit: 5,
          canWriteoff: true,
          takenTodayElsewhere: 0,
        },
      ]),
      new Date("2026-07-28T06:00:00.000Z"),
    );
    await replaceSnapshot(
      snapshot([
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
      ]),
      new Date("2026-07-28T06:05:00.000Z"),
    );

    const stored = await readSnapshot();
    expect(stored!.bootstrap.employees.map((e) => e.id)).toEqual(["e1"]);
    expect(stored!.fetchedAt).toBe("2026-07-28T06:05:00.000Z");
  });

  it("refuses an unmeasurable generatedAt at the write itself, not only at the call sites", async () => {
    // The guard used to live entirely in the callers, so the next write path
    // added would bypass it exactly as this test could. A stamp `cacheAge`
    // cannot measure reads `fresh` forever and disables the seven-day lockout,
    // so the store — the thing that owns the invariant — enforces it.
    await expect(
      replaceSnapshot({ ...snapshot([]), generatedAt: "not-a-date" }, new Date()),
    ).rejects.toBeInstanceOf(UnusableBootstrapError);
    await expect(readSnapshot()).resolves.toBeNull();
  });
});

describe("queue", () => {
  it("drains in deviceSeq order regardless of insertion order", async () => {
    for (const deviceSeq of [3, 1, 2]) {
      await enqueueOrder({ deviceSeq, badgeDigest: "B", reason: "buy", items: [] }, "e1");
    }
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2, 3]);
  });

  it("removes only the acknowledged order", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeDigest: "B", reason: "buy", items: [] }, "e1");
    await enqueueOrder({ deviceSeq: 2, badgeDigest: "B", reason: "buy", items: [] }, "e1");
    await dequeueOrder(1);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([2]);
  });
});

describe("quarantine", () => {
  const order = (deviceSeq: number) => ({
    deviceSeq,
    employeeId: "e1",
    body: { deviceSeq, badgeDigest: "B", reason: "buy" as const, items: [{ rawKm: "01…" }] },
  });

  // Keyed by `deviceSeq`, so a drain that parked an order and then crashed
  // before the dequeue re-parks the SAME record on replay rather than adding a
  // second copy of one pickup.
  it("overwrites rather than duplicates when the same order is parked twice", async () => {
    await quarantineOrder({
      ...order(1),
      at: "2026-07-28T07:00:00.000Z",
      status: 400,
      message: "a",
    });
    await quarantineOrder({
      ...order(1),
      at: "2026-07-28T07:05:00.000Z",
      status: 400,
      message: "b",
    });

    const parked = await listQuarantine();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.message).toBe("b");
  });

  // Custody before removal, order by order: what leaves the queue is already
  // durable somewhere else, and nothing about a queue that can never be
  // delivered is deleted.
  it("moves the whole queue aside, keeping every body", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder(order(deviceSeq).body, "e1");
    }

    const parked = await quarantineQueue(new Date("2026-07-28T07:00:00.000Z"), "revoked");

    expect(parked).toBe(2);
    expect(await listQueue()).toEqual([]);
    expect((await listQuarantine()).map((o) => [o.deviceSeq, o.status, o.message])).toEqual([
      [1, 0, "revoked"],
      [2, 0, "revoked"],
    ]);
    expect((await listQuarantine())[0]!.body.items).toEqual([{ rawKm: "01…" }]);
  });
});

describe("config", () => {
  it("round-trips the device identity", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "tok",
      kioskId: "k-1",
      kioskName: "Киоск-1",
      place: "Проходная",
      nextDeviceSeq: 7,
    });
    expect(await readConfig()).toMatchObject({ token: "tok", kioskId: "k-1", nextDeviceSeq: 7 });
  });

  /**
   * THE UPGRADE PATH for the binding itself. A config written before
   * `kioskId` existed carries no such property, and the day count compares the
   * value it finds here against the stamp on a journal entry — so an
   * `undefined` that is never normalised would be a third kind of "unknown"
   * that matches neither a real gate nor an unstamped entry, and the local half
   * of the day limit would silently read zero.
   */
  it("reads a config written before the binding was recorded as bound to no kiosk", async () => {
    const legacy = {
      serverUrl: "http://srv",
      token: "tok",
      kioskName: "Киоск-1",
      place: null,
      nextDeviceSeq: 7,
    } as unknown as KioskConfig;
    await writeConfig(legacy);

    const found = await readConfig();
    expect(found?.kioskId).toBeNull();
    expect(found?.token).toBe("tok");
  });

  /** Checked rather than trusted, and by the same rule the journal's stamp is
   * read with: an empty string is not an identity. */
  it("reads an empty binding as no kiosk at all", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "tok",
      kioskId: "",
      kioskName: "Киоск-1",
      place: null,
      nextDeviceSeq: 1,
    });
    expect((await readConfig())?.kioskId).toBeNull();
  });
});
