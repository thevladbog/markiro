import { describe, expect, it, vi } from "vitest";
import type { KioskBootstrapDto } from "../src/api/types.js";
import { resolveBoxScan } from "../src/session/box-resolution.js";

const bootstrap = {
  products: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      gtin14: "04600682000013",
      name: "Вода",
      unitPrice: "42.00",
      egaisCode: null,
    },
  ],
} as unknown as KioskBootstrapDto;
const meta = {
  binding: { serverUrl: "https://kiosk.example", kioskId: "kiosk-1" },
  credentialGeneration: "33333333-3333-4333-8333-333333333333",
  version: "7",
  generatedAt: "2026-08-13T10:00:00.000Z",
};
const row = {
  sscc: "346006820000000021",
  boxId: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  bottleCount: 12,
  contentKeys: ["a", "b"],
  updatedAt: "2026-08-13T10:00:00.000Z",
  version: "7",
};

describe("resolveBoxScan", () => {
  it("resolves only from the active local registry and carries local overlap keys", async () => {
    const lookup = vi.fn(async () => row);
    await expect(
      resolveBoxScan(
        { sscc: row.sscc, bootstrap, registryAge: "warn" },
        { readMeta: async () => meta, lookup },
      ),
    ).resolves.toEqual({
      kind: "resolved",
      box: {
        kind: "box",
        boxId: row.boxId,
        sscc: row.sscc,
        productId: row.productId,
        name: "Вода",
        bottleCount: 12,
        unitPrice: "42.00",
        contentKeys: ["a", "b"],
        registryVersion: "7",
      },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not lookup online or active rows when registry freshness blocks", async () => {
    const lookup = vi.fn(async () => row);
    await expect(
      resolveBoxScan(
        { sscc: row.sscc, bootstrap, registryAge: "blocked" },
        { readMeta: async () => meta, lookup },
      ),
    ).resolves.toEqual({ kind: "rejected", notice: "registry-blocked" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable and unknown local registry results", async () => {
    await expect(
      resolveBoxScan(
        { sscc: row.sscc, bootstrap, registryAge: "fresh" },
        { readMeta: async () => null, lookup: vi.fn() },
      ),
    ).resolves.toEqual({ kind: "rejected", notice: "registry-unavailable" });
    await expect(
      resolveBoxScan(
        { sscc: row.sscc, bootstrap, registryAge: "fresh" },
        { readMeta: async () => meta, lookup: async () => null },
      ),
    ).resolves.toEqual({ kind: "rejected", notice: "unknown-box" });
  });
});
