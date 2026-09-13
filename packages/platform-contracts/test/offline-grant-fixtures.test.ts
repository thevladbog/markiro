import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portable signed offline fixtures", () => {
  it("verifies recorded original-byte signatures and deterministic vector definitions", () => {
    expect(() =>
      execFileSync(process.execPath, ["tools/generate-offline-grant-fixtures.mjs", "--check"], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
  it("ships identical TS and Kotlin vectors", () => {
    expect(readFileSync("fixtures/offline-grants-v1.json", "utf8")).toBe(
      readFileSync("../../apps/handheld/app/src/test/resources/offline-grants-v1.json", "utf8"),
    );
  });
});
