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
import { IDBFactory } from "fake-indexeddb";
import { appendJournal, readJournal } from "../src/store/journal.js";
import {
  activateBoxRegistryPage,
  beginBoxRegistryStage,
  lookupBox,
  readBoxRegistryMeta,
  type BoxRegistryCut,
} from "../src/store/box-registry.js";

const REGISTRY_SSCC = "346006820000000021";
const binding = (serverUrl: string, kioskId: string) => ({ serverUrl, kioskId });

async function seedRegistry(serverUrl: string, kioskId: string, version = "7"): Promise<void> {
  const config = await readConfig();
  const target = {
    binding: binding(serverUrl, kioskId),
    credentialGeneration: config?.credentialGeneration ?? "missing",
    owner: "seed",
    since: null,
    until: version,
  };
  await beginBoxRegistryStage(target);
  await activateBoxRegistryPage(
    target,
    [
      {
        kind: "upsert",
        boxId: "00000000-0000-4000-8000-000000000001",
        sscc: REGISTRY_SSCC,
        productId: "00000000-0000-4000-8000-000000000002",
        bottleCount: 1,
        contentKeys: ["member"],
        updatedAt: "2026-08-13T12:00:00Z",
      },
    ],
    "2026-08-13T12:00:00Z",
  );
}

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
  it("upgrades a version-two database without losing its snapshot or queue", async () => {
    globalThis.indexedDB = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("markiro-kiosk", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("snapshot");
        db.createObjectStore("queue", { keyPath: "deviceSeq" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["snapshot", "queue"], "readwrite");
        tx.objectStore("snapshot").put({ bootstrap: snapshot([]), fetchedAt: "legacy" }, "current");
        tx.objectStore("queue").put({
          deviceSeq: 4,
          employeeId: "e1",
          body: { deviceSeq: 4, badgeCode: "legacy", reason: "buy", items: [] },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    expect(await readSnapshot()).toMatchObject({ fetchedAt: "legacy" });
    expect(await listQueue()).toEqual([
      {
        deviceSeq: 4,
        employeeId: "e1",
        body: { deviceSeq: 4, badgeCode: "legacy", reason: "buy", items: [] },
      },
    ]);
  });
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

  it("persists boxes verbatim beside a bottle estimate outside the wire body", async () => {
    const body = {
      deviceSeq: 3,
      badgeDigest: "B",
      reason: "buy" as const,
      items: [{ rawKm: "loose" }],
      boxes: [{ sscc: "346006820000000021" }],
    };

    await enqueueOrder(body, "e1", "pending_attestation", 13);

    expect(await listQueue()).toEqual([
      {
        deviceSeq: 3,
        employeeId: "e1",
        body,
        admissionState: "pending_attestation",
        estimatedBottleCount: 13,
      },
    ]);
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

  it("preserves registry when the same installation is re-paired with a normalized URL", async () => {
    await writeConfig({
      serverUrl: "https://one.example/api",
      token: "old",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 1,
    });
    await seedRegistry("https://one.example/api", "k-1");

    await writeConfig({
      serverUrl: "https://one.example/api/",
      token: "old",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 2,
    });

    expect(
      await lookupBox(binding("https://one.example/api/", "k-1"), REGISTRY_SSCC),
    ).not.toBeNull();
  });

  it("rejects an old credential cut after same-binding token rotation and accepts the new owner", async () => {
    const installation = binding("https://one.example/api", "k-1");
    const oldConfig = await writeConfig({
      ...installation,
      token: "old-token",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 1,
    });
    const oldCut = {
      binding: installation,
      credentialGeneration: oldConfig.credentialGeneration!,
      owner: "old-refresh",
      since: null,
      until: "1",
    } as BoxRegistryCut;
    await beginBoxRegistryStage(oldCut);

    const newConfig = await writeConfig({
      ...installation,
      token: "new-token",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 1,
    });
    expect(newConfig.credentialGeneration).not.toBe(oldConfig.credentialGeneration);

    await expect(activateBoxRegistryPage(oldCut, [], "2026-08-13T12:00:00Z")).rejects.toThrow(
      /credential|ownership|lost/i,
    );

    const newCut = {
      binding: installation,
      credentialGeneration: newConfig.credentialGeneration!,
      owner: "new-refresh",
      since: null,
      until: "2",
    } as BoxRegistryCut;
    await beginBoxRegistryStage(newCut);
    await activateBoxRegistryPage(newCut, [], "2026-08-13T12:01:00Z");
    expect(await readBoxRegistryMeta(installation)).toMatchObject({ version: "2" });
  });

  it.each([
    ["another server", "https://two.example/api", "k-1"],
    ["another kiosk", "https://one.example/api", "k-2"],
  ])(
    "atomically clears registry for %s but keeps queue and journal",
    async (_label, serverUrl, kioskId) => {
      await writeConfig({
        serverUrl: "https://one.example/api",
        token: "old",
        kioskId: "k-1",
        kioskName: "A",
        place: null,
        nextDeviceSeq: 1,
      });
      await seedRegistry("https://one.example/api", "k-1", "99");
      await enqueueOrder(
        { deviceSeq: 1, badgeDigest: "digest", reason: "buy", items: [{ rawKm: "wire" }] },
        "e1",
      );
      await appendJournal({
        at: "2026-08-13T12:00:00Z",
        createdAt: "2026-08-13T12:00:00Z",
        kioskId: "k-1",
        deviceSeq: 0,
        orderNo: "old",
        employeeId: "e1",
        acceptedCount: 1,
        conflicts: [],
      });

      await writeConfig({
        serverUrl,
        token: "new",
        kioskId,
        kioskName: "B",
        place: null,
        nextDeviceSeq: 0,
      });

      expect(await readBoxRegistryMeta(binding(serverUrl, kioskId))).toBeNull();
      expect(await listQueue()).toHaveLength(1);
      expect(await readJournal(10)).toHaveLength(1);
    },
  );

  it("clears registry on revocation without deleting queue or journal", async () => {
    const config = {
      serverUrl: "https://one.example/api",
      token: "old",
      kioskId: "k-1",
      kioskName: "A",
      place: null,
      nextDeviceSeq: 1,
    };
    await writeConfig(config);
    await seedRegistry(config.serverUrl, config.kioskId);
    await enqueueOrder(
      { deviceSeq: 1, badgeDigest: "digest", reason: "buy", items: [{ rawKm: "wire" }] },
      "e1",
    );

    await writeConfig({ ...config, token: null });

    expect(await readBoxRegistryMeta(binding(config.serverUrl, config.kioskId))).toBeNull();
    expect(await listQueue()).toHaveLength(1);
  });
});
