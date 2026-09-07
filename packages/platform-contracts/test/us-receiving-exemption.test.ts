import { describe, expect, it } from "vitest";
import {
  preservedReceivingExemptReceiptSchema,
  receivingExemptReceiptSchema,
} from "../src/index.js";

const validReceipt = {
  evidenceUrl: "https://supplier.example.test/declarations/2026-09",
  tlcHandling: "assign_if_missing" as const,
  proposedTlc: "=Own/Ä-001",
};

describe("receiving exemption contract primitives", () => {
  it("requires every nullable key without defaulting a missing object", () => {
    const nullableReceipt = { evidenceUrl: null, tlcHandling: null, proposedTlc: null };
    expect(receivingExemptReceiptSchema.parse(nullableReceipt)).toEqual(nullableReceipt);
    expect(preservedReceivingExemptReceiptSchema.parse(nullableReceipt)).toEqual(nullableReceipt);
    expect(receivingExemptReceiptSchema.safeParse({}).success).toBe(false);
    expect(receivingExemptReceiptSchema.safeParse(undefined).success).toBe(false);
    expect(
      preservedReceivingExemptReceiptSchema.safeParse({
        evidenceUrl: null,
        tlcHandling: null,
      }).success,
    ).toBe(false);
  });

  it.each(["approved", "reviewer", "actor"])("rejects the server-owned %s field", (field) => {
    expect(
      receivingExemptReceiptSchema.safeParse({ ...validReceipt, [field]: "not-allowed" }).success,
    ).toBe(false);
    expect(
      preservedReceivingExemptReceiptSchema.safeParse({
        ...validReceipt,
        [field]: "not-allowed",
      }).success,
    ).toBe(false);
  });

  it.each([
    "https://user@supplier.example.test/evidence",
    "https://supplier.example.test\\evidence",
    "https://supplier.example.test/\u0001",
    `https://example.test/${"é".repeat(502)}`,
  ])("rejects an invalid evidence URL without fetching it", (evidenceUrl) => {
    expect(receivingExemptReceiptSchema.safeParse({ ...validReceipt, evidenceUrl }).success).toBe(
      false,
    );
    expect(
      preservedReceivingExemptReceiptSchema.safeParse({ ...validReceipt, evidenceUrl }).success,
    ).toBe(false);
  });

  it.each(["https://bücher.example/evidence", `https://example.test/${"é".repeat(501)}a`])(
    "accepts a credential-free evidence URL at the shared boundary",
    (evidenceUrl) => {
      expect(receivingExemptReceiptSchema.parse({ ...validReceipt, evidenceUrl }).evidenceUrl).toBe(
        evidenceUrl,
      );
    },
  );

  it("normalizes entry TLCs but preserves exact canonical stored spelling", () => {
    expect(
      receivingExemptReceiptSchema.parse({ ...validReceipt, proposedTlc: "  =Own/Ä-001  " }),
    ).toEqual(validReceipt);
    expect(preservedReceivingExemptReceiptSchema.parse(validReceipt)).toEqual(validReceipt);
    expect(
      preservedReceivingExemptReceiptSchema.safeParse({
        ...validReceipt,
        proposedTlc: "  =Own/Ä-001  ",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid Unicode in entry and stored TLCs", () => {
    const invalid = { ...validReceipt, proposedTlc: "own-\ud800" };
    expect(receivingExemptReceiptSchema.safeParse(invalid).success).toBe(false);
    expect(preservedReceivingExemptReceiptSchema.safeParse(invalid).success).toBe(false);
  });
});
