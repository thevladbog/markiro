import { readFileSync } from "node:fs";

import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  deviceInfoSchema,
  deviceLicenseSchema,
  errorBodySchema,
  LICENSE_FEATURE_KEYS,
  LICENSE_QUOTA_KEYS,
  LICENSE_REFUSALS,
  licenseLoadRequestSchema,
  licensePreviewSchema,
  officeLicenseSchema,
} from "../src/host/protocol.js";
import { licenseLoad } from "../src/host/requests.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe("license shapes (proto/fixtures, plan ЛЦ-2)", () => {
  it("read the office's license without losing a field, and a newer host's", () => {
    expect(officeLicenseSchema.parse(fixture("office-license.json"))).toEqual(
      fixture("office-license.json"),
    );
    expect(officeLicenseSchema.safeParse(extended("office-license.json")).success).toBe(true);
    const future = { ...extended("office-license.json"), state: "some_future_state" };
    expect(officeLicenseSchema.parse(future).state).toBe("some_future_state");
  });

  it("read the preview's two columns and its warnings", () => {
    const preview = licensePreviewSchema.parse(fixture("office-license-preview.json"));
    expect(preview).toEqual(fixture("office-license-preview.json"));
    expect(preview.before.plan).toBe("trial");
    expect(preview.after.quotas.stations).toEqual({ limit: 3, used: 4, over: true });
    expect(preview.warnings).toEqual(["over_limit"]);
  });

  it("read a device's license with its record, and a record without one", () => {
    const info = deviceInfoSchema.parse(fixture("device-license.json"));
    expect(info.license).toEqual({
      state: "grace",
      since: "2027-10-20T09:00:00Z",
      phaseEndsAt: "2027-11-03T09:00:00Z",
      emergencyUntil: null,
    });
    expect(deviceInfoSchema.parse(fixture("device-info.json")).license).toBeUndefined();
    expect(
      deviceLicenseSchema.safeParse({ state: "grace", since: "yesterday", phaseEndsAt: null })
        .success,
    ).toBe(false);
  });

  it("send the file strictly through its one builder", () => {
    const file = (fixture("license-load-request.json") as { file: string }).file;
    expect(licenseLoad(file)).toEqual(fixture("license-load-request.json"));
    expect(licenseLoadRequestSchema.safeParse({ file, extra: true }).success).toBe(false);
    expect(licenseLoadRequestSchema.safeParse({ file: "" }).success).toBe(false);
    expect(licenseLoadRequestSchema.safeParse({ file: "a".repeat(16385) }).success).toBe(false);
  });

  it("read the refusals with their constraint, quota, feature or reason", () => {
    expect(errorBodySchema.parse(fixture("error-license-restricted.json")).error.details).toEqual({
      constraint: "license_restricted",
      state: "restricted",
      since: "2027-11-03T09:00:00Z",
    });
    expect(errorBodySchema.parse(fixture("error-seat-limit.json")).error.details).toEqual({
      constraint: "seat_limit",
      quota: "stations",
      used: 3,
      limit: 3,
    });
    expect(errorBodySchema.parse(fixture("error-feature-disabled.json")).error.details).toEqual({
      constraint: "feature_disabled",
      feature: "handheld",
    });
    const refused = errorBodySchema.parse(fixture("error-license-refused.json"));
    expect(LICENSE_REFUSALS).toContain(refused.error.details?.reason);
  });

  it("name the quotas and features as the cloud does (plan ЛЦ-1)", () => {
    expect([...LICENSE_QUOTA_KEYS]).toEqual([...STANDALONE_QUOTA_KEYS]);
    expect([...LICENSE_FEATURE_KEYS]).toEqual([...STANDALONE_FEATURE_KEYS]);
  });
});
