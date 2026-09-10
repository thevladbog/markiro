import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { renderPlatformReport } from "../src/platform-reports/report-renderer";
import {
  applyReportPrivacy,
  type PlatformReportSource,
} from "../src/platform-reports/report-definitions";

const input: PlatformReportInput = {
  reportType: "shift_operators",
  tenantIds: ["tenant-a"],
  fromDate: "2026-09-01",
  toDate: "2026-09-01",
  timezone: "Europe/Moscow",
  periodBasis: "events",
  privacy: "identified",
};
const source: PlatformReportSource = {
  snapshotAt: new Date("2026-09-02T00:00:00Z"),
  columns: [
    "tenant_id",
    "shift_id",
    "operator_id",
    "operator_name",
    "gtin14",
    "accepted_scans",
    "first_event_at",
  ],
  rows: [
    {
      tenant_id: "tenant-a",
      shift_id: "shift-a",
      operator_id: "operator-real-id",
      operator_name: ' \t=HYPERLINK("evil")',
      gtin14: "00012345678901",
      accepted_scans: 2,
      first_event_at: "2026-09-01T06:00:00Z",
    },
  ],
  definitions: { accepted_scans: "ok scans" },
};

describe("platform report ZIP", () => {
  it("renders BOM CSV, CRLF, quotes formulas and preserves identifiers as text", () => {
    const report = renderPlatformReport(input, source);
    const files = unzipSync(report.body);
    const csv = strFromU8(files["data.csv"]!);
    expect([...files["data.csv"]!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("' \t=HYPERLINK");
    expect(csv).toContain("'00012345678901");
    expect(report.rowCount).toBe(1);
    expect(Object.keys(files).sort()).toEqual(["data.csv", "metadata.json"]);
  });
  it("pseudonymizes consistently and removes the operator filter from artifact parameters", () => {
    const parameters = {
      ...input,
      privacy: "pseudonymous" as const,
      operatorId: "00000000-0000-4000-8000-000000000001",
    };
    const safe = applyReportPrivacy(parameters, source);
    const files = unzipSync(renderPlatformReport(parameters, safe).body);
    const text = Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    expect(text).not.toContain("operator-real-id");
    expect(text).not.toContain(parameters.operatorId);
    expect(text).not.toContain("HYPERLINK");
    expect(text).toContain("operator-001");
  });
  it("aggregate artifacts exclude person columns and person timestamps", () => {
    const parameters = { ...input, privacy: "aggregate" as const };
    const safe = applyReportPrivacy(parameters, source);
    expect(safe.columns).not.toContain("operator_id");
    expect(safe.columns).not.toContain("first_event_at");
    const text = Object.values(unzipSync(renderPlatformReport(parameters, safe).body))
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    expect(text).not.toContain("operator-real-id");
    expect(text).not.toContain("06:00:00");
  });
  it("fails instead of truncating row or byte limits", () => {
    expect(() =>
      renderPlatformReport(input, {
        ...source,
        rows: Array.from({ length: 100001 }, () => source.rows[0]!),
      }),
    ).toThrow("REPORT_LIMIT_EXCEEDED");
    expect(() =>
      renderPlatformReport(input, {
        ...source,
        rows: [{ ...source.rows[0], operator_name: "x".repeat(32 * 1024 * 1024) }],
      }),
    ).toThrow("REPORT_LIMIT_EXCEEDED");
  });
});
