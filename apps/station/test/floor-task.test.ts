import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { inventorySnapshotContentDigest } from "@markiro/domain";

import {
  activateVerifiedInventoryFloorTask,
  parseInventoryTaskList,
  parseResolvedInventoryTask,
  productionFloorTask,
  readPersistedInventoryFloorTask,
} from "../src/lib/floor-task.js";
import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import type { InventoryBundleManifest } from "../src/lib/inventory-mirror.js";

const inventoryId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";

const manifest: InventoryBundleManifest = {
  inventoryId,
  inventoryNumber: "INV-00042",
  snapshotId,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:02:03.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: inventorySnapshotContentDigest([]),
  codeCount: 0,
  productId: "44444444-4444-4444-8444-444444444444",
  productName: "Вода питьевая 0,5 л",
  gtin14: "04600000000015",
  boxCapacity: 12,
  mode: "check",
  lineId,
  lineName: "Розлив №2",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplate: null,
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

const task = {
  inventoryId,
  inventoryNumber: "INV-00042",
  productName: "Вода питьевая 0,5 л",
  mode: "check" as const,
  lineId,
  lineName: "Розлив №2",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
};

function executor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

describe("floor task contracts", () => {
  it("keeps the existing production shift shape behind a closed union branch", () => {
    const shift = { id: "shift-1", status: "active", mode: "aggregation" };

    expect(productionFloorTask(shift)).toEqual({ kind: "production", shift });
  });

  it("strictly validates inventory task discovery and barcode resolution", () => {
    expect(parseInventoryTaskList({ items: [task] })).toEqual([task]);
    expect(
      parseResolvedInventoryTask({
        task,
        deviceLineId: "55555555-5555-4555-8555-555555555555",
        requiresDifferentLineConfirmation: true,
      }),
    ).toMatchObject({ task, requiresDifferentLineConfirmation: true });

    expect(() => parseInventoryTaskList({ items: [{ ...task, unexpected: true }] })).toThrow();
    expect(() =>
      parseResolvedInventoryTask({
        task,
        deviceLineId: lineId,
        requiresDifferentLineConfirmation: true,
      }),
    ).toThrow();
    expect(() =>
      parseInventoryTaskList({ items: [{ ...task, productionDateTo: "2026-07-31" }] }),
    ).toThrow();
  });

  it("persists and resumes only a strictly valid, locally published inventory snapshot", async () => {
    const exec = executor();
    await applyMigrations(exec);
    await exec.run(
      `INSERT INTO inventory_task_mirror (
         inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision,
         active_snapshot_fixed_at, active_combined_digest, active_content_digest,
         active_code_count, active_manifest_json, staging_generation, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, 0, ?)`,
      [
        inventoryId,
        manifest.inventoryNumber,
        snapshotId,
        manifest.snapshotFixedAt,
        manifest.combinedDigest,
        manifest.contentDigest,
        JSON.stringify(manifest),
        "2026-08-25T02:00:00.000Z",
      ],
    );

    await expect(activateVerifiedInventoryFloorTask(exec, inventoryId)).resolves.toEqual({
      kind: "inventory",
      inventory: manifest,
    });
    await expect(readPersistedInventoryFloorTask(exec)).resolves.toEqual({
      kind: "inventory",
      inventory: manifest,
    });

    await exec.run(
      "UPDATE inventory_task_mirror SET active_manifest_json = ? WHERE inventory_id = ?",
      [JSON.stringify({ ...manifest, unexpected: true }), inventoryId],
    );
    await expect(readPersistedInventoryFloorTask(exec)).rejects.toThrow();
  });

  it("refuses activation while the bundle is staged but not published", async () => {
    const exec = executor();
    await applyMigrations(exec);
    await exec.run(
      `INSERT INTO inventory_task_mirror (
         inventory_id, inventory_number, staged_snapshot_id, staged_snapshot_revision,
         staged_snapshot_fixed_at, staged_combined_digest, staged_content_digest,
         staged_code_count, staged_manifest_json, staging_generation
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, 1)`,
      [
        inventoryId,
        manifest.inventoryNumber,
        snapshotId,
        manifest.snapshotFixedAt,
        manifest.combinedDigest,
        manifest.contentDigest,
        JSON.stringify(manifest),
      ],
    );

    await expect(activateVerifiedInventoryFloorTask(exec, inventoryId)).rejects.toThrow(
      "not published",
    );
    expect(
      await exec.all("SELECT value FROM station_meta WHERE key = ?", [
        "active_inventory_floor_task_v1",
      ]),
    ).toEqual([]);
  });

  it("rejects a crash-left pointer when restart uses a replacement credential owner", async () => {
    const exec = executor();
    await applyMigrations(exec);
    await exec.run(
      `INSERT INTO inventory_task_mirror (
         inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision,
         active_snapshot_fixed_at, active_combined_digest, active_content_digest,
         active_code_count, active_manifest_json, staging_generation, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, 0, ?)`,
      [
        inventoryId,
        manifest.inventoryNumber,
        snapshotId,
        manifest.snapshotFixedAt,
        manifest.combinedDigest,
        manifest.contentDigest,
        JSON.stringify(manifest),
        "2026-08-25T02:00:00.000Z",
      ],
    );
    const originalGeneration = createCredentialGeneration("credential-a");
    const commitLease = acquireCredentialCommitLease(originalGeneration);
    expect(commitLease).not.toBeNull();
    await activateVerifiedInventoryFloorTask(exec, inventoryId, commitLease!);
    commitLease!.release();

    await expect(
      readPersistedInventoryFloorTask(exec, createCredentialGeneration("credential-a")),
    ).resolves.toEqual({ kind: "inventory", inventory: manifest });
    await expect(
      readPersistedInventoryFloorTask(exec, createCredentialGeneration("credential-b")),
    ).resolves.toBeNull();
  });
});
