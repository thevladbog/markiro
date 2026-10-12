import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { createSyncEngine, type SyncState } from "../src/lib/sync.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";

it("counts only authorized pending rendering and original resolution rows while offline", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const generation = createCredentialGeneration("pending-state-test-key"),
    owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("Missing owner");
  for (const [key, status] of [
    [owner, "pending"],
    [owner, "accepted"],
    [owner, "conflict"],
    ["foreign", "pending"],
  ] as const) {
    const id = crypto.randomUUID();
    await exec.run(
      "INSERT INTO warehouse_pallet_renderings(owner,job_id,revision,value_json,receive_status) VALUES(?,?,?,'{}',?)",
      [key, id, "a".repeat(64), status],
    );
    await exec.run(
      "INSERT INTO warehouse_pallet_production_resolutions(owner,event_id,sscc,source_revision,attempt_id,value_json,digest,receive_status) VALUES(?,?,'146000000000001231',?,?,'{}',?,?)",
      [key, id, "a".repeat(64), id, "b".repeat(64), status],
    );
  }
  const states: SyncState[] = [],
    error = vi.spyOn(console, "error").mockImplementation(() => {}),
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const engine = createSyncEngine({
    exec,
    machineId: "test",
    credentialGeneration: generation,
    client: {
      get: async () => {
        throw new TypeError("Failed to fetch");
      },
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
    onState: (state) => states.push(state),
  });
  try {
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)?.pending).toBe(2);
  } finally {
    engine.stop();
    error.mockRestore();
    warn.mockRestore();
    db.close();
  }
});
