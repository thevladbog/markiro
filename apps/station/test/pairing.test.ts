import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { StationConfig } from "../src/lib/config.js";
import { applyMigrations, readOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { persistStationProvisioning, type StationProvisioning } from "../src/lib/pairing.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

const provisioning: StationProvisioning = {
  deviceId: "device-1",
  deviceName: "Packing station",
  tenantId: "tenant-1",
  organizationName: "Factory",
  lineId: "line-1",
  lineName: "Packing",
  apiKey: "station-credential",
  serverUrl: "https://station.example",
  operators: [
    {
      operatorId: "operator-1",
      name: "Operator",
      login: "1001",
      role: "operator",
      pinHash:
        "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
      badgeHash: null,
      active: true,
    },
  ],
};

describe("persistStationProvisioning", () => {
  it("publishes the full roster before atomically saving the provisioning bundle", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const events: string[] = [];
    let written: StationConfig | null = null;

    await persistStationProvisioning(provisioning, {
      machineId: "machine-1",
      exec,
      writeConfig: async (config) => {
        events.push("config");
        written = config;
      },
      onRosterPublished: () => events.push("roster"),
    });

    expect(events).toEqual(["roster", "config"]);
    expect(await readOperatorsMirror(exec)).toEqual(provisioning.operators);
    expect(written).toEqual({
      machineId: "machine-1",
      deviceId: "device-1",
      deviceName: "Packing station",
      tenantId: "tenant-1",
      organizationName: "Factory",
      lineId: "line-1",
      lineName: "Packing",
      apiKey: "station-credential",
      serverUrl: "https://station.example",
    });
  });

  it("does not write config when publishing the roster fails", async () => {
    const exec: SqlExecutor = {
      run: vi.fn().mockRejectedValue(new Error("mirror unavailable")),
      all: vi.fn().mockResolvedValue([]),
    };
    const writeConfig = vi.fn();

    await expect(
      persistStationProvisioning(provisioning, { machineId: "machine-1", exec, writeConfig }),
    ).rejects.toThrow("mirror unavailable");
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["a plaintext PIN verifier", { pinHash: "not-a-phc" }],
    ["a malformed badge verifier", { badgeHash: "not-a-phc" }],
  ])("rejects %s before publishing roster or config", async (_label, operatorPatch) => {
    const exec: SqlExecutor = { run: vi.fn(), all: vi.fn() };
    const writeConfig = vi.fn();
    const invalid: StationProvisioning = {
      ...provisioning,
      operators: [{ ...provisioning.operators[0]!, ...operatorPatch }],
    };

    await expect(
      persistStationProvisioning(invalid, { machineId: "machine-1", exec, writeConfig }),
    ).rejects.toThrow("Invalid operator roster");
    expect(exec.run).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("leaves operational mirror tables alone when the atomic config write fails", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await exec.run(
      "INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at) VALUES (?, ?, ?, ?, ?)",
      ["shift-1", "device-1", "sealed-work", "ok", "2026-08-06T00:00:00.000Z"],
    );
    const writeConfig = vi.fn().mockRejectedValue(new Error("disk full"));

    await expect(
      persistStationProvisioning(provisioning, { machineId: "machine-1", exec, writeConfig }),
    ).rejects.toThrow("disk full");
    expect(await exec.all<{ raw: string }>("SELECT raw FROM outbox ORDER BY id")).toEqual([
      { raw: "sealed-work" },
    ]);
    expect(await readOperatorsMirror(exec)).toEqual(provisioning.operators);
  });
});
