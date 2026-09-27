import { expect, it } from "vitest";
import { transformationReadinessSchema } from "../src/index.js";

it("ties complete state to absence of issues and rejects hidden response data", () => {
  const valid = {
    eventId: "00000000-0000-4000-8000-000000000001",
    state: "complete",
    ruleVersion: "transformation-readiness-v1",
    expectedDraftVersion: 1,
    inputDigest: "a".repeat(64),
    issues: [],
  };
  expect(transformationReadinessSchema.safeParse(valid).success).toBe(true);
  expect(transformationReadinessSchema.safeParse({ ...valid, state: "incomplete" }).success).toBe(
    false,
  );
  expect(
    transformationReadinessSchema.safeParse({ ...valid, tenantId: valid.eventId }).success,
  ).toBe(false);
});
