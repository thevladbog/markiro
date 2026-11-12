import { z } from "zod";

import {
  scannedCodeSchema,
  type FactRecord,
  type ScannedCode,
  type SetItem,
} from "../../host/protocol.js";
import { MAX_BATCH_BYTES } from "../../local/facts-sender.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, scannedCode } from "../facts.js";
import { readScan } from "./scan-pipeline.js";

export interface SetAssemblyContext {
  local: LocalExecutor;
  pairing: Pairing;
  shiftId: string;
  setGtin: string;
  recipe: readonly SetItem[];
  operatorId: string;
  now: () => string;
  newId: () => string;
}

const scopeSql = "host_id = ? AND device_id = ? AND shift_id = ?";
const draftSql = `${scopeSql} AND assembly_id IS NULL`;
const enteredShiftSql =
  "EXISTS (SELECT 1 FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ? " +
  "AND local_state IS NULL AND entered_at IS NOT NULL";
const activeShiftSql = `${enteredShiftSql} AND status = 'active')`;

const draftRow = z.object({ code: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

function scope({ pairing, shiftId }: SetAssemblyContext) {
  return [pairing.hostId, pairing.deviceId, shiftId];
}

export async function readCompletedSetCount(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
) {
  const [count] = await local.query(
    `SELECT count(*) AS n FROM floor_set_marks WHERE ${scopeSql} AND is_set = 1`,
    [pairing.hostId, pairing.deviceId, shiftId],
    countRow,
  );
  return count?.n ?? 0;
}

/** Local assemblies excluded from the host's shared total after its receipts arrive. */
export async function readLostSets(local: LocalExecutor, pairing: Pairing, shiftId: string) {
  const [count] = await local.query(
    "WITH RECURSIVE attempts(outcome, resent_as) AS (" +
      "SELECT o.outcome, o.resent_as FROM floor_set_marks m JOIN outbox o ON o.id = m.assembly_id " +
      "WHERE m.host_id = ? AND m.device_id = ? AND m.shift_id = ? AND m.is_set = 1 " +
      "UNION ALL SELECT o.outcome, o.resent_as FROM attempts a JOIN outbox o ON o.id = a.resent_as" +
      ") SELECT count(*) AS n FROM attempts WHERE resent_as IS NULL AND outcome IN ('conflict', 'rejected')",
    [pairing.hostId, pairing.deviceId, shiftId],
    countRow,
  );
  return count?.n ?? 0;
}

export async function readSetAssembly(context: SetAssemblyContext) {
  const [draft, completed] = await Promise.all([
    context.local.query(
      `SELECT code FROM floor_set_marks WHERE ${draftSql} ORDER BY seq`,
      scope(context),
      draftRow,
    ),
    readCompletedSetCount(context.local, context.pairing, context.shiftId),
  ]);
  return {
    items: draft.map(({ code }) => scannedCodeSchema.parse(JSON.parse(code))),
    completed,
  };
}

export type SetScanResult =
  | "item"
  | "assembled"
  | "invalid"
  | "wrong_item"
  | "duplicate"
  | "quantity_met"
  | "incomplete"
  | "too_large";

export function setItemCounts(items: readonly ScannedCode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.gtin14, (counts.get(item.gtin14) ?? 0) + 1);
  return counts;
}

/** The work queue serializes scans and undo. The database guard also checks the draft at commit. */
export async function recordSetScan(
  context: SetAssemblyContext,
  raw: string,
): Promise<SetScanResult> {
  const scan = readScan(raw);
  if (scan.kind !== "km") return "invalid";

  const code = scannedCode(scan.km);
  const { local, pairing, shiftId } = context;
  const values = scope(context);
  const [used] = await local.query(
    "SELECT count(*) AS n FROM floor_set_marks WHERE host_id = ? AND device_id = ? AND code_hash = ?",
    [pairing.hostId, pairing.deviceId, code.codeHash],
    countRow,
  );
  if (used?.n) return "duplicate";

  const { items } = await readSetAssembly(context);
  const counts = setItemCounts(items);
  const isSet = code.gtin14 === context.setGtin;
  const payload = JSON.stringify(code);

  if (!isSet) {
    const target = context.recipe.find(({ gtin14 }) => gtin14 === code.gtin14);
    if (!target) return "wrong_item";
    if ((counts.get(code.gtin14) ?? 0) >= target.quantity) return "quantity_met";
    // Leave room for the envelope and the set mark, including escaped GS bytes.
    const itemBytes = new TextEncoder().encode(JSON.stringify([...items, code])).length;
    if (itemBytes > MAX_BATCH_BYTES - 8192) return "too_large";
    await local.transaction([
      {
        sql:
          "INSERT INTO floor_set_marks (host_id, device_id, shift_id, code_hash, code) " +
          `SELECT ?, ?, ?, ?, ? WHERE ${activeShiftSql} AND ` +
          `(SELECT count(*) FROM floor_set_marks WHERE ${draftSql}) = ?`,
        values: [...values, code.codeHash, payload, ...values, ...values, items.length],
        expectedChanges: 1,
      },
    ]);
    return "item";
  }

  if (!context.recipe.every(({ gtin14, quantity }) => counts.get(gtin14) === quantity)) {
    return "incomplete";
  }
  const id = context.newId();
  const assembledAt = context.now();
  const fact: FactRecord = {
    id,
    shiftId,
    operatorId: context.operatorId,
    kind: "set_assembled",
    data: { assembledAt, items, setCode: code },
  };
  const itemHashes = JSON.stringify(items.map(({ codeHash }) => codeHash));
  await local.transaction([
    {
      sql:
        "INSERT INTO floor_set_marks (host_id, device_id, shift_id, code_hash, assembly_id, is_set) " +
        `SELECT ?, ?, ?, ?, ?, 1 WHERE ${activeShiftSql} AND ` +
        `(SELECT count(*) FROM floor_set_marks WHERE ${draftSql}) = ?`,
      values: [...values, code.codeHash, id, ...values, ...values, items.length],
      expectedChanges: 1,
    },
    {
      sql:
        `UPDATE floor_set_marks SET assembly_id = ?, code = NULL WHERE ${draftSql} ` +
        "AND code_hash IN (SELECT value FROM json_each(?))",
      values: [id, ...values, itemHashes],
      expectedChanges: items.length,
    },
    outboxStatement(fact, pairing, assembledAt),
  ]);
  return "assembled";
}

export async function undoSetItem(context: SetAssemblyContext): Promise<void> {
  const values = scope(context);
  await context.local.transaction([
    {
      sql:
        `DELETE FROM floor_set_marks WHERE seq = (` +
        `SELECT seq FROM floor_set_marks WHERE ${draftSql} ORDER BY seq DESC LIMIT 1` +
        `) AND ${enteredShiftSql})`,
      values: [...values, ...values],
    },
  ]);
}
