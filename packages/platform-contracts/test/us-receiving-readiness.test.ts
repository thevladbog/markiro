import { describe, expect, it } from "vitest";
import { receivingReadinessQuerySchema, receivingReadinessSchema } from "../src/index.js";

const result = {
  eventId: "a0000000-0000-4000-8000-000000000001",
  draftVersion: 1,
  checkedAt: "2026-09-07T10:00:00.000Z",
  inputDigest: "a".repeat(64),
  ruleVersion: "receiving-readiness-v3",
  exemptReviewRequiredLines: [],
  profileCode: "US_FSMA204_PROCESSOR",
  state: "complete",
  issues: [],
};
describe("saved receiving readiness contract", () => {
  it("requires an explicit canonical saved version and refuses client tenancy", () => {
    expect(receivingReadinessQuerySchema.parse({ expectedDraftVersion: "12" })).toEqual({
      expectedDraftVersion: 12,
    });
    for (const value of [undefined, "01", "1e2", "1.0", " 1", 0, -1, 2147483648, [], "1&tenant=x"])
      expect(receivingReadinessQuerySchema.safeParse({ expectedDraftVersion: value }).success).toBe(
        false,
      );
    expect(
      receivingReadinessQuerySchema.safeParse({ expectedDraftVersion: 1, tenantId: "other" })
        .success,
    ).toBe(false);
  });
  it("pins record version, input digest and assessment vocabulary", () => {
    expect(receivingReadinessSchema.parse(result)).toEqual(result);
    for (const change of [
      { eventId: "bad" },
      { draftVersion: 0 },
      { inputDigest: "short" },
      { profileCode: "RU_CHZ" },
      { ruleVersion: "unknown" },
      { state: "finalized" },
      { extra: true },
    ])
      expect(receivingReadinessSchema.safeParse({ ...result, ...change }).success).toBe(false);
  });
  it("refuses a complete result with an error or a blocked result without one", () => {
    const issue = {
      severity: "error",
      group: "lines",
      line: 1,
      field: "coverage",
      code: "coverage_unresolved",
      detail: "coverageStatus",
    };
    expect(receivingReadinessSchema.safeParse({ ...result, issues: [issue] }).success).toBe(false);
    expect(receivingReadinessSchema.safeParse({ ...result, state: "blocked" }).success).toBe(false);
    expect(
      receivingReadinessSchema.safeParse({ ...result, state: "blocked", issues: [issue] }).success,
    ).toBe(true);
    expect(
      receivingReadinessSchema.safeParse({ ...result, issues: [{ ...issue, severity: "warning" }] })
        .success,
    ).toBe(true);
  });
  it("rejects raw server text and impossible issue positions", () => {
    const issue = {
      severity: "error",
      group: "header",
      line: null,
      field: "location",
      code: "incomplete_description",
      detail: "phoneNumber",
    };
    for (const change of [
      { line: 1 },
      { line: 0 },
      { code: "SQL failure" },
      { detail: "private data" },
      { message: "secret" },
    ])
      expect(
        receivingReadinessSchema.safeParse({
          ...result,
          state: "blocked",
          issues: [{ ...issue, ...change }],
        }).success,
      ).toBe(false);
  });
  it("accepts the typed GTIN product-format detail without exposing raw data", () => {
    const issue = {
      severity: "error",
      group: "lines",
      line: 1,
      field: "product",
      code: "format",
      detail: "gtin",
    };
    expect(
      receivingReadinessSchema.parse({ ...result, state: "blocked", issues: [issue] }).issues,
    ).toEqual([issue]);
  });
});
