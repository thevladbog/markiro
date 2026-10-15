import { describe, expect, it } from "vitest";
import { isValidInn } from "@markiro/domain";
import {
  resolveCustomerInn,
  sameWarnings,
  siteRegistrationWarnings,
  usageWarnings,
} from "../src/modules/standalone-licenses/standalone-inn-check";

const MAIN = "7707083893";
const BILLING = "7728168971";
const OTHER = "7736207543";
const INVALID = "7701234567";

describe("test INNs", () => {
  it("are what the plan says they are", () => {
    for (const inn of [MAIN, BILLING, OTHER, "7707654321", "500100732259"])
      expect(isValidInn(inn)).toBe(true);
    expect(isValidInn(INVALID)).toBe(false);
  });
});

describe("siteRegistrationWarnings (spec §4.9)", () => {
  it("is quiet when the request, the organization profile and billing agree", () => {
    expect(
      siteRegistrationWarnings({
        requestInn: ` ${MAIN} `,
        trialInn: MAIN,
        orgInn: MAIN,
        billingInn: MAIN,
      }),
    ).toEqual([]);
  });

  it("names every disagreement once, sorted", () => {
    expect(
      siteRegistrationWarnings({
        requestInn: OTHER,
        trialInn: MAIN,
        orgInn: MAIN,
        billingInn: BILLING,
      }),
    ).toEqual(["request_inn_differs_billing", "request_inn_differs_org", "trial_inn_differs"]);
  });

  it("tells a missing request INN from an invalid one and a missing organization INN", () => {
    expect(
      siteRegistrationWarnings({ requestInn: "", trialInn: null, orgInn: null, billingInn: null }),
    ).toEqual(["org_inn_missing", "request_inn_missing"]);
    expect(
      siteRegistrationWarnings({
        requestInn: INVALID,
        trialInn: null,
        orgInn: INVALID,
        billingInn: null,
      }),
    ).toEqual(["org_inn_missing", "request_inn_invalid"]);
  });

  it("does not ask about the organization profile when billing holds a valid INN (a tenant without a cabinet)", () => {
    expect(
      siteRegistrationWarnings({
        requestInn: MAIN,
        trialInn: null,
        orgInn: null,
        billingInn: MAIN,
      }),
    ).toEqual([]);
    expect(
      siteRegistrationWarnings({
        requestInn: INVALID,
        trialInn: null,
        orgInn: INVALID,
        billingInn: MAIN,
      }),
    ).toEqual(["request_inn_invalid"]);
  });

  it("warns about an invalid trial INN even when the request INN is missing or invalid", () => {
    for (const requestInn of ["", INVALID]) {
      expect(
        siteRegistrationWarnings({ requestInn, trialInn: INVALID, orgInn: MAIN, billingInn: null }),
      ).toContain("trial_inn_differs");
    }
  });
});

describe("resolveCustomerInn (plan Д3)", () => {
  it("takes the organization profile INN and warns when billing differs", () => {
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: BILLING, siteInn: MAIN })).toEqual({
      inn: MAIN,
      warnings: [{ code: "billing_inn_differs", billingInn: BILLING }],
    });
  });

  it("falls back to billing when the profile INN is missing or invalid, and says so", () => {
    for (const orgInn of [null, INVALID]) {
      expect(resolveCustomerInn({ orgInn, billingInn: MAIN, siteInn: MAIN })).toEqual({
        inn: MAIN,
        warnings: [{ code: "customer_inn_from_billing" }],
      });
    }
  });

  it("warns that the host will refuse a file whose INN differs from the site's request", () => {
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: null, siteInn: OTHER })).toEqual({
      inn: MAIN,
      warnings: [{ code: "site_inn_differs", siteInn: OTHER }],
    });
    expect(resolveCustomerInn({ orgInn: MAIN, billingInn: null, siteInn: null })).toEqual({
      inn: MAIN,
      warnings: [{ code: "site_inn_differs", siteInn: null }],
    });
  });

  it("has no INN when neither source holds a valid one", () => {
    expect(resolveCustomerInn({ orgInn: INVALID, billingInn: "", siteInn: MAIN })).toEqual({
      inn: null,
      warnings: [],
    });
  });
});

describe("usageWarnings (plan Д10)", () => {
  const rights = {
    quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: null },
    features: {
      labelEditor: true,
      publicApi: false,
      pallets: true,
      chzIntegration: false,
      inventory: false,
      commerceMl: false,
      handheld: false,
      customLogo: false,
    },
  };

  it("warns for each quota below what the site already uses, and never for unlimited", () => {
    expect(usageWarnings(rights, { stations: 4, cabinetUsers: 9, lines: 1 })).toEqual([
      { code: "quota_below_usage", quota: "stations", limit: 2, used: 4 },
    ]);
    expect(usageWarnings(rights, null)).toEqual([]);
  });
});

describe("sameWarnings", () => {
  it("compares warning sets regardless of order and refuses extra or missing codes", () => {
    expect(
      sameWarnings(
        ["org_inn_missing", "request_inn_missing"],
        ["request_inn_missing", "org_inn_missing"],
      ),
    ).toBe(true);
    expect(sameWarnings(["org_inn_missing"], [])).toBe(false);
    expect(sameWarnings([], ["org_inn_missing"])).toBe(false);
  });
});
