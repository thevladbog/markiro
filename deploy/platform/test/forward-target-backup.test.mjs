import { hostFailureSites } from "../host/failure-diagnostic.mjs";
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

for (const purpose of ["archive", "restore"])
  for (const diagnosticFails of [false, true])
    test(`forward ${purpose} persists initiating failure before cleanup (diagnosticFails=${diagnosticFails})`, async (t) => {
      const f = await fixture(t, "valid");
      const original = f.backupOptions.runProcess;
      const { noteHostProcessFailure, sanitizeHostFailure } =
        await import("../host/failure-diagnostic.mjs");
      const initiating = noteHostProcessFailure(
        Object.assign(new Error("private-first-worker"), {
          terminationConfirmed: true,
        }),
        "/usr/bin/docker",
        42,
      );
      let failed = false,
        recorded = false,
        cleanup = 0,
        first;
      f.backupOptions.beforeFailureCleanup = async (error) => {
        first ??= sanitizeHostFailure(error, {
          operationId: f.input.identity.operationId,
          phase: "backup-verified",
          boundary: "createBackup",
          commandCategory: "validation",
        });
        recorded = true;
        if (diagnosticFails)
          throw Object.assign(new Error("private-diagnostic"), { durabilityUncertain: true });
      };
      f.backupOptions.runProcess = async (request) => {
        const args = request.args.slice(2);
        if (args[0] === "start" && args.at(-1).endsWith(`-${purpose}-worker`)) {
          failed = true;
          throw initiating;
        }
        if (failed && ["stop", "rm"].includes(args[1])) {
          cleanup++;
          assert.equal(recorded, true, "first diagnostic must precede cleanup");
          throw new Error("private-secondary-cleanup");
        }
        return original(request);
      };
      await assert.rejects(
        withForwardPreparationState(
          f.root,
          f.input,
          async (store) => {
            await store.complete("admitted", forwardPrepared(f).sourceRuntime);
            await store.enter("source-held");
            await store.complete("source-held");
            await store.enter("backup-verified");
            await store.guard((cap) =>
              createHeldForwardBackup(f.backupInput, cap, f.input, f.backupOptions),
            );
          },
          f.options,
        ),
      );
      assert.equal(failed, true);
      assert.equal(recorded, true);
      assert.equal(first.exitStatus, 42);
      assert.equal(cleanup > 0, !diagnosticFails);
      assert.ok(await lstat(join(f.root, ".deploy.lock")));
    });

for (const fault of [null, "late-running", "late-env"])
  test(`failed-edge mixed source inner inventory and restore checks (${fault})`, async (t) => {
    const { forwardEdgeSuccessorFixture } = await import("./forward-edge-successor-fixture.mjs");
    const { replaceForwardService } = await import("./forward-observation-fixture.mjs");
    const id = "b75b2c77-3785-4df0-8613-e70b0beafc57";
    const b = await targetBackupFixture(t, "valid", { nested: true, workerOperationId: id });
    const f = await forwardEdgeSuccessorFixture(t, { targetBackup: b });
    const api = replaceForwardService(f, "api");
    api.Id = f.sourceIds.api;
    api.State = { Running: false, Restarting: false, Paused: false, Status: "exited", ExitCode: 0 };
    await b.publish();
    await f.put(join(f.root, `forward-backup-runtime-${id}.json`), {
      version: 1,
      executorSha: f.input.identity.executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///var/run/docker.sock",
      image: b.runtime.image,
      provenance: "live-source",
    });
    const connectionFile = join(f.root, `forward-connection-${id}.json`);
    await f.put(connectionFile, { ...b.connection, operationId: id });
    let inventories = 0,
      failure;
    const options = {
      ...b.options,
      productMigrationProof: f.productMigrationProof,
      runProcess: async (request) => {
        if (request.args[2] === "info" && ++inventories === 2 && fault) {
          if (fault === "late-running") api.State.Running = true;
          if (fault === "late-env")
            api.Config.Env = api.Config.Env.filter(
              (value) => !value.startsWith("MARKIRO_RELEASES_DOMAIN="),
            );
          await b.publish();
        }
        if (request.args.at(-1) === forwardMigrationQuery)
          return { stdout: Buffer.from(JSON.stringify(f.ledger)) };
        return b.options.runProcess(request);
      },
    };
    const work = withForwardPreparationState(
      f.root,
      f.input,
      async (store) => {
        const p = forwardPrepared(f);
        await store.complete("admitted", p.sourceRuntime);
        await store.enter("source-held");
        await store.complete("source-held");
        await store.enter("backup-verified");
        const result = await store.guard((cap) =>
          createHeldForwardBackup(
            {
              ...b.input,
              operation: { ...f.candidateOperation, identity: f.input.identity },
              connectionFile,
            },
            cap,
            f.input,
            options,
          ).catch((error) => {
            failure = { code: error.code, stage: error.targetBackupStage };
            if (!fault)
              t.diagnostic(JSON.stringify({ ...failure, sites: hostFailureSites(error) }));
            throw error;
          }),
        );
        const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
        assert.equal(evidence.status, "completed");
        assert.equal(evidence.checks.length, 10);
        assert.equal(evidence.cleanup.verified, true);
        assert.ok(b.workerCommands() > 0);
        assert.equal(b.daemon.containers[1].Id, f.sourceIds.api);
        assert.equal(b.daemon.containers[1].State.Running, false);
      },
      f.options,
    );
    if (fault) {
      await assert.rejects(work);
      assert.deepEqual(failure, { code: "ERR_TARGET_BACKUP", stage: "entry-observation" });
      assert.equal(inventories, 2);
      assert.equal(b.workerCommands(), 0);
    } else await work;
  });
