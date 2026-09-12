import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildValidationReprocessingFixtures } from "../src/validation-reprocessing-fixtures.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/validation-reprocessing-fixtures.json",
    import.meta.url,
  ),
);

describe("validation reprocessing fixture shared with the handheld", () => {
  it("matches the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    const expected = JSON.stringify(buildValidationReprocessingFixtures(), null, 2) + "\n";
    expect(committed).toBe(expected);
  });
});
