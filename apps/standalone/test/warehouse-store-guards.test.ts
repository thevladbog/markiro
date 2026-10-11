import { boxLabelFields } from "@markiro/domain";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  countSent,
  countUnsentRecords,
  DUE_SESSIONS_SQL,
  finishSession,
  insertJobStatement,
  moveJobStatement,
  PURGE_SESSION_SQL,
  purgeWarehouseSessions,
  readJob,
  readJobByIdentity,
  readOpenJob,
  readOpenSession,
  recordStatement,
  startSession,
  StaleWarehouseError,
  UnreadableWarehouseJobError,
  updateSession,
  warehouseRecord,
  WAREHOUSE_RETENTION_MS,
  WAREHOUSE_JOB_STATES,
  type NewWarehouseJob,
  type WarehouseJobState,
} from "../src/floor/warehouse/warehouse-store.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { OPERATOR_ID, PAIRING, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { ZEBRA } from "./support/printing.js";
import { BOX_SSCC, BOX_TEMPLATE, UNIT_TEMPLATE } from "./support/warehouse.js";

const AT = "2026-10-09T07:00:00.000Z";
const LATER = "2026-10-09T07:05:00.000Z";
const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const OTHER = { hostId: HOST_ID, deviceId: OTHER_DEVICE };
/** The same device id under another host: a station paired to a second host. */
const FOREIGN = { hostId: "another-host", deviceId: DEVICE_ID };
const TEMPLATES = { unit: UNIT_TEMPLATE, box: BOX_TEMPLATE, pallet: null };
const PRINTER_JSON = JSON.stringify(ZEBRA);

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

type RawRow = Record<string, SQLInputValue>;

function insertRaw(db: DatabaseSync, table: string, row: RawRow): void {
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `row-${String(counter).padStart(4, "0")}`;
}

/** A job row as the table takes it: `prepared`, no label bytes, each field overridable. */
function jobRow(overrides: RawRow = {}): RawRow {
  const id = nextId();
  return {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    id,
    session_id: id,
    kind: "box",
    subject_id: "subject",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "prepared",
    template_id: BOX_TEMPLATE,
    template_rev: 4,
    template_spec: "{}",
    fields: JSON.stringify(FIELDS),
    printer: null,
    bytes_base64: null,
    error_code: null,
    attempts: 0,
    operator_id: OPERATOR_ID,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

function sessionRow(overrides: RawRow = {}): RawRow {
  return {
    id: nextId(),
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    reason: "damaged",
    unit_template_id: null,
    box_template_id: null,
    pallet_template_id: null,
    started_by: OPERATOR_ID,
    started_at: AT,
    updated_at: AT,
    finished_at: null,
    finished_by: null,
    ...overrides,
  };
}

function outboxRow(overrides: RawRow = {}): RawRow {
  return {
    id: nextId(),
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    session_id: SESSION,
    payload: "{}",
    created_at: AT,
    ...overrides,
  };
}

/** What a state demands of the rest of the row (the table's checks, spelled out). */
const STATE_SHAPES: Record<WarehouseJobState, RawRow> = {
  prepared: {},
  sending: { printer: PRINTER_JSON, bytes_base64: "XlhB", attempts: 1 },
  sent: { printer: PRINTER_JSON, bytes_base64: "XlhB", attempts: 1 },
  failed: { error_code: "printer_unconfigured" },
  unknown: { printer: PRINTER_JSON, bytes_base64: "XlhB", attempts: 1, error_code: "timeout" },
  verified: { printer: PRINTER_JSON, bytes_base64: "XlhB", attempts: 1 },
  cancelled: {},
};
const STATES = WAREHOUSE_JOB_STATES;
const OPEN_STATES: readonly WarehouseJobState[] = ["prepared", "sending", "failed", "unknown"];

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

describe("the warehouse tables refuse a row that breaks their rules (migration 0012)", () => {
  it("takes a job in each of its seven states, with the rest of the row they demand", () => {
    const { db } = openLocalDb();
    for (const state of STATES) {
      insertRaw(db, "wh_jobs", jobRow({ state, ...STATE_SHAPES[state] }));
    }
    expect(rows(db, "SELECT state FROM wh_jobs ORDER BY state").map((row) => row["state"])).toEqual(
      [...STATES].sort(),
    );
  });

  it("limits a job's kind, repair, reason and state to their lists", () => {
    const { db } = openLocalDb();
    for (const kind of ["unit", "box", "pallet"]) insertRaw(db, "wh_jobs", jobRow({ kind }));
    expect(() => insertRaw(db, "wh_jobs", jobRow({ kind: "carton" }))).toThrow(CHECK);
    for (const kind of ["box", "pallet"]) {
      insertRaw(db, "wh_jobs", jobRow({ kind, repair: "legacy_tspl_fnc1_literal" }));
    }
    // The repair of the old TSPL defect belongs to a box or a pallet, never to a unit.
    expect(() =>
      insertRaw(db, "wh_jobs", jobRow({ kind: "unit", repair: "legacy_tspl_fnc1_literal" })),
    ).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_jobs", jobRow({ repair: "other_repair" }))).toThrow(CHECK);
    for (const reason of ["not_printed", "damaged", "lost"]) {
      insertRaw(db, "wh_jobs", jobRow({ reason }));
    }
    expect(() => insertRaw(db, "wh_jobs", jobRow({ reason: "other" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_jobs", jobRow({ state: "queued" }))).toThrow(CHECK);
  });

  it("holds a template revision and an attempt count from zero up, JSON in the JSON columns", () => {
    const { db } = openLocalDb();
    insertRaw(db, "wh_jobs", jobRow({ template_rev: 0 }));
    expect(() => insertRaw(db, "wh_jobs", jobRow({ template_rev: -1 }))).toThrow(CHECK);
    insertRaw(db, "wh_jobs", jobRow({ state: "cancelled", attempts: 0 }));
    expect(() => insertRaw(db, "wh_jobs", jobRow({ state: "cancelled", attempts: -1 }))).toThrow(
      CHECK,
    );
    expect(() => insertRaw(db, "wh_jobs", jobRow({ template_spec: "not json" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_jobs", jobRow({ fields: "{" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_jobs", jobRow({ printer: "{" }))).toThrow(CHECK);
  });

  it("keeps label bytes only with the printer they were made for, and never empty", () => {
    const { db } = openLocalDb();
    insertRaw(db, "wh_jobs", jobRow({ printer: PRINTER_JSON, bytes_base64: "XlhB" }));
    expect(() => insertRaw(db, "wh_jobs", jobRow({ bytes_base64: "XlhB" }))).toThrow(CHECK);
    expect(() =>
      insertRaw(db, "wh_jobs", jobRow({ printer: PRINTER_JSON, bytes_base64: "" })),
    ).toThrow(CHECK);
  });

  it("demands the bytes of a job that was sent, is being sent or may have printed", () => {
    const { db } = openLocalDb();
    for (const state of ["sending", "sent", "unknown", "verified"] as const) {
      const shape = { ...STATE_SHAPES[state], printer: null, bytes_base64: null };
      expect(() => insertRaw(db, "wh_jobs", jobRow({ state, ...shape })), state).toThrow(CHECK);
    }
  });

  it("names an error exactly on a failed or an unknown job", () => {
    const { db } = openLocalDb();
    for (const state of STATES) {
      const wants = state === "failed" || state === "unknown";
      const shape = STATE_SHAPES[state];
      // The opposite of what the state wants is refused, in both directions.
      const flipped = wants ? { ...shape, error_code: null } : { ...shape, error_code: "oops" };
      expect(() => insertRaw(db, "wh_jobs", jobRow({ state, ...flipped })), state).toThrow(CHECK);
    }
  });

  it("starts a prepared job at no attempts", () => {
    const { db } = openLocalDb();
    expect(() => insertRaw(db, "wh_jobs", jobRow({ attempts: 1 }))).toThrow(CHECK);
    // A job past `prepared` may carry any count.
    insertRaw(db, "wh_jobs", jobRow({ state: "cancelled", attempts: 3 }));
  });

  it("lets one job of a session wait, whatever the others did, and per pairing", () => {
    const { db } = openLocalDb();
    // The finished ones never block a waiting job nor each other.
    for (const state of ["sent", "verified", "cancelled", "sent"] as const) {
      insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, state, ...STATE_SHAPES[state] }));
    }
    insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION }));
    // Each waiting state blocks the next waiting job of the same session.
    for (const state of OPEN_STATES) {
      expect(
        () =>
          insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, state, ...STATE_SHAPES[state] })),
        state,
      ).toThrow(UNIQUE);
    }
    // Another session, and another pairing's session of the same id, wait on their own.
    insertRaw(db, "wh_jobs", jobRow({ session_id: "another" }));
    insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, device_id: OTHER_DEVICE }));
    insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, host_id: "another-host" }));
    // A job id is unique on its own.
    const first = jobRow({ session_id: "third" });
    insertRaw(db, "wh_jobs", first);
    expect(() => insertRaw(db, "wh_jobs", { ...first, session_id: "fourth" })).toThrow(UNIQUE);
  });

  it("limits a session's reason and ties its two finish columns together", () => {
    const { db } = openLocalDb();
    for (const reason of ["not_printed", "damaged", "lost"]) {
      insertRaw(db, "wh_sessions", sessionRow({ reason, device_id: `device-${reason}` }));
    }
    expect(() => insertRaw(db, "wh_sessions", sessionRow({ reason: "other" }))).toThrow(CHECK);
    insertRaw(
      db,
      "wh_sessions",
      sessionRow({ device_id: "done", finished_at: LATER, finished_by: OPERATOR_ID }),
    );
    expect(() => insertRaw(db, "wh_sessions", sessionRow({ finished_at: LATER }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_sessions", sessionRow({ finished_by: OPERATOR_ID }))).toThrow(
      CHECK,
    );
  });

  it("keeps one open session per pairing, and a new one once it is finished", () => {
    const { db } = openLocalDb();
    const first = sessionRow();
    insertRaw(db, "wh_sessions", first);
    expect(() => insertRaw(db, "wh_sessions", sessionRow())).toThrow(UNIQUE);
    // Another device, and another host with the same device, have their own.
    insertRaw(db, "wh_sessions", sessionRow({ device_id: OTHER_DEVICE }));
    insertRaw(db, "wh_sessions", sessionRow({ host_id: "another-host" }));
    // The finished ones do not count, however many.
    db.prepare("UPDATE wh_sessions SET finished_at = ?, finished_by = ? WHERE id = ?").run(
      LATER,
      OPERATOR_ID,
      first["id"] ?? null,
    );
    insertRaw(db, "wh_sessions", sessionRow());
    expect(() => insertRaw(db, "wh_sessions", { ...first, host_id: "yet-another" })).toThrow(
      UNIQUE,
    );
  });

  it("holds a record as a JSON object with a receipt only together with its outcome", () => {
    const { db } = openLocalDb();
    insertRaw(db, "wh_outbox", outboxRow({ payload: '{"id":"x"}' }));
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ payload: "[]" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ payload: "{" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ attempts: -1 }))).toThrow(CHECK);
    insertRaw(db, "wh_outbox", outboxRow({ outcome: "accepted", acked_at: LATER }));
    insertRaw(
      db,
      "wh_outbox",
      outboxRow({ outcome: "rejected", outcome_code: "subject_unknown", acked_at: LATER }),
    );
    expect(() =>
      insertRaw(db, "wh_outbox", outboxRow({ outcome: "conflict", acked_at: LATER })),
    ).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ outcome: "accepted" }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ acked_at: LATER }))).toThrow(CHECK);
    expect(() => insertRaw(db, "wh_outbox", outboxRow({ outcome_code: "orphan" }))).toThrow(CHECK);
  });

  it("numbers its records in the order they came and takes an id only once", () => {
    const { db } = openLocalDb();
    const first = outboxRow();
    insertRaw(db, "wh_outbox", first);
    insertRaw(db, "wh_outbox", outboxRow());
    expect(rows(db, "SELECT seq FROM wh_outbox ORDER BY seq").map((row) => row["seq"])).toEqual([
      1, 2,
    ]);
    // The id is unique across pairings: the host's receipt names a record by it.
    expect(() => insertRaw(db, "wh_outbox", { ...first, device_id: OTHER_DEVICE })).toThrow(UNIQUE);
  });

  it("fixes the indexes: which are unique, which are partial, in which column order", () => {
    const { db } = openLocalDb();
    const indexes = rows(
      db,
      'SELECT t.name AS tableName, i.name AS name, i."unique" AS isUnique, i.partial AS isPartial ' +
        "FROM pragma_table_list AS t, pragma_index_list(t.name) AS i " +
        "WHERE t.schema = 'main' AND i.origin = 'c' AND t.name LIKE 'wh\\_%' ESCAPE '\\' " +
        "ORDER BY i.name",
    );
    expect(indexes).toEqual([
      { tableName: "wh_jobs", name: "wh_jobs_open", isUnique: 1, isPartial: 1 },
      { tableName: "wh_jobs", name: "wh_jobs_session", isUnique: 0, isPartial: 0 },
      { tableName: "wh_outbox", name: "wh_outbox_session", isUnique: 0, isPartial: 0 },
      { tableName: "wh_outbox", name: "wh_outbox_unsent", isUnique: 0, isPartial: 1 },
      { tableName: "wh_sessions", name: "wh_sessions_finished", isUnique: 0, isPartial: 1 },
      { tableName: "wh_sessions", name: "wh_sessions_open", isUnique: 1, isPartial: 1 },
    ]);
    const columns = (index: string): unknown[] =>
      rows(db, "SELECT name FROM pragma_index_info(?) ORDER BY seqno", index).map(
        (row) => row["name"],
      );
    expect(columns("wh_jobs_session")).toEqual(["host_id", "device_id", "session_id", "identity"]);
    expect(columns("wh_jobs_open")).toEqual(["host_id", "device_id", "session_id"]);
    expect(columns("wh_sessions_open")).toEqual(["host_id", "device_id"]);
    expect(columns("wh_sessions_finished")).toEqual(["host_id", "device_id", "finished_at"]);
    expect(columns("wh_outbox_unsent")).toEqual(["host_id", "device_id", "seq"]);
    // The session leads, so the unsent count (host and device only) is not drawn to it.
    expect(columns("wh_outbox_session")).toEqual(["session_id", "host_id", "device_id"]);
  });
});

describe("the warehouse store's reads and writes", () => {
  it("reads a job back as it was written, only for its own pairing", async () => {
    const { executor } = openLocalDb();
    const input = job("job-1", {
      kind: "pallet",
      subjectId: "a0000000-0000-4000-8000-000000000001",
      identity: "146006820000000409",
      repair: "legacy_tspl_fnc1_literal",
      reason: "lost",
      templateSpec: '{"widthMm":58}',
      createdAt: AT,
    });
    await executor.transaction([insertJobStatement(PAIRING, input)]);
    const expected = { ...input, attempts: 0, updatedAt: AT };
    expect(await readJob(executor, PAIRING, "job-1")).toEqual(expected);
    expect(await readOpenJob(executor, PAIRING, SESSION)).toEqual(expected);
    expect(await readJobByIdentity(executor, PAIRING, SESSION, "146006820000000409")).toEqual(
      expected,
    );
    // Another device of the same host, and another session, see nothing of it.
    expect(await readJob(executor, OTHER, "job-1")).toBeNull();
    expect(await readJob(executor, FOREIGN, "job-1")).toBeNull();
    expect(await readOpenJob(executor, OTHER, SESSION)).toBeNull();
    expect(await readOpenJob(executor, PAIRING, "another-session")).toBeNull();
    expect(await readJobByIdentity(executor, OTHER, SESSION, "146006820000000409")).toBeNull();
    expect(
      await readJobByIdentity(executor, PAIRING, "another-session", "146006820000000409"),
    ).toBe(null);
    expect(await readJobByIdentity(executor, PAIRING, SESSION, BOX_SSCC)).toBeNull();
  });

  it("calls a job waiting in each of its four waiting states, and in no other", async () => {
    const { db, executor } = openLocalDb();
    for (const state of STATES) {
      insertRaw(db, "wh_jobs", jobRow({ session_id: `s-${state}`, state, ...STATE_SHAPES[state] }));
      const waiting = await readOpenJob(executor, PAIRING, `s-${state}`);
      expect(waiting?.state ?? null, state).toBe(OPEN_STATES.includes(state) ? state : null);
    }
  });

  it("finds the newest job of a code that was not cancelled", async () => {
    const { db, executor } = openLocalDb();
    const base = { session_id: SESSION, identity: BOX_SSCC, ...STATE_SHAPES.sent, state: "sent" };
    insertRaw(db, "wh_jobs", jobRow({ ...base, id: "older" }));
    insertRaw(db, "wh_jobs", jobRow({ ...base, id: "newer" }));
    // A cancelled print left nothing behind, so it is neither the answer nor a repeat.
    insertRaw(
      db,
      "wh_jobs",
      jobRow({ ...base, id: "cancelled", state: "cancelled", ...STATE_SHAPES.cancelled }),
    );
    insertRaw(db, "wh_jobs", jobRow({ ...base, id: "another-code", identity: "other-code" }));
    expect((await readJobByIdentity(executor, PAIRING, SESSION, BOX_SSCC))?.id).toBe("newer");
    expect((await readJobByIdentity(executor, PAIRING, SESSION, "other-code"))?.id).toBe(
      "another-code",
    );
  });

  it("counts the labels that went to a printer: sent and checked, of this session and pairing", async () => {
    const { db, executor } = openLocalDb();
    const rowOf = (state: WarehouseJobState, overrides: RawRow = {}): RawRow =>
      jobRow({ session_id: SESSION, state, ...STATE_SHAPES[state], ...overrides });
    for (const state of ["sent", "sent", "verified", "cancelled", "unknown"] as const) {
      insertRaw(db, "wh_jobs", rowOf(state));
    }
    insertRaw(db, "wh_jobs", rowOf("sent", { session_id: "another-session" }));
    insertRaw(db, "wh_jobs", rowOf("sent", { device_id: OTHER_DEVICE }));
    expect(await countSent(executor, PAIRING, SESSION)).toBe(3);
    expect(await countSent(executor, PAIRING, "empty-session")).toBe(0);
  });

  it("refuses to read a job whose stored printer or fields this build cannot read", async () => {
    const { db, executor } = openLocalDb();
    insertRaw(db, "wh_jobs", jobRow({ id: "bad-printer", printer: '{"id":"x"}' }));
    insertRaw(db, "wh_jobs", jobRow({ id: "bad-fields", fields: "{}" }));
    insertRaw(db, "wh_jobs", jobRow({ id: "bad-kind-of-fields", fields: "[]" }));
    for (const id of ["bad-printer", "bad-fields", "bad-kind-of-fields"]) {
      await expect(readJob(executor, PAIRING, id), id).rejects.toBeInstanceOf(
        UnreadableWarehouseJobError,
      );
    }
    insertRaw(db, "wh_jobs", jobRow({ id: "good", printer: PRINTER_JSON }));
    expect((await readJob(executor, PAIRING, "good"))?.printer).toEqual(ZEBRA);
  });

  it("moves a job from the state and attempt it was read in, and writes every column of the move", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([
      insertJobStatement(PAIRING, job("job-1", { printer: null, bytesBase64: null })),
    ]);
    const read = await readJob(executor, PAIRING, "job-1");
    if (read === null) throw new Error("the job is there");
    const move = {
      state: "unknown",
      errorCode: "timeout",
      attempts: 2,
      reason: "lost",
      printer: ZEBRA,
      bytesBase64: "QUJD",
    } as const;
    // The attempt count must be the one that was read, even when the state is.
    await expect(
      executor.transaction([moveJobStatement(PAIRING, { ...read, attempts: 1 }, move, LATER)]),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    // Another pairing's key does not reach the row.
    await expect(
      executor.transaction([moveJobStatement(OTHER, read, move, LATER)]),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(await readJob(executor, PAIRING, "job-1")).toEqual({ ...read });
    // A refused move rolls back what shares its batch.
    const record = warehouseRecord(read, {
      id: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
      attempt: 2,
      reason: "lost",
      outcome: "unknown",
      errorCode: "timeout",
      operatorId: OPERATOR_ID,
      occurredAt: LATER,
    });
    await expect(
      executor.transaction([
        recordStatement(PAIRING, record, LATER),
        moveJobStatement(PAIRING, { ...read, state: "sent" }, move, LATER),
      ]),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT id FROM wh_outbox")).toEqual([]);
    await executor.transaction([moveJobStatement(PAIRING, read, move, LATER)]);
    expect(await readJob(executor, PAIRING, "job-1")).toEqual({
      ...read,
      state: "unknown",
      errorCode: "timeout",
      attempts: 2,
      reason: "lost",
      printer: ZEBRA,
      bytesBase64: "QUJD",
      updatedAt: LATER,
    });
  });

  it("starts a session with its templates, and passes on an error that no open session explains", async () => {
    const { db, executor } = openLocalDb();
    const started = await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "not_printed",
      templates: { unit: UNIT_TEMPLATE, box: null, pallet: "p-template" },
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(started).toEqual({
      id: SESSION,
      reason: "not_printed",
      templates: { unit: UNIT_TEMPLATE, box: null, pallet: "p-template" },
      startedBy: OPERATOR_ID,
      startedAt: AT,
    });
    expect(await readOpenSession(executor, PAIRING)).toEqual(started);
    // Another device has its own session; the first is not its answer.
    const other = await startSession(executor, OTHER, {
      id: "other-session",
      reason: "lost",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    expect(other.id).toBe("other-session");
    expect((await readOpenSession(executor, PAIRING))?.id).toBe(SESSION);
    // A finished session's id cannot be started again, and no open session answers in its place.
    await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, LATER);
    await expect(
      startSession(executor, PAIRING, {
        id: SESSION,
        reason: "lost",
        templates: TEMPLATES,
        operatorId: OPERATOR_ID,
        at: LATER,
      }),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(rows(db, "SELECT count(*) AS n FROM wh_sessions")).toEqual([{ n: 2 }]);
  });

  it("changes only its own pairing's open session, and a session once finished stays as it finished", async () => {
    const { db, executor } = openLocalDb();
    const session = await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    await expect(
      updateSession(executor, OTHER, { ...session, reason: "lost" }, LATER),
    ).rejects.toBeInstanceOf(StaleWarehouseError);
    await expect(
      updateSession(executor, FOREIGN, { ...session, reason: "lost" }, LATER),
    ).rejects.toBeInstanceOf(StaleWarehouseError);
    await updateSession(
      executor,
      PAIRING,
      { ...session, reason: "lost", templates: { unit: null, box: "b", pallet: "p" } },
      LATER,
    );
    expect(
      rows(
        db,
        "SELECT reason, unit_template_id, box_template_id, pallet_template_id, updated_at FROM wh_sessions",
      ),
    ).toEqual([
      {
        reason: "lost",
        unit_template_id: null,
        box_template_id: "b",
        pallet_template_id: "p",
        updated_at: LATER,
      },
    ]);
    // Another pairing cannot finish it.
    expect(await finishSession(executor, OTHER, SESSION, OPERATOR_ID, LATER)).toBe("busy");
    expect(await finishSession(executor, FOREIGN, SESSION, OPERATOR_ID, LATER)).toBe("busy");
    expect(await readOpenSession(executor, PAIRING)).not.toBeNull();
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, LATER)).toBe("finished");
    expect(rows(db, "SELECT finished_at, finished_by, updated_at FROM wh_sessions")).toEqual([
      { finished_at: LATER, finished_by: OPERATOR_ID, updated_at: LATER },
    ]);
    // A second finish changes nothing: the first operator and instant stay.
    await finishSession(executor, PAIRING, SESSION, "someone-else", "2026-10-10T00:00:00.000Z");
    expect(rows(db, "SELECT finished_at, finished_by, updated_at FROM wh_sessions")).toEqual([
      { finished_at: LATER, finished_by: OPERATOR_ID, updated_at: LATER },
    ]);
  });

  it("does not finish while a job waits in any of its four waiting states, and finishes past the others", async () => {
    const { db, executor } = openLocalDb();
    for (const state of STATES) {
      const session = `s-${state}`;
      await startSession(
        executor,
        { hostId: HOST_ID, deviceId: `device-${state}` },
        {
          id: session,
          reason: "damaged",
          templates: TEMPLATES,
          operatorId: OPERATOR_ID,
          at: AT,
        },
      );
      insertRaw(
        db,
        "wh_jobs",
        jobRow({
          device_id: `device-${state}`,
          session_id: session,
          state,
          ...STATE_SHAPES[state],
        }),
      );
      const result = await finishSession(
        executor,
        { hostId: HOST_ID, deviceId: `device-${state}` },
        session,
        OPERATOR_ID,
        LATER,
      );
      expect(result, state).toBe(OPEN_STATES.includes(state) ? "busy" : "finished");
    }
  });

  it("is held back by a waiting job of its own session only, not of another session, device or host", async () => {
    const { db, executor } = openLocalDb();
    await startSession(executor, PAIRING, {
      id: SESSION,
      reason: "damaged",
      templates: TEMPLATES,
      operatorId: OPERATOR_ID,
      at: AT,
    });
    // Waiting jobs of the same session id under another device and under another host, and
    // of another session of this pairing: none of them is this session's.
    insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, device_id: OTHER_DEVICE }));
    insertRaw(db, "wh_jobs", jobRow({ session_id: SESSION, host_id: "another-host" }));
    insertRaw(db, "wh_jobs", jobRow({ session_id: "another-session" }));
    expect(await finishSession(executor, PAIRING, SESSION, OPERATOR_ID, LATER)).toBe("finished");
  });

  it("counts the records that wait for the host's receipt, of this pairing only", async () => {
    const { db, executor } = openLocalDb();
    insertRaw(db, "wh_outbox", outboxRow());
    insertRaw(db, "wh_outbox", outboxRow({ outcome: "accepted", acked_at: LATER }));
    insertRaw(
      db,
      "wh_outbox",
      outboxRow({ outcome: "rejected", outcome_code: "x", acked_at: LATER }),
    );
    insertRaw(db, "wh_outbox", outboxRow({ device_id: OTHER_DEVICE }));
    insertRaw(db, "wh_outbox", outboxRow({ host_id: "another-host" }));
    expect(await countUnsentRecords(executor, PAIRING)).toBe(1);
    expect(await countUnsentRecords(executor, OTHER)).toBe(1);
    expect(await countUnsentRecords(executor, { hostId: "nobody", deviceId: DEVICE_ID })).toBe(0);
  });
});

describe("the retention of finished warehouse sessions", () => {
  /** A finished session of `pairing` with a job and a record of the given receipt. */
  function finished(
    db: DatabaseSync,
    id: string,
    options: {
      finishedAt?: string;
      outcomes?: (string | null)[];
      device?: string;
      open?: boolean;
    } = {},
  ): void {
    const { finishedAt = AT, outcomes = ["accepted"], device = DEVICE_ID, open = false } = options;
    insertRaw(
      db,
      "wh_sessions",
      sessionRow({
        id,
        device_id: device,
        finished_at: open ? null : finishedAt,
        finished_by: open ? null : OPERATOR_ID,
      }),
    );
    insertRaw(
      db,
      "wh_jobs",
      jobRow({ id: `${id}-job`, session_id: id, device_id: device, state: "cancelled" }),
    );
    for (const outcome of outcomes) {
      insertRaw(
        db,
        "wh_outbox",
        outboxRow({
          session_id: id,
          device_id: device,
          outcome,
          acked_at: outcome === null ? null : LATER,
          outcome_code: outcome === "rejected" ? "subject_unknown" : null,
        }),
      );
    }
  }

  const counts = (db: DatabaseSync): unknown =>
    rows(
      db,
      "SELECT (SELECT count(*) FROM wh_sessions) AS sessions, (SELECT count(*) FROM wh_jobs) AS jobs, " +
        "(SELECT count(*) FROM wh_outbox) AS records",
    );

  it("waits a full 30 days after the finish, to the millisecond", async () => {
    const { db, executor } = openLocalDb();
    expect(WAREHOUSE_RETENTION_MS).toBe(30 * 24 * 3600 * 1000);
    finished(db, "s1");
    const due = Date.parse(AT) + WAREHOUSE_RETENTION_MS;
    expect(await purgeWarehouseSessions(executor, PAIRING, new Date(due - 1))).toBe(0);
    expect(counts(db)).toEqual([{ sessions: 1, jobs: 1, records: 1 }]);
    expect(await purgeWarehouseSessions(executor, PAIRING, new Date(due))).toBe(1);
    expect(counts(db)).toEqual([{ sessions: 0, jobs: 0, records: 0 }]);
  });

  it("keeps an open session, however old and however accepted", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "open", { open: true });
    expect(await purgeWarehouseSessions(executor, PAIRING, new Date("2027-12-31T00:00:00Z"))).toBe(
      0,
    );
    expect(counts(db)).toEqual([{ sessions: 1, jobs: 1, records: 1 }]);
  });

  it("keeps a session while any record lacks the host's acceptance, a refused one included", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "mixed", { outcomes: ["accepted", null] });
    finished(db, "refused", { outcomes: ["accepted", "rejected"], device: OTHER_DEVICE });
    const now = new Date(Date.parse(AT) + 40 * 24 * 3600 * 1000);
    // Such a session is not even found due: no delete is attempted for it.
    let attempts = 0;
    const counting: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      transaction(statements) {
        attempts += 1;
        return executor.transaction(statements);
      },
    };
    expect(await purgeWarehouseSessions(counting, PAIRING, now)).toBe(0);
    expect(await purgeWarehouseSessions(counting, OTHER, now)).toBe(0);
    expect(attempts).toBe(0);
    expect(counts(db)).toEqual([{ sessions: 2, jobs: 2, records: 4 }]);
  });

  it("forgets a finished session that never wrote a record", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "empty", { outcomes: [] });
    const now = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    expect(await purgeWarehouseSessions(executor, PAIRING, now)).toBe(1);
    expect(counts(db)).toEqual([{ sessions: 0, jobs: 0, records: 0 }]);
  });

  it("deletes only the due session's own jobs and records, of this pairing", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "due", { outcomes: ["accepted", "accepted"] });
    // Its record waits for a receipt, which does not hold back the other session.
    finished(db, "recent", { finishedAt: "2026-11-05T00:00:00.000Z", outcomes: [null] });
    finished(db, "foreign", { device: OTHER_DEVICE });
    // The same session id under another pairing is not this pairing's to delete.
    insertRaw(
      db,
      "wh_jobs",
      jobRow({
        id: "due-job-of-other",
        session_id: "due",
        device_id: OTHER_DEVICE,
        state: "cancelled",
      }),
    );
    insertRaw(db, "wh_outbox", outboxRow({ session_id: "due", device_id: OTHER_DEVICE }));
    const now = new Date("2026-11-08T12:00:00.000Z");
    expect(await purgeWarehouseSessions(executor, PAIRING, now)).toBe(1);
    expect(rows(db, "SELECT id FROM wh_sessions ORDER BY id")).toEqual([
      { id: "foreign" },
      { id: "recent" },
    ]);
    expect(rows(db, "SELECT id FROM wh_jobs ORDER BY id")).toEqual([
      { id: "due-job-of-other" },
      { id: "foreign-job" },
      { id: "recent-job" },
    ]);
    expect(
      rows(db, "SELECT session_id, device_id FROM wh_outbox ORDER BY session_id, device_id"),
    ).toEqual([
      { session_id: "due", device_id: OTHER_DEVICE },
      { session_id: "foreign", device_id: OTHER_DEVICE },
      { session_id: "recent", device_id: DEVICE_ID },
    ]);
  });

  it("deletes a session by its own pairing's key only", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "mine");
    for (const other of [OTHER, FOREIGN]) {
      await expect(
        executor.transaction([
          {
            sql: PURGE_SESSION_SQL,
            values: [other.hostId, other.deviceId, "mine"],
            expectedChanges: 1,
          },
        ]),
      ).rejects.toMatchObject({ code: "changes_mismatch" });
    }
    expect(counts(db)).toEqual([{ sessions: 1, jobs: 1, records: 1 }]);
    await executor.transaction([
      { sql: PURGE_SESSION_SQL, values: [HOST_ID, DEVICE_ID, "mine"], expectedChanges: 1 },
    ]);
    expect(counts(db)).toEqual([{ sessions: 0, jobs: 1, records: 1 }]);
  });

  it("does not even try another pairing's due session", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "foreign", { device: OTHER_DEVICE });
    let attempts = 0;
    const counting: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      transaction(statements) {
        attempts += 1;
        return executor.transaction(statements);
      },
    };
    const now = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    expect(await purgeWarehouseSessions(counting, PAIRING, now)).toBe(0);
    expect(attempts).toBe(0);
    expect(await purgeWarehouseSessions(counting, OTHER, now)).toBe(1);
    expect(attempts).toBe(1);
  });

  it("leaves a session whole that took a record after it was found due", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "racy");
    const racing: LocalExecutor = {
      transaction: (statements) => executor.transaction(statements),
      async query(sql, params, row) {
        const found = await executor.query(sql, params, row);
        // The record arrives between the read of the due sessions and their delete.
        if (sql === DUE_SESSIONS_SQL) insertRaw(db, "wh_outbox", outboxRow({ session_id: "racy" }));
        return found;
      },
    };
    const now = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    expect(await purgeWarehouseSessions(racing, PAIRING, now)).toBe(0);
    expect(counts(db)).toEqual([{ sessions: 1, jobs: 1, records: 2 }]);
    // Next pass: the new record still waits, so the session still stays.
    expect(await purgeWarehouseSessions(executor, PAIRING, now)).toBe(0);
  });

  it("passes on a failure that is not a lost race, and goes on to the next session after a lost one", async () => {
    const { db, executor } = openLocalDb();
    finished(db, "a");
    finished(db, "b");
    const now = new Date(Date.parse(AT) + 31 * 24 * 3600 * 1000);
    const broken: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      async transaction() {
        throw new Error("disk gone");
      },
    };
    await expect(purgeWarehouseSessions(broken, PAIRING, now)).rejects.toThrow("disk gone");
    // A refused statement is no lost race either: only `changes_mismatch` is.
    const refusing: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      async transaction() {
        throw new LocalDbError("statement_failed", "constraint");
      },
    };
    await expect(purgeWarehouseSessions(refusing, PAIRING, now)).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(counts(db)).toEqual([{ sessions: 2, jobs: 2, records: 2 }]);
    // `a` takes a record after the read; `b` is purged all the same.
    const racing: LocalExecutor = {
      transaction: (statements) => executor.transaction(statements),
      async query(sql, params, row) {
        const found = await executor.query(sql, params, row);
        if (sql === DUE_SESSIONS_SQL) insertRaw(db, "wh_outbox", outboxRow({ session_id: "a" }));
        return found;
      },
    };
    expect(await purgeWarehouseSessions(racing, PAIRING, now)).toBe(1);
    expect(rows(db, "SELECT id FROM wh_sessions")).toEqual([{ id: "a" }]);
  });
});
