import { describe, expect, it } from "vitest";

import { platformAgreementContracts } from "../src/agreements.js";

// Shared fields only; each kind adds its own identifiers, so a fixture never
// smuggles a legal-entity key into a sole-proprietor body and passes for the
// wrong reason.
const SHARED = {
  name: "ООО «Пример»",
  address: "101000, Москва",
  email: "buh@example.ru",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
};

const LEGAL_ENTITY = {
  ...SHARED,
  kind: "legal_entity",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
};

describe("platformAgreementContracts", () => {
  it("accepts a legal entity counterparty", () => {
    expect(
      platformAgreementContracts.create.body.safeParse({ counterparty: LEGAL_ENTITY }).success,
    ).toBe(true);
  });

  it("rejects a ten-digit INN on a sole proprietor", () => {
    const result = platformAgreementContracts.create.body.safeParse({
      counterparty: {
        ...SHARED,
        kind: "sole_proprietor",
        // A sole proprietor's INN is twelve digits; ten must be refused for
        // that reason alone, not because of a stray unknown key.
        inn: "7701234567",
        ogrnip: "312770000000001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = platformAgreementContracts.create.body.safeParse({
      counterparty: LEGAL_ENTITY,
      sneaky: true,
    });
    expect(result.success).toBe(false);
  });

  it("requires a termination reason only when terminating", () => {
    expect(platformAgreementContracts.transition.body.safeParse({ status: "sent" }).success).toBe(
      true,
    );
    expect(
      platformAgreementContracts.transition.body.safeParse({ status: "terminated" }).success,
    ).toBe(false);
    expect(
      platformAgreementContracts.transition.body.safeParse({
        status: "terminated",
        terminationReason: "Соглашение сторон",
      }).success,
    ).toBe(true);
  });

  it("rejects a reason on a non-terminating transition", () => {
    expect(
      platformAgreementContracts.transition.body.safeParse({
        status: "sent",
        terminationReason: "Соглашение сторон",
      }).success,
    ).toBe(false);
  });
});

describe("list query", () => {
  it("reads withoutTenant by value, not by truthiness", () => {
    const parse = (value: unknown) =>
      platformAgreementContracts.list.query.safeParse({ withoutTenant: value });
    expect(parse(true).success && parse(true).data?.withoutTenant).toBe(true);
    expect(parse("true").success && parse("true").data?.withoutTenant).toBe(true);
    // z.coerce.boolean() would have made this true and silently inverted the filter.
    expect(parse(false).data?.withoutTenant).toBe(false);
    expect(parse("false").data?.withoutTenant).toBe(false);
  });

  it("rejects a string that is neither true nor false", () => {
    expect(platformAgreementContracts.list.query.safeParse({ withoutTenant: "1" }).success).toBe(
      false,
    );
  });
});
