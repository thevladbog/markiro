import { describe, expect, it } from "vitest";

import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";
const SSCC = "046006820000035007";
const PRINTER = JSON.stringify({ id: "p1", name: "Zebra" });

function job(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    purpose: "box",
    subject_id: `box-${id}`,
    sscc: SSCC,
    state: "prepared",
    verify: 0,
    template_id: "template-1",
    template_rev: 3,
    fields: "{}",
    printer: PRINTER,
    bytes_base64: "XlhB",
    operator_id: "operator-1",
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_print_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function setting(key: string, value: string): LocalStatement {
  return {
    sql: "INSERT INTO workstation_settings (key, value) VALUES (?, ?)",
    values: [key, value],
  };
}

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's print jobs (migration 0007)", () => {
  it("name what the label is for: a box, or a pallet of the pallets' plan, and nothing else", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, job("box"));
    await accepted(executor, job("pallet", { purpose: "pallet" }));
    await refused(executor, job("duplicate", { purpose: "duplicate" }));
    await refused(executor, job("short", { sscc: "04600682000003500" }));
    await refused(executor, job("letters", { sscc: "04600682000003500X" }));
  });

  it("keep a reason exactly for a failed or unknown job, and bytes for every job that went to a printer", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, job("failed", { state: "failed", error_code: "not_sent" }));
    await accepted(
      executor,
      job("unconfigured", {
        state: "failed",
        error_code: "printer_unconfigured",
        printer: null,
        bytes_base64: null,
      }),
    );
    await accepted(
      executor,
      job("unknown", { state: "unknown", error_code: "outcome_unknown", attempts: 1 }),
    );
    await refused(executor, job("failed-silent", { state: "failed" }));
    await refused(executor, job("sent-with-reason", { state: "sent", error_code: "not_sent" }));
    await refused(executor, job("prepared-with-reason", { error_code: "render_failed" }));
    for (const state of ["sending", "sent", "unknown", "verified"]) {
      await refused(
        executor,
        job(`no-bytes-${state}`, {
          state,
          verify: 1,
          attempts: 1,
          bytes_base64: null,
          error_code: state === "unknown" ? "timeout" : null,
        }),
      );
    }
    await refused(executor, job("bytes-without-printer", { printer: null }));
    await refused(executor, job("empty-bytes", { bytes_base64: "" }));
  });

  it("count no attempt before a job's first send, and verify only a job that asked for the check", async () => {
    const { executor } = openLocalDb();
    await refused(executor, job("prepared-sent-once", { attempts: 1 }));
    await accepted(executor, job("verified", { state: "verified", verify: 1, attempts: 1 }));
    await refused(executor, job("verified-unasked", { state: "verified", verify: 0, attempts: 1 }));
    await refused(executor, job("bad-state", { state: "printed" }));
    await refused(executor, job("bad-verify", { verify: 2 }));
    await refused(executor, job("bad-json", { fields: "{" }));
    await refused(executor, job("bad-printer", { printer: "{" }));
    await refused(executor, job("negative-attempts", { state: "sent", attempts: -1 }));
    await refused(executor, job("negative-revision", { template_rev: -1 }));
  });

  it("let one label wait at a time, and any number be done with", async () => {
    const { executor } = openLocalDb();
    const box = { subject_id: "box-1" };
    await accepted(executor, job("first", box));
    // A second open job of the same box, whatever open state it is in.
    await refused(executor, job("again-prepared", box));
    await refused(
      executor,
      job("again-failed", { ...box, state: "failed", error_code: "not_sent" }),
    );
    await refused(
      executor,
      job("again-awaiting", { ...box, state: "sent", verify: 1, attempts: 1 }),
    );
    // Done with: sent without a check, verified, skipped.
    await accepted(executor, job("sent", { ...box, state: "sent", attempts: 1 }));
    await accepted(
      executor,
      job("verified", { ...box, state: "verified", verify: 1, attempts: 1 }),
    );
    await accepted(executor, job("skipped", { ...box, state: "skipped" }));
    // Another box, another purpose, another pairing: each has its own.
    await accepted(executor, job("box-2", { subject_id: "box-2" }));
    await accepted(executor, job("pallet-1", { ...box, purpose: "pallet" }));
    await accepted(executor, job("other-device", { ...box, device_id: OTHER_DEVICE }));
  });
});

describe("the workstation's settings (migration 0007)", () => {
  it("keep one JSON value per key and belong to no pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, setting("printers", "{}"));
    await refused(executor, setting("printers", "[]"));
    await refused(executor, setting("sound", "{"));
    await expect(
      executor.transaction([
        { sql: "INSERT INTO workstation_settings (key, value) VALUES (NULL, '1')" },
      ]),
    ).rejects.toMatchObject({ code: "statement_failed" });
    await expect(
      executor.transaction([
        {
          sql: "INSERT INTO workstation_settings (key, value, host_id) VALUES ('a', '1', 'h')",
        },
      ]),
    ).rejects.toMatchObject({ code: "statement_failed" });
  });
});
