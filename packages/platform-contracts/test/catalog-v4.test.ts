import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";

const recurringService = {
  cadence: "month",
  includedMinutes: 180,
  carryover: "none",
  excessPolicy: "external_approval",
  scopeRu: "Консультации и настройка",
  scopeEn: "Consulting and configuration",
  operatingHoursRu: null,
  operatingHoursEn: null,
  schedulingTermsRu: null,
  schedulingTermsEn: null,
} as const;

const serviceFields = {
  nameRu: "Сервисное сопровождение",
  nameEn: "Service support",
  unit: "месяц",
  unitPrice: "30000.00",
  vatRateBps: null,
  vatIncluded: false,
  documentNameRu: "Сервисное сопровождение",
  documentNameEn: "Service support",
  subject: "service",
  sellerPolicyRevision: 1,
  lifecyclePolicyId: null,
} as const;

describe("commercial V4 recurring services", () => {
  it("accepts one monthly package without weakening the V3 service schema", () => {
    const input = {
      ...serviceFields,
      billingMode: "recurring",
      billingPeriod: "month",
      service: recurringService,
    } as const;

    expect(contracts.catalogVersionCreateV4Schema.parse(input)).toEqual(input);
    expect(contracts.catalogVersionCreateV3Schema.safeParse(input).success).toBe(false);
    expect(
      contracts.catalogVersionCreateV4Schema.safeParse({ ...input, billingPeriod: "year" }).success,
    ).toBe(false);
    expect(
      contracts.catalogVersionCreateV4Schema.safeParse({
        ...input,
        service: { ...recurringService, carryover: "next_period" },
      }).success,
    ).toBe(false);
  });

  it("preserves the existing one-time V3 service shape", () => {
    const input = {
      ...serviceFields,
      billingMode: "one_time",
      billingPeriod: null,
      service: {},
    } as const;

    expect(contracts.catalogVersionCreateV4Schema.parse(input)).toEqual(input);
    expect(contracts.catalogVersionCreateV3Schema.parse(input)).toEqual(input);
  });

  it("carries the exact monthly policy in V4 line terms", () => {
    const terms = {
      version: 2,
      subject: "service",
      documentNameRu: "Сервисное сопровождение",
      documentNameEn: "Service support",
      sellerPolicyRevision: 1,
      billingPeriod: "month",
      billingTimezone: "Europe/Moscow",
      activationRule: "after_current",
      serviceTerms: recurringService,
    } as const;

    expect(contracts.commercialLineTermsV4Schema.parse(terms)).toEqual(terms);
    expect(contracts.commercialLineTermsSchema.safeParse(terms).success).toBe(false);
    expect(
      contracts.commercialLineTermsV4Schema.safeParse({
        ...terms,
        activationRule: "on_application",
      }).success,
    ).toBe(false);
  });
});
