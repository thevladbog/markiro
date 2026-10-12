import { readFileSync } from "node:fs";

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { vi } from "vitest";

import { outboxStatement, scanRecord } from "../../src/floor/facts.js";
import {
  keepEnteredShift,
  readStoredWork,
  type WorkShift,
} from "../../src/floor/shifts/shift-copies.js";
import type { SnapshotOrganization, SnapshotSheet } from "../../src/floor/shifts/shift-snapshot.js";
import type { ScanContext } from "../../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type CodeCheck, type EnteredShift } from "../../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";
import { openLocalDb } from "./local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const supportModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../proto/fixtures/${name}`, supportModuleUrl), "utf8"),
  );
}

export const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

/** The active shift of milk this station entered (`device-shift-entered.json`): 12 to a box, 1 200 planned. */
export const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
export const SHIFT_ID = ENTERED.id;
/** The shift's GTIN and its issuer prefix. */
export const GTIN = "04600682000013";
export const PREFIX = "460068200";
/** A GTIN-14 of another product. */
export const OTHER_GTIN = "04607004650017";
/** Anna, the operator of the session. */
export const OPERATOR_ID = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";

/**
 * A product's code as a scanner hands it over: the AIM prefix `]d2`, AI 01
 * with the GTIN, AI 21 with the serial, the group separator and the crypto
 * tail (AI 93).
 */
export function km(serial: string, options: { gtin?: string; tail?: string; aim?: boolean } = {}) {
  const { gtin = GTIN, tail = "dGVz", aim = true } = options;
  return `${aim ? "]d2" : ""}01${gtin}21${serial}\u001d93${tail}`;
}

/** The shift entered and stored, read back as the work screen gets it. */
export async function enteredShift(
  local: LocalExecutor,
  shift: EnteredShift = ENTERED,
): Promise<WorkShift> {
  await keepEnteredShift(local, PAIRING, shift, "2026-10-08T06:02:00.000Z", 1_790_000_000_000);
  const stored = await readStoredWork(local, PAIRING, shift.id);
  if (stored.kind !== "ready") throw new Error(`the entered shift reads as ${stored.kind}`);
  return stored.shift;
}

/**
 * The entered shift with `organization` as its snapshot froze it (plan А4):
 * only what a render reads is replaced, the shift is not stored again.
 */
export async function workShift(organization: SnapshotOrganization | null): Promise<WorkShift> {
  const { executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { ...shift, snapshot: { ...shift.snapshot, organization } };
}

/**
 * The entered shift with the A4 sheet and the organization as its snapshot
 * froze them (plan А4): what `renderShiftSheet` reads, the shift not stored again.
 */
export async function sheetedShift(frozen: {
  palletSheet: SnapshotSheet | null;
  organization: SnapshotOrganization | null;
}): Promise<WorkShift> {
  const { executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { ...shift, snapshot: { ...shift.snapshot, ...frozen } };
}

/** A clock that moves on by one second per reading, from 06:15:00.000Z. */
export function steppingClock(start = Date.parse("2026-10-08T06:15:00.000Z")) {
  let next = start;
  return () => {
    const now = new Date(next);
    next += 1_000;
    return now;
  };
}

/** Ids `…0001`, `…0002`, … in order of asking. */
export function countingIds() {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

/** The pipeline's context over `local`: offline, no host, a stepping clock and counting ids. */
export function scanContext(
  local: LocalExecutor,
  shift: WorkShift,
  overrides: Partial<ScanContext> = {},
): ScanContext {
  return {
    local,
    pairing: PAIRING,
    shift,
    operatorId: OPERATOR_ID,
    online: () => false,
    checkCode: vi.fn<(codeHash: string) => Promise<CodeCheck>>(async () => ({ status: "free" })),
    onHostError: vi.fn<(error: unknown) => void>(),
    now: steppingClock(),
    newId: countingIds(),
    ...overrides,
  };
}

/** Every row of `sql` with `params`, as node:sqlite reads it. */
export function rows(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));
}

/**
 * An executor whose next transaction waits for `release()`: the test holds
 * the write while another piece of work reads, so the race the queue rules
 * out is played deterministically.
 */
export function holdingWrites(local: LocalExecutor) {
  let hold: Promise<void> | null = null;
  let release: () => void = () => undefined;
  let waiting: () => void = () => undefined;
  let reached = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const executor: LocalExecutor = {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async (statements: readonly LocalStatement[]) => {
      const held = hold;
      if (held !== null) {
        hold = null;
        waiting();
        await held;
      }
      return local.transaction(statements);
    },
  };
  return {
    executor,
    /** The next transaction waits until `release()`. */
    holdNext: () => {
      reached = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    /** Resolves once the held transaction is waiting. */
    reached: () => reached,
    release: () => release(),
  };
}

/** An executor whose every transaction fails as a full disk does. */
export function failingWrites(local: LocalExecutor): LocalExecutor {
  return {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async () => {
      throw new LocalDbError("statement_failed", "database or disk is full");
    },
  };
}

/** A second active shift of the same product this station entered, for two boxes at once. */
export const SECOND: EnteredShift = {
  ...ENTERED,
  id: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a",
  number: "OCT26-005/S",
};

export interface SeededBlock {
  blockId: string;
  from: number;
  to: number;
  next?: number;
  prefix?: string;
  extension?: number;
  hostId?: string;
  deviceId?: string;
  receivedAt?: string;
}

/** A block of SSCC serials this station holds, written as the block request keeps one. */
export function seedBlock(db: DatabaseSync, block: SeededBlock): void {
  db.prepare(
    "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
      "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    block.blockId,
    block.hostId ?? PAIRING.hostId,
    block.deviceId ?? PAIRING.deviceId,
    block.prefix ?? PREFIX,
    block.extension ?? 0,
    block.from,
    block.to,
    block.next ?? block.from,
    block.receivedAt ?? "2026-10-08T06:00:00.000Z",
  );
}

/**
 * `count` records of unreadable scans in the outbox of `pairing`, ids
 * `…000001`, `…000002`, … in order, written as the floor writes them.
 */
export async function unsentScans(
  local: LocalExecutor,
  count: number,
  pairing: { hostId: string; deviceId: string } = PAIRING,
  firstId = 1,
): Promise<string[]> {
  const ids: string[] = [];
  const statements: LocalStatement[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(firstId + index).padStart(12, "0")}`;
    ids.push(id);
    statements.push(
      outboxStatement(
        scanRecord(
          { id, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          {
            scannedAt: "2026-10-08T06:15:00.000Z",
            verdict: "invalid",
            duplicateSource: null,
            rawKind: "unknown",
            rawLength: 10,
            code: null,
            boxId: null,
          },
        ),
        pairing,
        "2026-10-08T06:15:00.000Z",
      ),
    );
    if (statements.length === 32 || index === count - 1) {
      await local.transaction(statements.splice(0));
    }
  }
  return ids;
}
