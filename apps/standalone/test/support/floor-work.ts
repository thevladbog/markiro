import { readFileSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";

import {
  keepEnteredShift,
  readStoredWork,
  type WorkShift,
} from "../../src/floor/shifts/shift-copies.js";
import type { ScanContext } from "../../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type CodeCheck, type EnteredShift } from "../../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";

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

/** Every row of `sql`, as node:sqlite reads it. */
export function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db
    .prepare(sql)
    .all()
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
