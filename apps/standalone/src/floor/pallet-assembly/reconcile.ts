import { z } from "zod";

import type { PalletAssemblyCloseIssue } from "../../host/pallet-assembly.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { applyAssemblyChange } from "./statements.js";

const issueRow = z.object({ id: z.string() });
const issueKey = "o.outcome_details ->> 'closeIssueId'";
const awaitingOffice =
  "o.kind = 'warehouse_pallet_closed' AND o.outcome = 'rejected' AND o.resolved_at IS NULL " +
  "AND NOT EXISTS (SELECT 1 FROM pallet_assembly_outbox c WHERE c.replaces_id = o.id)";

export async function readPalletAssemblyCloseIssues(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<string[]> {
  const rows = await local.query(
    `SELECT DISTINCT ${issueKey} AS id FROM pallet_assembly_outbox o WHERE o.host_id = ? AND o.device_id = ? ` +
      `AND ${awaitingOffice} AND ${issueKey} IS NOT NULL`,
    [pairing.hostId, pairing.deviceId],
    issueRow,
  );
  return rows.map(({ id }) => id);
}

const rejectedClose = z.object({
  id: z.string(),
  position: z.number().int(),
  payload: z.string(),
});
const closePayload = z.object({
  operatorId: z.string(),
  data: z.object({
    palletId: z.string(),
    sscc: z.string(),
    blockId: z.string(),
    serial: z.number().int().nonnegative(),
    openedAt: z.string(),
    closedAt: z.string(),
    boxCount: z.number().int().positive(),
  }),
});
const boxTotals = z.object({
  boxes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  date: z.string().nullable(),
});

/** Office evidence chooses the physical members. The original event and label never change. */
export async function reconcilePalletAssemblyCloseIssue(
  local: LocalExecutor,
  pairing: Pairing,
  issue: PalletAssemblyCloseIssue,
  now: () => Date,
): Promise<boolean> {
  if (issue.status !== "approved" && issue.status !== "cancelled") return false;
  const owner = [pairing.hostId, pairing.deviceId];
  const [rejected] = await local.query(
    "SELECT o.id, coalesce(o.priority_seq, o.seq) AS position, o.payload FROM pallet_assembly_outbox o " +
      "WHERE o.host_id = ? AND o.device_id = ? AND o.pallet_id = ? " +
      `AND ${awaitingOffice} AND ${issueKey} = ? ORDER BY o.seq DESC LIMIT 1`,
    [...owner, issue.palletId, issue.id],
    rejectedClose,
  );
  if (rejected === undefined) return false;
  const original = closePayload.parse(JSON.parse(rejected.payload));
  if (original.data.palletId !== issue.palletId || original.data.sscc !== issue.sscc) return false;

  const at = now().toISOString();
  const guard =
    "id = ? AND host_id = ? AND device_id = ? AND sscc = ? AND cancelled_at IS NULL " +
    "AND print_state <> 'printing' AND EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.id = ? " +
    `AND ${awaitingOffice})`;
  const palletKey = [issue.palletId, ...owner, issue.sscc, rejected.id];
  if (issue.status === "cancelled") {
    return applyAssemblyChange(local, [
      {
        sql: `UPDATE pallet_assembly_pallets SET cancelled_at = ? WHERE ${guard}`,
        values: [at, ...palletKey],
        expectedChanges: 1,
      },
      {
        sql:
          "UPDATE pallet_assembly_outbox SET acked_at = ?, outcome = 'rejected', outcome_code = 'close_cancelled', " +
          "resolved_at = ? WHERE pallet_id = ? AND host_id = ? AND device_id = ? AND acked_at IS NULL",
        values: [at, at, issue.palletId, ...owner],
      },
      {
        sql:
          "UPDATE pallet_assembly_outbox SET resolved_at = ? WHERE pallet_id = ? AND host_id = ? AND device_id = ? " +
          "AND outcome = 'rejected' AND resolved_at IS NULL",
        values: [at, issue.palletId, ...owner],
      },
    ]);
  }

  const boxes = issue.approvedBoxSsccs;
  if (
    boxes === undefined ||
    boxes.length === 0 ||
    boxes.length !== issue.approvedBoxes ||
    new Set(boxes).size !== boxes.length
  ) {
    return false;
  }
  const boxList = JSON.stringify(boxes);
  const [totals] = await local.query(
    "SELECT count(*) AS boxes, coalesce(sum(m.item_count), 0) AS items, " +
      "CASE WHEN count(m.production_date) = count(*) AND min(m.production_date) = max(m.production_date) " +
      "THEN min(m.production_date) ELSE NULL END AS date " +
      "FROM pallet_assembly_members m JOIN pallet_assembly_outbox o ON o.id = m.add_id " +
      "WHERE m.pallet_id = ? AND m.host_id = ? AND m.device_id = ? AND m.removed_at IS NULL " +
      "AND o.outcome = 'accepted' AND m.sscc IN (SELECT value FROM json_each(?))",
    [issue.palletId, ...owner, boxList],
    boxTotals,
  );
  // A pending restore can still owe a member's accepted receipt. Leave the
  // issue intact until all of the selected members are known.
  if (totals === undefined || totals.boxes !== boxes.length) return false;

  const id = crypto.randomUUID();
  const kind = "warehouse_pallet_closed";
  const payload = JSON.stringify({
    id,
    kind,
    operatorId: original.operatorId,
    data: { ...original.data, boxCount: totals.boxes },
  });
  return applyAssemblyChange(local, [
    {
      sql: `UPDATE pallet_assembly_pallets SET revision = revision + 1 WHERE ${guard}`,
      values: palletKey,
      expectedChanges: 1,
    },
    {
      sql:
        "INSERT INTO pallet_assembly_outbox (id, host_id, device_id, pallet_id, kind, payload, created_at, " +
        "priority_seq, replaces_id, correction_label, correction_boxes) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
        "json_set(label, '$.boxCount', ?, '$.itemCount', ?, '$.productionDate', ?), ? " +
        "FROM pallet_assembly_pallets WHERE id = ? AND host_id = ? AND device_id = ?",
      values: [
        id,
        ...owner,
        issue.palletId,
        kind,
        payload,
        at,
        rejected.position,
        rejected.id,
        totals.boxes,
        totals.items,
        totals.date,
        boxList,
        issue.palletId,
        ...owner,
      ],
      expectedChanges: 1,
    },
  ]);
}
