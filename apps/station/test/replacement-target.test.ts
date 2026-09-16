import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { persistStationProvisioning, type StationProvisioning } from "../src/lib/pairing.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import {
  applyTargetReplacementConfiguration,
  readTargetReplacementFence,
  persistTargetReplacementFence,
} from "../src/lib/replacement-target.js";
import {
  replacementBlocksNewWork,
  replacementCanEnterTask,
} from "../src/lib/device-replacement.js";
function open(path: string) {
  const db = new DatabaseSync(path);
  const exec: SqlExecutor = {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
  return { db, exec };
}
const boundary = {
  version: 1 as const,
  executionId: randomUUID(),
  credentialEpoch: 2,
  newWorkAllowedAt: 5000,
  serverTime: 1000,
};
const provisioning: StationProvisioning = {
  deviceId: randomUUID(),
  tenantId: "tenant",
  deviceName: "Target",
  organizationName: "Factory",
  apiKey: "candidate",
  serverUrl: "https://example.invalid",
  operators: [],
  replacement: boundary,
};
describe("durable replacement target fence", () => {
  it("persists before credential publication, survives reopen and needs matching authenticated release", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "replacement-target-")), "test.sqlite");
    let local = open(path);
    await applyMigrations(local.exec);
    const writeConfig = vi.fn(async () => {
      expect(await replacementBlocksNewWork(local.exec)).toBe(true);
      throw new Error("config publication lost");
    });
    await expect(
      persistStationProvisioning(provisioning, {
        machineId: "machine",
        exec: local.exec,
        writeConfig,
      }),
    ).rejects.toThrow("config publication lost");
    local.db.close();
    local = open(path);
    expect(await replacementBlocksNewWork(local.exec)).toBe(true);
    expect(await replacementCanEnterTask(local.exec, randomUUID(), "shift")).toBe(false);
    await persistStationProvisioning(provisioning, {
      machineId: "machine",
      exec: local.exec,
      writeConfig: async () => {},
    });
    const generation = createCredentialGeneration(provisioning.apiKey);
    await applyTargetReplacementConfiguration(
      local.exec,
      generation,
      {
        tenantId: provisioning.tenantId,
        deviceId: provisioning.deviceId,
        kind: "station",
        credentialEpoch: 2,
      },
      undefined,
    );
    expect(await replacementBlocksNewWork(local.exec)).toBe(true);
    await expect(
      applyTargetReplacementConfiguration(
        local.exec,
        generation,
        {
          tenantId: provisioning.tenantId,
          deviceId: "foreign",
          kind: "station",
          credentialEpoch: 2,
        },
        { ...boundary, serverTime: 5000 },
      ),
    ).rejects.toThrow();
    await applyTargetReplacementConfiguration(
      local.exec,
      generation,
      {
        tenantId: provisioning.tenantId,
        deviceId: provisioning.deviceId,
        kind: "station",
        credentialEpoch: 2,
      },
      { ...boundary, serverTime: 5000 },
    );
    expect(await replacementBlocksNewWork(local.exec)).toBe(false);
    await applyTargetReplacementConfiguration(
      local.exec,
      generation,
      {
        tenantId: provisioning.tenantId,
        deviceId: provisioning.deviceId,
        kind: "station",
        credentialEpoch: 2,
      },
      boundary,
    );
    expect(await replacementBlocksNewWork(local.exec)).toBe(false);
    expect((await readTargetReplacementFence(local.exec))?.fence.serverTime).toBe(5000);
    local.db.close();
  });
  it("rejects delayed pairing/configuration after a newer epoch without moving the boundary", async () => {
    const local = open(":memory:");
    await applyMigrations(local.exec);
    await persistTargetReplacementFence(local.exec, provisioning);
    const next = {
      ...provisioning,
      apiKey: "new-candidate",
      replacement: { ...boundary, credentialEpoch: 3, serverTime: 2000 },
    };
    await persistTargetReplacementFence(local.exec, next);
    const owner = {
      tenantId: provisioning.tenantId,
      deviceId: provisioning.deviceId,
      kind: "station" as const,
      credentialEpoch: 2,
    };
    await expect(
      applyTargetReplacementConfiguration(
        local.exec,
        createCredentialGeneration(provisioning.apiKey),
        owner,
        { ...boundary, serverTime: 6000 },
      ),
    ).rejects.toThrow();
    await expect(
      persistTargetReplacementFence(local.exec, {
        ...provisioning,
        replacement: { ...boundary, serverTime: 6000 },
      }),
    ).rejects.toThrow();
    await expect(
      persistTargetReplacementFence(local.exec, {
        ...next,
        replacement: { ...next.replacement, newWorkAllowedAt: 1000 },
      }),
    ).rejects.toThrow();
    expect(await replacementBlocksNewWork(local.exec)).toBe(true);
    expect((await readTargetReplacementFence(local.exec))?.fence).toEqual(next.replacement);
    local.db.close();
  });
  it("failed or ineffective fence persistence cannot publish a credential", async () => {
    for (const kind of ["fail", "ignore"]) {
      const local = open(":memory:");
      await applyMigrations(local.exec);
      local.db.exec(
        `CREATE TRIGGER reject_fence BEFORE INSERT ON station_meta WHEN NEW.key='device_replacement_target_v1' BEGIN SELECT RAISE(${kind === "fail" ? "ABORT,'simulated'" : "IGNORE"}); END`,
      );
      const writeConfig = vi.fn();
      await expect(
        persistStationProvisioning(provisioning, {
          machineId: "machine",
          exec: local.exec,
          writeConfig,
        }),
      ).rejects.toThrow();
      expect(writeConfig).not.toHaveBeenCalled();
      local.db.close();
    }
  });
});
