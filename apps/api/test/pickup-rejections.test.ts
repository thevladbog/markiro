import { describe, expect, it } from "vitest";
import { publicScanRejectionCodes } from "../src/modules/pickup-rejections/pickup-rejections.service";

describe("pickup rejection public codes", () => {
  it("filters marker-only metadata and preserves loose and box lines", () => {
    expect(
      publicScanRejectionCodes([
        { rawKm: "not-a-km", reason: "not_km" },
        { source: "request", version: 2, terminalReason: "order_rejected" },
        {
          source: "box",
          sscc: "346006820000000014",
          bottleCount: 12,
          reason: "duplicate",
        },
      ]),
    ).toEqual([
      { rawKm: "not-a-km", reason: "not_km" },
      {
        source: "box",
        sscc: "346006820000000014",
        bottleCount: 12,
        reason: "duplicate",
      },
    ]);
    expect(
      publicScanRejectionCodes([
        { source: "request", version: 2, terminalReason: "unknown_badge" },
      ]),
    ).toEqual([]);
  });
});
