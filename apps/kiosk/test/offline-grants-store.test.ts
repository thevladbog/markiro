import { describe, expect, it } from "vitest";
import { withStore } from "../src/store/db.js";

describe("offline grant storage", () => {
  it("adds durable grant state without inventing a strict rollout configuration", async () => {
    await expect(
      withStore("offline-grants", "readonly", (store) => store.get("current")),
    ).resolves.toBeUndefined();
  });
});

it("upgrades a real version-five queue without changing its old payload or inventing authority", async () => {
  const legacy = {
    deviceSeq: 41,
    employeeId: "legacy",
    body: {
      deviceSeq: 41,
      badgeCode: "synthetic-legacy",
      reason: "buy",
      items: [{ rawKm: "saved-raw" }],
    },
  };
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("markiro-kiosk", 5);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("queue", { keyPath: "deviceSeq" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").put(legacy);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
  expect(await withStore("queue", "readonly", (s) => s.get(41))).toEqual(legacy);
  expect(await withStore("offline-grants", "readonly", (s) => s.getAll())).toEqual([]);
  expect(await withStore("offline-grant-readiness", "readonly", (s) => s.getAll())).toEqual([]);
});
