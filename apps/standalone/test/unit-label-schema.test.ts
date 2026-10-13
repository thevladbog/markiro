import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { DomainError, productLabelStatus } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  UNIT_LABEL_ATTEMPT_ERROR_CODES,
  UNIT_LABEL_ATTEMPT_STATES,
  UNIT_LABEL_POLICIES,
  UNIT_LABEL_VERIFICATIONS,
  UNRESOLVED_UNIT_LABEL_SQL,
} from "../src/floor/unit-labels/unit-label-store.js";
import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-13T08:00:00.000Z";
const PRINTER = JSON.stringify({ id: "p1", name: "Zebra", language: "zpl", dpi: 203 });
const FULL_CODE = "0104600682000013215abc\u001d93Zz";

/**
 * A valid unresolved job in a shift of its own, so that a row refused below is refused by the
 * rule under test and not by the one unresolved job of a shift.
 */
function job(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: `shift-${id}`,
    code_hash: "a".repeat(64),
    scan_id: `scan-${id}`,
    attempt_no: 1,
    attempt_state: "prepared",
    verification_policy: "required",
    verification: "pending",
    printer: PRINTER,
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

  it("keep the label's bytes, its printer and its digests from the preparation on", async () => {
    const { executor } = openLocalDb();
    for (const state of UNIT_LABEL_ATTEMPT_STATES) {
      const base = { attempt_state: state, error_code: codeOf(state) };
      await refused(executor, job(`${state}-no-bytes`, { ...base, bytes_base64: null }));
      await refused(executor, job(`${state}-empty-bytes`, { ...base, bytes_base64: "" }));
      await refused(executor, job(`${state}-no-printer`, { ...base, printer: null }));
    }
    await refused(executor, job("printer-not-json", { printer: "{" }));
    await refused(executor, job("printer-array", { printer: "[]" }));
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

  // Golden parity with the domain's state machine: a row is a valid projection of a job exactly
  // when `productLabelStatus` reads it (the check's outcome follows the policy, a skip only after
  // `sent` of a required check), save one: a check that was never asked cannot be verified after
  // `sent`, as `canApplyProductLabelEvent` refuses that `verified`. And the unique index's
  // predicate is exactly «not completed».
  it("take exactly the domain's projections, and call unresolved exactly what is not completed", async () => {
    const { db, executor } = openLocalDb();
    let n = 0;
    for (const state of UNIT_LABEL_ATTEMPT_STATES) {
      for (const policy of UNIT_LABEL_POLICIES) {
        for (const verification of UNIT_LABEL_VERIFICATIONS) {
          n += 1;
          // The projection's outcome: `pending` under a required check, `not_required` under
          // none; a skip is of a required check; `verified` under either.
          const outcomeFollowsPolicy =
            verification === "verified" ||
            (verification === "not_required") === (policy === "none");
          let status: ReturnType<typeof productLabelStatus> | null = null;
          try {
            status = productLabelStatus(
              state,
              policy,
              verification === "verified",
              verification === "skipped",
            );
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
          }
          const reachable =
            outcomeFollowsPolicy &&
            status !== null &&
            !(verification === "verified" && state === "sent" && policy === "none");
          const id = `job-${n}`;
          const row = job(id, {
            attempt_state: state,
            verification_policy: policy,
            verification,
            error_code: codeOf(state),
          });
          const what = `${state} ${policy} ${verification}`;
          if (!reachable) {
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

  it("let one job of a shift and pairing be unresolved, and any number be completed", async () => {
    const { executor } = openLocalDb();
    const one = (id: string, overrides: Record<string, unknown> = {}) =>
      job(id, { shift_id: "shift-1", ...overrides });
    await accepted(executor, one("first"));
    // A second unresolved job of the shift, in any unresolved form.
    await refused(executor, one("again-pending"));
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
    // Completed: sent without a check, verified, skipped.
    await accepted(
      executor,
      one("sent", {
        verification_policy: "none",
        verification: "not_required",
        attempt_state: "sent",
      }),
    );
    await accepted(executor, one("verified", { attempt_state: "sent", verification: "verified" }));
    await accepted(executor, one("skipped", { attempt_state: "sent", verification: "skipped" }));
    // Another shift, another pairing: each has its own.
    await accepted(executor, one("shift-2", { shift_id: "shift-2" }));
    await accepted(executor, one("other-device", { device_id: OTHER_DEVICE }));
    // A job's key is its own across shifts.
    await refused(executor, one("first", { shift_id: "shift-3" }));
  });
});

// The shell's twin: `migration_0015_adds_the_unit_labels_and_keeps_every_object`
// (`tests/local_db.rs`).
describe("migration 0015 over a database of 0014 (plan РЕЖ part B)", () => {
  it("adds the table and its three indexes, and leaves every other object as it was", () => {
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
      ["index", "floor_unit_labels_sending", "floor_unit_labels"],
      ["index", "floor_unit_labels_shift", "floor_unit_labels"],
      ["index", "floor_unit_labels_unresolved", "floor_unit_labels"],
      ["index", "sqlite_autoindex_floor_unit_labels_1", "floor_unit_labels"],
      ["table", "floor_unit_labels", "floor_unit_labels"],
    ]);
  });
});
