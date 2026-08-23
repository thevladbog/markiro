import { describe, expect, it } from "vitest";
import * as exportedContracts from "../src/index.js";

const contracts = exportedContracts as unknown as Record<string, unknown>;
const actualMatchesLegal = { sameAsLegal: true } as const;

describe("billing legal-profile contracts", () => {
  it("requires the legal-entity identifiers without leaking them into an individual", () => {
    expect(contracts.billingProfileInputSchema).toBeDefined();
    const schema = contracts.billingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(
      schema.safeParse({
        kind: "legal_entity",
        fullName: "ООО Маркиро",
        displayName: "Маркиро",
        inn: "7700000000",
        kpp: "770001001",
        ogrn: "1027700000000",
        legalAddressRaw: "г Москва",
        actualAddress: { sameAsLegal: true },
        postalAddress: { sameAsLegal: true },
        contact: { name: null, email: null, phone: null },
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ kind: "legal_entity", inn: "7700000000" }).success).toBe(false);

    expect(
      schema.safeParse({
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        displayName: "Иванов И. И.",
        legalAddressRaw: "г Москва",
        actualAddress: { sameAsLegal: true },
        postalAddress: { sameAsLegal: true },
        contact: { name: null, email: null, phone: null },
      }).success,
    ).toBe(true);
  });

  it("validates every tenant profile kind independently", () => {
    expect(contracts.billingProfileInputSchema).toBeDefined();
    const schema = contracts.billingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const common = {
      displayName: "Плательщик",
      legalAddressRaw: "г Казань",
      actualAddress: { sameAsLegal: true },
      postalAddress: {
        sameAsLegal: false,
        raw: "420000, г Казань",
        normalized: null,
      },
      contact: { name: "Иван", email: "billing@example.invalid", phone: "+79990000000" },
    };

    expect(
      schema.safeParse({
        ...common,
        kind: "sole_proprietor",
        fullName: "ИП Иванов Иван Иванович",
        inn: "123456789012",
        ogrnip: "123456789012345",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...common,
        kind: "self_employed",
        fullName: "Иванов Иван Иванович",
        inn: "123456789012",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...common,
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        inn: null,
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        ...common,
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        kpp: "123456789",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...common,
        kind: "sole_proprietor",
        fullName: "ИП Иванов Иван Иванович",
        inn: "123456789012",
      }).success,
    ).toBe(false);
  });

  it("accepts every seller party kind and validates actual-address inputs", () => {
    expect(contracts.operatorBillingProfileInputSchema).toBeDefined();
    const schema = contracts.operatorBillingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const common = {
      fullName: "ООО Маркиро",
      displayName: "Маркиро",
      legalAddressRaw: "г Москва",
      actualAddress: { sameAsLegal: true },
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
    };

    expect(
      schema.safeParse({
        ...common,
        kind: "legal_entity",
        inn: "7700000000",
        kpp: "770001001",
        ogrn: "1027700000000",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: "individual",
        fullName: "Иванов Иван Иванович",
        displayName: "Иванов И. И.",
        legalAddressRaw: "г Москва",
        actualAddress: actualMatchesLegal,
        postalAddress: { sameAsLegal: true },
        contact: { name: null, email: null, phone: null },
      }).success,
    ).toBe(true);
    expect(
      (
        contracts.billingProfileInputSchema as { safeParse(value: unknown): { success: boolean } }
      ).safeParse({
        kind: "self_employed",
        fullName: "Петров Пётр Петрович",
        displayName: "Петров П. П.",
        inn: "123456789012",
        legalAddressRaw: "г Казань",
        actualAddress: { sameAsLegal: false },
        postalAddress: { sameAsLegal: true },
        contact: { name: null, email: null, phone: null },
      }).success,
    ).toBe(false);
  });

  it("accepts exact N-1 seller and tenant request bodies without broadening current inputs", () => {
    const operatorSchema = contracts.operatorBillingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> };
    };
    const tenantSchema = contracts.billingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> };
    };
    const currentOperatorSchema = contracts.currentOperatorBillingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const currentTenantSchema = contracts.currentBillingProfileInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const legacySeller = {
      kind: "legal_entity",
      fullName: "ООО Маркиро",
      displayName: "Маркиро",
      inn: "7700000000",
      kpp: "770001001",
      ogrn: "1027700000000",
      legalAddressRaw: "г Москва",
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
    };
    const legacyTenant = {
      kind: "individual",
      fullName: "Иванов Иван Иванович",
      displayName: "Иванов И. И.",
      legalAddressRaw: "г Казань",
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
    };

    const sellerResult = operatorSchema.safeParse(legacySeller);
    const tenantResult = tenantSchema.safeParse(legacyTenant);

    expect(sellerResult.success).toBe(true);
    expect(sellerResult.data).not.toHaveProperty("actualAddress");
    expect(tenantResult.success).toBe(true);
    expect(tenantResult.data).not.toHaveProperty("actualAddress");
    expect(operatorSchema.safeParse(legacyTenant).success).toBe(false);
    expect(operatorSchema.safeParse({ ...legacySeller, unexpected: true }).success).toBe(false);
    expect(currentOperatorSchema.safeParse(legacySeller).success).toBe(false);
    expect(currentTenantSchema.safeParse(legacyTenant).success).toBe(false);
  });

  it("keeps an unconfirmed migrated profile readable before the operator completes it", () => {
    expect(contracts.billingProfileSchema).toBeDefined();
    const schema = contracts.billingProfileSchema as {
      safeParse(value: unknown): { success: boolean };
    };

    const migratedProfile = {
      id: "00000000-0000-4000-8000-000000000601",
      kind: "legal_entity",
      fullName: "Маркиро",
      displayName: "Маркиро",
      inn: "7700000000",
      kpp: "770001001",
      ogrn: "1027700000000",
      ogrnip: null,
      legalAddressRaw: "г Москва",
      legalAddress: { value: "г Москва", city: "Москва" },
      actualSameAsLegal: true,
      actualAddressRaw: null,
      actualAddress: null,
      postalSameAsLegal: false,
      postalAddressRaw: null,
      postalAddress: null,
      contact: null,
      revision: 1,
      isCurrent: true,
      isConfirmed: false,
      confirmedByPlatformUserId: null,
      confirmedAt: null,
      createdByPlatformUserId: "legacy-admin",
      createdAt: new Date("2026-08-22T04:00:00.000Z"),
    };

    expect(schema.safeParse(migratedProfile).success).toBe(true);
    const missingActualAddressResponse: Record<string, unknown> = { ...migratedProfile };
    delete missingActualAddressResponse.actualSameAsLegal;
    delete missingActualAddressResponse.actualAddressRaw;
    delete missingActualAddressResponse.actualAddress;
    expect(schema.safeParse(missingActualAddressResponse).success).toBe(false);
  });
});
