import { describe, expect, it } from "vitest";

import {
  inventorySnapshotContentDigest,
  inventorySnapshotPageDigest,
  parseStationInventoryBundleManifest,
  parseStationInventoryBundlePage,
} from "../src/index.js";

const item = {
  codeHash: "066e15060b18b753ddffa6a92d9d2ce2366b5fc3c704d6d61c89bb77740b47ff",
  canonicalRaw: "010460000000001521SERIAL-B",
  gtin14: "04600000000015",
  serial: "SERIAL-B",
  sourceStatus: "INTRODUCED" as const,
  sourceState: null,
  sourceProductionDate: "2026-08-01",
  parentSscc: null,
  expected: true,
  protected: false,
};

const manifest = {
  inventoryId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "INV-1",
  snapshotId: "22222222-2222-4222-8222-222222222222",
  snapshotRevision: 1 as const,
  snapshotFixedAt: "2026-08-25T01:02:03.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 1,
  productId: "33333333-3333-4333-8333-333333333333",
  productName: "Сидр",
  gtin14: "04600000000015",
  boxCapacity: 12,
  mode: "check" as const,
  lineId: "44444444-4444-4444-8444-444444444444",
  lineName: "Линия 1",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplate: null,
  limits: {
    codePageSize: 200 as const,
    eventBatchSize: 100 as const,
    progressPageSize: 200 as const,
  },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

describe("station inventory bundle contract", () => {
  it("derives stable content and page proofs over every immutable row field", () => {
    expect(inventorySnapshotContentDigest([item])).toBe(
      "4e966ef1bc339ad9768627e7b38af49b3667610d44298a4be4751b16edabc573",
    );
    expect(
      inventorySnapshotPageDigest({
        snapshotId: manifest.snapshotId,
        snapshotFixedAt: manifest.snapshotFixedAt,
        contentDigest: manifest.contentDigest,
        cursor: null,
        items: [item],
        nextCursor: null,
      }),
    ).toBe("8d6b3eda03dc098d6b16fc7ce6c849a2c3756a7357043c7de3f1867a348aad75");

    expect(() => inventorySnapshotContentDigest([item, item])).toThrow("strict code-hash order");
  });

  it("strictly parses the complete manifest and page and rejects unknown fields", () => {
    expect(parseStationInventoryBundleManifest(manifest)).toEqual(manifest);
    expect(() => parseStationInventoryBundleManifest({ ...manifest, unexpected: true })).toThrow(
      "Invalid station inventory bundle manifest",
    );

    const page = {
      snapshotId: manifest.snapshotId,
      snapshotRevision: 1,
      snapshotFixedAt: manifest.snapshotFixedAt,
      combinedDigest: manifest.combinedDigest,
      contentDigest: manifest.contentDigest,
      cursor: null,
      items: [item],
      nextCursor: null,
      pageDigest: "c".repeat(64),
    };
    expect(parseStationInventoryBundlePage(page)).toEqual(page);
    expect(() =>
      parseStationInventoryBundlePage({ ...page, items: [{ ...item, extra: 1 }] }),
    ).toThrow("Invalid station inventory bundle page");
  });

  it("fails closed on unsafe repack SSCC structures", () => {
    const repack = {
      ...manifest,
      mode: "repack" as const,
      boxLabelTemplate: {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Короб",
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
      },
      sscc: {
        allocationOrder: 2,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 2000,
        consumedThroughSerial: 10,
      },
      ssccRevokedFrom: [],
      ssccRevokedBlocks: [{ allocationOrder: 1, fromSerial: 1, toSerial: 2000 }],
    };
    expect(parseStationInventoryBundleManifest(repack)).toEqual(repack);
    expect(() =>
      parseStationInventoryBundleManifest({
        ...repack,
        sscc: { ...repack.sscc, consumedThroughSerial: 2001 },
      }),
    ).toThrow("Invalid station inventory bundle manifest");
    expect(() =>
      parseStationInventoryBundleManifest({
        ...repack,
        ssccRevokedBlocks: [{ allocationOrder: 2, fromSerial: 1, toSerial: 2000 }],
      }),
    ).toThrow("Invalid station inventory bundle manifest");
    expect(() =>
      parseStationInventoryBundleManifest({
        ...repack,
        ssccRevokedBlocks: [{ allocationOrder: 3, fromSerial: 1, toSerial: 2000 }],
      }),
    ).toThrow("Invalid station inventory bundle manifest");
  });
});
