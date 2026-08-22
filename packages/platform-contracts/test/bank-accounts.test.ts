import { describe, expect, it } from "vitest";
import * as exportedContracts from "../src/index.js";

const contracts = exportedContracts as unknown as Record<string, unknown>;

describe("billing bank-account contracts", () => {
  it("accepts one explicit RUB account and rejects malformed identifiers", () => {
    expect(contracts.bankAccountInputSchema).toBeDefined();
    const schema = contracts.bankAccountInputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const valid = {
      label: "Основной расчётный счёт",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
    };

    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, settlementAccount: "407028109" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, bic: "04452522X" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, currency: "USD" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, hiddenProviderPayload: {} }).success).toBe(false);
  });
});
