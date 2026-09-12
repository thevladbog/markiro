import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSyncLimitsFixtures } from "../src/sync/limits-fixtures.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/sync-limits-fixtures.json",
    import.meta.url,
  ),
);

describe("sync limits fixture shared with the handheld", () => {
  it("matches the committed JSON byte for byte", () => {
    const committed = readFileSync(fixturePath, "utf8");
    const expected = JSON.stringify(buildSyncLimitsFixtures(), null, 2) + "\n";
    expect(committed).toBe(expected);
  });
});
