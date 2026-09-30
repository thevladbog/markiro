import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_COLUMNS,
  COMMERCIAL_DEFINITIONS,
} from "../src/platform-reports/commercial-report-source";
import { EVIDENCE_COMMON_DEFINITIONS } from "../src/platform-reports/report-definitions";
import {
  QUALITY_COLUMNS,
  QUALITY_DEFINITIONS,
} from "../src/platform-reports/quality-report-source";
import { USAGE_COLUMNS, USAGE_DEFINITIONS } from "../src/platform-reports/usage-report-source";

function undefinedColumns(columns: readonly string[], specific: Record<string, string>) {
  return columns.filter((column) => !EVIDENCE_COMMON_DEFINITIONS[column] && !specific[column]);
}

describe("evidence report definitions", () => {
  it("defines every usage column", () => {
    expect(undefinedColumns(USAGE_COLUMNS, USAGE_DEFINITIONS)).toEqual([]);
  });

  it("defines every quality column", () => {
    expect(undefinedColumns(QUALITY_COLUMNS, QUALITY_DEFINITIONS)).toEqual([]);
  });

  it("defines every commercial column", () => {
    expect(undefinedColumns(COMMERCIAL_COLUMNS, COMMERCIAL_DEFINITIONS)).toEqual([]);
  });

  it("states the aggregate-mode grain, where the tenant dimension is removed", () => {
    expect(EVIDENCE_COMMON_DEFINITIONS.grain).toMatch(/aggregate/i);
  });
});
