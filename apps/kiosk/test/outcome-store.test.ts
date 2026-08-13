import { describe, expect, it } from "vitest";
import {
  acknowledgeOutcome,
  findOldestUnviewedOutcome,
  putOutcome,
  type OutcomeOwner,
} from "../src/store/outcomes.js";

const owner: OutcomeOwner = {
  serverUrl: "https://tenant.example/api",
  kioskId: "k-1",
  credentialGeneration: "generation-1",
};

describe("stored kiosk outcomes", () => {
  it("upserts per owner/deviceSeq and reveals only the same employee and owner", async () => {
    const outcome = {
      owner,
      deviceSeq: 7,
      employeeId: "e1",
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: null,
      kind: "accepted" as const,
      orderNo: "ORD-7",
      acceptedCount: 13,
      acceptedBoxes: [{ sscc: "346006820000000021", bottleCount: 12 }],
      rejected: [],
    };
    await putOutcome(outcome);
    await putOutcome({ ...outcome, at: "2026-08-13T12:01:00.000Z" });

    await expect(findOldestUnviewedOutcome(owner, "e2")).resolves.toBeNull();
    await expect(
      findOldestUnviewedOutcome({ ...owner, credentialGeneration: "generation-2" }, "e1"),
    ).resolves.toBeNull();
    await expect(findOldestUnviewedOutcome(owner, "e1")).resolves.toMatchObject({
      deviceSeq: 7,
      at: "2026-08-13T12:01:00.000Z",
      viewedAt: null,
    });
  });

  it("marks a result viewed only after explicit acknowledgement", async () => {
    await putOutcome({
      owner,
      deviceSeq: 8,
      employeeId: "e1",
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: null,
      kind: "rejected",
      orderNo: null,
      acceptedCount: 0,
      acceptedBoxes: [],
      rejected: [{ kind: "box", sscc: "346006820000000021", bottleCount: 12, reason: "duplicate" }],
    });
    expect((await findOldestUnviewedOutcome(owner, "e1"))?.deviceSeq).toBe(8);
    await acknowledgeOutcome(owner, 8, "2026-08-13T12:05:00.000Z");
    await expect(findOldestUnviewedOutcome(owner, "e1")).resolves.toBeNull();
  });

  it("bounds one owner generation to the newest one hundred results", async () => {
    for (let deviceSeq = 1; deviceSeq <= 101; deviceSeq += 1) {
      await putOutcome({
        owner,
        deviceSeq,
        employeeId: "e1",
        at: new Date(Date.UTC(2026, 7, 13, 12, deviceSeq)).toISOString(),
        viewedAt: null,
        kind: "accepted",
        orderNo: `ORD-${deviceSeq}`,
        acceptedCount: 1,
        acceptedBoxes: [],
        rejected: [],
      });
    }
    expect((await findOldestUnviewedOutcome(owner, "e1"))?.deviceSeq).toBe(2);
  });
});
