import { describe, expect, it } from "vitest";
import {
  acknowledgeOutcome,
  findOldestUnviewedOutcome,
  putOutcome,
  readOutcome,
  type OutcomeOwner,
} from "../src/store/outcomes.js";
import { STORE_OUTCOMES, withStore } from "../src/store/db.js";

const owner: OutcomeOwner = {
  serverUrl: "https://tenant.example/api",
  kioskId: "11111111-1111-4111-8111-111111111111",
  credentialGeneration: "33333333-3333-4333-8333-333333333333",
};

describe("stored kiosk outcomes", () => {
  it("upserts per owner/deviceSeq and reveals only the same employee and owner", async () => {
    const outcome = {
      owner,
      deviceSeq: 7,
      employeeId: "22222222-2222-4222-8222-222222222222",
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

    await expect(
      findOldestUnviewedOutcome(owner, "99999999-9999-4999-8999-999999999999"),
    ).resolves.toBeNull();
    await expect(
      findOldestUnviewedOutcome(
        { ...owner, credentialGeneration: "44444444-4444-4444-8444-444444444444" },
        "22222222-2222-4222-8222-222222222222",
      ),
    ).resolves.toBeNull();
    await expect(
      findOldestUnviewedOutcome(owner, "22222222-2222-4222-8222-222222222222"),
    ).resolves.toMatchObject({
      deviceSeq: 7,
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: null,
    });
  });

  it("keeps the first timestamp and acknowledgement when a delivered order replays", async () => {
    const base = {
      owner,
      employeeId: "22222222-2222-4222-8222-222222222222",
      viewedAt: null,
      kind: "accepted" as const,
      orderNo: "ORD-7",
      acceptedCount: 1,
      acceptedBoxes: [],
      rejected: [],
    };
    await putOutcome({ ...base, deviceSeq: 17, at: "2026-08-13T12:00:00.000Z" });
    await putOutcome({ ...base, deviceSeq: 18, at: "2026-08-13T12:01:00.000Z" });
    await acknowledgeOutcome(owner, 17, "2026-08-13T12:05:00.000Z");

    await putOutcome({ ...base, deviceSeq: 17, at: "2026-08-13T13:00:00.000Z" });

    await expect(readOutcome(owner, 17)).resolves.toMatchObject({
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: "2026-08-13T12:05:00.000Z",
    });
    await expect(
      findOldestUnviewedOutcome(owner, "22222222-2222-4222-8222-222222222222"),
    ).resolves.toMatchObject({
      deviceSeq: 18,
      at: "2026-08-13T12:01:00.000Z",
    });
  });

  it("marks a result viewed only after explicit acknowledgement", async () => {
    await putOutcome({
      owner,
      deviceSeq: 8,
      employeeId: "22222222-2222-4222-8222-222222222222",
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: null,
      kind: "rejected",
      orderNo: null,
      acceptedCount: 0,
      acceptedBoxes: [],
      rejected: [{ kind: "box", sscc: "346006820000000021", bottleCount: 12, reason: "duplicate" }],
    });
    expect(
      (await findOldestUnviewedOutcome(owner, "22222222-2222-4222-8222-222222222222"))?.deviceSeq,
    ).toBe(8);
    await acknowledgeOutcome(owner, 8, "2026-08-13T12:05:00.000Z");
    await expect(
      findOldestUnviewedOutcome(owner, "22222222-2222-4222-8222-222222222222"),
    ).resolves.toBeNull();
  });

  it("bounds one owner generation to the newest one hundred results", async () => {
    for (let deviceSeq = 1; deviceSeq <= 101; deviceSeq += 1) {
      await putOutcome({
        owner,
        deviceSeq,
        employeeId: "22222222-2222-4222-8222-222222222222",
        at: new Date(Date.UTC(2026, 7, 13, 12, deviceSeq)).toISOString(),
        viewedAt: null,
        kind: "accepted",
        orderNo: `ORD-${deviceSeq}`,
        acceptedCount: 1,
        acceptedBoxes: [],
        rejected: [],
      });
    }
    expect(
      (await findOldestUnviewedOutcome(owner, "22222222-2222-4222-8222-222222222222"))?.deviceSeq,
    ).toBe(2);
  });

  it("rejects injected records whose key, owner, dates, SSCC, reason or text are invalid", async () => {
    await putOutcome({
      owner,
      deviceSeq: 30,
      employeeId: "22222222-2222-4222-8222-222222222222",
      at: "2026-08-13T12:00:00.000Z",
      viewedAt: null,
      kind: "rejected",
      orderNo: null,
      acceptedCount: 0,
      acceptedBoxes: [],
      rejected: [{ kind: "box", sscc: "346006820000000021", bottleCount: 12, reason: "duplicate" }],
    });
    const valid = await readOutcome(owner, 30);
    if (!valid?.id) throw new Error("valid outcome missing");

    const invalidRows = [
      { ...valid, owner: { ...valid.owner, kioskId: "other-kiosk" } },
      { ...valid, owner: { ...valid.owner, kioskId: "bad\u001fid" } },
      { ...valid, viewedAt: "not-a-date" },
      {
        ...valid,
        rejected: [
          { kind: "box", sscc: "346006820000000020", bottleCount: 12, reason: "duplicate" },
        ],
      },
      {
        ...valid,
        rejected: [
          { kind: "box", sscc: "346006820000000021", bottleCount: 12, reason: "surprise" },
        ],
      },
      { ...valid, employeeId: "x".repeat(1_025) },
      { ...valid, employeeId: "я".repeat(200) },
      { ...valid, employeeId: "e1" },
      { ...valid, owner: { ...valid.owner, kioskId: "k-1" } },
    ];

    for (const row of invalidRows) {
      await withStore(STORE_OUTCOMES, "readwrite", (store) => store.put(row));
      await expect(readOutcome(owner, 30)).resolves.toBeNull();
    }
  });

  it("rejects acknowledgement when the row is absent or the date is non-canonical", async () => {
    await expect(acknowledgeOutcome(owner, 404, "2026-08-13T12:05:00.000Z")).rejects.toThrow(
      "outcome not found",
    );
    await expect(acknowledgeOutcome(owner, 404, "2026-08-13 12:05:00Z")).rejects.toThrow(
      "invalid viewedAt",
    );
  });
});
