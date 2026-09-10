import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLabelFixtures } from "../src/labels/label-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/label-fixtures.json", import.meta.url),
);

describe("label fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", async () => {
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed).toBe(JSON.stringify(await buildLabelFixtures(), null, 2) + "\n");
  });

  it("cover every element kind and both resolutions without leaking an image into the byte-identical group", async () => {
    const fixtures = await buildLabelFixtures();
    const kinds = new Set(
      fixtures.byteIdentical.flatMap((f) => f.spec.elements.map((e) => e.kind)),
    );
    for (const kind of ["text", "field", "barcode", "line", "box"]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(new Set(fixtures.byteIdentical.map((f) => f.spec.dpi))).toEqual(new Set([203, 300]));
    for (const fixture of fixtures.byteIdentical) {
      expect(fixture.zpl, fixture.name).not.toContain("^GFA");
      expect(fixture.tspl, fixture.name).not.toContain("BITMAP");
    }
    expect(fixtures.structural.length).toBeGreaterThanOrEqual(4);
    for (const fixture of fixtures.structural) {
      expect(fixture.rasterCalls.length, fixture.name).toBeGreaterThan(0);
    }
  });
});
