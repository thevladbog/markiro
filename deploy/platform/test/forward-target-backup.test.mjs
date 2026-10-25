import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHeldForwardBackup } from "../host/target-backup.mjs";
import { withForwardPreparationState } from "../host/forward-state.mjs";
import { forwardMigrationQuery } from "../host/forward-ledger.mjs";
import { upgradeBackupResult } from "../host/upgrade-command-runtime.mjs";
import { forwardPrepared } from "./forward-fixture.mjs";
import { targetBackupFixture } from "./target-backup-fixture.mjs";
import { forwardObservationFixture } from "./forward-observation-fixture.mjs";
import { provisionForwardRuntimes } from "./forward-backup-fixture.mjs";
async function fixture(t, mode) {
  const operationId = randomUUID();
  const b = await targetBackupFixture(t, mode, { nested: true, workerOperationId: operationId });
  const f = await forwardObservationFixture(t, { targetBackup: b, operationId });
  await b.publish();
  await provisionForwardRuntimes(f);
  const connectionFile = join(f.root, `forward-connection-${f.input.identity.operationId}.json`);
  await writeFile(
    connectionFile,
    JSON.stringify({ ...b.connection, operationId: f.input.identity.operationId }),
    { mode: 0o600 },
  );
  const input = { ...b.input, operation: f.candidateOperation, connectionFile };
  const options = {
    ...b.options,
    productMigrationProof: f.productMigrationProof,
    runProcess: async (request) => {
      if (request.args.at(-1) === forwardMigrationQuery) {
        assert.equal(b.docker.containers.size + b.docker.volumes.size, 0);
        return { stdout: Buffer.from(JSON.stringify(f.ledger)) };
      }
      return b.options.runProcess(request);
    },
  };
  return { ...f, b, backupInput: input, backupOptions: options };
}
for (const mode of [
  "valid",
  "forged",
  "wrong-phase",
  "running-writer",
  "schema",
  "ledger",
  "wrong-config",
  "cleanup",
  "restore-cleanup",
  "unreaped",
])
  test(`post-migration actual-source backup pipeline: ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    const historical = await readFile(
      join(f.root, `upgrade-backup-runtime-${f.input.failed.identity.operationId}.json`),
    );
    let succeeded = false;
    if (mode === "running-writer") {
      f.b.daemon.containers[1].State.Running = true;
      await f.b.publish();
    }
    if (mode === "schema") f.ledger.schema.schemaSha256 = "f".repeat(64);
    if (mode === "ledger") f.ledger.rows[0].hash = "f".repeat(64);
    if (mode === "wrong-config")
      f.backupInput.operation = {
        ...f.backupInput.operation,
        configuration: f.oldOperation.configuration,
      };
    const call = withForwardPreparationState(
      f.root,
      f.input,
      async (s) => {
        const prepared = forwardPrepared(f);
        await s.complete("admitted", prepared.sourceRuntime);
        await s.enter("source-held");
        await s.complete("source-held");
        if (mode !== "wrong-phase") await s.enter("backup-verified");
        const produce = () =>
          s.guard((cap) =>
            createHeldForwardBackup(
              f.backupInput,
              mode === "forged" ? {} : cap,
              f.input,
              f.backupOptions,
            ),
          );
        if (mode !== "valid") {
          await assert.rejects(produce());
          return;
        }
        const result = await produce();
        const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
        assert.equal(evidence.status, "completed");
        assert.equal(evidence.checks.length, 10);
        const projected = upgradeBackupResult(f.input.identity, result);
        prepared.preparation.backup = projected.backup;
        prepared.preparation.fence = projected.fence;
        await s.complete("backup-verified", projected.backup, prepared.preparation);
        assert.equal((await s.read()).status, "completed");
        assert.equal((await s.read()).migrationEntered, true);
        succeeded = true;
      },
      f.options,
    );
    if (["cleanup", "restore-cleanup", "unreaped"].includes(mode)) {
      await assert.rejects(call, (error) => error.durabilityUncertain === true);
      assert.ok(await lstat(join(f.root, ".deploy.lock")));
      assert.ok(f.b.workerCommands() > 0, "fault must be reached inside actual worker lifecycle");
    } else await call;
    assert.equal(succeeded, mode === "valid");
    assert.deepEqual(
      await readFile(
        join(f.root, `upgrade-backup-runtime-${f.input.failed.identity.operationId}.json`),
      ),
      historical,
    );
    if (
      ["forged", "wrong-phase", "running-writer", "schema", "ledger", "wrong-config"].includes(mode)
    )
      assert.equal(f.b.workerCommands(), 0);
  });
