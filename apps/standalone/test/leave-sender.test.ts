import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { markLeave } from "../src/floor/shifts/shift-participation.js";
import { HostError } from "../src/host/client.js";
import { deviceShiftSchema, type DeviceShift } from "../src/host/protocol.js";
import { sendPendingLeaves } from "../src/local/leave-sender.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { SHARED, SHARED_ENTERED } from "./support/multi-station.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const AT = "2026-10-08T10:00:00.000Z";
const NOW = () => new Date("2026-10-08T10:00:05.000Z");
const pauseRow = z.object({
  leave_requested_at: z.string().nullable(),
  my_state: z.string().nullable(),
});
/** The host's answer to the leave: this station `left`, read at 10:00:06. */
const LEFT: DeviceShift = deviceShiftSchema.parse({
  ...SHARED,
  myState: "left",
  totals: { accepted: 547, boxesClosed: 45, pallets: 0, asOf: "2026-10-08T10:00:06Z" },
});

async function paused() {
  const opened = openLocalDb();
  await keepEnteredShift(opened.executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", 1);
  expect(await markLeave(opened.executor, PAIRING, SHARED.id, AT)).toBe(true);
  const row = () =>
    opened.executor.query(
      "SELECT leave_requested_at, my_state FROM floor_shift_participation",
      [],
      pauseRow,
    );
  return { ...opened, row };
}

describe("this station's pause of a shared shift (plan 2b, host D5)", () => {
  it("is asked only of a part that is active here and of a shift open and not closing here", async () => {
    const { db, executor } = await paused();
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = NULL").run();
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(SHARED.id);
    expect(await markLeave(executor, PAIRING, SHARED.id, AT)).toBe(false);
    db.prepare("UPDATE floor_shifts SET local_state = NULL WHERE id = ?").run(SHARED.id);
    db.prepare("UPDATE floor_shift_participation SET my_state = 'left'").run();
    expect(await markLeave(executor, PAIRING, SHARED.id, AT)).toBe(false);
    // A shift with no figures (a planned one, a host before protocol 7) owes the host no pause.
    expect(await markLeave(executor, PAIRING, "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a", AT)).toBe(
      false,
    );
  });

  it("is sent with this station's leave token, the host's answer kept, and settled", async () => {
    const { executor, row } = await paused();
    const leave = vi.fn(async () => LEFT);
    expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({ sent: 1, stale: 0 });
    // The token is this station's own `joinedRev` from its entry answer (host `651eb1c06`).
    expect(leave).toHaveBeenCalledWith(SHARED.id, { joinedRev: 12 });
    expect(await row()).toEqual([{ leave_requested_at: null, my_state: "left" }]);
    // Nothing is owed any more: nothing goes again.
    expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({ sent: 0, stale: 0 });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("goes with no body when no answer named the token (an older host)", async () => {
    const { db, executor } = await paused();
    db.prepare("UPDATE floor_shift_participation SET joined_rev = NULL").run();
    const leave = vi.fn(async () => LEFT);
    await sendPendingLeaves(executor, PAIRING, leave, NOW);
    expect(leave).toHaveBeenCalledWith(SHARED.id, null);
  });

  it("is settled as already re-entered when the host answers the part still active (a stale token)", async () => {
    const { executor, row } = await paused();
    // The host saw a later entry (a return from `left` stamps a new token): it wrote nothing and
    // answers the shift as it is, this station active, read at 10:00:06.
    const stillIn = deviceShiftSchema.parse({
      ...SHARED,
      myState: "active",
      totals: { accepted: 560, boxesClosed: 46, pallets: 0, asOf: "2026-10-08T10:00:06Z" },
    });
    const leave = vi.fn(async () => stillIn);
    expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({ sent: 0, stale: 1 });
    expect(await row()).toEqual([{ leave_requested_at: null, my_state: "active" }]);
  });

  it("is settled without an answer when the host owes nothing: never entered, or no such shift", async () => {
    for (const refusal of [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "shift_not_entered" },
      }),
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such shift" }),
    ]) {
      const { executor, row } = await paused();
      expect(
        await sendPendingLeaves(
          executor,
          PAIRING,
          vi.fn(async () => Promise.reject(refusal)),
          NOW,
        ),
      ).toEqual({ sent: 0, stale: 0 });
      expect(await row()).toEqual([{ leave_requested_at: null, my_state: "active" }]);
    }
  });

  it("is kept when the host did not hear it, for the link's next try", async () => {
    const { executor, row } = await paused();
    const away = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    await expect(
      sendPendingLeaves(
        executor,
        PAIRING,
        vi.fn(async () => Promise.reject(away)),
        NOW,
      ),
    ).rejects.toBe(away);
    expect(await row()).toEqual([{ leave_requested_at: AT, my_state: "active" }]);
  });

  describe("with several pauses, one failing does not hold the others", () => {
    const SECOND = "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a";
    const both = z.object({ shift_id: z.string(), leave_requested_at: z.string().nullable() });

    /** Two pauses, the first (older) of the shared shift, the second of a copy of it. */
    async function twoPaused() {
      const opened = await paused();
      // A copy of the row under another shift id, asked a second later.
      const columns = (
        opened.db.prepare("PRAGMA table_info(floor_shift_participation)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      const select = columns
        .map((c) =>
          c === "shift_id" ? "?" : c === "leave_requested_at" ? "'2026-10-08T10:00:01.000Z'" : c,
        )
        .join(", ");
      opened.db
        .prepare(
          `INSERT INTO floor_shift_participation (${columns.join(", ")}) SELECT ${select} FROM floor_shift_participation`,
        )
        .run(SECOND);
      const rows = () =>
        opened.executor.query(
          "SELECT shift_id, leave_requested_at FROM floor_shift_participation ORDER BY shift_id",
          [],
          both,
        );
      return { ...opened, rows };
    }
    const refusal = (code: string, status: number, details?: Record<string, unknown>) =>
      new HostError({
        kind: "api",
        code,
        status,
        message: "no",
        ...(details === undefined ? {} : { details }),
      });

    it("settles a permanent refusal of the first and still sends the second", async () => {
      const { executor, rows } = await twoPaused();
      const leave = vi.fn(async (id: string) => {
        if (id === SHARED.id) throw refusal("validation_failed", 400);
        return LEFT;
      });
      expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({
        sent: 1,
        stale: 0,
      });
      expect(leave).toHaveBeenCalledTimes(2);
      expect((await rows()).map((r) => r.leave_requested_at)).toEqual([null, null]);
    });

    it("keeps a pause that may still succeed and sends the next, then surfaces the error", async () => {
      for (const failure of [
        new HostError({ kind: "transport", code: "timeout", message: "slow" }),
        refusal("internal", 500),
        refusal("unauthorized", 401, { credential: "device" }),
        refusal("forbidden", 403),
        refusal("conflict", 409, { constraint: "something_new" }),
      ]) {
        const { executor, rows } = await twoPaused();
        const leave = vi.fn(async (id: string) => {
          if (id === SHARED.id) throw failure;
          return LEFT;
        });
        await expect(sendPendingLeaves(executor, PAIRING, leave, NOW)).rejects.toBe(failure);
        expect(leave).toHaveBeenCalledTimes(2);
        const kept = (await rows()).filter((r) => r.leave_requested_at !== null);
        expect(kept.map((r) => r.shift_id)).toEqual([SHARED.id]);
      }
    });

    it("surfaces a refused key even when an earlier pause failed for another reason", async () => {
      const { executor } = await twoPaused();
      const away = new HostError({ kind: "transport", code: "unreachable", message: "down" });
      const rejected = refusal("unauthorized", 401, { credential: "device" });
      const leave = vi.fn(async (id: string) => {
        throw id === SHARED.id ? away : rejected;
      });
      await expect(sendPendingLeaves(executor, PAIRING, leave, NOW)).rejects.toBe(rejected);
    });
  });

  it("is not settled by the answer of an older request when a newer one was asked meanwhile", async () => {
    const { db, executor, row } = await paused();
    const leave = vi.fn(async () => {
      db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
        "2026-10-08T10:00:03.000Z",
      );
      return LEFT;
    });
    await sendPendingLeaves(executor, PAIRING, leave, NOW);
    expect(await row()).toEqual([
      { leave_requested_at: "2026-10-08T10:00:03.000Z", my_state: "left" },
    ]);
  });
});
