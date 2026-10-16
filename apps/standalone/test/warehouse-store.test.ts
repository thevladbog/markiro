import { boxLabelFields } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  countSent,
  countUnsentRecords,
  finishSession,
  insertJobStatement,
  listSessionJobs,
  moveJobStatement,
  purgeWarehouseSessions,
  readJob,
  readJobByIdentity,
  readOpenJob,
  readOpenSession,
  recordStatement,
  startSession,
  StaleWarehouseError,
  updateSession,
  warehouseRecord,
  type NewWarehouseJob,
} from "../src/floor/warehouse/warehouse-store.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { ZEBRA } from "./support/printing.js";
import { BOX_SSCC, BOX_TEMPLATE, UNIT_TEMPLATE } from "./support/warehouse.js";

const AT = "2026-10-09T07:00:00.000Z";
const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const TEMPLATES = { unit: UNIT_TEMPLATE, box: BOX_TEMPLATE, pallet: null };

const FIELDS = boxLabelFields({
  sscc: BOX_SSCC,
  itemCount: 12,
  productName: "Молоко 3,2% 0,9 л",
  productPrintName: "Молоко 3,2%",
  gtin14: "04600682000013",
  egaisCode: null,
  shelfLifeDays: 10,
  operatorName: "Анна Кузнецова",
  counterpartyName: null,
  closedAt: "2026-10-08T06:10:00.000Z",
  productionDate: "2026-10-08",
  shiftNumber: "OCT26-003",
});

function job(id: string, overrides: Partial<NewWarehouseJob> = {}): NewWarehouseJob {
  return {
    id,
    sessionId: SESSION,
    kind: "box",
    subjectId: "b0000000-0000-4000-8000-000000000001",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "prepared",
    templateId: BOX_TEMPLATE,
    templateRev: 4,
    templateSpec: "{}",
    fields: FIELDS,
    printer: ZEBRA,
    bytesBase64: "XlhB",
    errorCode: null,
    operatorId: OPERATOR_ID,
    createdAt: AT,
    ...overrides,
  };
}

describe("the warehouse reprint's own tables (migration 0012)", () => {
  it("keep one open session per pairing, continued after a pause and never after its finish", async () => {
    const { executor } = openLocalDb();
    expect(await readOpenSession(executor, PAIRING)).toBeNull();
    const started = await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(await readOpenSession(executor, PAIRING)).toEqual(started);
    // A second start while one is open answers the open one.
    const again = await startSession(executor, PAIRING, {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      reason: "lost",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(again.id).toBe(SESSION);
    await updateSession(executor, PAIRING, { ...started, reason: "lost" }, AT);
    expect((await readOpenSession(executor, PAIRING))?.reason).toBe("lost");
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
    expect(await readOpenSession(executor, PAIRING)).toBeNull();
    await expect(updateSession(executor, PAIRING, started, AT)).rejects.toBeInstanceOf(
      StaleWarehouseError,
    );
  });

  it("hold one waiting job per session, and no finish while it waits", async () => {
    const { executor } = openLocalDb();
    await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    await executor.transaction([insertJobStatement(PAIRING, job("job-1"))]);
    await expect(
      executor.transaction([insertJobStatement(PAIRING, job("job-2", { identity: "x" }))]),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("busy");
    const waiting = await readOpenJob(executor, PAIRING, SESSION);
    expect(waiting?.id).toBe("job-1");
    if (waiting === null) throw new Error("the job waits");
    // `sending`, then `sent`: the job is done with, and the session may finish.
    await executor.transaction([
      moveJobStatement(
        PAIRING,
        waiting,
        {
          state: "sending",
          errorCode: null,
          attempts: 1,
          reason: "damaged",
          printer: ZEBRA,
          bytesBase64: "XlhB",
        },
        AT,
      ),
    ]);
    const sending = await readJob(executor, PAIRING, "job-1");
    if (sending === null) throw new Error("the job is there");
    await executor.transaction([
      moveJobStatement(
        PAIRING,
        sending,
        {
          state: "sent",
          errorCode: null,
          attempts: 1,
          reason: "damaged",
          printer: ZEBRA,
          bytesBase64: "XlhB",
        },
        AT,
      ),
    ]);
    // A move from a state the job left is refused.
    await expect(
      executor.transaction([
        moveJobStatement(
          PAIRING,
          sending,
          {
            state: "unknown",
            errorCode: "timeout",
            attempts: 1,
            reason: "damaged",
            printer: ZEBRA,
            bytesBase64: "XlhB",
          },
          AT,
        ),
      ]),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(await countSent(executor, PAIRING, SESSION)).toBe(1);
    expect((await readJobByIdentity(executor, PAIRING, SESSION, BOX_SSCC))?.state).toBe("sent");
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
  });

  it("refuse a job that breaks its rules", async () => {
    const { db, executor } = openLocalDb();
    const refused = async (overrides: Partial<NewWarehouseJob>) =>
      expect(
        executor.transaction([insertJobStatement(PAIRING, job(crypto.randomUUID(), overrides))]),
      ).rejects.toMatchObject({ code: "statement_failed" });
    await refused({ state: "failed", errorCode: null });
    await refused({ state: "prepared", errorCode: "timeout" });
    await refused({ printer: null });
    await refused({ kind: "unit", repair: "legacy_tspl_fnc1_literal" });
    // A reason outside the list, written past the types.
    const statement = insertJobStatement(PAIRING, job("job-9"));
    const values = [...(statement.values ?? [])];
    values[8] = "other";
    await expect(executor.transaction([{ ...statement, values }])).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT id FROM wh_jobs")).toEqual([]);
  });

  it("keep the records of a job for the host, in their order, and count the unsent ones", async () => {
    const { db, executor } = openLocalDb();
    const record = warehouseRecord(job("4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"), {
      id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      attempt: 1,
      reason: "damaged",
      outcome: "sent",
      errorCode: null,
      operatorId: OPERATOR_ID,
      occurredAt: AT,
    });
    expect(record).toEqual({
      id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      sessionId: SESSION,
      jobId: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
      attempt: 1,
      subjectKind: "box",
      subjectId: "b0000000-0000-4000-8000-000000000001",
      identity: BOX_SSCC,
      reasonCode: "damaged",
      repair: null,
      templateId: BOX_TEMPLATE,
      templateRev: 4,
      outcome: "sent",
      errorCode: null,
      operatorId: OPERATOR_ID,
      occurredAt: AT,
    });
    await executor.transaction([recordStatement(PAIRING, record, AT)]);
    expect(await countUnsentRecords(executor, PAIRING)).toBe(1);
    expect(rows(db, "SELECT session_id, payload FROM wh_outbox")).toEqual([
      { session_id: SESSION, payload: JSON.stringify(record) },
    ]);
  });

  it("forget a finished session 30 days after its records were all accepted, and only then", async () => {
    const { db, executor } = openLocalDb();
    await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    await executor.transaction([
      insertJobStatement(
        PAIRING,
        job("job-1", {
          state: "failed",
          errorCode: "printer_unconfigured",
          printer: null,
          bytesBase64: null,
        }),
      ),
    ]);
    const failed = await readJob(executor, PAIRING, "job-1");
    if (failed === null) throw new Error("the job is there");
    await executor.transaction([
      moveJobStatement(
        PAIRING,
        failed,
        {
          state: "cancelled",
          errorCode: null,
          attempts: 0,
          reason: "damaged",
          printer: null,
          bytesBase64: null,
        },
        AT,
      ),
      recordStatement(
        PAIRING,
        warehouseRecord(failed, {
          id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
          attempt: 0,
          reason: "damaged",
          outcome: "cancelled",
          errorCode: null,
          operatorId: OPERATOR_ID,
          occurredAt: AT,
        }),
        AT,
      ),
    ]);
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, AT)).toBe("finished");
    const later = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    // The record has no receipt yet: the session stays.
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(0);
    db.prepare(
      "UPDATE wh_outbox SET outcome = 'rejected', outcome_code = 'subject_unknown', acked_at = ?",
    ).run(AT);
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(0);
    db.prepare("UPDATE wh_outbox SET outcome = 'accepted', outcome_code = NULL").run();
    expect(await purgeWarehouseSessions(executor, PAIRING, new Date(Date.parse(AT) + 1000))).toBe(
      0,
    );
    expect(await purgeWarehouseSessions(executor, PAIRING, later)).toBe(1);
    for (const table of ["wh_sessions", "wh_jobs", "wh_outbox"]) {
      expect(
        await executor.query(`SELECT count(*) AS n FROM ${table}`, [], z.object({ n: z.number() })),
      ).toEqual([{ n: 0 }]);
    }
  });
});

describe("the journal of a reprint session", () => {
  async function started() {
    const opened = openLocalDb();
    await startSession(opened.executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    return opened;
  }

  it("lists the session's jobs, the newest first, and no other session's", async () => {
    const { db, executor } = await started();
    await executor.transaction([insertJobStatement(PAIRING, job("job-1"))]);
    db.prepare("UPDATE wh_jobs SET state = 'sent' WHERE id = 'job-1'").run();
    await executor.transaction([
      insertJobStatement(PAIRING, job("job-2", { identity: "second", kind: "unit" })),
    ]);
    const listed = await listSessionJobs(executor, PAIRING, SESSION);
    expect(listed.map((one) => [one.id, one.state, one.kind])).toEqual([
      ["job-2", "prepared", "unit"],
      ["job-1", "sent", "box"],
    ]);
    expect(await listSessionJobs(executor, PAIRING, "another-session")).toEqual([]);
  });

  it("leaves out a job this build cannot read instead of failing the whole journal", async () => {
    const { db, executor } = await started();
    await executor.transaction([insertJobStatement(PAIRING, job("job-1"))]);
    db.prepare("UPDATE wh_jobs SET state = 'sent' WHERE id = 'job-1'").run();
    await executor.transaction([insertJobStatement(PAIRING, job("job-2", { identity: "second" }))]);
    db.prepare("UPDATE wh_jobs SET fields = ? WHERE id = 'job-2'").run(
      JSON.stringify({ nope: "x" }),
    );
    const listed = await listSessionJobs(executor, PAIRING, SESSION);
    expect(listed.map((one) => one.id)).toEqual(["job-1"]);
  });
});
