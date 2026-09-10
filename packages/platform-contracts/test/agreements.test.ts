import { describe, expect, it } from "vitest";

import { platformAgreementContracts } from "../src/agreements.js";

const LEGAL_ENTITY = {
  kind: "legal_entity",
  name: "ООО «Пример»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
  address: "101000, Москва",
  email: "buh@example.ru",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
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
        ...LEGAL_ENTITY,
        kind: "sole_proprietor",
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
