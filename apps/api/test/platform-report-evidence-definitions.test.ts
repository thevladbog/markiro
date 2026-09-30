import { describe, expect, it } from "vitest";
import { EVIDENCE_COMMON_DEFINITIONS } from "../src/platform-reports/report-definitions";
import { USAGE_COLUMNS, USAGE_DEFINITIONS } from "../src/platform-reports/usage-report-source";

function undefinedColumns(columns: readonly string[], specific: Record<string, string>) {
  return columns.filter((column) => !EVIDENCE_COMMON_DEFINITIONS[column] && !specific[column]);
}

describe("evidence report definitions", () => {
  it("defines every usage column", () => {
    expect(undefinedColumns(USAGE_COLUMNS, USAGE_DEFINITIONS)).toEqual([]);
  });

  it("states the aggregate-mode grain, where the tenant dimension is removed", () => {
    expect(EVIDENCE_COMMON_DEFINITIONS.grain).toMatch(/aggregate/i);
  });
});
