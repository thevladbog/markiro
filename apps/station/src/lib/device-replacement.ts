import { readReplacementEvidenceRecovery } from "./replacement-evidence-recovery.js";
import { targetReplacementWaiting } from "./replacement-target.js";
import {
  deviceReplacementCurrentIntentResponseSchema,
  deviceReplacementIntentClosureSchema,
  deviceReplacementClosureAcknowledgementRequestSchema,
  deviceReplacementClosureAcknowledgementResponseSchema,
  type DeviceReplacementIntentClosure,
  deviceReplacementReadinessRequestSchema,
  deviceReplacementReadinessResponseSchema,
  type DeviceReplacementCurrentIntentResponse,
  type DeviceReplacementReadinessRequest,
  type DeviceReplacementReadinessResponse,
} from "@markiro/platform-contracts";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "./credential-recovery.js";
import type { SqlExecutor } from "./mirror.js";

type Intent = NonNullable<DeviceReplacementCurrentIntentResponse>;
interface DrainRow {
  intent_id: string;
  state: "draining" | "cancelled" | "closed";
  closure_json: string | null;
  closure_acknowledged_at: string | null;
  grant_install_floor: number;
  intent_json: string;
  resume_tasks_json: string;
  credential_ownership: string;
  report_sequence: number;
  storage_revision: number;
  request_id: string | null;
  body_json: string | null;
  acknowledged_at: string | null;
  response_json: string | null;
}
export interface ReplacementReport {
  body: DeviceReplacementReadinessRequest;
  credentialOwnership: string;
}
interface LocalInput {
  exec: SqlExecutor;
  generation: CredentialGeneration;
  clientBuild: string;
}

export async function readReplacementDrain(exec: SqlExecutor): Promise<DrainRow | null> {
  const [row] = await exec.all<DrainRow>("SELECT * FROM device_replacement_drain WHERE id=1");
  return row ?? null;
}
async function ownership(generation: CredentialGeneration): Promise<string> {
  const owner = await credentialGenerationOwnership(generation);
  if (!owner || generation.sealed) throw new Error("replacement stale credential");
  return owner;
}

/** Persist first. SQLite retires only device grants in the same statement. */
export async function prepareReplacementReadiness(input: {
  exec: SqlExecutor;
  generation: CredentialGeneration;
  intent: Intent;
  expectedDevice: { tenantId: string; deviceId: string };
  activeTask?: DeviceReplacementReadinessRequest["activeTasks"][number];
}): Promise<void> {
  const intent = deviceReplacementCurrentIntentResponseSchema.parse(input.intent);
  if (!intent) throw new Error("replacement intent required");
  const owner = await ownership(input.generation);
  const prior = await readReplacementDrain(input.exec);
  if (prior?.intent_id === intent.intentId && prior.state !== "draining")
    throw new Error("REPLACEMENT_STALE_INTENT");
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("replacement stale credential");
  try {
    await input.exec.run(
      `INSERT INTO device_replacement_drain(id,intent_id,intent_json,tenant_id,device_id,credential_epoch,credential_ownership,resume_tasks_json)
      VALUES(1,?,?,?,?,?,?,(SELECT json_group_array(json_object('taskId',task_id,'kind',kind)) FROM (
        SELECT id task_id,'shift' kind FROM shift_mirror WHERE status='active' AND (
          EXISTS(SELECT 1 FROM scan_events_mirror WHERE shift_id=shift_mirror.id) OR
          EXISTS(SELECT 1 FROM boxes_mirror WHERE shift_id=shift_mirror.id) OR
          EXISTS(SELECT 1 FROM offline_grant_task_admissions WHERE task_id=shift_mirror.id))
        UNION SELECT json_extract(value,'$.inventoryId'),'inventory' FROM station_meta WHERE key='active_inventory_floor_task_v1'
        UNION SELECT json_extract(?, '$.taskId'),json_extract(?, '$.kind') WHERE ? IS NOT NULL
      ))) ON CONFLICT(id) DO UPDATE SET
      resume_tasks_json=CASE WHEN device_replacement_drain.state='cancelled' AND device_replacement_drain.closure_acknowledged_at IS NOT NULL
        THEN excluded.resume_tasks_json ELSE device_replacement_drain.resume_tasks_json END,
      state='draining',closure_json=NULL,closure_acknowledged_at=NULL,
      intent_id=excluded.intent_id,intent_json=excluded.intent_json,tenant_id=excluded.tenant_id,
      device_id=excluded.device_id,credential_epoch=excluded.credential_epoch,credential_ownership=excluded.credential_ownership,
      report_sequence=-1,storage_revision=device_replacement_drain.storage_revision+1,
      request_id=NULL,body_json=NULL,acknowledged_at=NULL,response_json=NULL
      WHERE device_replacement_drain.intent_id<>excluded.intent_id
        AND json_extract(excluded.intent_json,'$.requestedAt')>json_extract(device_replacement_drain.intent_json,'$.requestedAt')
        AND (device_replacement_drain.closure_json IS NULL OR (
          json_extract(excluded.intent_json,'$.preparationId')<>json_extract(device_replacement_drain.closure_json,'$.tombstone.preparationId')
          AND julianday(json_extract(excluded.intent_json,'$.requestedAt'))>julianday(json_extract(device_replacement_drain.closure_json,'$.tombstone.closedAt'))))`,
      [
        intent.intentId,
        JSON.stringify(intent),
        input.expectedDevice.tenantId,
        input.expectedDevice.deviceId,
        intent.credentialEpoch,
        owner,
        JSON.stringify(input.activeTask ?? null),
        JSON.stringify(input.activeTask ?? null),
        input.activeTask?.taskId ?? null,
      ],
    );
    const row = await readReplacementDrain(input.exec);
    if (row?.state !== "draining") throw new Error("REPLACEMENT_STALE_INTENT");
    if (row?.intent_id !== intent.intentId) throw new Error("REPLACEMENT_PENDING_OR_STALE_INTENT");
    if (row?.credential_ownership !== owner)
      throw new Error("replacement credential owner mismatch");
  } finally {
    lease.release();
  }
}

/** One SQLite read sees every normalized channel at the same point in time. */
export async function readReplacementMeasurements(
  exec: SqlExecutor,
): Promise<
  Pick<
    DeviceReplacementReadinessRequest,
    "pending" | "conflicts" | "unknownPrints" | "activeTasks" | "installedGrants"
  > & { highestSequence: number }
> {
  try {
    const [row] = await exec.all<{
      scans: number;
      inventories: number;
      shiftClosures: number;
      productLabels: number;
      boxes: number;
      exceptions: number;
      conflicts: number;
      unknownPrints: number;
      tasks: string;
      grants: string;
      highestSequence: number;
    }>(`SELECT
      (SELECT COUNT(*) FROM outbox) scans,
      (SELECT COUNT(*) FROM inventory_outbox) inventories,
      (SELECT COUNT(*) FROM shift_close_outbox) shiftClosures,
      (SELECT COUNT(*) FROM product_label_outbox)+(SELECT COUNT(*) FROM product_label_jobs WHERE status<>'completed') productLabels,
      (SELECT COUNT(*) FROM boxes_mirror WHERE disassembled_at IS NULL AND (acked_at IS NULL OR (closed_at IS NOT NULL AND confirmed_revision<reconciliation_revision)))+(SELECT COUNT(*) FROM pallets_mirror WHERE acked_at IS NULL AND disassembled_at IS NULL)+(SELECT COUNT(*) FROM inventory_repack_boxes_mirror WHERE state='open') boxes,
      (SELECT COUNT(*) FROM box_exceptions_mirror)+(SELECT COUNT(*) FROM box_reconciliation_issues)+(SELECT COUNT(*) FROM pallet_exceptions_mirror)+(SELECT COUNT(*) FROM product_label_receipts WHERE outcome='quarantined')+
      (SELECT COUNT(*) FROM station_meta WHERE key LIKE 'offline_grant_evidence_pin:%' OR key LIKE 'inventory_sync_batch_v1:%') exceptions,
      (SELECT COUNT(*) FROM conflicts_mirror)+(SELECT COUNT(*) FROM inventory_conflicts_mirror WHERE state<>'resolved')+(SELECT COUNT(*) FROM shift_close_outbox WHERE state='conflict')+(SELECT COUNT(*) FROM product_label_jobs WHERE ownership_conflict=1) conflicts,
      (SELECT COUNT(*) FROM product_label_jobs WHERE status<>'completed' AND json_extract(projection_json,'$.attemptState') IN ('sending','delivery_unknown'))+
      (SELECT COUNT(*) FROM boxes_mirror WHERE disassembled_at IS NULL AND print_verified_at IS NULL AND print_skipped_at IS NULL AND (print_state IN ('printing','sending','delivery_unknown') OR (closed_at IS NOT NULL AND print_state IN ('pending','printed'))))+
      (SELECT COUNT(*) FROM pallets_mirror WHERE disassembled_at IS NULL AND print_verified_at IS NULL AND print_skipped_at IS NULL AND (print_state IN ('printing','sending','delivery_unknown') OR (closed_at IS NOT NULL AND print_state IN ('pending','printed'))))+
      (SELECT COUNT(*) FROM inventory_repack_boxes_mirror WHERE state<>'invalidated' AND print_state='printing') unknownPrints,
      (SELECT json_group_array(json_object('taskId',task_id,'kind',kind)) FROM (
         SELECT id task_id,'shift' kind FROM shift_mirror WHERE status='active'
         UNION SELECT json_extract(value,'$.inventoryId'),'inventory' FROM station_meta WHERE key='active_inventory_floor_task_v1'
      )) tasks,
      (SELECT json_group_array(json_object('grantId',grant_id)) FROM offline_grant_grants) grants,
      COALESCE((SELECT MAX(sequence) FROM (
        SELECT seq sequence FROM sqlite_sequence
        UNION ALL SELECT device_sequence FROM inventory_scan_events_mirror
        UNION ALL SELECT next_device_sequence-1 FROM inventory_terminal_state
        UNION ALL SELECT sequence FROM product_label_events
      )),0) highestSequence`);
    if (!row) throw new Error("replacement measurements missing");
    return {
      pending: {
        scans: row.scans,
        inventories: row.inventories,
        shiftClosures: row.shiftClosures,
        productLabels: row.productLabels,
        boxes: row.boxes,
        exceptions: row.exceptions,
      },
      conflicts: row.conflicts,
      unknownPrints: row.unknownPrints,
      activeTasks: JSON.parse(row.tasks) as DeviceReplacementReadinessRequest["activeTasks"],
      installedGrants: JSON.parse(
        row.grants,
      ) as DeviceReplacementReadinessRequest["installedGrants"],
      highestSequence: row.highestSequence,
    };
  } catch (error) {
    // Older/broken local schemas cannot claim a measured zero. Other failures
    // (I/O, corruption, cancellation) propagate with the pending report intact.
    if (!/no such (table|column)/.test(String(error))) throw error;
    return {
      pending: {
        scans: "unsupported",
        inventories: "unsupported",
        shiftClosures: "unsupported",
        productLabels: "unsupported",
        boxes: "unsupported",
        exceptions: "unsupported",
      },
      conflicts: "unsupported",
      unknownPrints: "unsupported",
      activeTasks: [],
      installedGrants: [],
      highestSequence: 0,
    };
  }
}

/** Keep a pending request immutable. Acknowledged reports may advance on the same intent. */
export async function drainReplacementReadiness(
  input: LocalInput,
): Promise<ReplacementReport | null> {
  const owner = await ownership(input.generation);
  const row = await readReplacementDrain(input.exec);
  if (!row || row.state !== "draining") return null;
  if (row.credential_ownership !== owner) throw new Error("replacement credential owner mismatch");
  if (row.body_json && !row.acknowledged_at)
    return {
      body: deviceReplacementReadinessRequestSchema.parse(JSON.parse(row.body_json)),
      credentialOwnership: owner,
    };
  const intent = deviceReplacementCurrentIntentResponseSchema.parse(JSON.parse(row.intent_json));
  if (!intent) throw new Error("replacement intent missing");
  const { highestSequence, ...measurements } = await readReplacementMeasurements(input.exec);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ ...measurements, highestSequence })),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const body = deviceReplacementReadinessRequestSchema.parse({
    ...measurements,
    requestId: crypto.randomUUID(),
    intentId: intent.intentId,
    credentialEpoch: intent.credentialEpoch,
    reportSequence: row.report_sequence + 1,
    storageRevision: row.storage_revision + 1,
    clientBuild: input.clientBuild,
    journal: { digest, highestSequence },
  });
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("replacement stale credential");
  try {
    await input.exec.run(
      `UPDATE device_replacement_drain SET request_id=?,body_json=?,report_sequence=?,storage_revision=?,acknowledged_at=NULL,response_json=NULL
      WHERE id=1 AND state='draining' AND intent_id=? AND credential_ownership=? AND report_sequence=? AND (request_id IS NULL OR acknowledged_at IS NOT NULL)`,
      [
        body.requestId,
        JSON.stringify(body),
        body.reportSequence,
        body.storageRevision,
        intent.intentId,
        owner,
        row.report_sequence,
      ],
    );
    const saved = await readReplacementDrain(input.exec);
    if (
      !saved?.body_json ||
      saved.credential_ownership !== owner ||
      saved.intent_id !== intent.intentId
    )
      throw new Error("replacement intent changed");
    return {
      body: deviceReplacementReadinessRequestSchema.parse(JSON.parse(saved.body_json)),
      credentialOwnership: owner,
    };
  } finally {
    lease.release();
  }
}

/** Network/cancellation failures never rewrite or acknowledge the pinned body. */
export async function reportReplacementReadiness(
  input: LocalInput & { client: { post(path: string, body: unknown): Promise<unknown> } },
): Promise<DeviceReplacementReadinessResponse | null> {
  const report = await drainReplacementReadiness(input);
  if (!report) return null;
  await ownership(input.generation);
  const response = deviceReplacementReadinessResponseSchema.parse(
    await input.client.post("/station/device-replacement-readiness", report.body),
  );
  if (response.requestId !== report.body.requestId || response.intentId !== report.body.intentId)
    throw new Error("replacement response identity mismatch");
  const owner = await ownership(input.generation);
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("replacement stale credential");
  try {
    await input.exec.run(
      `UPDATE device_replacement_drain SET acknowledged_at=?,response_json=? WHERE id=1 AND request_id=? AND intent_id=? AND credential_ownership=? AND body_json=? AND acknowledged_at IS NULL`,
      [
        response.receivedAt,
        JSON.stringify(response),
        report.body.requestId,
        report.body.intentId,
        owner,
        JSON.stringify(report.body),
      ],
    );
  } finally {
    lease.release();
  }
  return response;
}

/** Cancellation releases drain only after its exact acknowledgement is durable. */
export function replacementCancellationAcknowledged(
  row: Pick<DrainRow, "state" | "closure_acknowledged_at"> | null,
): boolean {
  return row?.state === "cancelled" && row.closure_acknowledged_at !== null;
}

/** Drain is independent of observe/strict grant rollout and survives delayed configuration. */
export async function replacementBlocksNewWork(exec: SqlExecutor): Promise<boolean> {
  if (await readReplacementEvidenceRecovery(exec)) return true;
  if (await targetReplacementWaiting(exec)) return true;
  const row = await readReplacementDrain(exec);
  return row !== null && !replacementCancellationAcknowledged(row);
}

export async function replacementCanEnterTask(
  exec: SqlExecutor,
  taskId: string,
  kind: "shift" | "inventory",
): Promise<boolean> {
  if (await readReplacementEvidenceRecovery(exec)) return false;
  if (await targetReplacementWaiting(exec)) return false;
  const row = await readReplacementDrain(exec);
  if (!row || replacementCancellationAcknowledged(row)) return true;
  const tasks = JSON.parse(row.resume_tasks_json) as Array<{ taskId: string; kind: string }>;
  return tasks.some((task) => task.taskId === taskId && task.kind === kind);
}

/** Persist an exact closure while retaining drain until its acknowledgement is durable. */
export async function applyReplacementClosure(input: {
  exec: SqlExecutor;
  generation: CredentialGeneration;
  tombstone: DeviceReplacementIntentClosure;
}): Promise<void> {
  const tombstone = deviceReplacementIntentClosureSchema.parse(input.tombstone);
  const owner = await ownership(input.generation);
  const row = await readReplacementDrain(input.exec);
  if (!row || row.credential_ownership !== owner)
    throw new Error("replacement closure credential mismatch");
  const intent = deviceReplacementCurrentIntentResponseSchema.parse(JSON.parse(row.intent_json));
  if (
    !intent ||
    tombstone.intentId !== intent.intentId ||
    tombstone.preparationId !== intent.preparationId ||
    tombstone.credentialEpoch !== intent.credentialEpoch ||
    tombstone.preparationRevision <= intent.preparationRevision ||
    Date.parse(tombstone.closedAt) < Date.parse(intent.requestedAt)
  )
    throw new Error("replacement closure intent mismatch");
  if (row.closure_json) {
    const saved = deviceReplacementClosureAcknowledgementRequestSchema.parse(
      JSON.parse(row.closure_json),
    );
    if (JSON.stringify(saved.tombstone) !== JSON.stringify(tombstone))
      throw new Error("replacement closure changed");
    return;
  }
  const request = deviceReplacementClosureAcknowledgementRequestSchema.parse({
    requestId: crypto.randomUUID(),
    tombstone,
  });
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("replacement stale credential");
  try {
    await input.exec.run(
      `UPDATE device_replacement_drain SET state=?,closure_json=?,closure_acknowledged_at=NULL,
      grant_install_floor=COALESCE((SELECT MAX(sequence) FROM (
        SELECT request_sequence sequence FROM offline_grant_install_commands
        UNION ALL SELECT request_sequence FROM offline_grant_configuration_commands
        UNION ALL SELECT request_sequence FROM offline_grant_keyset_commands
        UNION ALL SELECT grant_install_floor FROM device_replacement_drain
      )),0)+1
      WHERE id=1 AND intent_id=? AND credential_ownership=? AND state='draining' AND closure_json IS NULL`,
      [tombstone.state, JSON.stringify(request), intent.intentId, owner],
    );
    const saved = await readReplacementDrain(input.exec);
    if (
      saved?.intent_id !== intent.intentId ||
      !saved.closure_json ||
      saved.state !== tombstone.state
    )
      throw new Error("replacement closure intent mismatch");
  } finally {
    lease.release();
  }
}

/** Closure acknowledgement retries the exact durable request even after response loss. */
export async function acknowledgeReplacementClosure(input: {
  exec: SqlExecutor;
  generation: CredentialGeneration;
  client: { post(path: string, body: unknown): Promise<unknown> };
}): Promise<boolean> {
  const owner = await ownership(input.generation);
  const row = await readReplacementDrain(input.exec);
  if (!row?.closure_json || row.closure_acknowledged_at) return false;
  if (row.credential_ownership !== owner)
    throw new Error("replacement closure credential mismatch");
  const body = deviceReplacementClosureAcknowledgementRequestSchema.parse(
    JSON.parse(row.closure_json),
  );
  const response = deviceReplacementClosureAcknowledgementResponseSchema.parse(
    await input.client.post("/station/device-replacement-intent/v1/acknowledge", body),
  );
  if (
    response.requestId !== body.requestId ||
    JSON.stringify(response.tombstone) !== JSON.stringify(body.tombstone)
  )
    throw new Error("replacement closure response mismatch");
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("replacement stale credential");
  try {
    await input.exec.run(
      `UPDATE device_replacement_drain SET closure_acknowledged_at=?,
      grant_install_floor=COALESCE((SELECT MAX(sequence) FROM (
        SELECT request_sequence sequence FROM offline_grant_install_commands
        UNION ALL SELECT request_sequence FROM offline_grant_configuration_commands
        UNION ALL SELECT request_sequence FROM offline_grant_keyset_commands
        UNION ALL SELECT grant_install_floor FROM device_replacement_drain
      )),0)+1
      WHERE id=1 AND intent_id=? AND credential_ownership=? AND closure_json=? AND closure_acknowledged_at IS NULL`,
      [response.acknowledgedAt, body.tombstone.intentId, owner, JSON.stringify(body)],
    );
    const saved = await readReplacementDrain(input.exec);
    if (
      saved?.intent_id !== body.tombstone.intentId ||
      saved.credential_ownership !== owner ||
      saved.closure_json !== JSON.stringify(body) ||
      saved.closure_acknowledged_at !== response.acknowledgedAt
    )
      throw new Error("replacement closure acknowledgement not persisted");
    return replacementCancellationAcknowledged(saved);
  } finally {
    lease.release();
  }
}
