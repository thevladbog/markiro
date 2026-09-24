import { describe, expect, it } from "vitest";
import { boxMembershipDigestV1 } from "../src/sync/box-reconciliation.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("box membership digest v1", () => {
  it("is independent of input order", () => {
    expect(boxMembershipDigestV1([B, A])).toBe(boxMembershipDigestV1([A, B]));
  });

  it("changes when membership changes", () => {
    expect(boxMembershipDigestV1([A])).not.toBe(boxMembershipDigestV1([A, B]));
  });

  it("rejects invalid and duplicate code hashes", () => {
    expect(() => boxMembershipDigestV1([A, A])).toThrow(/duplicate/);
    expect(() => boxMembershipDigestV1(["not-a-hash"])).toThrow(/hash/);
  });

  it("has a stable empty-set digest", () => {
    expect(boxMembershipDigestV1([])).toBe(
      "5a57cbf1b6092eaed17eecefca5c9aaf5c14614ac182f87ca1fbf240aa028494",
    );
  });
});
