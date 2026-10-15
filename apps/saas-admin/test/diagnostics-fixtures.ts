import type {
  StandaloneDiagnosticDetail,
  StandaloneDiagnosticsHistory,
  StandaloneDiagnosticsIngestResponse,
  StandaloneDiagnosticsOverview,
  StandaloneDiagnosticsStatistics,
} from "@markiro/platform-contracts";

export const DIAG_TENANT_ID = "11111111-2222-4333-8444-555555555555";
export const DIAG_HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const DIAG_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const month = (key: string, accepted: number) => ({
  month: key,
  shifts: {
    aggregation: 6,
    validation: 1,
    validationPrint: 0,
    fromOffice: 5,
    fromStation: 2,
    withPallets: 2,
  },
  scans: { accepted, duplicates: 64, rejected: 9 },
  boxes: { closed: 585, disassembled: 0, codes: accepted },
  pallets: { closed: 13, disassembled: 0 },
  exceptions: {
    boxUndo: 4,
    boxClear: 0,
    boxReprint: 2,
    boxDisassemble: 0,
    palletReprint: 0,
    palletDisassemble: 0,
  },
  conflicts: { late: 1, displaced: 0, reviewed: 0 },
  reprints: { warehouse: 0, unitLabel: 0 },
  disaggregationApplied: 0,
  syncRejected: 2,
});

export const DIAG_SUMMARY = {
  id: DIAG_ID,
  hostKey: DIAG_HOST_ID,
  siteId: "99999999-8888-4777-8666-555555555555",
  generatedAt: "2026-10-14T09:00:00.000Z",
  receivedAt: "2026-10-15T10:00:00.000Z",
  kid: "sup-d11c3182",
  payloadVersion: 2 as const,
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  pcRole: "host" as const,
  os: "Windows 11",
  arch: "x64",
  webview: "WebView2 130.0.2849.80",
  licenseState: "active",
};

const LICENSE = {
  state: "active",
  plan: "subscription",
  licenseId: "11111111-2222-4333-8444-555555555555",
  sequence: 3,
  kid: "lic-1",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2027-10-01T00:00:00Z",
  graceDays: 14,
  daysLeft: 350,
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 3, used: 4, over: true },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 5, used: 1, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: false,
    handheld: true,
    customLogo: false,
  },
  innMatches: true,
};

export const DIAG_OVERVIEW: StandaloneDiagnosticsOverview = {
  hosts: [
    {
      hostKey: DIAG_HOST_ID,
      siteId: DIAG_SUMMARY.siteId,
      siteName: "Цех розлива",
      last: DIAG_SUMMARY,
      license: LICENSE,
      devices: { station: 3, office: 2, handheld: 1 },
      cloudLicense: { sequence: 4, validUntil: "2027-11-01T00:00:00.000Z" },
      outdated: null,
    },
  ],
  latestPublishedVersion: null,
};
export const DIAG_EMPTY_OVERVIEW: StandaloneDiagnosticsOverview = {
  hosts: [],
  latestPublishedVersion: null,
};

export const DIAG_STATISTICS: StandaloneDiagnosticsStatistics = {
  hosts: [DIAG_HOST_ID, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e60"],
  multipleHosts: true,
  months: [
    { month: "2026-08", hostCount: 1, stats: month("2026-08", 5000) },
    { month: "2026-10", hostCount: 2, stats: month("2026-10", 14040) },
  ],
};

export const DIAG_HISTORY: StandaloneDiagnosticsHistory = {
  items: [DIAG_SUMMARY],
  nextCursor: null,
};
export const DIAG_DETAIL: StandaloneDiagnosticDetail = {
  diagnostic: DIAG_SUMMARY,
  devices: { station: 3, office: 2, handheld: 1 },
  months: [month("2026-10", 7020)],
  license: LICENSE,
};
export const DIAG_INGESTED: StandaloneDiagnosticsIngestResponse = {
  duplicate: false,
  diagnostic: DIAG_SUMMARY,
  monthsApplied: 2,
  monthsSkipped: 0,
};
