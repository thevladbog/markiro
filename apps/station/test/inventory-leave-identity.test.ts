import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { initializeDeviceRecovery } from "../src/lib/device-recovery.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { leaveInventoryTask } from "../src/lib/inventory-sync.js";
import { makeExec, openFileDatabase } from "./support/sqlite-exec.js";

describe("legacy inventory leave identity", () => {
  it("reuses its persisted activation identity after response loss and SQLite reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "station-leave-identity-"));
    const path = join(directory, "mirror.sqlite");
    let db = openFileDatabase(path);
    let exec = makeExec(db);
    const inventoryId = randomUUID(),
      snapshotId = randomUUID(),
      deviceId = randomUUID();
    const apiKey = "leave-test-key";
    let generation = createCredentialGeneration(apiKey);
    const ownership = await credentialGenerationOwnership(generation);
    const activationId = randomUUID();
    let pointerValue = JSON.stringify({
      inventoryId,
      snapshotId,
      activationId,
      credentialOwnership: ownership,
    });
    const bodies: unknown[] = [];
    const post = async (_path: string, body?: unknown) => {
      bodies.push(structuredClone(body));
      expect(
        db
          .prepare("SELECT value FROM station_meta WHERE key='active_inventory_floor_task_v1'")
          .get(),
      ).toEqual({ value: pointerValue });
      if (bodies.length === 1) throw new Error("response lost");
      return { outcome: "left" };
    };
    const leave = () =>
      leaveInventoryTask({
        exec,
        client: { post },
        inventoryId,
        snapshotId,
        deviceId,
        pointerValue,
        credentialGeneration: generation,
        closeScanner: async () => undefined,
        scanQueueIdle: async () => undefined,
        sync: {
          nudge: () => undefined,
          idle: async () => undefined,
          stop: () => undefined,
          resume: () => undefined,
        },
      });
    try {
      await applyMigrations(exec);
      await initializeDeviceRecovery(exec, {
        machineId: "local",
        deviceId,
        tenantId: "tenant",
        apiKey,
        serverUrl: "https://example.invalid",
      });
      db.prepare(
        "INSERT INTO inventory_task_mirror(inventory_id,inventory_number,active_snapshot_id,active_snapshot_revision) VALUES(?,'INV-1',?,1)",
      ).run(inventoryId, snapshotId);
      db.prepare(
        "INSERT INTO station_meta(key,value) VALUES('active_inventory_floor_task_v1',?)",
      ).run(pointerValue);
      await expect(leave()).rejects.toThrow("response lost");
      expect(bodies[0]).toEqual({ requestId: activationId, pendingEventCount: 0, openBoxCount: 0 });
      db.close();
      db = openFileDatabase(path);
      exec = makeExec(db);
      generation = createCredentialGeneration(apiKey);
      await leave();
      expect(bodies[1]).toEqual(bodies[0]);
      const nextActivation = randomUUID();
      pointerValue = JSON.stringify({
        inventoryId,
        snapshotId,
        activationId: nextActivation,
        credentialOwnership: ownership,
      });
      db.prepare(
        "INSERT INTO station_meta(key,value) VALUES('active_inventory_floor_task_v1',?)",
      ).run(pointerValue);
      await leave();
      expect(bodies[2]).toEqual({
        requestId: nextActivation,
        pendingEventCount: 0,
        openBoxCount: 0,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
