import { describe, expect, it, vi } from "vitest";

import { closeShift } from "../src/floor/close/shift-close.js";
import { undoLastCode } from "../src/floor/exceptions/box-exceptions.js";
import { boxLabelStep, readPrintJob, sendLabelJob } from "../src/floor/print/print-jobs.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import type { EnteredShift } from "../src/host/protocol.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  purgeAcknowledged,
  RETAINED_TABLES,
  RETENTION_INTERVAL_MS,
  scheduleRetention,
  type Every,
} from "../src/local/retention.js";
import {
  ENTERED,
  enteredShift,
  km,
  PAIRING,
  rows,
  scanContext,
  SECOND,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { fakeRender, manualRuntime, printStation, resolveContext } from "./support/printing.js";

type Station = Awaited<ReturnType<typeof printStation>>;

const NOW = new Date("2026-11-08T12:00:00.000Z");
/** 30 days before `NOW`: a close the host took at or before it is done with. */
const CUTOFF = "2026-10-09T12:00:00.000Z";
const THIRD: EnteredShift = {
  ...ENTERED,
  id: "5f8b2d0e-3c6a-4e9f-b4d7-0a1c2e3f4d5b",
  number: "OCT26-006/S",
};
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };

/**
 * A shift worked and closed on this station: two codes, one taken out again,
 * the box closed with its label sent, the shift closed; every record with
 * the receipt `outcome` at `ackedAt`, and the copy `closed` when the host
 * took the close.
 */
async function finished(
  at: Station,
  shift: EnteredShift,
  serial: string,
  ackedAt: string,
  outcome: "accepted" | "rejected" = "accepted",
): Promise<void> {
  const work = await enteredShift(at.local, shift);
  const context = scanContext(at.local, work, { newId: () => crypto.randomUUID() });
  await processScan(context, km(`${serial}1`));
  await processScan(context, km(`${serial}2`));
  await undoLastCode(context);
  const closed = await closeOpenBox(context, [
    boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: work,
      operatorName: "Анна Кузнецова",
      newId: () => `job-${serial}`,
      render: fakeRender,
    }),
  ]);
  if (closed.kind !== "closed") throw new Error(closed.kind);
  const job = await readPrintJob(at.local, PAIRING, `job-${serial}`);
  if (job === null) throw new Error("no job");
  await sendLabelJob(resolveContext(at.local, manualRuntime(fakeHardware().hardware).runtime), job);
  const result = await closeShift(context, "production_defect");
  if (result.kind !== "closed") throw new Error(result.kind);
  at.db
    .prepare("UPDATE outbox SET outcome = ?, acked_at = ? WHERE shift_id = ?")
    .run(outcome, ackedAt, shift.id);
  if (outcome === "accepted") {
    at.db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(shift.id);
  }
}

/** The rows of each table the shift's records live in, the copy's first. */
function kept(at: Station, shiftId: string): Record<string, unknown> {
  const counts: Record<string, unknown> = {
    floor_shifts: rows(at.db, "SELECT count(*) AS n FROM floor_shifts WHERE id = ?", shiftId)[0]?.[
      "n"
    ],
  };
  for (const table of RETAINED_TABLES) {
    counts[table] = rows(
      at.db,
      `SELECT count(*) AS n FROM ${table} WHERE shift_id = ?`,
      shiftId,
    )[0]?.["n"];
  }
  return counts;
}

const FOURTH: EnteredShift = {
  ...ENTERED,
  id: "7c1e3a5b-9d2f-4b6c-8e0a-4f6a8c0e2b4d",
  number: "OCT26-007/S",
};
const OTHER_HOST_PAIRING = { ...PAIRING, hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };

type Pair = typeof PAIRING;

/** The rows of each table the shift's records live in under one pairing, the copy's first. */
function keptFor(at: Station, pairing: Pair, shiftId: string): Record<string, unknown> {
  const counts: Record<string, unknown> = {
    floor_shifts: rows(
      at.db,
      "SELECT count(*) AS n FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ?",
      pairing.hostId,
      pairing.deviceId,
      shiftId,
    )[0]?.["n"],
  };
  for (const table of RETAINED_TABLES) {
    counts[table] = rows(
      at.db,
      `SELECT count(*) AS n FROM ${table} WHERE host_id = ? AND device_id = ? AND shift_id = ?`,
      pairing.hostId,
      pairing.deviceId,
      shiftId,
    )[0]?.["n"];
  }
  return counts;
}

/**
 * Copies every record of one of this station's shifts (the copy and each
 * retained table) to another pairing under the same shift id, as a second
 * pairing on the same computer would hold them: new row ids, a different
 * serial digit so that no unique key meets itself.
 */
function copyRecordsTo(at: Station, shiftId: string, to: Pair, digit: string): void {
  const tag = `~${to.hostId.slice(0, 4)}${to.deviceId.slice(0, 4)}`;
  for (const table of ["floor_shifts", ...RETAINED_TABLES]) {
    const columns = rows(at.db, "SELECT name FROM pragma_table_info(?)", table).map((row) =>
      String(row["name"]),
    );
    const select = columns.map((column) => {
      if (column === "host_id") return `'${to.hostId}'`;
      if (column === "device_id") return `'${to.deviceId}'`;
      if (column === "id" && table !== "floor_shifts") return `id || '${tag}'`;
      if (column === "sscc") return `'${digit}' || substr(sscc, 2)`;
      if (column === "seq") return "NULL";
      return column;
    });
    const own = table === "floor_shifts" ? "id" : "shift_id";
    at.db
      .prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${select.join(", ")} FROM ${table} ` +
          `WHERE host_id = ? AND device_id = ? AND ${own} = ?`,
      )
      .run(PAIRING.hostId, PAIRING.deviceId, shiftId);
  }
}

const NONE = {
  floor_shifts: 0,
  floor_scans: 0,
  floor_exceptions: 0,
  floor_codes: 0,
  floor_print_jobs: 0,
  floor_boxes: 0,
  outbox: 0,
};
const WHOLE = {
  floor_shifts: 1,
  floor_scans: 2,
  floor_exceptions: 1,
  floor_codes: 1,
  floor_print_jobs: 1,
  floor_boxes: 1,
  outbox: 5,
};

describe("the retention of a shift's records on the station", () => {
  it("deletes a shift 30 days after the host took its close, and keeps one taken later", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", CUTOFF);
    await finished(at, SECOND, "B", "2026-10-09T12:00:00.001Z");
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(NONE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
    // The SSCC blocks stay: a restored host asks the station for them.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    expect(await purgeAcknowledged(at.local, PAIRING, new Date("2026-11-08T12:00:00.001Z"))).toBe(
      1,
    );
    expect(kept(at, SECOND.id)).toEqual(NONE);
  });

  it("keeps a shift whose close the host refused, or has not answered", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z", "rejected");
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare(
        "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'shift_closed'",
      )
      .run(SECOND.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
  });

  it("keeps a shift with a record not yet answered or a label that waits", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare(
        "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'scan'",
      )
      .run(ENTERED.id);
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted' WHERE shift_id = ?",
      )
      .run(SECOND.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
  });

  it("leaves another pairing's rows alone, the same shift ids included", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    expect(await purgeAcknowledged(at.local, OTHER_PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
  });

  it("keeps a shift that took a record between its reading and its delete", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    await finished(at, THIRD, "C", "2026-09-01T00:00:00.000Z");
    let first = true;
    const racing = {
      query: at.local.query.bind(at.local),
      transaction: async (statements: Parameters<typeof at.local.transaction>[0]) => {
        if (first) {
          first = false;
          // Another write lands first: a record of the shift without its receipt.
          at.db
            .prepare(
              "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'scan'",
            )
            .run(ENTERED.id);
        }
        return at.local.transaction(statements);
      },
    };
    expect(await purgeAcknowledged(racing, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, THIRD.id)).toEqual(NONE);
  });

  it("names every table of a shift's records: a table with a `shift_id` and no retention fails here", async () => {
    const at = await printStation();
    const withShift = rows(
      at.db,
      "SELECT m.name AS name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS " +
        "(SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'shift_id') ORDER BY m.name",
    ).map((row) => row["name"]);
    expect(withShift).toEqual([...RETAINED_TABLES].sort());
  });
});

describe("the retention of one pairing among others on the same computer", () => {
  it("deletes only its own pairing's rows of a shift id another pairing holds too", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", CUTOFF);
    copyRecordsTo(at, ENTERED.id, OTHER_PAIRING, "7");
    copyRecordsTo(at, ENTERED.id, OTHER_HOST_PAIRING, "8");
    expect(keptFor(at, PAIRING, ENTERED.id)).toEqual(WHOLE);
    expect(keptFor(at, OTHER_PAIRING, ENTERED.id)).toEqual(WHOLE);
    expect(keptFor(at, OTHER_HOST_PAIRING, ENTERED.id)).toEqual(WHOLE);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(keptFor(at, PAIRING, ENTERED.id)).toEqual(NONE);
    expect(keptFor(at, OTHER_PAIRING, ENTERED.id)).toEqual(WHOLE);
    expect(keptFor(at, OTHER_HOST_PAIRING, ENTERED.id)).toEqual(WHOLE);
    // Each of the others is purged by its own pass, and only by it.
    expect(await purgeAcknowledged(at.local, OTHER_PAIRING, NOW)).toBe(1);
    expect(keptFor(at, OTHER_PAIRING, ENTERED.id)).toEqual(NONE);
    expect(keptFor(at, OTHER_HOST_PAIRING, ENTERED.id)).toEqual(WHOLE);
  });

  it("is not held back by another pairing's unanswered record or waiting label of the same shift id", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", CUTOFF);
    copyRecordsTo(at, ENTERED.id, OTHER_PAIRING, "7");
    copyRecordsTo(at, ENTERED.id, OTHER_HOST_PAIRING, "8");
    for (const other of [OTHER_PAIRING, OTHER_HOST_PAIRING]) {
      at.db
        .prepare(
          "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE host_id = ? AND device_id = ? " +
            "AND kind = 'scan'",
        )
        .run(other.hostId, other.deviceId);
    }
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted' " +
          "WHERE NOT (host_id = ? AND device_id = ?)",
      )
      .run(PAIRING.hostId, PAIRING.deviceId);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(keptFor(at, PAIRING, ENTERED.id)).toEqual(NONE);
  });

  it("is not made due by another pairing's accepted close of the same shift id", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z", "rejected");
    copyRecordsTo(at, ENTERED.id, OTHER_PAIRING, "7");
    copyRecordsTo(at, ENTERED.id, OTHER_HOST_PAIRING, "8");
    for (const other of [OTHER_PAIRING, OTHER_HOST_PAIRING]) {
      at.db
        .prepare("UPDATE outbox SET outcome = 'accepted' WHERE host_id = ? AND device_id = ?")
        .run(other.hostId, other.deviceId);
    }
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(keptFor(at, PAIRING, ENTERED.id)).toEqual(WHOLE);
  });
});

describe("the retention among several shifts of one pairing", () => {
  it("takes only the shift that is done with, however its neighbours stand", async () => {
    const at = await printStation();
    // Records without a receipt, a label that waits, a close the host refused, and one done with.
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    await finished(at, THIRD, "C", "2026-09-01T00:00:00.000Z");
    await finished(at, FOURTH, "D", "2026-09-01T00:00:00.000Z", "rejected");
    at.db
      .prepare(
        "UPDATE outbox SET outcome = NULL, acked_at = NULL WHERE shift_id = ? AND kind = 'scan'",
      )
      .run(ENTERED.id);
    at.db
      .prepare(
        "UPDATE floor_print_jobs SET state = 'unknown', error_code = 'interrupted' WHERE shift_id = ?",
      )
      .run(SECOND.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
    expect(kept(at, SECOND.id)).toEqual(WHOLE);
    expect(kept(at, THIRD.id)).toEqual(NONE);
    expect(kept(at, FOURTH.id)).toEqual(WHOLE);
  });

  it("deletes every shift due in one pass and keeps the SSCC blocks and their requests", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", CUTOFF);
    await finished(at, SECOND, "B", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare(
        "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, " +
          "extension, requested_at) VALUES (?, ?, ?, '460068200', 0, ?)",
      )
      .run(crypto.randomUUID(), PAIRING.hostId, PAIRING.deviceId, CUTOFF);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(2);
    expect(kept(at, ENTERED.id)).toEqual(NONE);
    expect(kept(at, SECOND.id)).toEqual(NONE);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 1 }]);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
  });

  it.each([
    ["prepared", "state = 'prepared', attempts = 0, error_code = NULL"],
    ["sending", "state = 'sending', error_code = NULL"],
    ["failed", "state = 'failed', error_code = 'printer_offline'"],
    ["unknown", "state = 'unknown', error_code = 'interrupted'"],
    ["sent and waiting for its check", "state = 'sent', verify = 1, error_code = NULL"],
  ])("keeps a shift whose label is %s", async (_name, change) => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    at.db.prepare(`UPDATE floor_print_jobs SET ${change} WHERE shift_id = ?`).run(ENTERED.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
  });

  it.each([
    ["sent and not to be checked", "state = 'sent', verify = 0, error_code = NULL"],
    ["verified", "state = 'verified', verify = 1, error_code = NULL"],
    ["skipped", "state = 'skipped', error_code = NULL"],
  ])("takes a shift whose label is %s", async (_name, change) => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    at.db.prepare(`UPDATE floor_print_jobs SET ${change} WHERE shift_id = ?`).run(ENTERED.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)).toEqual(NONE);
  });

  it("does not take a shift that has no close of its own on the station, receipts or not", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    at.db
      .prepare("DELETE FROM outbox WHERE shift_id = ? AND kind = 'shift_closed'")
      .run(ENTERED.id);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    expect(kept(at, ENTERED.id)).toEqual({ ...WHOLE, outbox: WHOLE.outbox - 1 });
  });

  it("passes on a failure that is not a shift taking a record meanwhile, and leaves the shift whole", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "A", "2026-09-01T00:00:00.000Z");
    const failing = (error: unknown) => ({
      query: at.local.query.bind(at.local),
      transaction: async () => {
        throw error;
      },
    });
    await expect(
      purgeAcknowledged(failing(new LocalDbError("statement_failed", "disk")), PAIRING, NOW),
    ).rejects.toMatchObject({ code: "statement_failed" });
    await expect(purgeAcknowledged(failing(new Error("boom")), PAIRING, NOW)).rejects.toThrow(
      "boom",
    );
    expect(kept(at, ENTERED.id)).toEqual(WHOLE);
  });
});

describe("the retention pass", () => {
  it("runs at once and then every hour, never two at a time, until stopped", async () => {
    let fire: () => void = () => undefined;
    let interval = 0;
    let stopped = false;
    const every: Every = (ms, callback) => {
      interval = ms;
      fire = callback;
      return () => {
        stopped = true;
      };
    };
    const runs: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          runs.push(resolve);
        }),
    );
    const stop = scheduleRetention(run, every);
    expect(run).toHaveBeenCalledTimes(1);
    expect(interval).toBe(RETENTION_INTERVAL_MS);
    expect(RETENTION_INTERVAL_MS).toBe(3_600_000);
    fire();
    expect(run).toHaveBeenCalledTimes(1);
    runs[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    fire();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    expect(stopped).toBe(true);
  });

  it("runs again after a pass that failed", async () => {
    let fire: () => void = () => undefined;
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk"))
      .mockResolvedValue(undefined);
    scheduleRetention(run, (_ms, callback) => {
      fire = callback;
      return () => undefined;
    });
    await Promise.resolve();
    await Promise.resolve();
    fire();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
