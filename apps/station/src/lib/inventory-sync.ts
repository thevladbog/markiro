import { parseInventoryProgressPage, type InventoryProgressPage } from "@markiro/domain";

import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
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
  expected: { inventoryId: string; snapshotId: string; deviceId: string },
  value: unknown,
): Promise<InventoryProgressPage> {
  const page = parseInventoryProgressPage(value);
  if (page.inventoryId !== expected.inventoryId || page.snapshotId !== expected.snapshotId) {
    throw new Error("Invalid inventory progress page");
  }
  for (const item of page.items) {
    if (item.winner) {
      await exec.run(
        `INSERT INTO inventory_code_results_mirror
           (inventory_id, snapshot_id, code_hash, first_accepted_event_id,
            winning_device_id, winning_scanned_at, observed_production_date,
            classification, origin_classification, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(inventory_id, snapshot_id, code_hash) DO UPDATE SET
           first_accepted_event_id = excluded.first_accepted_event_id,
           winning_device_id = excluded.winning_device_id,
           winning_scanned_at = excluded.winning_scanned_at,
           observed_production_date = excluded.observed_production_date,
           classification = excluded.classification,
           origin_classification = CASE
             WHEN inventory_code_results_mirror.origin_classification = 'voided'
               THEN excluded.origin_classification
             ELSE inventory_code_results_mirror.origin_classification
           END,
           updated_at = excluded.updated_at`,
        [
          expected.inventoryId,
          expected.snapshotId,
          item.codeHash,
          item.winner.eventId,
          item.winner.deviceId,
          item.winner.scannedAt,
          item.observedProductionDate,
          item.classification === "ineligible" ? "known-ineligible" : item.classification,
          item.classification === "ineligible" ? "known-ineligible" : item.classification,
          item.correctedAt,
        ],
      );
      if (item.winner.deviceId !== expected.deviceId) {
        const local = await exec.all<{ event_id: string }>(
          `SELECT event_id FROM inventory_scan_events_mirror
            WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ? AND device_id = ?
            ORDER BY scanned_at, device_id, event_id LIMIT 1`,
          [expected.inventoryId, expected.snapshotId, item.codeHash, expected.deviceId],
        );
        const losingEventId = local[0]?.event_id ?? null;
        if (losingEventId) {
          await exec.run(
            `INSERT INTO inventory_conflicts_mirror
               (inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
                winning_event_id, winning_device_id, winning_scanned_at, detected_at, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
             ON CONFLICT(inventory_id, snapshot_id, conflict_id) DO NOTHING`,
            [
              expected.inventoryId,
              expected.snapshotId,
              `${losingEventId}:${item.winner.eventId}`,
              item.codeHash,
              losingEventId,
              item.winner.eventId,
              item.winner.deviceId,
              item.winner.scannedAt,
              item.correctedAt,
            ],
          );
        }
      }
    } else {
      await exec.run(
        `UPDATE inventory_code_results_mirror
            SET classification = ?, observed_production_date = ?, updated_at = ?
          WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
        [
          item.classification === "ineligible" ? "known-ineligible" : item.classification,
          item.observedProductionDate,
          item.correctedAt,
          expected.inventoryId,
          expected.snapshotId,
          item.codeHash,
        ],
      );
    }
  }
  if (page.nextCursor !== null) {
    await exec.run(
      `UPDATE inventory_terminal_state SET progress_cursor = ?, updated_at = ?
        WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
      [
        page.nextCursor,
        new Date().toISOString(),
        expected.inventoryId,
        expected.snapshotId,
        expected.deviceId,
      ],
    );
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
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, 2_000);
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
    async pollProgress() {
      if (stopped || paused || generation.sealed || !deps.client.get) return;
      const rows = await deps.exec.all<{ device_id: string; progress_cursor: string | null }>(
        `SELECT device_id, progress_cursor FROM inventory_terminal_state
          WHERE inventory_id = ? AND snapshot_id = ?`,
        [deps.inventoryId, deps.snapshotId],
      );
      const terminal = rows[0];
      if (!terminal) return;
      const suffix = terminal.progress_cursor
        ? `?cursor=${encodeURIComponent(terminal.progress_cursor)}&limit=200`
        : "?limit=200";
      const value = await deps.client.get(
        `/station/inventories/${deps.inventoryId}/progress${suffix}`,
      );
      const lease = acquireCredentialCommitLease(generation);
      if (!lease) return;
      try {
        await applyInventoryProgressPage(
          deps.exec,
          {
            inventoryId: deps.inventoryId,
            snapshotId: deps.snapshotId,
            deviceId: terminal.device_id,
          },
          value,
        );
      } finally {
        lease.release();
      }
    },
    pause() {
      paused = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    resume() {
      paused = false;
      start();
    },
    stop() {
      stopped = true;
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
  closeScanner(): Promise<void>;
  scanQueueIdle(): Promise<void>;
  sync: Pick<InventorySyncEngine, "idle" | "nudge">;
}

export async function leaveInventoryTask(deps: LeaveInventoryTaskDeps): Promise<void> {
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
  await deps.exec.run(
    `DELETE FROM station_meta WHERE key = 'active_inventory_floor_task_v1'
      AND json_extract(value, '$.inventoryId') = ?
      AND json_extract(value, '$.snapshotId') = ?`,
    [deps.inventoryId, deps.snapshotId],
  );
}
