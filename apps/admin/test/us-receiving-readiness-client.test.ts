import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
const id = "a0000000-0000-4000-8000-000000000001";
const result = {
  eventId: id,
  draftVersion: 7,
  checkedAt: "2026-09-07T10:00:00.000Z",
  inputDigest: "a".repeat(64),
  ruleVersion: "receiving-readiness-v3",
  exemptReviewRequiredLines: [],
  profileCode: "US_FSMA204_PROCESSOR",
  state: "complete",
  issues: [],
};
describe("read-only readiness browser boundary", () => {
  it("requests the exact saved version without a mutation body", async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json(result));
    expect(await createUsBrowserClient(send).checkReceivingReadiness(id.toUpperCase(), 7)).toEqual(
      result,
    );
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/receiving/${id}/readiness?expectedDraftVersion=7`,
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(send.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it("never accepts a different draft/version or contradictory success", async () => {
    for (const change of [
      { eventId: "b0000000-0000-4000-8000-000000000001" },
      { draftVersion: 8 },
      { state: "blocked" },
    ]) {
      const send = vi.fn<typeof fetch>(async () => Response.json({ ...result, ...change }));
      await expect(
        createUsBrowserClient(send).checkReceivingReadiness(id, 7),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rejects invalid inputs before network and preserves safe stale-version errors", async () => {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ code: "receiving_draft_conflict" }, { status: 409 }),
    );
    const client = createUsBrowserClient(send);
    await expect(client.checkReceivingReadiness(id, 0)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
    await expect(client.checkReceivingReadiness(id, 7)).rejects.toMatchObject({
      code: "receiving_draft_conflict",
    });
  });
});
