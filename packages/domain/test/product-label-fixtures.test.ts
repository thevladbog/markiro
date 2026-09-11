import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProductLabelFixtures } from "../src/product-labels/fixtures.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/product-label-fixtures.json",
    import.meta.url,
  ),
);

describe("product label fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    // Regenerate with `pnpm --filter @markiro/domain fixtures:product-labels`.
    // Failing here means the Kotlin port is pinned to something this package
    // no longer produces.
    expect(readFileSync(fixturePath, "utf8")).toBe(
      JSON.stringify(buildProductLabelFixtures(), null, 2) + "\n",
    );
  });

  it("cover both policies, every refusal, and every terminal status", () => {
    const fixtures = buildProductLabelFixtures();
    const statuses = new Set(fixtures.projection.map((c) => c.projection?.status));
    for (const status of ["prepared", "sending", "awaiting_verification", "completed", "attention"])
      expect(statuses, status).toContain(status);
    expect(fixtures.projection.filter((c) => c.invalidAt !== null).length).toBeGreaterThanOrEqual(
      5,
    );
    expect(new Set(fixtures.projection.map((c) => c.verification))).toEqual(
      new Set(["none", "required"]),
    );
    expect(new Set(fixtures.compare.map((c) => c.result))).toEqual(
      new Set(["match", "mismatch", "invalid"]),
    );
  });

  it("prove the crypto tail is part of the comparison", () => {
    // The identity hash the scan loop uses would call this the same code. This
    // comparison must not, or a duplicate of a different unit would verify.
    const fixtures = buildProductLabelFixtures();
    const stripped = fixtures.compare.find((c) => c.name.includes("crypto tail"));
    expect(stripped?.result).toBe("invalid");
  });

  it("carry an unknown delivery resolved by a scan under the none policy", () => {
    // The one case a naive port drops: verification is only wired up for the
    // `required` policy, and this transition exists for both.
    const fixtures = buildProductLabelFixtures();
    const resolved = fixtures.projection.find(
      (c) => c.verification === "none" && c.projection?.verificationOutcome === "verified",
    );
    expect(resolved, "no none-policy job completed by a scan").toBeDefined();
    expect(resolved!.projection!.status).toBe("completed");
    expect(resolved!.invalidAt).toBeNull();
  });
});
