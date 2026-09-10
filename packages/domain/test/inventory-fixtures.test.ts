import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInventoryFixtures } from "../src/inventory/inventory-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/inventory-fixtures.json", import.meta.url),
);

describe("inventory fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed).toBe(JSON.stringify(buildInventoryFixtures(), null, 2) + "\n");
  });

  it("cover every classification kind, both box outcomes and all three source-date kinds", () => {
    const fixtures = buildInventoryFixtures();
    const kinds = new Set(fixtures.classify.map((c) => c.expected.kind));
    for (const kind of [
      "expected",
      "protected",
      "known-ineligible",
      "unknown",
      "duplicate",
      "invalid",
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(
      fixtures.classify.some(
        (c) => c.expected.kind === "duplicate" && c.expected.scanKind === "known_box",
      ),
    ).toBe(true);
    expect(
      fixtures.classify.some(
        (c) => c.expected.kind === "unknown" && c.expected.scanKind === "old_box",
      ),
    ).toBe(true);
    const dateKinds = new Set(fixtures.classify.map((c) => c.sourceDate.kind));
    expect([...dateKinds].sort()).toEqual(["mixed", "none", "single"]);
    expect(fixtures.batchDigest.length).toBeGreaterThanOrEqual(3);
  });
});
