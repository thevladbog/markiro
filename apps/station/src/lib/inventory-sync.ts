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
    canCommit?: () => boolean;
  },
  value: unknown,
): Promise<InventoryProgressPage> {
  const terminalRows = await exec.all<{
    progress_cursor: string | null;
    progress_result_revision: number;
  }>(
    `SELECT progress_cursor, progress_result_revision FROM inventory_terminal_state
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
  const receiptId = `${expected.inventoryId}:${expected.snapshotId}:${expected.deviceId}:${requestedCursor ?? "root"}:${priorResultRevision}:${page.resultRevision}:${page.nextCursor ?? "end"}`;
  await exec.run(
    `INSERT INTO inventory_progress_receipts
       (receipt_id, inventory_id, snapshot_id, device_id, requested_cursor,
        prior_result_revision, page_json, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO NOTHING`,
    [
      receiptId,
      expected.inventoryId,
      expected.snapshotId,
      expected.deviceId,
      requestedCursor,
      priorResultRevision,
      JSON.stringify(page),
      new Date().toISOString(),
    ],
  );
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
        const value = await deps.client.post(
          `/station/inventories/${deps.inventoryId}/event-batches`,
          batch.request,
        );
        if (stopped || paused || generation.sealed) break;
        const commitLease = acquireCredentialCommitLease(generation);
        if (!commitLease) break;
        try {
          await acknowledgeInventoryOutboxBatch(deps.exec, batch, value);
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
      if (!draining) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
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
  sync: Pick<InventorySyncEngine, "idle" | "nudge">;
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
    pointer.credentialOwnership !== expectedOwnership
  ) {
    throw new Error("inventory floor task ownership changed");
  }
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
  const pending = await inventoryOutboxDepth(deps.exec, deps.inventoryId, deps.snapshotId);
  const openRows = await deps.exec.all<{ count: number }>(
    `SELECT COUNT(*) AS count FROM inventory_repack_boxes_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND owner_device_id = ? AND state = 'open'`,
    [deps.inventoryId, deps.snapshotId, deps.deviceId],
  );
  if (pending !== 0 || (openRows[0]?.count ?? 0) !== 0) {
    throw new Error("inventory task still has pending work");
  }
  const response = await deps.client.post(`/station/inventories/${deps.inventoryId}/leave`, {
    pendingEventCount: 0,
    openBoxCount: 0,
  });
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
    await deps.exec.run(
      `DELETE FROM station_meta WHERE key = 'active_inventory_floor_task_v1'
        AND value = ?`,
      [deps.pointerValue],
    );
    const remaining = await deps.exec.all<{ value: string }>(
      "SELECT value FROM station_meta WHERE key = 'active_inventory_floor_task_v1'",
    );
    if (remaining.length !== 0) throw new Error("inventory floor task ownership changed");
  } finally {
    lease.release();
  }
}
