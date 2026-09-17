import { credentialOwnsRetainedWork } from "./device-recovery.js";
import { deviceRecoveryAllowsWork } from "./device-recovery.js";
import { parseInventoryProgressPage, type InventoryProgressPage } from "@markiro/domain";

import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "./credential-recovery.js";
import {
  acknowledgeInventoryOutboxBatch,
  inventoryOutboxDepth,
  prepareInventoryOutboxBatch,
} from "./inventory-outbox.js";
import type { SqlExecutor } from "./mirror.js";
import {
  StationGrantAdmission,
  stationOperatorIsCurrentlyActive,
} from "./offline-grants/admission.js";
import { sampleGrantClock } from "./offline-grants/clock.js";
import {
  readStationEvidencePin,
  readStationSavedEvidence,
  sendStationEvidence,
  stationEvidenceCommitExecutor,
} from "./offline-grants/evidence-store.js";
import { readInventoryExecutionProjection } from "./offline-grants/semantic.js";

export interface InventorySyncState {
  pending: number;
  draining: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface InventorySyncEngineDeps {
  exec: SqlExecutor;
  client: {
    post(path: string, body?: unknown): Promise<unknown>;
    get?(path: string): Promise<unknown>;
  };
  inventoryId: string;
  snapshotId: string;
  floorTaskPointerValue?: string;
  credentialGeneration?: CredentialGeneration;
  onState(state: InventorySyncState): void;
  now?: () => number;
  retry?: boolean;
  onProgressApplied?: (page: InventoryProgressPage) => void | Promise<void>;
}

export interface InventorySyncEngine {
  nudge(): void;
  pollProgress(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  idle(): Promise<void>;
}

export async function applyInventoryProgressPage(
  exec: SqlExecutor,
  expected: {
    inventoryId: string;
    snapshotId: string;
    deviceId: string;
    requestedCursor?: string | null;
    minimumResultRevision?: number;
    pointerValue?: string;
    credentialOwnership?: string | null;
    canCommit?: () => boolean;
  },
  value: unknown,
): Promise<InventoryProgressPage> {
  const terminalRows = await exec.all<{
    progress_cursor: string | null;
    progress_result_revision: number;
    updated_at: string;
  }>(
    `SELECT progress_cursor, progress_result_revision, updated_at FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [expected.inventoryId, expected.snapshotId, expected.deviceId],
  );
  const terminal = terminalRows[0];
  if (!terminal) throw new Error("inventory progress terminal is missing");
  const requestedCursor =
    expected.requestedCursor === undefined ? terminal.progress_cursor : expected.requestedCursor;
  const priorResultRevision =
    expected.minimumResultRevision === undefined
      ? terminal.progress_result_revision
      : expected.minimumResultRevision;
  const page = parseInventoryProgressPage(value, {
    inventoryId: expected.inventoryId,
    snapshotId: expected.snapshotId,
    cursor: requestedCursor,
    minimumResultRevision: priorResultRevision,
  });
  if (expected.canCommit && !expected.canCommit()) {
    throw new Error("inventory progress generation retired");
  }
  const pointerKey = "active_inventory_floor_task_v1";
  const pointerRows = expected.pointerValue
    ? [{ value: expected.pointerValue }]
    : await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key = ?", [
        pointerKey,
      ]);
  const pointerValue = pointerRows[0]?.value;
  if (!pointerValue) throw new Error("inventory floor task ownership changed");
  let pointer: unknown;
  try {
    pointer = JSON.parse(pointerValue);
  } catch {
    throw new Error("inventory floor task ownership changed");
  }
  if (
    typeof pointer !== "object" ||
    pointer === null ||
    Array.isArray(pointer) ||
    !("inventoryId" in pointer) ||
    pointer.inventoryId !== expected.inventoryId ||
    !("snapshotId" in pointer) ||
    pointer.snapshotId !== expected.snapshotId ||
    !("credentialOwnership" in pointer) ||
    typeof pointer.credentialOwnership !== "string" ||
    !/^[0-9a-f]{64}$/.test(pointer.credentialOwnership) ||
    (expected.credentialOwnership !== undefined &&
      !(await credentialOwnsRetainedWork(
        exec,
        expected.credentialOwnership,
        pointer.credentialOwnership,
      ))) ||
    !("activationId" in pointer) ||
    typeof pointer.activationId !== "string" ||
    pointer.activationId.length === 0 ||
    Object.keys(pointer).length !== 4
  ) {
    throw new Error("inventory floor task ownership changed");
  }
  const receiptId = `${expected.inventoryId}:${expected.snapshotId}:${expected.deviceId}:${requestedCursor ?? "root"}:${priorResultRevision}:${page.resultRevision}:${page.nextCursor ?? "end"}`;
  const pageJson = JSON.stringify(page);
  const appliedAt = page.items.at(-1)?.correctedAt ?? terminal.updated_at;
  await exec.run(
    `INSERT INTO inventory_progress_receipts_v2
       (receipt_id, inventory_id, snapshot_id, device_id, requested_cursor,
        prior_result_revision, page_json, pointer_key, pointer_value,
        credential_ownership, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO NOTHING`,
    [
      receiptId,
      expected.inventoryId,
      expected.snapshotId,
      expected.deviceId,
      requestedCursor,
      priorResultRevision,
      pageJson,
      pointerKey,
      pointerValue,
      pointer.credentialOwnership,
      appliedAt,
    ],
  );
  const receipts = await exec.all<{
    inventory_id: string;
    snapshot_id: string;
    device_id: string;
    requested_cursor: string | null;
    prior_result_revision: number;
    page_json: string;
    pointer_key: string | null;
    pointer_value: string | null;
    credential_ownership: string | null;
    applied_at: string;
  }>(
    `SELECT inventory_id, snapshot_id, device_id, requested_cursor, prior_result_revision,
            page_json, pointer_key, pointer_value, credential_ownership, applied_at
       FROM inventory_progress_receipts_v2 WHERE receipt_id = ?`,
    [receiptId],
  );
  const receipt = receipts[0];
  if (
    receipts.length !== 1 ||
    receipt?.inventory_id !== expected.inventoryId ||
    receipt.snapshot_id !== expected.snapshotId ||
    receipt.device_id !== expected.deviceId ||
    receipt.requested_cursor !== requestedCursor ||
    receipt.prior_result_revision !== priorResultRevision ||
    receipt.page_json !== pageJson ||
    receipt.pointer_key !== pointerKey ||
    receipt.pointer_value !== pointerValue ||
    receipt.credential_ownership !== pointer.credentialOwnership ||
    receipt.applied_at !== appliedAt
  ) {
    throw new Error("inventory progress receipt changed");
  }
  const committed = await exec.all<{
    progress_cursor: string | null;
    progress_result_revision: number;
  }>(
    `SELECT progress_cursor, progress_result_revision FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [expected.inventoryId, expected.snapshotId, expected.deviceId],
  );
  if (
    committed[0]?.progress_cursor !== (page.nextCursor ?? requestedCursor) ||
    committed[0]?.progress_result_revision !== page.resultRevision
  ) {
    throw new Error("inventory progress cursor changed");
  }
  if (expected.canCommit && !expected.canCommit()) {
    throw new Error("inventory progress generation retired");
  }
  return page;
}

export function createInventorySyncEngine(deps: InventorySyncEngineDeps): InventorySyncEngine {
  const generation = deps.credentialGeneration ?? createCredentialGeneration();
  const now = deps.now ?? Date.now;
  let stopped = false;
  let paused = false;
  let draining = false;
  let requested = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: Array<() => void> = [];
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;
  let retryDelayMs = 2_000;
  let epoch = 0;
  let progressFlight: Promise<void> | null = null;

  const resolveIdle = () => {
    if (draining) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const publish = async () => {
    deps.onState({
      pending: await inventoryOutboxDepth(deps.exec, deps.inventoryId, deps.snapshotId),
      draining,
      lastSuccessAt,
      lastError,
    });
  };

  const scheduleRetry = () => {
    if (deps.retry === false || stopped || paused || retryTimer) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, delay);
  };

  const run = async () => {
    try {
      do {
        requested = false;
        if (stopped || paused || generation.sealed) break;
        if (!(await deviceRecoveryAllowsWork(deps.exec, generation))) break;
        const preparationLease = acquireCredentialCommitLease(generation);
        if (!preparationLease) break;
        let batch;
        try {
          batch = await prepareInventoryOutboxBatch(deps.exec, {
            inventoryId: deps.inventoryId,
            snapshotId: deps.snapshotId,
          });
        } finally {
          preparationLease.release();
        }
        if (!batch) {
          lastError = null;
          break;
        }
        const evidenceKey = `inventory-event-batch:${deps.inventoryId}:${deps.snapshotId}:${batch.request.batchId}`;
        const value = batch.negotiated
          ? await sendStationEvidence({
              exec: deps.exec,
              client: deps.client,
              generation,
              key: evidenceKey,
              path: `/station/grants/v1/evidence/inventories/${deps.inventoryId}/event-batches`,
              batchId: batch.request.batchId,
              payload: batch.request,
              links: batch.evidenceLinks ?? [],
              checkpoint: { pinValue: batch.pinValue },
            })
          : await deps.client.post(
              `/station/inventories/${deps.inventoryId}/event-batches`,
              batch.request,
            );
        if (stopped || paused || generation.sealed) break;
        if (!(await deviceRecoveryAllowsWork(deps.exec, generation))) break;
        const commitLease = acquireCredentialCommitLease(generation);
        if (!commitLease) break;
        try {
          const evidencePin = batch.negotiated
            ? await readStationEvidencePin(deps.exec, generation, evidenceKey)
            : null;
          await acknowledgeInventoryOutboxBatch(
            evidencePin
              ? await stationEvidenceCommitExecutor(
                  deps.exec,
                  generation,
                  evidencePin.credentialOwnership,
                )
              : deps.exec,
            batch,
            value,
          );
        } finally {
          commitLease.release();
        }
        lastSuccessAt = now();
        lastError = null;
        retryDelayMs = 2_000;
        requested = true;
      } while (requested && !stopped && !paused);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "inventory sync failed";
      scheduleRetry();
    } finally {
      draining = false;
      await publish();
      resolveIdle();
      if (requested && !stopped && !paused && !retryTimer) start();
    }
  };

  const start = () => {
    if (stopped || paused || draining || retryTimer) {
      if (draining) requested = true;
      return;
    }
    draining = true;
    void publish();
    void run();
  };

  return {
    nudge: start,
    pollProgress() {
      if (progressFlight) return progressFlight;
      if (stopped || paused || generation.sealed || !deps.client.get) return Promise.resolve();
      const startedEpoch = epoch;
      progressFlight = (async () => {
        if (!(await deviceRecoveryAllowsWork(deps.exec, generation))) return;
        const rows = await deps.exec.all<{
          device_id: string;
          progress_cursor: string | null;
          progress_result_revision: number;
        }>(
          `SELECT device_id, progress_cursor, progress_result_revision FROM inventory_terminal_state
            WHERE inventory_id = ? AND snapshot_id = ?`,
          [deps.inventoryId, deps.snapshotId],
        );
        const terminal = rows[0];
        if (!terminal || stopped || paused || generation.sealed || epoch !== startedEpoch) return;
        const suffix = terminal.progress_cursor
          ? `?cursor=${encodeURIComponent(terminal.progress_cursor)}&limit=200`
          : "?limit=200";
        const value = await deps.client.get!(
          `/station/inventories/${deps.inventoryId}/progress${suffix}`,
        );
        if (stopped || paused || generation.sealed || epoch !== startedEpoch) return;
        const lease = acquireCredentialCommitLease(generation);
        if (!lease) return;
        try {
          const page = await applyInventoryProgressPage(
            deps.exec,
            {
              inventoryId: deps.inventoryId,
              snapshotId: deps.snapshotId,
              deviceId: terminal.device_id,
              requestedCursor: terminal.progress_cursor,
              minimumResultRevision: terminal.progress_result_revision,
              ...(deps.floorTaskPointerValue ? { pointerValue: deps.floorTaskPointerValue } : {}),
              credentialOwnership: await credentialGenerationOwnership(generation),
              canCommit: () => !stopped && !paused && !generation.sealed && epoch === startedEpoch,
            },
            value,
          );
          if (!stopped && !paused && !generation.sealed && epoch === startedEpoch) {
            await deps.onProgressApplied?.(page);
          }
        } finally {
          lease.release();
        }
      })().finally(() => {
        progressFlight = null;
      });
      return progressFlight;
    },
    pause() {
      paused = true;
      epoch += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    resume() {
      stopped = false;
      paused = false;
      epoch += 1;
      start();
    },
    stop() {
      stopped = true;
      epoch += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    idle() {
      const drain = draining
        ? new Promise<void>((resolve) => idleResolvers.push(resolve))
        : Promise.resolve();
      const progress = progressFlight?.then(() => undefined) ?? Promise.resolve();
      return Promise.all([drain, progress]).then(() => undefined);
    },
  };
}

export interface LeaveInventoryTaskDeps {
  exec: SqlExecutor;
  client: { post(path: string, body?: unknown): Promise<unknown> };
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  pointerValue: string;
  credentialGeneration: CredentialGeneration;
  closeScanner(): Promise<void>;
  scanQueueIdle(): Promise<void>;
  sync: Pick<InventorySyncEngine, "idle" | "nudge" | "resume" | "stop">;
}

export async function leaveInventoryTask(deps: LeaveInventoryTaskDeps): Promise<void> {
  const expectedOwnership = await credentialGenerationOwnership(deps.credentialGeneration);
  let pointer: unknown;
  try {
    pointer = JSON.parse(deps.pointerValue);
  } catch {
    throw new Error("inventory floor task ownership changed");
  }
  if (
    expectedOwnership === null ||
    typeof pointer !== "object" ||
    pointer === null ||
    !("inventoryId" in pointer) ||
    pointer.inventoryId !== deps.inventoryId ||
    !("snapshotId" in pointer) ||
    pointer.snapshotId !== deps.snapshotId ||
    !("activationId" in pointer) ||
    typeof pointer.activationId !== "string" ||
    !("credentialOwnership" in pointer) ||
    typeof pointer.credentialOwnership !== "string" ||
    !(await credentialOwnsRetainedWork(deps.exec, expectedOwnership, pointer.credentialOwnership))
  ) {
    throw new Error("inventory floor task ownership changed");
  }
  const activationId = pointer.activationId;
  const originalCredentialOwnership = pointer.credentialOwnership;
  const owned = await deps.exec.all<{ value: string }>(
    "SELECT value FROM station_meta WHERE key = ? AND value = ?",
    ["active_inventory_floor_task_v1", deps.pointerValue],
  );
  if (owned.length !== 1 || deps.credentialGeneration.sealed) {
    throw new Error("inventory floor task ownership changed");
  }
  await deps.closeScanner();
  await deps.scanQueueIdle();
  deps.sync.nudge();
  await deps.sync.idle();
  deps.sync.stop();
  try {
    await deps.sync.idle();
    const currentBeforeLeave = await deps.exec.all<{ value: string }>(
      "SELECT value FROM station_meta WHERE key = ? AND value = ?",
      ["active_inventory_floor_task_v1", deps.pointerValue],
    );
    if (currentBeforeLeave.length !== 1 || deps.credentialGeneration.sealed) {
      throw new Error("inventory floor task ownership changed");
    }
    const pending = await inventoryOutboxDepth(deps.exec, deps.inventoryId, deps.snapshotId);
    const openRows = await deps.exec.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inventory_repack_boxes_mirror
        WHERE inventory_id = ? AND snapshot_id = ? AND owner_device_id = ? AND state = 'open'`,
      [deps.inventoryId, deps.snapshotId, deps.deviceId],
    );
    const openBoxCount = openRows[0]?.count ?? 0;
    if (pending !== 0) {
      throw new Error("inventory task still has pending work");
    }
    const leavePayload = {
      pendingEventCount: 0,
      openBoxCount,
    };
    const [grantState] = await deps.exec.all<{
      tenant_id: string;
      device_id: string;
      owner_kind: "station";
      credential_epoch: number;
    }>(
      "SELECT tenant_id,device_id,owner_kind,credential_epoch FROM offline_grant_install_state WHERE id=1",
    );
    let response: unknown;
    let intentKey: string | null = null;
    if (grantState) {
      const [terminal] = await deps.exec.all<{ operator_id: string | null }>(
        `SELECT operator_id FROM inventory_terminal_state
          WHERE inventory_id=? AND snapshot_id=? AND device_id=?`,
        [deps.inventoryId, deps.snapshotId, deps.deviceId],
      );
      if (
        !terminal?.operator_id ||
        !(await stationOperatorIsCurrentlyActive(deps.exec, terminal.operator_id))
      ) {
        throw new Error("offline grant operator unauthorized");
      }
      const [binding] = await deps.exec.all<{ snapshot_digest: string }>(
        `SELECT json_extract(grant_json,'$.snapshotDigest') snapshot_digest
           FROM offline_grant_grants
          WHERE json_extract(grant_json,'$.kindOfGrant')='task'
            AND json_extract(grant_json,'$.taskKind')='inventory'
            AND json_extract(grant_json,'$.taskId')=?
          ORDER BY installed_sequence DESC LIMIT 1`,
        [deps.inventoryId],
      );
      const currentCredentialOwnership = await credentialGenerationOwnership(
        deps.credentialGeneration,
      );
      if (!currentCredentialOwnership) throw new Error("inventory floor task credential retired");
      intentKey = `inventory-leave:${activationId}`;
      const eventId = `${activationId}#inventory.close.v1`;
      const committed = await new StationGrantAdmission(
        deps.exec,
        sampleGrantClock,
      ).commitCompletion({
        operatorId: terminal.operator_id,
        intent: {
          owner: {
            tenantId: grantState.tenant_id,
            deviceId: grantState.device_id,
            kind: grantState.owner_kind,
            credentialEpoch: grantState.credential_epoch,
          },
          capability: "inventory.start.v1",
          taskId: deps.inventoryId,
          snapshotDigest: binding?.snapshot_digest ?? "missing",
          eventId,
          eventType: "inventory.close.v1",
          cost: {},
        },
        execution: await readInventoryExecutionProjection(deps.exec, deps.inventoryId),
        event: { eventType: "inventory.close.v1", leavePayload },
        facts: {},
        result: { intentKey },
        ownerStatements: [
          {
            sql: "INSERT INTO offline_grant_inventory_leave_commands(command_id,payload_json) VALUES(?,?)",
            values: [
              intentKey,
              JSON.stringify({
                intentKey,
                inventoryId: deps.inventoryId,
                snapshotId: deps.snapshotId,
                deviceId: deps.deviceId,
                operatorId: terminal.operator_id,
                eventId,
                credentialOwnership: originalCredentialOwnership,
                currentCredentialOwnership,
                pointerValue: deps.pointerValue,
                leavePayload,
                createdAt: new Date().toISOString(),
              }),
            ],
          },
        ],
      });
      if (!committed.decision.allow) {
        throw new Error(`offline grant denied: ${committed.decision.reason ?? "denied"}`);
      }
      const saved = await readStationSavedEvidence(deps.exec, [
        { eventId, pointer: "/#inventory.close.v1" },
      ]);
      if (!saved.negotiated) throw new Error("inventory leave evidence is missing");
      response = await sendStationEvidence({
        exec: deps.exec,
        client: deps.client,
        generation: deps.credentialGeneration,
        key: intentKey,
        path: `/station/grants/v1/evidence/inventories/${deps.inventoryId}/leave`,
        batchId: activationId,
        payload: leavePayload,
        links: saved.links,
        checkpoint: { pointerValue: deps.pointerValue },
      });
    } else {
      response = await deps.client.post(
        `/station/inventories/${deps.inventoryId}/leave`,
        // Activation is durable before floor entry and survives restart/retry.
        { ...leavePayload, requestId: activationId },
      );
    }
    if (
      typeof response !== "object" ||
      response === null ||
      !("outcome" in response) ||
      response.outcome !== "left" ||
      Object.keys(response).length !== 1
    ) {
      throw new Error("invalid inventory leave response");
    }
    const lease = acquireCredentialCommitLease(deps.credentialGeneration);
    if (!lease) throw new Error("inventory floor task credential retired");
    try {
      const current = await deps.exec.all<{ value: string }>(
        "SELECT value FROM station_meta WHERE key = ? AND value = ?",
        ["active_inventory_floor_task_v1", deps.pointerValue],
      );
      if (current.length !== 1) throw new Error("inventory floor task ownership changed");
      if (intentKey) {
        const currentCredentialOwnership = await credentialGenerationOwnership(
          deps.credentialGeneration,
        );
        if (!currentCredentialOwnership) {
          throw new Error("inventory floor task credential retired");
        }
        await deps.exec.run(
          "INSERT INTO offline_grant_inventory_leave_ack_commands(command_id,payload_json) VALUES(?,?) ON CONFLICT(command_id) DO NOTHING",
          [
            intentKey,
            JSON.stringify({
              intentKey,
              pointerValue: deps.pointerValue,
              credentialOwnership: originalCredentialOwnership,
              currentCredentialOwnership,
              receipt: response,
            }),
          ],
        );
      } else {
        await deps.exec.run(
          `DELETE FROM station_meta WHERE key = 'active_inventory_floor_task_v1'
            AND value = ?`,
          [deps.pointerValue],
        );
      }
      const remaining = await deps.exec.all<{ value: string }>(
        "SELECT value FROM station_meta WHERE key = 'active_inventory_floor_task_v1'",
      );
      if (remaining.length !== 0) throw new Error("inventory floor task ownership changed");
    } finally {
      lease.release();
    }
  } catch (error) {
    deps.sync.resume();
    throw error;
  }
}
