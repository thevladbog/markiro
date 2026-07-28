import { describe, expect, it } from "vitest";
import { readSnapshot, replaceSnapshot } from "../src/store/cache.js";
import { dequeueOrder, enqueueOrder, listQueue } from "../src/store/queue.js";
import { readConfig, writeConfig } from "../src/store/config.js";
import type { KioskBootstrapDto } from "../src/api/types.js";

const snapshot = (employees: KioskBootstrapDto["employees"]): KioskBootstrapDto => ({
  generatedAt: "2026-07-28T06:00:00.000Z",
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
        { id: "e1", fullName: "A", role: null, badgeHash: null },
        { id: "e2", fullName: "B", role: null, badgeHash: null },
      ]),
      new Date("2026-07-28T06:00:00.000Z"),
    );
    await replaceSnapshot(
      snapshot([{ id: "e1", fullName: "A", role: null, badgeHash: null }]),
      new Date("2026-07-28T06:05:00.000Z"),
    );

    const stored = await readSnapshot();
    expect(stored!.bootstrap.employees.map((e) => e.id)).toEqual(["e1"]);
    expect(stored!.fetchedAt).toBe("2026-07-28T06:05:00.000Z");
  });
});

describe("queue", () => {
  it("drains in deviceSeq order regardless of insertion order", async () => {
    for (const deviceSeq of [3, 1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
    }
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2, 3]);
  });

  it("removes only the acknowledged order", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] });
    await enqueueOrder({ deviceSeq: 2, badgeCode: "B", reason: "buy", items: [] });
    await dequeueOrder(1);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([2]);
  });
});

describe("config", () => {
  it("round-trips the device identity", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "tok",
      kioskName: "Киоск-1",
      place: "Проходная",
      nextDeviceSeq: 7,
    });
    expect(await readConfig()).toMatchObject({ token: "tok", nextDeviceSeq: 7 });
  });
});
