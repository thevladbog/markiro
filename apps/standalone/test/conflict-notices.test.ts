import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CONFLICT_COUNT_SQL } from "../src/floor/outbox-status.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import {
  deviceDisplacementsSchema,
  type ConflictStatusRequest,
  type DeviceDisplacement,
  type DeviceDisplacements,
} from "../src/host/review.js";
import {
  NOTICE_STATUS_CHUNK,
  readConflictNotices,
  type NoticeContext,
} from "../src/local/conflict-notices.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { PAIRING, rows, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const PAGE: DeviceDisplacements = deviceDisplacementsSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/device-displacements.json", testModuleUrl), "utf8"),
  ),
);
function firstOf(page: DeviceDisplacements): DeviceDisplacement {
  const [first] = page.items;
  if (first === undefined) throw new Error("the fixture holds a displacement");
  return first;
}
const FIRST = firstOf(PAGE);
const NOW = new Date("2026-10-11T09:00:00.000Z");
const AT = "2026-10-11T08:00:00.000Z";
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const NONE: DeviceDisplacements = { items: [], more: false };

function conflicted(db: DatabaseSync, ids: readonly string[]): void {
  const statement = db.prepare(
    "UPDATE outbox SET outcome = 'conflict', outcome_details = '{}', acked_at = ? WHERE id = ?",
  );
  for (const id of ids) statement.run(AT, id);
}

function displacement(n: number, fields: Partial<DeviceDisplacement> = {}): DeviceDisplacement {
  return {
    ...FIRST,
    conflictId: `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    recordId: `00000000-0000-4000-8000-d${String(n).padStart(11, "0")}`,
    ...fields,
  };
}

function context(
  local: LocalExecutor,
  conflictStatus: HostApi["conflictStatus"],
  listDisplacements: HostApi["listDisplacements"] = vi.fn(async () => NONE),
): NoticeContext {
  return { local, pairing: PAIRING, conflictStatus, listDisplacements, now: () => NOW };
}

function noStatus(): HostApi["conflictStatus"] {
  return vi.fn<HostApi["conflictStatus"]>(async () => ({ reviewed: [] }));
}

async function conflictCount(local: LocalExecutor): Promise<unknown> {
  return local.query(CONFLICT_COUNT_SQL, [PAIRING.hostId, PAIRING.deviceId], countRow);
}

const countRow = z.object({ n: z.number() });

describe("what the host tells the station of its conflicts (plan КНФ)", () => {
  it("resolves the conflicts the office reviewed, by nobody of this station, and touches nothing else", async () => {
    const { db, executor } = openLocalDb();
    const [first = "", second = ""] = await unsentScans(executor, 2);
    const [foreign = ""] = await unsentScans(executor, 1, OTHER_PAIRING, 50);
    conflicted(db, [first, second, foreign]);
    const status = vi.fn<HostApi["conflictStatus"]>(async () => ({
      reviewed: [
        { recordId: first, reviewedAt: "2026-10-11T07:00:00Z" },
        // The host names only what it was asked; another pairing's record is ignored.
        { recordId: foreign, reviewedAt: "2026-10-11T07:00:00Z" },
      ],
    }));
    await expect(readConflictNotices(context(executor, status))).resolves.toEqual({
      changed: true,
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith({ recordIds: [first, second].sort() });
    expect(
      rows(
        db,
        "SELECT id, resolution, resolved_at, resolved_by, office_reviewed_at FROM outbox ORDER BY id",
      ),
    ).toEqual([
      {
        id: first,
        resolution: "dismissed",
        resolved_at: NOW.toISOString(),
        resolved_by: null,
        office_reviewed_at: "2026-10-11T07:00:00Z",
      },
      {
        id: second,
        resolution: null,
        resolved_at: null,
        resolved_by: null,
        office_reviewed_at: null,
      },
      {
        id: foreign,
        resolution: null,
        resolved_at: null,
        resolved_by: null,
        office_reviewed_at: null,
      },
    ]);
    expect(await conflictCount(executor)).toEqual([{ n: 1 }]);
  });

  it("keeps each displacement once and asks for the next after its cursor", async () => {
    const { db, executor } = openLocalDb();
    const list = vi
      .fn<HostApi["listDisplacements"]>()
      .mockResolvedValueOnce(PAGE)
      .mockResolvedValue(NONE);
    const status = noStatus();
    await expect(readConflictNotices(context(executor, status, list))).resolves.toEqual({
      changed: true,
    });
    expect(list).toHaveBeenNthCalledWith(1, null);
    expect(rows(db, "SELECT * FROM floor_displacements")).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        conflict_id: FIRST.conflictId,
        record_id: FIRST.recordId,
        shift_id: FIRST.shiftId,
        code_hash: FIRST.codeHash,
        box_id: FIRST.boxId,
        detected_at: FIRST.detectedAt,
        winner_shift_number: FIRST.winner.shiftNumber,
        winner_same_device: 0,
        winner_scanned_at: FIRST.winner.scannedAt,
        learned_at: NOW.toISOString(),
        resolved_at: null,
        resolved_by: null,
        office_reviewed_at: null,
      },
    ]);
    // The open displacement was asked after in the same read.
    expect(status).toHaveBeenCalledWith({ recordIds: [FIRST.recordId] });
    // The next read starts after it, and the same displacement sent again stays one row.
    list.mockResolvedValueOnce(PAGE);
    await readConflictNotices(context(executor, status, list));
    expect(list).toHaveBeenNthCalledWith(2, { at: FIRST.detectedAt, id: FIRST.conflictId });
    expect(rows(db, "SELECT count(*) AS n FROM floor_displacements")).toEqual([{ n: 1 }]);
  });

  it("keeps a displacement the office reviewed already as resolved, and one of the same station as such", async () => {
    const { db, executor } = openLocalDb();
    const list = vi.fn<HostApi["listDisplacements"]>(async () => ({
      items: [
        displacement(1, { reviewedAt: "2026-10-11T07:30:00Z" }),
        displacement(2, { winner: { ...FIRST.winner, sameDevice: true } }),
      ],
      more: false,
    }));
    await readConflictNotices(context(executor, noStatus(), list));
    expect(
      rows(
        db,
        "SELECT conflict_id, winner_same_device, resolved_at, resolved_by, office_reviewed_at " +
          "FROM floor_displacements ORDER BY conflict_id",
      ),
    ).toEqual([
      {
        conflict_id: displacement(1).conflictId,
        winner_same_device: 0,
        resolved_at: NOW.toISOString(),
        resolved_by: null,
        office_reviewed_at: "2026-10-11T07:30:00Z",
      },
      {
        conflict_id: displacement(2).conflictId,
        winner_same_device: 1,
        resolved_at: null,
        resolved_by: null,
        office_reviewed_at: null,
      },
    ]);
  });

  it("resolves an open displacement the office reviewed later", async () => {
    const { db, executor } = openLocalDb();
    await readConflictNotices(
      context(
        executor,
        noStatus(),
        vi.fn(async () => PAGE),
      ),
    );
    const status = vi.fn<HostApi["conflictStatus"]>(async () => ({
      reviewed: [{ recordId: FIRST.recordId, reviewedAt: "2026-10-11T08:30:00Z" }],
    }));
    await expect(readConflictNotices(context(executor, status))).resolves.toEqual({
      changed: true,
    });
    expect(
      rows(db, "SELECT resolved_at, resolved_by, office_reviewed_at FROM floor_displacements"),
    ).toEqual([
      {
        resolved_at: NOW.toISOString(),
        resolved_by: null,
        office_reviewed_at: "2026-10-11T08:30:00Z",
      },
    ]);
  });

  it("asks after 450 open records in parts of 200", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 450);
    conflicted(db, ids);
    const status = vi.fn<HostApi["conflictStatus"]>(async () => ({ reviewed: [] }));
    await expect(readConflictNotices(context(executor, status))).resolves.toEqual({
      changed: false,
    });
    expect(NOTICE_STATUS_CHUNK).toBe(200);
    expect(
      status.mock.calls.map(([request]: [ConflictStatusRequest]) => request.recordIds.length),
    ).toEqual([200, 200, 50]);
    expect(status.mock.calls.flatMap(([request]) => request.recordIds)).toEqual([...ids].sort());
  });

  it("reads the next page after the last row of one that says more", async () => {
    const { db, executor } = openLocalDb();
    const list = vi
      .fn<HostApi["listDisplacements"]>()
      .mockResolvedValueOnce({ items: [displacement(1), displacement(2)], more: true })
      .mockResolvedValueOnce({ items: [displacement(3)], more: false });
    await readConflictNotices(context(executor, noStatus(), list));
    expect(list.mock.calls).toEqual([
      [null],
      [{ at: FIRST.detectedAt, id: displacement(2).conflictId }],
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_displacements")).toEqual([{ n: 3 }]);
  });

  it("learns nothing and fails nothing from a host that does not know the routes yet", async () => {
    const { db, executor } = openLocalDb();
    const [record = ""] = await unsentScans(executor, 1);
    conflicted(db, [record]);
    const older = new HostError({
      kind: "api",
      code: "not_found",
      status: 404,
      message: "no route",
    });
    const list = vi.fn<HostApi["listDisplacements"]>(async () => Promise.reject(older));
    const status = vi.fn<HostApi["conflictStatus"]>(async () => Promise.reject(older));
    await expect(readConflictNotices(context(executor, status, list))).resolves.toEqual({
      changed: false,
    });
    expect(rows(db, "SELECT resolved_at FROM outbox")).toEqual([{ resolved_at: null }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_displacements")).toEqual([{ n: 0 }]);
  });

  it("rejects on a failure of the link, for the link to try again", async () => {
    const { executor } = openLocalDb();
    const lost = new HostError({ kind: "transport", code: "unreachable", message: "x" });
    const list = vi.fn<HostApi["listDisplacements"]>(async () => Promise.reject(lost));
    await expect(readConflictNotices(context(executor, noStatus(), list))).rejects.toBe(lost);
  });

  it("asks nothing when nothing is open", async () => {
    const { db, executor } = openLocalDb();
    const [accepted = ""] = await unsentScans(executor, 1);
    db.prepare("UPDATE outbox SET outcome = 'accepted', acked_at = ? WHERE id = ?").run(
      AT,
      accepted,
    );
    const status = noStatus();
    await expect(readConflictNotices(context(executor, status))).resolves.toEqual({
      changed: false,
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("asks only after this pairing's own displacements", async () => {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
        "code_hash, detected_at, winner_shift_number, winner_same_device, winner_scanned_at, " +
        "learned_at) VALUES (?, ?, 'c-other', 'r-other', 's', ?, ?, 'N', 0, ?, ?)",
    ).run(OTHER_PAIRING.hostId, OTHER_PAIRING.deviceId, FIRST.codeHash, AT, AT, AT);
    const list = vi.fn<HostApi["listDisplacements"]>(async () => NONE);
    const status = noStatus();
    await readConflictNotices(context(executor, status, list));
    // Another pairing's newest row is no cursor of this one, and its record is not asked after.
    expect(list).toHaveBeenCalledWith(null);
    expect(status).not.toHaveBeenCalled();
  });
});
