import { describe, expect, it } from "vitest";

import type { LocalExecutor } from "../src/local/executor.js";
import { countUnsentRecords } from "../src/local/outbox.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

function record(id: string, deviceId: string, acked: boolean) {
  return {
    sql:
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
      "outcome, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', '{}', ?, ?, ?)",
    values: [
      id,
      HOST_ID,
      deviceId,
      "2026-10-09T08:00:00.000Z",
      acked ? "accepted" : null,
      acked ? "2026-10-09T08:00:01.000Z" : null,
    ],
  };
}

describe("the unsent records of the outbox", () => {
  it("are counted for the pairing, or for every pairing when it is unknown", async () => {
    const { executor } = openLocalDb();
    expect(await countUnsentRecords(executor, PAIRING)).toBe(0);
    expect(await countUnsentRecords(executor, null)).toBe(0);
    await executor.transaction([
      record("a", DEVICE_ID, false),
      record("b", DEVICE_ID, false),
      record("c", DEVICE_ID, true),
      record("d", OTHER_DEVICE, false),
    ]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(2);
    expect(await countUnsentRecords(executor, null)).toBe(3);
  });

  it("are counted for the host of the pairing only", async () => {
    const { executor } = openLocalDb();
    await executor.transaction([
      record("a", DEVICE_ID, false),
      {
        ...record("b", DEVICE_ID, false),
        // The same device id under another host is another pairing.
        values: [
          "b",
          "6d1f3a5b-7c9e-4b0d-8a2c-4e6f8091a2b3",
          DEVICE_ID,
          "2026-10-09T08:00:00.000Z",
          null,
          null,
        ],
      },
    ]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(1);
    expect(await countUnsentRecords(executor, null)).toBe(2);
  });

  it("count the warehouse reprint's records without the host's receipt with the facts (plan СКЛ)", async () => {
    const { executor } = openLocalDb();
    const warehouse = (id: string, deviceId: string, receipt: string | null) => ({
      sql:
        "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at, " +
        "outcome, acked_at) VALUES (?, ?, ?, 's', '{}', ?, ?, ?)",
      values: [
        id,
        HOST_ID,
        deviceId,
        "2026-10-09T08:00:00.000Z",
        receipt,
        receipt === null ? null : "2026-10-09T08:00:01.000Z",
      ],
    });
    await executor.transaction([
      record("a", DEVICE_ID, false),
      warehouse("w1", DEVICE_ID, null),
      warehouse("w2", DEVICE_ID, null),
      warehouse("w3", DEVICE_ID, "accepted"),
      warehouse("w4", DEVICE_ID, "rejected"),
      warehouse("w5", OTHER_DEVICE, null),
      {
        ...warehouse("w6", DEVICE_ID, null),
        values: ["w6", "another-host", DEVICE_ID, "2026-10-09T08:00:00.000Z", null, null],
      },
    ]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(3);
    expect(await countUnsentRecords(executor, null)).toBe(5);
  });

  it("are unknown when the database cannot be read", async () => {
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    expect(await countUnsentRecords(failing, PAIRING)).toBeNull();
    expect(await countUnsentRecords(failing, null)).toBeNull();
  });
});
