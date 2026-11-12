import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { catalogTables } from "../backup/catalog.mjs";
import { mapInventory } from "../backup/inventory.mjs";
import { digest } from "../backup/schemas.mjs";
import { withHealthyForwardRollout } from "../host/healthy-forward-rollout-state.mjs";
import { createHeldHealthyForwardBackup } from "../host/target-backup.mjs";
import { targetBackupFixture } from "./target-backup-fixture.mjs";

for (const fault of [null, "ledger-mismatch", "source-api-running"]) {
  test(`fresh rollout verifies the held source and restored ledger (${fault ?? "valid"})`, async (t) => {
    const fixture = await targetBackupFixture(t, "valid", { nested: true });
    const { input, f, daemon } = fixture;
    const { root, identity } = input.operation;
    const priorId = "45b7e3bc-564f-4b93-aee3-a3f8372f590a";
    const prior = JSON.stringify({ kind: "platform-forward-recovery-index", operationId: priorId });
    const indexPath = join(root, "upgrade-index.json");
    await writeFile(indexPath, prior, { mode: 0o600 });
    const runtime = JSON.stringify(fixture.runtime);
    await writeFile(
      join(root, `healthy-forward-backup-runtime-${identity.operationId}.json`),
      runtime,
      {
        mode: 0o600,
      },
    );
    const migrationJournal = { count: "204", sha256: "e".repeat(64) };
    f.document.inventory.migrationJournal = migrationJournal;
    f.document.inventory.tables = [
      { schema: "drizzle", name: "__drizzle_migrations", ...migrationJournal },
      ...catalogTables.map((name) => ({ schema: "public", name, count: "0", sha256: digest("") })),
    ];
    const postgres = daemon.containers[0];
    const owned = [
      { service: "postgres", container: postgres, active: true },
      ...["api", "edge"].map((service) => ({
        service,
        container: {
          ...daemon.templates[service],
          State: {
            Status: fault === "source-api-running" && service === "api" ? "running" : "exited",
            Running: fault === "source-api-running" && service === "api",
            Restarting: false,
            Paused: false,
            Dead: false,
          },
        },
        active: false,
      })),
    ];
    let attempted = false;
    let backupStage;
    const execute = withHealthyForwardRollout(
      {
        root,
        operationId: identity.operationId,
        predecessorOperationId: priorId,
        predecessorIndexSha256: digest(prior),
        operationSha256: "a".repeat(64),
        executorSha: identity.executorSha,
        backupRuntimeSha256: digest(runtime),
        postgresId: postgres.Id,
      },
      {
        verifyAuthority: async () => {},
        preflight: async () => {},
        stopSource: async () => {},
        verifySourceStopped: async () => {},
        verifyBackup: async (capability) => {
          const result = await createHeldHealthyForwardBackup(input, capability, {
            ...fixture.options,
            sourceContainers: Object.fromEntries(
              owned.map(({ service, container }) => [service, container.Id]),
            ),
            observeSource: async () => ({ owned, config: f.env }),
            runProcess: async (request) => {
              if (request.args.at(-1).includes("AS row_sha")) {
                assert.ok(request.args.includes(postgres.Id));
                return {
                  stdout: JSON.stringify(
                    fault === "ledger-mismatch"
                      ? { ...migrationJournal, sha256: "f".repeat(64) }
                      : migrationJournal,
                  ),
                };
              }
              const result = await fixture.options.runProcess(request);
              if (
                request.args[2] === "cp" &&
                request.args[3].includes("-archive-worker:/work/out/.")
              ) {
                const path = join(request.args[4], "inventory.json");
                const captured = JSON.parse(await readFile(path));
                captured.catalogState = catalogTables.map((name) => ({ name, rows: [] }));
                await writeFile(path, JSON.stringify(captured));
              }
              if (
                request.args[2] === "cp" &&
                request.args[3].includes("-restore-worker:/work/out/.")
              ) {
                const path = join(request.args[4], "restored.json");
                const restored = JSON.parse(await readFile(path));
                restored.inventory = mapInventory(f.document.inventory, input.roleMapping);
                await writeFile(path, JSON.stringify(restored));
              }
              return result;
            },
          }).catch((error) => {
            backupStage = error.targetBackupStage;
            throw error;
          });
          assert.equal(
            JSON.parse(await readFile(result.restoreEvidence.evidencePath)).status,
            "completed",
          );
          return result.backupProofSha256;
        },
        activateApi: async () => {
          attempted = true;
          return "a".repeat(64);
        },
        activateEdge: async () => "b".repeat(64),
        verifyHealth: async (expected) => expected,
      },
    );
    if (fault) {
      await assert.rejects(execute, { durabilityUncertain: true });
      assert.equal(String(await readFile(indexPath)), prior);
    } else await execute.catch((error) => assert.fail(`${error.code} at ${backupStage}`));
    assert.equal(attempted, fault === null);
    assert.equal(fixture.workerCommands() > 0, fault !== "source-api-running");
    assert.equal(fixture.docker.containers.size + fixture.docker.volumes.size, 0);
  });
}
