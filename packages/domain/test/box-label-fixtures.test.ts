import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBoxLabelFixtures } from "../src/labels/box-label-fixtures.js";
import { withTimeZone } from "./support/timezone.js";
const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/box-label-fixtures.json", import.meta.url),
);

/**
 * Each case pins its own zone while it is built, so this reproduces the same
 * bytes on a developer's machine and in CI without an outer pin.
 */
function generate() {
  return buildBoxLabelFixtures(withTimeZone);
}

describe("box label fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    // Regenerate with `pnpm --filter @markiro/domain fixtures:box-labels`.
    // Failing here means the Kotlin port is pinned to something this package
    // no longer produces.
    expect(readFileSync(fixturePath, "utf8")).toBe(JSON.stringify(generate(), null, 2) + "\n");
  });

  it("cover both extension digits, every refusal code, and the calendar edges", () => {
    const fixtures = generate();
    expect(new Set(fixtures.sscc.map((c) => c.extensionDigit))).toContain(0);
    expect(new Set(fixtures.sscc.map((c) => c.extensionDigit))).toContain(1);
    expect(new Set(fixtures.sscc.filter((c) => c.error).map((c) => c.error))).toEqual(
      new Set(["SSCC_RANGE", "SSCC_PREFIX"]),
    );
    const names = fixtures.fields.map((c) => c.name).join(" ");
    for (const edge of ["leap day", "year boundary", "one-day shelf life"]) {
      expect(names, edge).toContain(edge);
    }
  });

  it("carry a case whose local day differs from the UTC one", () => {
    // Without it nothing exercises the fallback in a zone where the instant has
    // already rolled over, which is the case a naive port gets wrong.
    const shifted = generate().fields.find((c) => c.timeZone !== "UTC");
    expect(shifted, "no non-UTC case").toBeDefined();
    expect(shifted!.input.closedAt).toContain("2026-09-10");
    expect(shifted!.fields.date).toBe("11.09.2026");
  });
});
