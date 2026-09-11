import { describe, expect, it } from "vitest";
import {
  legacyCommercialProjection,
  isCommercialV2,
} from "../src/platform-http/commercial-version";
describe("negotiated commercial representation", () => {
  it("preserves opaque historical snapshots and audit metadata literally", () => {
    const before = { subject: "original text", maxLines: 0 };
    expect(legacyCommercialProjection({ before, after: before, sellerSnapshot: before })).toEqual({
      before,
      after: before,
      sellerSnapshot: before,
    });
  });
  it("never changes zero to unlimited and projects only introduced metadata", () => {
    expect(() => legacyCommercialProjection({ plan: { maxLines: 0 } })).toThrow();
    expect(
      legacyCommercialProjection({
        subject: null,
        documentNameRu: null,
        plan: { maxLines: null },
        other: 1,
      }),
    ).toEqual({ plan: { maxLines: null }, other: 1 });
  });
  it("requires exactly the explicit supported version", () => {
    expect(isCommercialV2({ headers: {} })).toBe(false);
    expect(isCommercialV2({ headers: { "x-markiro-commercial-version": "2" } })).toBe(true);
    expect(() => isCommercialV2({ headers: { "x-markiro-commercial-version": "3" } })).toThrow();
  });
});
