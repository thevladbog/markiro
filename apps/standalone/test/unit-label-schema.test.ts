import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  applyProductLabelEvent,
  DomainError,
  type ProductLabelEvent,
  type ProductLabelJobStatus,
  type ProductLabelProjection,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MOVE_JOB_SQL,
  UNIT_LABEL_ATTEMPT_ERROR_CODES,
  UNIT_LABEL_ATTEMPT_STATES,
  UNIT_LABEL_POLICIES,
  UNIT_LABEL_VERIFICATIONS,
  UNRESOLVED_JOB_SQL,
  UNRESOLVED_UNIT_LABEL_SQL,
} from "../src/floor/unit-labels/unit-label-store.js";
import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const OTHER_HOST = "5d2e8c1a-3b4f-4a6d-9c7e-1f2a3b4c5d6e";
const AT = "2026-10-13T08:00:00.000Z";
const FULL_CODE = "0104600682000013215abc\u001d93Zz";

/**
 * A valid unresolved job of a station of its own, so that a row refused below is refused by the
 * rule under test and not by the one unresolved job of a station.
 */
function job(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: `device-${id}`,
    shift_id: `shift-${id}`,
    code_hash: "a".repeat(64),
    scan_id: `scan-${id}`,
    attempt_no: 1,
    attempt_state: "prepared",
    verification_policy: "required",
    verification: "pending",
    print_mode: "raw",
    language: "zpl",
    dpi: 203,
    bytes_base64: "XlhB",
    bytes_digest: "b".repeat(64),
    payload_digest: "c".repeat(64),
    template_id: "template-1",
    template_rev: 3,
    fields: JSON.stringify({ "km.full": FULL_CODE }),
    operator_id: "operator-1",
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_unit_labels (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

/** The error code a valid row of `state` carries: the first of its list, or none. */
function codeOf(state: (typeof UNIT_LABEL_ATTEMPT_STATES)[number]): string | null {
  return state === "failed_before_send" || state === "delivery_unknown"
    ? UNIT_LABEL_ATTEMPT_ERROR_CODES[state][0]
    : null;
}

const JOB_ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BYTES_DIGEST = "b".repeat(64);
const PAYLOAD_DIGEST = "c".repeat(64);
const EVENT_HEAD = {
  eventId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  jobId: JOB_ID,
  shiftId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  codeHash: "a".repeat(64),
  acceptedAt: AT,
  policyRevision: "3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a",
  templateDigest: "d".repeat(64),
  payloadDigest: PAYLOAD_DIGEST,
  operatorId: "4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b",
  occurredAt: AT,
};

/** The domain's `prepared` of attempt `attemptNo`: the same bytes in the same identity. */
function preparedEvent(sequence: number, attemptNo: number): ProductLabelEvent {
  return {
    ...EVENT_HEAD,
    sequence,
    attemptId: `attempt-${attemptNo}`,
    kind: "prepared",
    attemptNo,
    reason: attemptNo === 1 ? null : "lost",
    dpi: 203,
    bytesDigest: BYTES_DIGEST,
    language: "zpl",
  };
}

/** Every event the domain knows, as the next one of `current`'s job. */
function nextEvents(current: ProductLabelProjection): ProductLabelEvent[] {
  const head = {
    ...EVENT_HEAD,
    sequence: current.latestSequence + 1,
    attemptId: current.attemptId,
  };
  return [
    preparedEvent(current.latestSequence + 1, current.attemptNo + 1),
    { ...head, kind: "sending" },
    { ...head, kind: "sent" },
    ...UNIT_LABEL_ATTEMPT_ERROR_CODES.failed_before_send.map((errorCode): ProductLabelEvent => ({
      ...head,
      kind: "failed_before_send",
      errorCode,
    })),
    ...UNIT_LABEL_ATTEMPT_ERROR_CODES.delivery_unknown.map((errorCode): ProductLabelEvent => ({
      ...head,
      kind: "delivery_unknown",
      errorCode,
    })),
    { ...head, kind: "verification_skipped" },
    { ...head, kind: "verified", scannedPayloadDigest: PAYLOAD_DIGEST },
    { ...head, kind: "verified", scannedPayloadDigest: "e".repeat(64) },
    { ...head, kind: "verification_rejected", reason: "mismatch" },
  ];
}

/**
 * The projections a job reaches from its `prepared` under either policy (a breadth-first walk
 * over `applyProductLabelEvent`, every event tried at every step), by «attempt state, policy,
 * check», each with the status the domain gave it.
 */
function reachableProjections(): Map<string, ProductLabelJobStatus> {
  const reached = new Map<string, ProductLabelJobStatus>();
  for (const policy of UNIT_LABEL_POLICIES) {
    const queue: ProductLabelProjection[] = [
      applyProductLabelEvent(null, preparedEvent(1, 1), policy),
    ];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const key = `${next.attemptState} ${next.verification} ${next.verificationOutcome}`;
      if (reached.has(key)) continue;
      reached.set(key, next.status);
      for (const event of nextEvents(next)) {
        try {
          queue.push(applyProductLabelEvent(next, event, policy));
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
        }
      }
    }
  }
  return reached;
}

describe("the station's unit label jobs (migration 0015)", () => {
  it("keep the domain's words: attempt states, policies, checks, reprint reasons", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, job("prepared"));
    await refused(executor, job("printed", { attempt_state: "printed" }));
    // A label of unknown outcome verified takes any policy and check but for the words' own lists.
    const verifiedUnknown = {
      attempt_state: "delivery_unknown",
      error_code: "interrupted",
      verification: "verified",
    };
    await accepted(executor, job("unknown-verified", verifiedUnknown));
    await refused(executor, job("maybe", { ...verifiedUnknown, verification_policy: "maybe" }));
    await refused(executor, job("checked", { ...verifiedUnknown, verification: "checked" }));
    await refused(executor, job("torn", { attempt_no: 2, reason: "torn" }));
    for (const reason of ["not_printed", "damaged", "lost"]) {
      await accepted(executor, job(`reprint-${reason}`, { attempt_no: 2, reason }));
    }
  });

  it("keep a reprint's reason exactly on an attempt after the first, from attempt 1", async () => {
    const { executor } = openLocalDb();
    await refused(executor, job("first-with-reason", { reason: "lost" }));
    await refused(executor, job("reprint-without-reason", { attempt_no: 2 }));
    await refused(executor, job("attempt-0", { attempt_no: 0 }));
    // The reason stays with its attempt through every state of it.
    await accepted(
      executor,
      job("reprint-sent", { attempt_no: 3, reason: "damaged", attempt_state: "sent" }),
    );
  });

  it("keep an error code exactly in the two error states, from that state's list", async () => {
    const { executor } = openLocalDb();
    for (const [state, codes] of Object.entries(UNIT_LABEL_ATTEMPT_ERROR_CODES)) {
      for (const code of codes) {
        await accepted(
          executor,
          job(`${state}-${code}`, { attempt_state: state, error_code: code }),
        );
      }
      await refused(executor, job(`${state}-without-code`, { attempt_state: state }));
      await refused(
        executor,
        job(`${state}-unknown-code`, { attempt_state: state, error_code: "paper_out" }),
      );
    }
    await refused(
      executor,
      job("failed-with-the-other-list", {
        attempt_state: "failed_before_send",
        error_code: "interrupted",
      }),
    );
    await refused(
      executor,
      job("unknown-with-the-other-list", {
        attempt_state: "delivery_unknown",
        error_code: "printer_changed",
      }),
    );
    for (const state of ["prepared", "sending", "sent"]) {
      await refused(
        executor,
        job(`${state}-with-code`, { attempt_state: state, error_code: "interrupted" }),
      );
    }
  });

  it("keep the label's bytes, their print identity and their digests from the preparation on", async () => {
    const { executor } = openLocalDb();
    for (const state of UNIT_LABEL_ATTEMPT_STATES) {
      const base = { attempt_state: state, error_code: codeOf(state) };
      await refused(executor, job(`${state}-no-bytes`, { ...base, bytes_base64: null }));
      await refused(executor, job(`${state}-empty-bytes`, { ...base, bytes_base64: "" }));
      await refused(executor, job(`${state}-no-mode`, { ...base, print_mode: null }));
      await refused(executor, job(`${state}-no-dpi`, { ...base, dpi: null }));
    }
    await refused(executor, job("fields-not-json", { fields: "{" }));
    await refused(executor, job("fields-array", { fields: "[]" }));
    for (const column of ["code_hash", "bytes_digest", "payload_digest"]) {
      await refused(executor, job(`${column}-upper`, { [column]: "A".repeat(64) }));
      await refused(executor, job(`${column}-short`, { [column]: "a".repeat(63) }));
      await refused(executor, job(`${column}-long`, { [column]: "a".repeat(65) }));
      await refused(executor, job(`${column}-not-hex`, { [column]: `${"a".repeat(63)}g` }));
      await refused(executor, job(`${column}-missing`, { [column]: null }));
    }
    await refused(executor, job("negative-revision", { template_rev: -1 }));
    for (const column of ["scan_id", "template_id", "operator_id", "shift_id", "fields"]) {
      await refused(executor, job(`${column}-missing`, { [column]: null }));
    }
  });

  // The bytes are rendered for one way of printing (the domain's `ProductLabelPrintIdentity`: a
  // printer language, or the `mono-raster-v1` page of the Windows driver, which has none) and one
  // resolution; a send compares the printer assigned at that moment with them.
  it("keep the way of printing the bytes were rendered for: a RAW language, or the driver's page", async () => {
    const { executor } = openLocalDb();
    for (const language of ["zpl", "tspl"]) {
      for (const dpi of [203, 300]) {
        await accepted(executor, job(`raw-${language}-${dpi}`, { language, dpi }));
      }
    }
    for (const dpi of [203, 300]) {
      await accepted(
        executor,
        job(`driver-${dpi}`, { print_mode: "windows_driver", language: null, dpi }),
      );
    }
    await refused(executor, job("mode-unknown", { print_mode: "driver" }));
    await refused(executor, job("language-unknown", { language: "epl" }));
    await refused(executor, job("raw-without-language", { language: null }));
    await refused(
      executor,
      job("driver-with-language", { print_mode: "windows_driver", language: "zpl" }),
    );
    for (const dpi of [0, 200, 600, "203dpi"]) {
      await refused(executor, job(`dpi-${dpi}`, { dpi }));
    }
  });

  // The domain's job keeps its origin (`jobId`, `shiftId`, `codeHash`, `acceptedAt`, its policy,
  // the template's and the payload's digests) and, across its reprints, the same bytes in the
  // same print identity: only the attempt, its state, the check, the reason, the error code and
  // the time move (`MOVE_JOB_SQL`).
  it("keep a job's origin, its print identity and its bytes for good, and let the attempt move", async () => {
    const { db, executor } = openLocalDb();
    await accepted(executor, job("fixed", { device_id: DEVICE_ID }));
    const changes: readonly (readonly (readonly [string, unknown])[])[] = [
      [["id", "fixed-2"]],
      [["host_id", OTHER_HOST]],
      [["device_id", OTHER_DEVICE]],
      [["shift_id", "shift-2"]],
      [["scan_id", "scan-2"]],
      [["code_hash", "d".repeat(64)]],
      // The policy goes with its check's outcome, or a CHECK would refuse the row first.
      [
        ["verification_policy", "none"],
        ["verification", "not_required"],
      ],
      // The way of printing goes with its language, or a CHECK would refuse the row first.
      [
        ["print_mode", "windows_driver"],
        ["language", null],
      ],
      [["language", "tspl"]],
      [["dpi", 300]],
      [["bytes_base64", "XlhC"]],
      [["bytes_digest", "d".repeat(64)]],
      [["payload_digest", "d".repeat(64)]],
      [["template_id", "template-2"]],
      [["template_rev", 4]],
      [["fields", JSON.stringify({ "km.full": "other" })]],
      [["created_at", "2026-10-13T09:00:00.000Z"]],
    ];
    const before = db.prepare("SELECT * FROM floor_unit_labels").all();
    for (const change of changes) {
      const what = change.map(([column]) => column).join(", ");
      await expect(
        executor.transaction([
          {
            sql: `UPDATE floor_unit_labels SET ${change.map(([column]) => `${column} = ?`).join(", ")} WHERE id = 'fixed'`,
            values: change.map(([, value]) => value),
          },
        ]),
        what,
      ).rejects.toMatchObject({ code: "statement_failed" });
    }
    expect(db.prepare("SELECT * FROM floor_unit_labels").all()).toEqual(before);
    // The same values written again change nothing, and are taken.
    await accepted(executor, {
      sql: "UPDATE floor_unit_labels SET language = 'zpl', dpi = 203, bytes_base64 = 'XlhB' WHERE id = 'fixed'",
      values: [],
    });
    // The attempt moves through the station's own step: sent, then a reprint of the same bytes.
    const move = (
      next: readonly [number, string, string, string | null],
      from: readonly [number, string, string],
    ): LocalStatement => ({
      sql: MOVE_JOB_SQL,
      values: [...next, null, AT, HOST_ID, DEVICE_ID, "fixed", ...from],
    });
    await accepted(executor, move([1, "sending", "pending", null], [1, "prepared", "pending"]));
    await accepted(executor, move([1, "sent", "pending", null], [1, "sending", "pending"]));
    await accepted(executor, move([2, "prepared", "pending", "lost"], [1, "sent", "pending"]));
    expect(MOVE_JOB_SQL).not.toMatch(/printer|language|dpi|bytes|print_mode/);
  });

  // Golden parity with the domain's state machine: the rows the table takes are exactly the
  // projections `applyProductLabelEvent` reaches from a job's `prepared` under either policy,
  // every event kind tried at every step (reprints included), and the unique index's predicate
  // is exactly «not completed» of the status the walk reached each one with.
  it("take exactly the domain's reachable projections, and call unresolved exactly what is not completed", async () => {
    const reached = reachableProjections();
    expect(reached.size).toBe(14);
    const { db, executor } = openLocalDb();
    let n = 0;
    for (const state of UNIT_LABEL_ATTEMPT_STATES) {
      for (const policy of UNIT_LABEL_POLICIES) {
        for (const verification of UNIT_LABEL_VERIFICATIONS) {
          n += 1;
          const what = `${state} ${policy} ${verification}`;
          const status = reached.get(what);
          const id = `job-${n}`;
          const row = job(id, {
            attempt_state: state,
            verification_policy: policy,
            verification,
            error_code: codeOf(state),
          });
          if (status === undefined) {
            await expect(executor.transaction([row]), what).rejects.toMatchObject({
              code: "statement_failed",
            });
            continue;
          }
          await expect(executor.transaction([row]), what).resolves.toEqual([1]);
          const found = db
            .prepare(
              `SELECT ${UNRESOLVED_UNIT_LABEL_SQL} AS unresolved FROM floor_unit_labels WHERE id = ?`,
            )
            .get(id);
          expect(z.object({ unresolved: z.number() }).parse(found).unresolved === 1, what).toBe(
            status !== "completed",
          );
        }
      }
    }
    expect(n).toBe(40);
  });

  // The cloud's rule: a station has one unresolved product label job whatever its shift
  // (`PRODUCT_LABEL_BUSY` across shifts; entering any shift opens it).
  it("let one job of a station be unresolved whatever its shift, and any number be completed", async () => {
    const { db, executor } = openLocalDb();
    const one = (id: string, overrides: Record<string, unknown> = {}) =>
      job(id, { device_id: DEVICE_ID, shift_id: "shift-1", ...overrides });
    await accepted(executor, one("first"));
    // A second unresolved job of the station, in any unresolved form, in this shift or another.
    await refused(executor, one("again-pending"));
    await refused(executor, one("another-shift", { shift_id: "shift-2" }));
    await refused(
      executor,
      one("again-attention", {
        verification_policy: "none",
        verification: "not_required",
        attempt_state: "delivery_unknown",
        error_code: "interrupted",
      }),
    );
    await refused(
      executor,
      one("again-awaiting", { attempt_state: "sent", verification: "pending" }),
    );
    // Completed: sent without a check, verified, skipped; in any shift.
    await accepted(
      executor,
      one("sent", {
        verification_policy: "none",
        verification: "not_required",
        attempt_state: "sent",
      }),
    );
    await accepted(executor, one("verified", { attempt_state: "sent", verification: "verified" }));
    await accepted(
      executor,
      one("skipped", { shift_id: "shift-2", attempt_state: "sent", verification: "skipped" }),
    );
    // Another device of the host, and the same device under another host, each have their own.
    await accepted(executor, one("other-device", { device_id: OTHER_DEVICE }));
    await accepted(executor, one("other-host", { host_id: OTHER_HOST }));
    // A job's key is its own across shifts.
    await refused(executor, one("first", { shift_id: "shift-3" }));
    // The station's one unresolved job, read whatever its shift.
    const unresolved = db.prepare(UNRESOLVED_JOB_SQL).all(HOST_ID, DEVICE_ID);
    expect(unresolved.map((row) => [row["id"], row["shift_id"]])).toEqual([["first", "shift-1"]]);
  });

  it("keep one job per accepted unit of a pairing", async () => {
    const { executor } = openLocalDb();
    const done = { attempt_state: "sent", verification: "verified" };
    await accepted(executor, job("a", { device_id: DEVICE_ID, scan_id: "scan-1", ...done }));
    await refused(executor, job("b", { device_id: DEVICE_ID, scan_id: "scan-1", ...done }));
    await refused(
      executor,
      job("c", { device_id: DEVICE_ID, scan_id: "scan-1", shift_id: "shift-a", ...done }),
    );
    // A scan id of another pairing is another unit.
    await accepted(executor, job("d", { device_id: OTHER_DEVICE, scan_id: "scan-1", ...done }));
    await accepted(
      executor,
      job("e", { device_id: DEVICE_ID, host_id: OTHER_HOST, scan_id: "scan-1", ...done }),
    );
  });
});

// The shell's twin: `migration_0015_adds_the_unit_labels_and_keeps_every_object`
// (`tests/local_db.rs`).
describe("migration 0015 over a database of 0014 (plan РЕЖ part B)", () => {
  it("adds the table, its four indexes and its trigger, and leaves every other object as it was", () => {
    const migrations = new URL("../src-tauri/migrations/", testModuleUrl);
    const migrate = (db: DatabaseSync, from: string, to: string): void => {
      const files = readdirSync(migrations)
        .filter((name) => name.endsWith(".sql") && name >= from && name <= `${to}_zzz`)
        .sort();
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) db.exec(readFileSync(new URL(name, migrations), "utf8"));
    };
    const master = (db: DatabaseSync) =>
      db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all()
        .map((row) => ({ ...row }));
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0014");
    const before = master(db);
    migrate(db, "0015", "0015");
    const after = master(db);
    const added = after.filter(
      (row) => !before.some((old) => JSON.stringify(old) === JSON.stringify(row)),
    );
    expect(after.filter((row) => !added.includes(row))).toEqual(before);
    expect(added.map((row) => [row["type"], row["name"], row["tbl_name"]])).toEqual([
      ["index", "floor_unit_labels_scan", "floor_unit_labels"],
      ["index", "floor_unit_labels_sending", "floor_unit_labels"],
      ["index", "floor_unit_labels_shift", "floor_unit_labels"],
      ["index", "floor_unit_labels_unresolved", "floor_unit_labels"],
      ["index", "sqlite_autoindex_floor_unit_labels_1", "floor_unit_labels"],
      ["table", "floor_unit_labels", "floor_unit_labels"],
      ["trigger", "floor_unit_labels_fixed", "floor_unit_labels"],
    ]);
  });
});
