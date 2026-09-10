import { describe, expect, it } from "vitest";

import { platformCapabilitiesForRole, platformReportContracts } from "../src/index.js";

const tenantA = "tenant-a";
const tenantB = "tenant-b";
const uuid = "11111111-1111-4111-8111-111111111111";
const valid = {
  reportType: "shifts",
  tenantIds: [tenantA, tenantB],
  fromDate: "2026-01-01",
  toDate: "2026-12-31",
  timezone: "Europe/Moscow",
  periodBasis: "events",
  privacy: "identified",
  idempotencyKey: uuid,
} as const;

describe("platform operational report contracts", () => {
  it("requires tenant-scoped searchable paginated options with a bounded kind", () => {
    expect(
      platformReportContracts.options.query.parse({ tenantIds: "tenant-a", kind: "lines" }),
    ).toEqual({ tenantIds: ["tenant-a"], kind: "lines", limit: 50, offset: 0 });
    for (const query of [
      { kind: "lines" },
      { tenantIds: [tenantA], kind: "credentials" },
      { tenantIds: [tenantA], kind: "lines", search: "a".repeat(201) },
    ])
      expect(platformReportContracts.options.query.safeParse(query).success).toBe(false);
  });
  it("accepts a strict create request and exposes only the safe report DTO", () => {
    expect(platformReportContracts.create.body.parse(valid)).toEqual(valid);

    const report = platformReportContracts.create.response.parse({
      id: uuid,
      parameters: (({ idempotencyKey: _, ...parameters }) => parameters)(valid),
      status: "queued",
      createdAt: "2026-09-10T08:00:00Z",
      snapshotAt: null,
      completedAt: null,
      expiresAt: "2026-09-17T08:00:00Z",
      errorCode: null,
      rowCount: null,
      byteSize: null,
      filename: null,
    });

    expect(report).not.toHaveProperty("objectKey");
    expect(
      platformReportContracts.create.response.safeParse({ ...report, objectKey: "private/key.zip" })
        .success,
    ).toBe(false);
    for (const errorCode of ["database connection password leaked", "REPORT_UNKNOWN_FAILURE"]) {
      expect(
        platformReportContracts.create.response.safeParse({ ...report, errorCode }).success,
      ).toBe(false);
    }
  });

  it.each([
    [{ tenantIds: [] }, "empty tenant selection"],
    [{ tenantIds: [tenantA, tenantA] }, "duplicate tenant selection"],
    [
      { tenantIds: Array.from({ length: 11 }, (_, index) => `tenant-${index}`) },
      "more than ten tenants",
    ],
    [{ fromDate: "2026-02-30" }, "invalid calendar date"],
    [{ timezone: "Mars/Olympus" }, "invalid IANA timezone"],
    [{ timezone: "+03:00" }, "numeric timezone offset"],
    [{ fromDate: "2026-01-02", toDate: "2026-01-01" }, "reversed dates"],
    [{ fromDate: "2025-01-01", toDate: "2026-01-02" }, "more than 366 inclusive days"],
    [{ unexpected: true }, "unknown request key"],
  ])("rejects %s (%s)", (override, _description) => {
    expect(platformReportContracts.create.body.safeParse({ ...valid, ...override }).success).toBe(
      false,
    );
  });

  it("rejects filters and period bases irrelevant to the selected template", () => {
    const invalid = [
      { reportType: "commerceml", lineId: uuid },
      { reportType: "commerceml", productId: uuid },
      { reportType: "commerceml", gtin14: "04601234567890" },
      { reportType: "commerceml", operatorId: uuid },
      { reportType: "commerceml", status: "ready" },
      { reportType: "shifts", outcome: "ok" },
      { reportType: "inventories", operatorId: uuid },
      { reportType: "summary", operatorId: uuid },
      { reportType: "summary", status: "closed" },
      { reportType: "shifts", status: "completed" },
      { reportType: "inventories", status: "active" },
      { reportType: "inventories", periodBasis: "production_date" },
      { reportType: "summary", periodBasis: "production_date" },
      { reportType: "commerceml", periodBasis: "production_date" },
      { privacy: "aggregate", operatorId: uuid },
    ];

    for (const override of invalid) {
      expect(platformReportContracts.create.body.safeParse({ ...valid, ...override }).success).toBe(
        false,
      );
    }
    const outcome = platformReportContracts.create.body.safeParse({ ...valid, outcome: "ok" });
    expect(outcome.error?.issues).toEqual([
      { code: "custom", path: ["outcome"], message: "Outcome is CommerceML-only" },
    ]);
    expect(
      platformReportContracts.create.body.safeParse({
        ...valid,
        reportType: "commerceml",
        outcome: "ok",
      }).success,
    ).toBe(true);
  });

  it("defines list and expiring-download response envelopes", () => {
    expect(platformReportContracts.list.response.parse({ items: [], nextOffset: null })).toEqual({
      items: [],
      nextOffset: null,
    });
    expect(
      platformReportContracts.download.response.parse({
        url: "https://objects.example.invalid/signed",
        filename: "reports.zip",
        expiresInSeconds: 300,
      }),
    ).toEqual({
      url: "https://objects.example.invalid/signed",
      filename: "reports.zip",
      expiresInSeconds: 300,
    });
    expect(
      platformReportContracts.download.response.safeParse({
        url: "https://objects.example.invalid/signed",
        filename: "reports.zip",
        expiresInSeconds: 301,
      }).success,
    ).toBe(false);
  });

  it("grants every report capability only to platform administrators", () => {
    const reportCapabilities = [
      "reports.read",
      "reports.create",
      "reports.download",
      "reports.identified",
    ];
    expect(platformCapabilitiesForRole.platform_admin).toEqual(
      expect.arrayContaining(reportCapabilities),
    );
    for (const role of ["support", "accountant"] as const) {
      for (const capability of reportCapabilities) {
        expect(platformCapabilitiesForRole[role]).not.toContain(capability);
      }
    }
  });
});
