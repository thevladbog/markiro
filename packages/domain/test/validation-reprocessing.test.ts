import { describe, expect, it } from "vitest";
import {
  validationOccurrenceOutcomeSchema,
  validationOccurrenceStatusSchema,
} from "../src/validation-reprocessing.js";
import { validationPrintInputSchema } from "../src/product-labels/contracts.js";

describe("validation reprocessing policy", () => {
  const input = {
    mode: "duplicate_dm",
    verification: "none",
    templateId: "40000000-0000-4000-8000-000000000004",
  };
  it("defaults legacy input to false", () => {
    expect(validationPrintInputSchema.parse(input)).toEqual({
      ...input,
      allowPreviouslyAcceptedCodes: false,
    });
  });
  it("accepts only a boolean on duplicate printing", () => {
    expect(
      validationPrintInputSchema.parse({ ...input, allowPreviouslyAcceptedCodes: true }),
    ).toMatchObject({ allowPreviouslyAcceptedCodes: true });
    expect(() =>
      validationPrintInputSchema.parse({ mode: "none", allowPreviouslyAcceptedCodes: false }),
    ).toThrow();
  });
});

describe("historical ordinary receipt ownership", () => {
  const receipt = {
    shiftId: "11111111-1111-4111-8111-111111111111",
    codeHash: "a".repeat(64),
    scannedAt: "2026-09-12T08:00:00.000Z",
    outcome: "first_accepted",
    ownership: "released",
  };
  it("accepts explicit released history and rejects release on any other result", () => {
    expect(validationOccurrenceOutcomeSchema.parse(receipt)).toEqual(receipt);
    for (const outcome of ["reprocessed", "conflict", "pending"]) {
      expect(
        validationOccurrenceStatusSchema.safeParse({
          protocol: "validation-reprocessing-v1",
          occurrences: [{ ...receipt, outcome }],
        }).success,
      ).toBe(false);
    }
  });
});
