import { describe, expect, it } from "vitest";
import * as contracts from "../src/traceability/profile.js";
const { provisionUsTraceabilityProfileSchema } = contracts;

const input = { code: "US_FSMA204_PROCESSOR", timeZone: "America/Chicago" };

describe("US profile response", () => {
  const summary = {
    ...input,
    retentionYears: 5,
    baselineVersion: "US-REG-2026-09-03",
    effectiveAt: "2026-09-05T00:00:00.000Z",
  };
  it("validates the persisted summary without inventing missing response fields", () => {
    expect(contracts.usTraceabilityProfileSummarySchema.parse(summary)).toEqual(summary);
    for (const key of Object.keys(summary)) {
      expect(
        contracts.usTraceabilityProfileSummarySchema.safeParse({ ...summary, [key]: undefined })
          .success,
      ).toBe(false);
    }
  });
  it.each([
    { code: "RU_CHZ" },
    { timeZone: "Mars/Olympus" },
    { retentionYears: 1 },
    { baselineVersion: "" },
    { effectiveAt: "yesterday" },
    { tenantId: "other" },
  ])("rejects invalid or extra response data %j", (override) => {
    expect(
      contracts.usTraceabilityProfileSummarySchema.safeParse({ ...summary, ...override }).success,
    ).toBe(false);
  });
});

describe("US profile provisioning input", () => {
  it("requires an explicit US profile and timezone, with five calendar years by default", () => {
    expect(provisionUsTraceabilityProfileSchema.parse(input)).toEqual({
      ...input,
      retentionYears: 5,
    });
    expect(
      provisionUsTraceabilityProfileSchema.parse({
        ...input,
        code: "US_GENERIC_LOT_TRACEABILITY",
        retentionYears: 2,
      }),
    ).toEqual({ ...input, code: "US_GENERIC_LOT_TRACEABILITY", retentionYears: 2 });
  });

  it.each([
    { ...input, code: "RU_CHZ" },
    { ...input, code: undefined },
    { ...input, timeZone: undefined },
    { ...input, timeZone: "" },
    { ...input, timeZone: "Mars/Olympus" },
    { ...input, timeZone: "+03:00" },
    { ...input, retentionYears: 1 },
    { ...input, retentionYears: 2.5 },
    { ...input, retentionYears: "5" },
    { ...input, retentionYears: 2147483648 },
    { ...input, baselineVersion: "client-controlled" },
    { ...input, tenantId: "another-tenant" },
    { ...input, effectiveAt: "2026-01-01T00:00:00Z" },
  ])("rejects invalid or server-owned input %j", (value) => {
    expect(provisionUsTraceabilityProfileSchema.safeParse(value).success).toBe(false);
  });
});
