import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildKmFixtures } from "../src/gs1/km-fixtures.js";

const fixturePath = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/km-fixtures.json", import.meta.url),
);

describe("KM fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    const expected = JSON.stringify(buildKmFixtures(), null, 2) + "\n";
    expect(committed).toBe(expected);
  });

  it("cover every parser error code at least once", () => {
    const errors = new Set(
      buildKmFixtures()
        .parse.map((fixture) => ("error" in fixture.expected ? fixture.expected.error : null))
        .filter((code): code is string => code !== null),
    );
    for (const code of [
      "KM_EMPTY",
      "KM_NO_GTIN",
      "KM_BAD_GTIN",
      "KM_NO_SERIAL",
      "KM_BAD_AI",
      "KM_EMPTY_AI",
      "KM_DUPLICATE_AI",
      "KM_BAD_ENCODING",
      "KM_BAD_CONTROL",
      "KM_TOO_LONG",
      "GTIN_INVALID",
    ]) {
      expect(errors, code).toContain(code);
    }
  });
});
