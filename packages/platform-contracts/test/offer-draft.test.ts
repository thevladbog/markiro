import { describe, expect, it } from "vitest";
import { platformOfferDraftContracts } from "../src/offer-draft.js";

const input = {
  expectedUpdatedAt: "2026-09-11T12:00:00.000Z",
  idempotencyKey: "81111111-1111-4111-8111-111111111111",
  lines: [
    {
      kind: "service",
      catalogVersionId: null,
      nameRu: "Работа",
      nameEn: "Work",
      quantity: 1,
      unit: "шт",
      agreedUnitPrice: "100.00",
      vatRateBps: null,
      vatIncluded: false,
      activationPolicy: null,
      commercialTerms: null,
    },
  ],
};

describe("offer draft update boundary", () => {
  it("requires concurrency and retry identity and forbids identity/status replacement", () => {
    const schema = platformOfferDraftContracts.update.body;
    expect(schema.safeParse(input).success).toBe(true);
    for (const field of ["tenantId", "familyId", "status", "number", "revision"])
      expect(schema.safeParse({ ...input, [field]: "replacement" }).success).toBe(false);
    expect(schema.safeParse({ ...input, expectedUpdatedAt: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, idempotencyKey: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, lines: [] }).success).toBe(false);
  });
});
