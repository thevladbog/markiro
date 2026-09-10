import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBoxLabelFixtures } from "../src/labels/box-label-fixtures.js";
import { withTimeZone } from "./support/timezone.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/box-label-fixtures.json", import.meta.url),
);

/**
 * Generated the way the export script generates it — pinned to UTC, because one
 * case deliberately exercises `localIsoDate` and would otherwise produce a
 * different day on a developer's machine than in CI.
 */
function generate() {
  return withTimeZone("UTC", () => buildBoxLabelFixtures());
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

  it("pin the zone they were generated in, so the Kotlin reader can apply it", () => {
    // Without this the local-date case reproduces only on the machine that
    // wrote it, and the Kotlin test would fail for a reason nothing explains.
    expect(generate().timeZone).toBe("UTC");
  });
});
