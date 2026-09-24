import { boxMembershipDigestV1, canonicalizeKm, kmHash } from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";

export interface BoxReconciliationFact {
  shiftId: string;
  boxId: string;
  sscc: string;
  closedAt: string;
  devicePalletId: string | null;
  itemCount: number;
  membershipDigest: string;
  digestVersion: 1;
  revision: number;
  /** A repair at this revision was already sent and acknowledged. */
  controlAfterReplay: boolean;
  /** Kept locally, never submitted to the API. */
  codeHashes: string[];
}

export interface BoxReconciliationResult {
  boxId: string;
  status: "confirmed" | "replay_required" | "content_mismatch" | "identity_conflict";
  reasonCode: string;
  serverItemCount: number | null;
}

interface BoxRow {
  box_id: string;
  shift_id: string;
  sscc: string;
  closed_at: string;
  pallet_id: string | null;
  reconciliation_revision: number;
  last_checked_revision: number;
  confirmed_revision: number;
}

interface MemberRow {
  code_hash: string;
  gtin14: string;
  serial: string;
  scanned_at: string;
}

interface EventRow {
  id: number;
  shift_id: string;
  terminal_id: string | null;
  raw: string;
  verdict: string;
  scanned_at: string;
  operator_id: string | null;
  code_hash: string | null;
  box_id: string | null;
}

export interface BoxReconciliationSummary {
  localClosed: number;
  delivered: number;
  confirmed: number;
  pending: number;
  issues: number;
}

export interface BoxReconciliationIssue {
  boxId: string;
  shiftId: string;
  sscc: string | null;
  reasonCode: string;
  localItemCount: number;
  serverItemCount: number | null;
  checkedAt: string;
}

export async function readBoxReconciliationLastChecked(
  exec: SqlExecutor,
  shiftId?: string,
): Promise<string | null> {
  const [row] = await exec.all<{ checked_at: string | null }>(
    `SELECT MAX(server_reconciled_at) checked_at FROM boxes_mirror
     WHERE closed_at IS NOT NULL AND disassembled_at IS NULL ${shiftId ? "AND shift_id=?" : ""}`,
    shiftId ? [shiftId] : [],
  );
  return row?.checked_at ?? null;
}

export async function readBoxReconciliationIssues(
  exec: SqlExecutor,
  shiftId?: string,
): Promise<BoxReconciliationIssue[]> {
  const rows = await exec.all<{
    box_id: string;
    shift_id: string;
    sscc: string | null;
    reason_code: string;
    local_item_count: number;
    server_item_count: number | null;
    checked_at: string;
  }>(
    `SELECT issue.box_id,issue.shift_id,box.sscc,issue.reason_code,
      issue.local_item_count,issue.server_item_count,issue.checked_at
    FROM box_reconciliation_issues issue
    LEFT JOIN boxes_mirror box ON box.box_id=issue.box_id
    ${shiftId ? "WHERE issue.shift_id=?" : ""}
    ORDER BY issue.checked_at DESC LIMIT 100`,
    shiftId ? [shiftId] : [],
  );
  return rows.map((row) => ({
    boxId: row.box_id,
    shiftId: row.shift_id,
    sscc: row.sscc,
    reasonCode: row.reason_code,
    localItemCount: row.local_item_count,
    serverItemCount: row.server_item_count,
    checkedAt: row.checked_at,
  }));
}

export async function readBoxReconciliationShifts(
  exec: SqlExecutor,
): Promise<{ shiftId: string; label: string; pending: number; issues: number }[]> {
  const rows = await exec.all<{
    shift_id: string;
    label: string | null;
    pending: number;
    issues: number;
  }>(`SELECT box.shift_id,shift.number label,
      SUM(CASE WHEN box.confirmed_revision<box.reconciliation_revision THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN issue.box_id IS NOT NULL THEN 1 ELSE 0 END) issues
    FROM boxes_mirror box
    LEFT JOIN shift_mirror shift ON shift.id=box.shift_id
    LEFT JOIN box_reconciliation_issues issue ON issue.box_id=box.box_id
    WHERE box.closed_at IS NOT NULL AND box.disassembled_at IS NULL
    GROUP BY box.shift_id,shift.number HAVING pending>0 OR issues>0
    ORDER BY box.shift_id`);
  return rows.map((row) => ({
    shiftId: row.shift_id,
    label: row.label ?? row.shift_id,
    pending: row.pending,
    issues: row.issues,
  }));
}

export async function readBoxReconciliationSummary(
  exec: SqlExecutor,
  shiftId?: string,
): Promise<BoxReconciliationSummary> {
  const predicate = shiftId ? "AND shift_id=?" : "";
  const params = shiftId ? [shiftId] : [];
  const [row] = await exec.all<{
    local_closed: number;
    delivered: number;
    confirmed: number;
    pending: number;
  }>(
    `SELECT COUNT(*) local_closed,
       COALESCE(SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END),0) delivered,
       COALESCE(SUM(CASE WHEN confirmed_revision>=reconciliation_revision THEN 1 ELSE 0 END),0) confirmed,
       COALESCE(SUM(CASE WHEN confirmed_revision<reconciliation_revision THEN 1 ELSE 0 END),0) pending
       FROM boxes_mirror WHERE closed_at IS NOT NULL AND disassembled_at IS NULL ${predicate}`,
    params,
  );
  const [issues] = await exec.all<{ n: number }>(
    `SELECT COUNT(*) n FROM box_reconciliation_issues WHERE 1=1 ${shiftId ? "AND shift_id=?" : ""}`,
    params,
  );
  return {
    localClosed: row?.local_closed ?? 0,
    delivered: row?.delivered ?? 0,
    confirmed: row?.confirmed ?? 0,
    pending: row?.pending ?? 0,
    issues: issues?.n ?? 0,
  };
}

export async function requestFullShiftReconciliation(
  exec: SqlExecutor,
  shiftId?: string,
): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror SET reconciliation_revision=reconciliation_revision+1
    WHERE closed_at IS NOT NULL AND disassembled_at IS NULL ${shiftId ? "AND shift_id=?" : ""}`,
    shiftId ? [shiftId] : [],
  );
}

export async function readBoxReconciliationBatch(
  exec: SqlExecutor,
  shiftId?: string,
  limit = 200,
  checkedBefore?: string,
): Promise<BoxReconciliationFact[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid reconciliation limit");
  const rows = await exec.all<BoxRow>(
    `SELECT box_id,shift_id,sscc,closed_at,pallet_id,reconciliation_revision,
      last_checked_revision,confirmed_revision
    FROM boxes_mirror
    WHERE closed_at IS NOT NULL AND sscc IS NOT NULL AND disassembled_at IS NULL
      AND acked_at IS NOT NULL
      AND (last_checked_revision<reconciliation_revision
        OR (confirmed_revision<reconciliation_revision AND NOT EXISTS(
          SELECT 1 FROM box_reconciliation_issues issue WHERE issue.box_id=boxes_mirror.box_id))
        OR (confirmed_revision<reconciliation_revision AND
          (server_reconciled_at IS NULL OR (? IS NOT NULL AND server_reconciled_at<?))))
      ${shiftId ? "AND shift_id=?" : ""}
    ORDER BY rowid LIMIT ?`,
    [checkedBefore ?? null, checkedBefore ?? null, ...(shiftId ? [shiftId] : []), limit],
  );
  const facts: BoxReconciliationFact[] = [];
  for (const row of rows) {
    const members = await readMembers(exec, row.box_id);
    const hashes = members.map((member) => member.code_hash);
    facts.push({
      shiftId: row.shift_id,
      boxId: row.box_id,
      sscc: row.sscc,
      closedAt: row.closed_at,
      devicePalletId: row.pallet_id,
      itemCount: hashes.length,
      membershipDigest: boxMembershipDigestV1(hashes),
      digestVersion: 1,
      revision: row.reconciliation_revision,
      controlAfterReplay:
        row.last_checked_revision >= row.reconciliation_revision &&
        row.confirmed_revision < row.reconciliation_revision,
      codeHashes: hashes,
    });
  }
  return facts;
}

async function readMembers(exec: SqlExecutor, boxId: string): Promise<MemberRow[]> {
  return exec.all<MemberRow>(
    `SELECT code_hash,gtin14,serial,scanned_at FROM codes_mirror
    WHERE box_id=? ORDER BY code_hash`,
    [boxId],
  );
}

/** No single historic event means no replay. A partial box is worse than a visible issue. */
async function reconstructBox(
  exec: SqlExecutor,
  fact: BoxReconciliationFact,
): Promise<readonly Record<string, string | null>[] | null> {
  const members = await readMembers(exec, fact.boxId);
  if (
    members.length === 0 ||
    boxMembershipDigestV1(members.map((m) => m.code_hash)) !== fact.membershipDigest
  )
    return null;
  const events = await exec.all<EventRow>(
    `SELECT id,shift_id,terminal_id,raw,verdict,
      scanned_at,operator_id,code_hash,box_id
    FROM scan_events_mirror WHERE shift_id=? AND verdict='ok'
      AND scanned_at IN (SELECT value FROM json_each(?)) ORDER BY id`,
    [fact.shiftId, JSON.stringify([...new Set(members.map((member) => member.scanned_at))])],
  );
  const byHash = new Map<string, EventRow[]>();
  for (const event of events) {
    let hash: string;
    try {
      hash = kmHash(canonicalizeKm(event.raw));
    } catch {
      continue;
    }
    if (event.code_hash !== null && event.code_hash !== hash) return null;
    if (event.box_id !== null && event.box_id !== fact.boxId) continue;
    const matches = byHash.get(hash) ?? [];
    matches.push(event);
    byHash.set(hash, matches);
  }
  const replay: Record<string, string | null>[] = [];
  for (const member of members) {
    const matches = (byHash.get(member.code_hash) ?? []).filter(
      (event) => event.scanned_at === member.scanned_at,
    );
    if (matches.length !== 1) return null;
    const event = matches[0]!;
    const grantEvidence = await exec.all<{ event_id: string }>(
      `SELECT command.event_id
      FROM offline_grant_scan_commands command
      JOIN offline_grant_event_evidence evidence ON evidence.event_id=command.event_id
      JOIN offline_grant_decisions decision ON decision.event_id=command.event_id
      WHERE json_extract(command.payload_json,'$.event.shiftId')=?
        AND json_extract(command.payload_json,'$.event.raw')=?
        AND json_extract(command.payload_json,'$.event.scannedAt')=?
        AND json_extract(command.payload_json,'$.code.codeHash')=?
        AND json_extract(command.payload_json,'$.code.boxId')=?
        AND command.stored_code=1
        AND json_extract(decision.decision_json,'$.allow')=1
      LIMIT 2`,
      [fact.shiftId, event.raw, event.scanned_at, member.code_hash, fact.boxId],
    );
    if (grantEvidence.length > 1) return null;
    replay.push({
      shiftId: fact.shiftId,
      terminalId: event.terminal_id,
      raw: event.raw,
      verdict: event.verdict,
      scannedAt: event.scanned_at,
      codeHash: member.code_hash,
      gtin14: member.gtin14,
      serial: member.serial,
      boxId: fact.boxId,
      operatorId: event.operator_id,
      replayEventId: grantEvidence[0]?.event_id ?? null,
    });
  }
  return replay;
}

async function recordIssue(
  exec: SqlExecutor,
  fact: BoxReconciliationFact,
  result: BoxReconciliationResult,
  status: string = result.status,
): Promise<void> {
  await exec.run(
    `INSERT INTO box_reconciliation_issues
    (box_id,shift_id,status,reason_code,local_item_count,server_item_count,checked_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(box_id) DO UPDATE SET
      status=excluded.status,reason_code=excluded.reason_code,
      local_item_count=excluded.local_item_count,server_item_count=excluded.server_item_count,
      checked_at=excluded.checked_at`,
    [
      fact.boxId,
      fact.shiftId,
      status,
      result.reasonCode,
      fact.itemCount,
      result.serverItemCount,
      new Date().toISOString(),
    ],
  );
}

/** The caller must hold the current credential commit lease and serialize with sync drain. */
export async function applyBoxReconciliationResults(
  exec: SqlExecutor,
  facts: readonly BoxReconciliationFact[],
  results: readonly BoxReconciliationResult[],
): Promise<void> {
  if (
    facts.length !== results.length ||
    new Set(results.map((result) => result.boxId)).size !== results.length ||
    facts.some((fact, index) => fact.boxId !== results[index]?.boxId)
  )
    throw new Error("Incomplete box reconciliation response");
  for (const [index, result] of results.entries()) {
    const fact = facts[index]!;
    const current = await exec.all<{
      revision: number;
      digest: string | null;
      acked_at: string | null;
    }>(
      `SELECT reconciliation_revision revision,server_reconciled_at digest,acked_at
       FROM boxes_mirror WHERE box_id=? AND shift_id=?`,
      [fact.boxId, fact.shiftId],
    );
    if (current[0]?.revision !== fact.revision || current[0]?.acked_at === null) continue;
    const members = await readMembers(exec, fact.boxId);
    if (boxMembershipDigestV1(members.map((member) => member.code_hash)) !== fact.membershipDigest)
      continue;
    const guard = `box_id=? AND shift_id=? AND reconciliation_revision=? AND acked_at IS NOT NULL
      AND sscc=? AND closed_at=? AND pallet_id IS ?
      AND (SELECT COUNT(*) FROM codes_mirror WHERE box_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM codes_mirror WHERE box_id=?
        AND code_hash NOT IN (SELECT value FROM json_each(?)))`;
    const guardValues = [
      fact.boxId,
      fact.shiftId,
      fact.revision,
      fact.sscc,
      fact.closedAt,
      fact.devicePalletId,
      fact.boxId,
      fact.itemCount,
      fact.boxId,
      JSON.stringify(fact.codeHashes),
    ];
    if (result.status === "confirmed") {
      if (!exec.atomic) throw new Error("Atomic reconciliation commit unavailable");
      await exec.atomic([
        {
          sql: `UPDATE boxes_mirror SET confirmed_revision=?,last_checked_revision=?,server_reconciled_at=?
          WHERE ${guard}`,
          values: [fact.revision, fact.revision, new Date().toISOString(), ...guardValues],
          expectedChanges: 1,
        },
        { sql: "DELETE FROM box_reconciliation_issues WHERE box_id=?", values: [fact.boxId] },
      ]);
      continue;
    }
    if (result.status !== "replay_required") {
      await recordIssue(exec, fact, result);
      await markChecked(exec, fact);
      continue;
    }
    if (fact.controlAfterReplay) {
      await recordIssue(
        exec,
        fact,
        { ...result, reasonCode: "replay_not_confirmed" },
        "replay_evidence_missing",
      );
      await markChecked(exec, fact);
      continue;
    }
    if (!exec.atomic) throw new Error("Atomic reconciliation commit unavailable");
    if (result.reasonCode === "box_absent") {
      const replay = await reconstructBox(exec, fact);
      if (!replay) {
        await recordIssue(
          exec,
          fact,
          { ...result, reasonCode: "replay_evidence_missing" },
          "replay_evidence_missing",
        );
        await markChecked(exec, fact);
        continue;
      }
      await exec.atomic([
        {
          sql: `UPDATE boxes_mirror SET acked_at=NULL,
            confirmed_revision=MIN(confirmed_revision,reconciliation_revision-1),
            last_checked_revision=?,server_reconciled_at=?
          WHERE ${guard}
            AND NOT EXISTS(SELECT 1 FROM outbox WHERE box_id=?)`,
          values: [fact.revision, new Date().toISOString(), ...guardValues, fact.boxId],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO outbox(shift_id,terminal_id,raw,verdict,scanned_at,
            code_hash,gtin14,serial,box_id,operator_id,replay_event_id,replay_origin)
          SELECT json_extract(value,'$.shiftId'),json_extract(value,'$.terminalId'),
            json_extract(value,'$.raw'),json_extract(value,'$.verdict'),json_extract(value,'$.scannedAt'),
            json_extract(value,'$.codeHash'),json_extract(value,'$.gtin14'),json_extract(value,'$.serial'),
            json_extract(value,'$.boxId'),json_extract(value,'$.operatorId'),
            json_extract(value,'$.replayEventId'),1 FROM json_each(?)`,
          values: [JSON.stringify(replay)],
          expectedChanges: replay.length,
        },
      ]);
    } else if (result.reasonCode === "closure_absent" || result.reasonCode === "pallet_absent") {
      await exec.atomic([
        {
          sql: `UPDATE boxes_mirror SET acked_at=NULL,
            confirmed_revision=MIN(confirmed_revision,reconciliation_revision-1),
            last_checked_revision=?,server_reconciled_at=?
        WHERE ${guard}`,
          values: [fact.revision, new Date().toISOString(), ...guardValues],
          expectedChanges: 1,
        },
      ]);
    } else {
      await recordIssue(exec, fact, result, "identity_conflict");
      await markChecked(exec, fact);
    }
  }
}

async function markChecked(exec: SqlExecutor, fact: BoxReconciliationFact): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror SET last_checked_revision=?,server_reconciled_at=?,
      confirmed_revision=MIN(confirmed_revision,reconciliation_revision-1)
    WHERE box_id=? AND shift_id=? AND reconciliation_revision=?`,
    [fact.revision, new Date().toISOString(), fact.boxId, fact.shiftId, fact.revision],
  );
}
