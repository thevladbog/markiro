import { describe, expect, it } from "vitest";
import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import {
  STANDALONE_SUPPORT_FEATURE_KEYS,
  STANDALONE_SUPPORT_QUOTA_KEYS,
  standaloneSupportPayloadSchema,
} from "../src/index.js";

const zeroMonth = (month: string) => ({
  month,
  shifts: {
    aggregation: 1,
    validation: 0,
    validationPrint: 0,
    fromOffice: 1,
    fromStation: 0,
    withPallets: 0,
  },
  scans: { accepted: 7020, duplicates: 64, rejected: 9 },
  boxes: { closed: 585, disassembled: 0, codes: 7020 },
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
  syncRejected: 0,
});
const quota = (limit: number | null, used: number) => ({ limit, used, over: false });
const license = () => ({
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
    lines: quota(2, 1),
    stations: quota(3, 2),
    kiosks: quota(null, 0),
    cabinetUsers: quota(5, 1),
  },
  features: Object.fromEntries(STANDALONE_FEATURE_KEYS.map((key) => [key, true])),
  innMatches: true,
});
const v1 = () => ({
  v: 1,
  generatedAt: "2026-10-14T09:00:00.000Z",
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  months: [zeroMonth("2026-09"), zeroMonth("2026-10")],
  devices: { station: 3, office: 2, handheld: 1 },
});
const v2 = () => ({
  ...v1(),
  v: 2,
  hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  role: "host",
  os: "Windows 11",
  arch: "x64",
  webview: "WebView2 130.0.2849.80",
  license: license(),
});

describe("standalone support payload (plan ДИАГ К1)", () => {
  it("accepts v1 and v2 and keeps the field names of the client", () => {
    expect(standaloneSupportPayloadSchema.parse(v1())).toMatchObject({ v: 1 });
    expect(standaloneSupportPayloadSchema.parse(v2())).toMatchObject({ v: 2, role: "host" });
    expect(
      standaloneSupportPayloadSchema.safeParse({
        ...v2(),
        hostId: null,
        role: null,
        os: null,
        arch: null,
        webview: null,
        license: null,
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown field at every level, even a harmless-looking one", () => {
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), extra: 1 }).success).toBe(false);
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), hostId: "x" }).success).toBe(false);
    const month = { ...zeroMonth("2026-10"), productName: "Молоко" };
    expect(standaloneSupportPayloadSchema.safeParse({ ...v1(), months: [month] }).success).toBe(
      false,
    );
    const customer = { ...license(), customer: { name: "ООО", inn: "7707083893" } };
    expect(standaloneSupportPayloadSchema.safeParse({ ...v2(), license: customer }).success).toBe(
      false,
    );
    const fingerprint = { ...license(), fingerprint: "ab".repeat(32) };
    expect(
      standaloneSupportPayloadSchema.safeParse({ ...v2(), license: fingerprint }).success,
    ).toBe(false);
  });

  it("requires months to be calendar months, strictly increasing, one to twelve", () => {
    const parse = (months: unknown[]) =>
      standaloneSupportPayloadSchema.safeParse({ ...v1(), months }).success;
    expect(parse([])).toBe(false);
    expect(parse([zeroMonth("2026-13")])).toBe(false);
    expect(parse([zeroMonth("2026-10"), zeroMonth("2026-09")])).toBe(false);
    expect(parse([zeroMonth("2026-10"), zeroMonth("2026-10")])).toBe(false);
    const year = Array.from({ length: 12 }, (_, i) =>
      zeroMonth(`2025-${String(i + 1).padStart(2, "0")}`),
    );
    expect(parse(year)).toBe(true);
    expect(parse([...year, zeroMonth("2026-01")])).toBe(false);
  });

  it("bounds every counter: integer, not negative, not above 2^53 - 1", () => {
    const withScans = (accepted: number) => ({
      ...v1(),
      months: [{ ...zeroMonth("2026-10"), scans: { accepted, duplicates: 0, rejected: 0 } }],
    });
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(standaloneSupportPayloadSchema.safeParse(withScans(bad)).success).toBe(false);
    }
    expect(
      standaloneSupportPayloadSchema.safeParse(withScans(Number.MAX_SAFE_INTEGER)).success,
    ).toBe(true);
  });

  it("bounds versions and system strings: length and no control characters", () => {
    const parse = (patch: Record<string, unknown>) =>
      standaloneSupportPayloadSchema.safeParse({ ...v2(), ...patch }).success;
    expect(parse({ appVersion: "x".repeat(65) })).toBe(false);
    expect(parse({ appVersion: "0.2.0\u0000" })).toBe(false);
    expect(parse({ hostVersion: "0.2.0\r\nX: y" })).toBe(false);
    expect(parse({ os: "Windows‮11" })).toBe(true);
    expect(parse({ webview: "w".repeat(121) })).toBe(false);
    expect(parse({ generatedAt: "yesterday" })).toBe(false);
    expect(parse({ hostId: "3F1C2D4E-5A6B-4C7D-8E9F-0A1B2C3D4E5F" })).toBe(false);
    expect(parse({ role: "kiosk" })).toBe(false);
  });

  it("keeps its quota and feature key lists equal to the domain's", () => {
    expect([...STANDALONE_SUPPORT_QUOTA_KEYS].sort()).toEqual([...STANDALONE_QUOTA_KEYS].sort());
    expect([...STANDALONE_SUPPORT_FEATURE_KEYS].sort()).toEqual(
      [...STANDALONE_FEATURE_KEYS].sort(),
    );
  });
});
