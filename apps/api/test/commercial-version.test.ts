import { describe, expect, it } from "vitest";
import {
  commercialResponse,
  legacyCommercialProjection,
  commercialVersion,
  projectCommercialResponse,
} from "../src/platform-http/commercial-version";
import { z } from "zod";
describe("negotiated commercial representation", () => {
  it("preserves opaque historical snapshots and audit metadata literally", () => {
    const before = { subject: "original text", maxLines: 0 };
    expect(legacyCommercialProjection({ before, after: before, sellerSnapshot: before })).toEqual({
      before,
      after: before,
      sellerSnapshot: before,
    });
  });
  it("never changes zero to unlimited and projects only introduced metadata", () => {
    expect(() => legacyCommercialProjection({ plan: { maxLines: 0 } })).toThrow();
    expect(
      legacyCommercialProjection({
        subject: null,
        documentNameRu: null,
        plan: { maxLines: null },
        other: 1,
      }),
    ).toEqual({ plan: { maxLines: null }, other: 1 });
  });
  it("requires exactly the explicit supported version", () => {
    expect(commercialVersion({ headers: {} })).toBe(1);
    expect(commercialVersion({ headers: { "x-markiro-commercial-version": "2" } })).toBe(2);
    expect(commercialVersion({ headers: { "x-markiro-commercial-version": "3" } })).toBe(3);
    expect(commercialVersion({ headers: { "x-markiro-commercial-version": "4" } })).toBe(4);
    for (const value of ["1", "5", "", " 3", "3, 3", ["3", "3"], 3])
      expect(() =>
        commercialVersion({ headers: { "x-markiro-commercial-version": value } }),
      ).toThrow();
    expect(() =>
      commercialVersion({
        headers: { "x-markiro-commercial-version": "3" },
        rawHeaders: ["X-Markiro-Commercial-Version", "3", "x-markiro-commercial-version", "3"],
      }),
    ).toThrow();
  });
});

describe("P1 commercial projection", () => {
  it.each([1, 2] as const)("projects nullable legacy fields for version %i", (version) => {
    expect(
      projectCommercialResponse(version, {
        lifecyclePolicyId: null,
        plan: {
          chzIntegrationEnabled: null,
          inventoryEnabled: null,
          commerceMlEnabled: null,
          handheldEnabled: null,
          maxLines: 1,
        },
      }),
    ).toEqual({ plan: { maxLines: 1 } });
  });
  it.each([1, 2] as const)(
    "rejects explicit P1 meaning and effects before projection for version %i",
    (version) => {
      for (const value of [
        { plan: { inventoryEnabled: false } },
        { lifecyclePolicyId: "policy" },
        { addon: { effects: [{ key: "inventory", featureEnabled: true }] } },
        {
          scheduledAddons: [
            {
              addonVersion: {
                effects: [
                  { entitlementKey: "handheld", featureEnabled: true, quotaIncrement: null },
                ],
              },
            },
          ],
        },
      ])
        expect(() => projectCommercialResponse(version, value)).toThrow(
          expect.objectContaining({ response: { code: "client_update_required" } }),
        );
    },
  );
  it("preserves V3 and opaque saved bytes", () => {
    const terms = { inventoryEnabled: false, lifecyclePolicyId: "policy", maxLines: 0 };
    expect(projectCommercialResponse(3, terms)).toEqual(terms);
    expect(projectCommercialResponse(2, { documentSnapshot: terms })).toEqual({
      documentSnapshot: terms,
    });
  });

  it.each([1, 2, 3] as const)(
    "requires V4 for recurring service catalog values in version %i",
    (version) => {
      expect(() =>
        projectCommercialResponse(version, {
          kind: "service",
          billingMode: "recurring",
          service: { cadence: "month" },
        }),
      ).toThrow(expect.objectContaining({ response: { code: "client_update_required" } }));
      expect(() =>
        projectCommercialResponse(version, { serviceTerms: { cadence: "month" } }),
      ).toThrow(expect.objectContaining({ response: { code: "client_update_required" } }));
    },
  );

  it("uses the V4 response schema without projecting recurring service fields", () => {
    const legacy = z.object({ version: z.literal(1) });
    const v2 = z.object({ version: z.literal(2) });
    const v3 = z.object({ version: z.literal(3) });
    const v4 = z.object({
      version: z.literal(4),
      serviceTerms: z.object({ cadence: z.literal("month") }),
    });
    expect(
      commercialResponse(4, legacy, v2, { version: 4, serviceTerms: { cadence: "month" } }, v3, v4),
    ).toEqual({ version: 4, serviceTerms: { cadence: "month" } });
  });
});
