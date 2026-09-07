import { describe, expect, it } from "vitest";
import { receivingRevisionReadinessSchema, receivingReadinessSchema } from "../src/index.js";

const root = "a0000000-0000-4000-8000-000000000001";
const amendment = "a0000000-0000-4000-8000-000000000002";
const ready = {
  eventId: amendment,
  rootId: root,
  previousRevisionId: root,
  expectedLifecycleVersion: 3,
  draftVersion: 2,
  checkedAt: "2026-09-08T10:00:00.000Z",
  inputDigest: "a".repeat(64),
  ruleVersion: "receiving-readiness-v4",
  profileCode: "US_FSMA204_PROCESSOR",
  state: "complete",
  issues: [],
  exemptReviewRequiredLines: [1, 3],
};
describe("Receiving revision readiness v4", () => {
  it("binds an amendment to exact root/predecessor/version without changing its payload", () => {
    expect(receivingRevisionReadinessSchema.parse(ready)).toEqual(ready);
    expect(
      receivingRevisionReadinessSchema.parse({
        ...ready,
        eventId: root,
        previousRevisionId: null,
        expectedLifecycleVersion: 1,
      }),
    ).toMatchObject({ eventId: root, previousRevisionId: null });
  });
  it.each([
    { rootId: "bad" },
    { expectedLifecycleVersion: 0 },
    { expectedLifecycleVersion: "3" },
    { expectedLifecycleVersion: 2147483648 },
    { previousRevisionId: undefined },
    { previousRevisionId: amendment },
    { previousRevisionId: null },
    { eventId: root },
    { ruleVersion: "receiving-readiness-v3" },
    { state: "finalized" },
    { extra: true },
    { exemptReviewRequiredLines: [3, 1] },
    { exemptReviewRequiredLines: [1, 1] },
  ])("rejects uncorrelated or malformed readiness %j", (patch) => {
    expect(receivingRevisionReadinessSchema.safeParse({ ...ready, ...patch }).success).toBe(false);
  });
  it("retains the typed issue/state invariant and rejects raw errors", () => {
    const issue = {
      severity: "error",
      group: "lines",
      line: 1,
      field: "lot",
      code: "inactive",
      detail: null,
    };
    expect(receivingRevisionReadinessSchema.safeParse({ ...ready, issues: [issue] }).success).toBe(
      false,
    );
    expect(receivingRevisionReadinessSchema.safeParse({ ...ready, state: "blocked" }).success).toBe(
      false,
    );
    expect(
      receivingRevisionReadinessSchema.parse({ ...ready, state: "blocked", issues: [issue] })
        .issues,
    ).toEqual([issue]);
    expect(
      receivingRevisionReadinessSchema.safeParse({
        ...ready,
        state: "blocked",
        issues: [{ ...issue, message: "private" }],
      }).success,
    ).toBe(false);
  });
  it("keeps legacy readiness version-pinned", () => {
    const v3 = {
      eventId: ready.eventId,
      draftVersion: ready.draftVersion,
      checkedAt: ready.checkedAt,
      inputDigest: ready.inputDigest,
      ruleVersion: "receiving-readiness-v3",
      profileCode: ready.profileCode,
      state: ready.state,
      issues: ready.issues,
      exemptReviewRequiredLines: ready.exemptReviewRequiredLines,
    };
    expect(receivingReadinessSchema.parse(v3)).toEqual(v3);
    expect(receivingReadinessSchema.safeParse(ready).success).toBe(false);
    expect(receivingRevisionReadinessSchema.safeParse(v3).success).toBe(false);
  });
});
