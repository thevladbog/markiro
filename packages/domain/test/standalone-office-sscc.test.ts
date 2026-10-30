import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSscc, parseScannedSscc } from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../apps/standalone/proto/fixtures/office-pallet-sscc.json", import.meta.url),
    "utf8",
  ),
) as {
  normalization: { raw: string; sscc: string | null }[];
  allocation: { prefix: string; serial: number; sscc: string }[];
};
describe("office host SSCC contract", () => {
  it("keeps Rust normalization and issuance pinned to domain results", () => {
    for (const row of fixture.normalization)
      expect(parseScannedSscc(row.raw.trim())).toBe(row.sscc);
    for (const row of fixture.allocation)
      expect(buildSscc(1, row.prefix, row.serial)).toBe(row.sscc);
  });
});
