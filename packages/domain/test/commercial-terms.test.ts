import { describe, expect, it } from "vitest";
import {
  commercialTaxDefaults,
  isCommercialTaxAllowed,
  resolveCommercialPeriod,
  type SellerTaxPolicy,
} from "../src/index.js";

describe("resolveCommercialPeriod", () => {
  it("derives every monthly boundary from the original day instead of a clamped prior boundary", () => {
    const input = {
      anchorAt: "2027-01-31T09:00:00.000Z",
      billingPeriod: "month" as const,
    };

    expect(resolveCommercialPeriod({ ...input, cycle: 0 })).toEqual({
      billingPeriod: "month",
      billingTimezone: "Europe/Moscow",
      calendarPolicyVersion: 1,
      anchorAt: "2027-01-31T09:00:00.000Z",
      cycle: 0,
      startsAt: "2027-01-31T09:00:00.000Z",
      endsAt: "2027-02-28T09:00:00.000Z",
    });
    expect(resolveCommercialPeriod({ ...input, cycle: 1 })).toMatchObject({
      startsAt: "2027-02-28T09:00:00.000Z",
      endsAt: "2027-03-31T09:00:00.000Z",
    });
  });

  it("restores a leap-day annual anchor when the target year has February 29", () => {
    const input = {
      anchorAt: "2024-02-29T09:00:00.000Z",
      billingPeriod: "year" as const,
    };

    expect(resolveCommercialPeriod({ ...input, cycle: 0 })).toMatchObject({
      startsAt: "2024-02-29T09:00:00.000Z",
      endsAt: "2025-02-28T09:00:00.000Z",
    });
    expect(resolveCommercialPeriod({ ...input, cycle: 3 })).toMatchObject({
      startsAt: "2027-02-28T09:00:00.000Z",
      endsAt: "2028-02-29T09:00:00.000Z",
    });
  });

  it("uses the Moscow civil date when the UTC instant falls on the prior day", () => {
    const input = {
      anchorAt: "2027-01-30T22:15:16.123Z",
      billingPeriod: "month" as const,
    };

    expect(resolveCommercialPeriod({ ...input, cycle: 0 })).toMatchObject({
      startsAt: "2027-01-30T22:15:16.123Z",
      endsAt: "2027-02-27T22:15:16.123Z",
    });
    expect(resolveCommercialPeriod({ ...input, cycle: 1 })).toMatchObject({
      startsAt: "2027-02-27T22:15:16.123Z",
      endsAt: "2027-03-30T22:15:16.123Z",
    });
  });

  it("canonicalizes an offset ISO instant to UTC", () => {
    expect(
      resolveCommercialPeriod({
        anchorAt: "2027-01-31T12:00:00.000+03:00",
        billingPeriod: "month",
        cycle: 0,
      }),
    ).toMatchObject({
      anchorAt: "2027-01-31T09:00:00.000Z",
      startsAt: "2027-01-31T09:00:00.000Z",
      endsAt: "2027-02-28T09:00:00.000Z",
    });
  });

  it("preserves the exact cycle-zero anchor during a historical Moscow clock overlap", () => {
    expect(
      resolveCommercialPeriod({
        anchorAt: "2010-10-30T22:30:00.000Z",
        billingPeriod: "month",
        cycle: 0,
      }),
    ).toMatchObject({
      anchorAt: "2010-10-30T22:30:00.000Z",
      startsAt: "2010-10-30T22:30:00.000Z",
    });
  });

  it("chooses the earlier instant when a later boundary has two Moscow representations", () => {
    expect(
      resolveCommercialPeriod({
        anchorAt: "2010-08-30T22:30:00.000Z",
        billingPeriod: "month",
        cycle: 2,
      }),
    ).toMatchObject({
      startsAt: "2010-10-30T22:30:00.000Z",
    });
  });

  it("rejects ISO instants with precision beyond milliseconds", () => {
    expect(() =>
      resolveCommercialPeriod({
        anchorAt: "2027-01-31T09:00:00.1234Z",
        billingPeriod: "month",
        cycle: 0,
      }),
    ).toThrow();
  });

  it.each([
    "",
    "not-a-date",
    "2027-02-29T09:00:00.000Z",
    "2027-01-31",
    "2027-01-31T09:00:00.000",
    "0000-01-01T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
  ])("rejects malformed or out-of-range ISO instant %s", (anchorAt) => {
    expect(() => resolveCommercialPeriod({ anchorAt, billingPeriod: "month", cycle: 0 })).toThrow();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or overflowing cycle %s",
    (cycle) => {
      expect(() =>
        resolveCommercialPeriod({
          anchorAt: "2027-01-31T09:00:00.000Z",
          billingPeriod: "month",
          cycle,
        }),
      ).toThrow();
    },
  );

  it("rejects a period whose end boundary exceeds the supported date range", () => {
    expect(() =>
      resolveCommercialPeriod({
        anchorAt: "9999-12-31T09:00:00.000Z",
        billingPeriod: "month",
        cycle: 0,
      }),
    ).toThrow();
  });

  it("rejects an unsupported billing period at runtime", () => {
    expect(() =>
      resolveCommercialPeriod({
        anchorAt: "2027-01-31T09:00:00.000Z",
        billingPeriod: "quarter" as "month",
        cycle: 0,
      }),
    ).toThrow();
  });
});

describe("seller tax policy", () => {
  it("keeps Without VAT distinct from numeric zero and from VAT included", () => {
    const npd = { kind: "without_vat", regime: "npd" } as const;

    expect(commercialTaxDefaults(npd)).toEqual({ vatRateBps: null, vatIncluded: false });
    expect(isCommercialTaxAllowed(npd, { vatRateBps: null, vatIncluded: false })).toBe(true);
    expect(isCommercialTaxAllowed(npd, { vatRateBps: 0, vatIncluded: false })).toBe(false);
    expect(isCommercialTaxAllowed(npd, { vatRateBps: null, vatIncluded: true })).toBe(false);
  });

  it("uses the configured VAT default and accepts only configured numeric rates", () => {
    const policy: SellerTaxPolicy = {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [0, 1_000, 2_000],
      defaultRateBps: 2_000,
      defaultIncluded: true,
    };

    expect(commercialTaxDefaults(policy)).toEqual({
      vatRateBps: 2_000,
      vatIncluded: true,
    });
    expect(isCommercialTaxAllowed(policy, { vatRateBps: 0, vatIncluded: false })).toBe(true);
    expect(isCommercialTaxAllowed(policy, { vatRateBps: 1_000, vatIncluded: true })).toBe(true);
    expect(isCommercialTaxAllowed(policy, { vatRateBps: 500, vatIncluded: true })).toBe(false);
    expect(isCommercialTaxAllowed(policy, { vatRateBps: null, vatIncluded: false })).toBe(false);
  });

  it.each([
    { kind: "without_vat", regime: "vat" },
    {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [],
      defaultRateBps: 2_000,
      defaultIncluded: true,
    },
    {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [2_000],
      defaultRateBps: 1_000,
      defaultIncluded: true,
    },
    {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [-1, 2_000],
      defaultRateBps: 2_000,
      defaultIncluded: true,
    },
    {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [2_000.5],
      defaultRateBps: 2_000.5,
      defaultIncluded: false,
    },
  ])("rejects malformed seller tax policy %#", (policy) => {
    expect(() => commercialTaxDefaults(policy as SellerTaxPolicy)).toThrow();
    expect(() =>
      isCommercialTaxAllowed(policy as SellerTaxPolicy, {
        vatRateBps: null,
        vatIncluded: false,
      }),
    ).toThrow();
  });

  it("rejects malformed tax values without accepting them", () => {
    const policy: SellerTaxPolicy = {
      kind: "vat",
      regime: "other",
      allowedRatesBps: [2_000],
      defaultRateBps: 2_000,
      defaultIncluded: false,
    };

    expect(
      isCommercialTaxAllowed(policy, {
        vatRateBps: 2_000,
        vatIncluded: "false" as unknown as boolean,
      }),
    ).toBe(false);
    expect(
      isCommercialTaxAllowed(policy, {
        vatRateBps: 2_000.5,
        vatIncluded: false,
      }),
    ).toBe(false);
  });
});
