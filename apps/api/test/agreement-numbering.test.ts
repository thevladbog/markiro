import { describe, expect, it } from "vitest";

import { nextAgreementNumber } from "../src/modules/platform-agreements/agreement-numbering";

describe("nextAgreementNumber", () => {
  it("starts a fresh year at one", () => {
    expect(nextAgreementNumber([], 2026)).toBe("МКР-2026-0001");
  });

  it("continues from the highest sequence of the same year", () => {
    expect(nextAgreementNumber(["МКР-2026-0001", "МКР-2026-0007"], 2026)).toBe("МКР-2026-0008");
  });

  it("ignores other years and manually typed numbers", () => {
    expect(nextAgreementNumber(["МКР-2025-0099", "договор от руки"], 2026)).toBe("МКР-2026-0001");
  });

  it("keeps four digits past the hundreds", () => {
    expect(nextAgreementNumber(["МКР-2026-0099"], 2026)).toBe("МКР-2026-0100");
  });
});
