import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { inventorySnapshotContentDigest, inventorySnapshotPageDigest } from "@markiro/domain";
import type { StationClient } from "../src/lib/api-client.js";
import { mirrorInventoryBundle } from "../src/lib/inventory-bundle.js";
import {
  readInventoryMirrorState,
  type InventoryBundleManifest,
  type InventoryBundlePage,
} from "../src/lib/inventory-mirror.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";

const inventoryId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const digest = "a".repeat(64);
const firstHash = "066e15060b18b753ddffa6a92d9d2ce2366b5fc3c704d6d61c89bb77740b47ff";
const secondHash = "71ecc4669aa5893c25d6d3e42a6b2a4775097ee72ff87cd16165d8a3f7bb88b9";
const fixedAt = "2026-08-25T01:02:03.000Z";

const pageItems = [
  {
    codeHash: firstHash,
    canonicalRaw: "010460000000001521SERIAL-B",
    gtin14: "04600000000015",
    serial: "SERIAL-B",
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: "2026-08-01",
    parentSscc: null,
    expected: true,
    protected: false,
  },
  {
    codeHash: secondHash,
    canonicalRaw: "010460000000001521SERIAL-A",
    gtin14: "04600000000015",
    serial: "SERIAL-A",
    sourceStatus: "EMITTED" as const,
    sourceState: null,
    sourceProductionDate: null,
    parentSscc: null,
    expected: false,
    protected: false,
  },
];
const contentDigest = inventorySnapshotContentDigest(pageItems);

const manifest: InventoryBundleManifest = {
  inventoryId,
  inventoryNumber: "INV-2026-001",
  snapshotId,
  snapshotRevision: 1,
  snapshotFixedAt: fixedAt,
  combinedDigest: digest,
  contentDigest,
  codeCount: 2,
  productId: "44444444-4444-4444-8444-444444444444",
  productName: "Сидр",
  gtin14: "04600000000015",
  boxCapacity: 12,
  mode: "check",
  lineId: "55555555-5555-4555-8555-555555555555",
  lineName: "Линия 1",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplate: null,
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

const pages: InventoryBundlePage[] = [
  {
    snapshotId,
    snapshotRevision: 1,
    snapshotFixedAt: fixedAt,
    combinedDigest: digest,
    contentDigest,
    cursor: null,
    items: [pageItems[0]!],
    nextCursor: firstHash,
    pageDigest: inventorySnapshotPageDigest({
      snapshotId,
      snapshotFixedAt: fixedAt,
      contentDigest,
      cursor: null,
      items: [pageItems[0]!],
      nextCursor: firstHash,
    }),
  },
  {
    snapshotId,
    snapshotRevision: 1,
    snapshotFixedAt: fixedAt,
    combinedDigest: digest,
    contentDigest,
    cursor: firstHash,
    items: [pageItems[1]!],
    nextCursor: null,
    pageDigest: inventorySnapshotPageDigest({
      snapshotId,
      snapshotFixedAt: fixedAt,
      contentDigest,
      cursor: firstHash,
      items: [pageItems[1]!],
      nextCursor: null,
    }),
  },
];

function executor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("mirrorInventoryBundle", () => {
  it("does not stage a manifest that arrives after its selection lease retires", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const pendingManifest = deferred<InventoryBundleManifest>();
    let current = true;
    const request = mirrorInventoryBundle(
      {
        get: async <T>(path: string) => {
          if (path.endsWith("/manifest")) return pendingManifest.promise as Promise<T>;
          return (path.includes("cursor=") ? pages[1] : pages[0]) as T;
        },
      },
      exec,
      inventoryId,
      { isCurrent: () => current },
    );

    current = false;
    pendingManifest.resolve(manifest);

    await expect(request).resolves.toBe(false);
    await expect(readInventoryMirrorState(exec, inventoryId)).resolves.toBeNull();
  });

  it("does not ingest or publish a final page that arrives after its selection lease retires", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const pendingPage = deferred<InventoryBundlePage>();
    const finalPage: InventoryBundlePage = {
      ...pages[0]!,
      items: pageItems,
      nextCursor: null,
      pageDigest: inventorySnapshotPageDigest({
        snapshotId,
        snapshotFixedAt: fixedAt,
        contentDigest,
        cursor: null,
        items: pageItems,
        nextCursor: null,
      }),
    };
    let current = true;
    let pageRequested!: () => void;
    const pageStarted = new Promise<void>((resolve) => {
      pageRequested = resolve;
    });
    const request = mirrorInventoryBundle(
      {
        get: async <T>(path: string) => {
          if (path.endsWith("/manifest")) return manifest as T;
          pageRequested();
          return pendingPage.promise as Promise<T>;
        },
      },
      exec,
      inventoryId,
      { isCurrent: () => current },
    );
    await pageStarted;

    current = false;
    pendingPage.resolve(finalPage);

    await expect(request).resolves.toBe(false);
    await expect(readInventoryMirrorState(exec, inventoryId)).resolves.toMatchObject({
      activeSnapshotId: null,
      stagedCodeCount: 0,
    });
  });

  it("continues from the durable cursor after a process restart and publishes only at completion", async () => {
    const exec = executor();
    await applyMigrations(exec);
    let failAfterFirstPage = true;
    const requests: string[] = [];
    const get: Pick<StationClient, "get">["get"] = async <T>(path: string) => {
      requests.push(path);
      let response: unknown;
      if (path.endsWith("/manifest")) response = manifest;
      else if (path.includes("cursor=")) {
        if (failAfterFirstPage) throw new Error("network interrupted");
        response = pages[1];
      } else response = pages[0];
      return response as T;
    };

    await expect(mirrorInventoryBundle({ get }, exec, inventoryId)).rejects.toThrow(
      "network interrupted",
    );
    expect(await readInventoryMirrorState(exec, inventoryId)).toMatchObject({
      activeSnapshotId: null,
      nextCursor: firstHash,
      stagedCodeCount: 1,
    });

    failAfterFirstPage = false;
    await expect(mirrorInventoryBundle({ get }, exec, inventoryId)).resolves.toBe(true);
    expect(await readInventoryMirrorState(exec, inventoryId)).toMatchObject({
      activeSnapshotId: snapshotId,
      stagedSnapshotId: null,
    });
    expect(requests.at(-1)).toContain(`cursor=${firstHash}`);
  });

  it("strictly rejects malformed network JSON and a mismatched requested inventory", async () => {
    const malformed = [
      { ...manifest, inventoryId: "99999999-9999-4999-8999-999999999999" },
      { ...manifest, unexpected: true },
      { ...manifest, inventoryNumber: "" },
      { ...manifest, productId: "not-a-uuid" },
      { ...manifest, mode: "scan" },
      { ...manifest, boxCapacity: 0 },
      { ...manifest, limits: { ...manifest.limits, codePageSize: 199 } },
      {
        ...manifest,
        mode: "repack",
        boxLabelTemplate: {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Короб",
          spec: { widthMm: 5, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
        },
        sscc: {
          allocationOrder: 1,
          issuerPrefix: "460000009",
          extensionDigit: 0,
          fromSerial: 1,
          toSerial: 2000,
          consumedThroughSerial: 10,
        },
      },
      {
        ...manifest,
        mode: "repack",
        boxLabelTemplate: {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Короб",
          spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
        },
        sscc: {
          issuerPrefix: "460000009",
          extensionDigit: 0,
          fromSerial: 1,
          toSerial: 2000,
          consumedThroughSerial: 10,
        },
        ssccRevokedFrom: [1],
        ssccRevokedBlocks: [],
      },
    ];
    for (const response of malformed) {
      const exec = executor();
      await applyMigrations(exec);
      await expect(
        mirrorInventoryBundle({ get: async <T>() => response as T }, exec, inventoryId),
      ).rejects.toThrow();
    }

    const exec = executor();
    await applyMigrations(exec);
    let request = 0;
    await expect(
      mirrorInventoryBundle(
        {
          get: async <T>() => {
            request += 1;
            return (request === 1 ? manifest : { ...pages[0], unexpected: true }) as T;
          },
        },
        exec,
        inventoryId,
      ),
    ).rejects.toThrow("Invalid station inventory bundle page");

    const itemExec = executor();
    await applyMigrations(itemExec);
    request = 0;
    await expect(
      mirrorInventoryBundle(
        {
          get: async <T>() => {
            request += 1;
            return (
              request === 1 ? manifest : { ...pages[0], items: [{ ...pageItems[0], serial: 7 }] }
            ) as T;
          },
        },
        itemExec,
        inventoryId,
      ),
    ).rejects.toThrow("Invalid station inventory bundle page");
  });
});
