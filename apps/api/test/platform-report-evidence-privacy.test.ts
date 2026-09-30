import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { platformReportTypeSchema, type PlatformReportInput } from "@markiro/platform-contracts";
import {
  applyReportPrivacy,
  REPORT_DEFINITIONS_VERSION,
  type PlatformReportSource,
} from "../src/platform-reports/report-definitions";
import { renderPlatformReport } from "../src/platform-reports/report-renderer";

const identified: PlatformReportInput = {
  reportType: "usage",
  tenantIds: ["tenant-b-real", "tenant-a-real"],
  fromDate: "2026-09-01",
  toDate: "2026-09-02",
  timezone: "Europe/Moscow",
  periodBasis: "events",
  privacy: "identified",
};
const source: PlatformReportSource = {
  snapshotAt: new Date("2026-09-03T00:00:00Z"),
  columns: ["tenant_id", "tenant_name", "day", "accepted_units", "active_lines"],
  rows: [
    {
      tenant_id: "tenant-b-real",
      tenant_name: "Beta Factory",
      day: "2026-09-01",
      accepted_units: 5,
      active_lines: 1,
    },
    {
      tenant_id: "tenant-a-real",
      tenant_name: "Alpha Factory",
      day: "2026-09-01",
      accepted_units: 7,
      active_lines: 2,
    },
  ],
  definitions: {
    tenant_id: "tenant identifier",
    tenant_name: "tenant name",
    accepted_units: "accepted units",
  },
};

function artifact(input: PlatformReportInput, raw: PlatformReportSource) {
  const files = unzipSync(renderPlatformReport(input, raw).body);
  const text = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join("\n");
  return { files, text, metadata: JSON.parse(strFromU8(files["metadata.json"]!)) };
}

describe("evidence report privacy", () => {
  it("labels tenants in ascending id order and leaves no real tenant text in any file", () => {
    const input = { ...identified, privacy: "pseudonymous" as const };
    const safe = applyReportPrivacy(input, source);
    expect(safe.rows.map((row) => [row.tenant_id, row.tenant_name])).toEqual([
      ["tenant-02", "tenant-02"],
      ["tenant-01", "tenant-01"],
    ]);
    const { text, metadata } = artifact(input, source);
    for (const secret of ["tenant-a-real", "tenant-b-real", "Alpha Factory", "Beta Factory"])
      expect(text).not.toContain(secret);
    expect(metadata.parameters).not.toHaveProperty("tenantIds");
    expect(metadata.parameters.tenantCount).toBe(2);
  });

  it("aggregate removes tenant columns, sums days and drops their definitions", () => {
    const input = { ...identified, privacy: "aggregate" as const };
    const safe = applyReportPrivacy(input, source);
    expect(safe.columns).toEqual(["day", "accepted_units", "active_lines"]);
    expect(safe.rows).toEqual([{ day: "2026-09-01", accepted_units: 12, active_lines: 3 }]);
    expect(safe.definitions).toEqual({ accepted_units: "accepted units" });
    const { text, metadata } = artifact(input, source);
    for (const secret of ["tenant-a-real", "tenant-b-real", "Alpha Factory", "Beta Factory"])
      expect(text).not.toContain(secret);
    expect(metadata.parameters).not.toHaveProperty("tenantIds");
  });

  it("replaces tenant_name in pseudonymous mode even when tenant_id is not a column", () => {
    const input = { ...identified, privacy: "pseudonymous" as const };
    const nameOnly: PlatformReportSource = {
      snapshotAt: source.snapshotAt,
      columns: ["tenant_name", "day", "accepted_units"],
      rows: [
        { tenant_name: "Alpha Factory", day: "2026-09-01", accepted_units: 7 },
        { tenant_name: "Beta Factory", day: "2026-09-01", accepted_units: 5 },
      ],
      definitions: { tenant_name: "tenant name", accepted_units: "accepted units" },
    };
    const safe = applyReportPrivacy(input, nameOnly);
    expect(safe.columns).toEqual(["tenant_name", "day", "accepted_units"]);
    const text = JSON.stringify(safe.rows);
    expect(text).not.toContain("Alpha Factory");
    expect(text).not.toContain("Beta Factory");
    expect(safe.rows.map((row) => row.accepted_units)).toEqual([7, 5]);
  });

  it("aggregate orders days ascending, not by first appearance across tenants", () => {
    const input = { ...identified, privacy: "aggregate" as const };
    const interleaved: PlatformReportSource = {
      ...source,
      rows: [
        {
          tenant_id: "tenant-a-real",
          tenant_name: "Alpha Factory",
          day: "2026-09-01",
          accepted_units: 1,
          active_lines: 1,
        },
        {
          tenant_id: "tenant-a-real",
          tenant_name: "Alpha Factory",
          day: "2026-09-03",
          accepted_units: 3,
          active_lines: 3,
        },
        {
          tenant_id: "tenant-b-real",
          tenant_name: "Beta Factory",
          day: "2026-09-02",
          accepted_units: 20,
          active_lines: 2,
        },
      ],
    };
    const safe = applyReportPrivacy(input, interleaved);
    expect(safe.rows).toEqual([
      { day: "2026-09-01", accepted_units: 1, active_lines: 1 },
      { day: "2026-09-02", accepted_units: 20, active_lines: 2 },
      { day: "2026-09-03", accepted_units: 3, active_lines: 3 },
    ]);
  });

  it("identified keeps names and tenant ids", () => {
    const { text, metadata } = artifact(identified, source);
    expect(text).toContain("Alpha Factory");
    expect(metadata.parameters.tenantIds).toEqual(identified.tenantIds);
  });

  it.each(["pseudonymous", "aggregate"] as const)(
    "is idempotent in %s mode because the renderer applies privacy a second time",
    (privacy) => {
      const input = { ...identified, privacy };
      const once = applyReportPrivacy(input, source);
      expect(applyReportPrivacy(input, once)).toEqual(once);
    },
  );

  it("leaves the tenant columns of the existing report types untouched", () => {
    const input: PlatformReportInput = {
      ...identified,
      reportType: "shifts",
      privacy: "pseudonymous",
    };
    const safe = applyReportPrivacy(input, source);
    expect(safe.rows.map((row) => row.tenant_id)).toEqual(["tenant-b-real", "tenant-a-real"]);
    expect(artifact(input, source).metadata.parameters.tenantIds).toEqual(identified.tenantIds);
  });

  it("writes definitionsVersion and the SHA-256 of the exact data.csv bytes", () => {
    const { files, metadata } = artifact(identified, source);
    expect(metadata.definitionsVersion).toBe(REPORT_DEFINITIONS_VERSION.usage);
    expect(metadata.dataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.dataSha256).toBe(createHash("sha256").update(files["data.csv"]!).digest("hex"));
  });

  it("versions every report type", () => {
    expect(Object.keys(REPORT_DEFINITIONS_VERSION).sort()).toEqual(
      [...platformReportTypeSchema.options].sort(),
    );
  });
});
