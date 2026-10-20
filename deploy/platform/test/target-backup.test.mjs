import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { createTargetRecoveryBackup } from "../host/target-backup.mjs";
import { randomUUID, createHash } from "node:crypto";
import * as targetBackup from "../host/target-backup.mjs";
import { withRecoveryState } from "../host/recovery-state.mjs";
import { backupProof } from "./host-fixtures.mjs";
import { withHostState } from "../host/state.mjs";

import { targetBackupFixture as fixture } from "./target-backup-fixture.mjs";
const invoke = (f) => createTargetRecoveryBackup(f.input, f.options);

test("target backup returns fresh bound recovery descriptors only after concrete observations and isolated cleanup", async (t) => {
  const f = await fixture(t);
  const result = await invoke(f);
  assert.equal(f.boundaries(), 4);
  assert.equal(f.docker.containers.size + f.docker.volumes.size, 0);
  const inventory = JSON.parse(await readFile(result.backup.inventoryPath));
  const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.provenance, "live-source");
  assert.equal(inventory.runtime.architecture, "amd64");
  assert.equal(inventory.executorSha, f.input.operation.identity.executorSha);
  assert.equal(result.fence.fenceId, inventory.fence.before.fenceId);
  assert.equal(result.fence.beganAt, inventory.fence.before.beganAt);
  assert.notEqual(result.fence.fenceId, f.f.record.deployment.preparedTarget.fence.fenceId);
  assert.equal(
    result.fence.enforcementSha256,
    digest({
      version: 1,
      kind: "platform-docker-private-database-fence",
      target: f.input.operation.identity.target,
      dockerId: f.input.observationPolicy.dockerId,
      network: f.input.observationPolicy.networks.database,
      volume: f.input.observationPolicy.volume,
      postgresImageId: f.input.observationPolicy.postgresImageId,
      hbaSha256: f.input.hbaSha256,
    }),
  );
  await assert.rejects(lstat(join(f.f.root, ".deploy.lock")), { code: "ENOENT" });
});

for (const mode of [
  "host",
  "image",
  "network",
  "active",
  "foreign",
  "session",
  "stale-hba",
  "hba-path",
  "service-host",
  "service-port",
  "service-db",
  "connection-network",
  "runtime-endpoint",
  "runtime-executable",
  "runtime-provenance",
  "runtime-executor",
  "runtime-architecture",
  "source-failure",
  "altered-private",
  "final-observation",
  "unreaped",
  "durability",
  "cleanup",
  "restore-cleanup",
  "journal",
]) {
  test(`target backup rejects ${mode} without returning acceptance`, async (t) => {
    const f = await fixture(t, mode);
    if (mode === "host") f.options.readMachineId = async () => "b".repeat(32);
    if (mode === "image") f.daemon.containers[0].Image = `sha256:${"0".repeat(64)}`;
    if (mode === "network") f.daemon.networks[1].Id = "0".repeat(64);
    if (["active", "foreign"].includes(mode)) {
      const c = structuredClone(f.daemon.containers[0]);
      c.Id = "9".repeat(64);
      c.Name = "/foreign-writer";
      c.Config.Labels =
        mode === "foreign"
          ? {}
          : {
              "com.docker.compose.project": "markiro-platform",
              "com.docker.compose.service": "api",
            };
      if (mode === "foreign") c.State = { Running: false, Status: "exited" };
      f.daemon.containers.push(c);
    }
    if (mode === "session")
      f.daemon.adminResult.sessions = [
        { usename: "markiro_app", client_addr: "172.20.0.5", application_name: "foreign" },
      ];
    if (mode === "stale-hba") f.daemon.adminResult.started_at = 1;
    if (mode === "hba-path") f.input.hbaPath = f.f.env.MARKIRO_POSTGRES_CA_FILE;
    if (mode.startsWith("service-")) {
      const text = String(await readFile(f.connection.serviceFile));
      const replacement = {
        "service-host": ["host=db.private", "host=foreign.private"],
        "service-port": ["port=5432", "port=5433"],
        "service-db": ["dbname=markiro", "dbname=other"],
      }[mode];
      await f.save("backup-service.conf", text.replace(...replacement));
    }
    if (mode === "connection-network") {
      f.connection.network = "foreign-network";
      await f.save("connection.json", f.connection);
    }
    const field = {
      "runtime-endpoint": ["endpoint", "unix:///other.sock"],
      "runtime-executable": ["dockerExecutable", "/tmp/docker"],
      "runtime-provenance": ["provenance", "local-synthetic"],
      "runtime-executor": ["executorSha", "0".repeat(40)],
    }[mode];
    if (field) {
      f.runtime[field[0]] = field[1];
      await f.save("backup-runtime.json", f.runtime);
    }
    if (mode === "runtime-architecture") f.daemon.images.at(-1).Architecture = "arm64";
    if (mode === "journal")
      await withHostState(f.f.root, (store) => store.begin(f.input.operation.identity));
    await f.publish();
    await assert.rejects(invoke(f), (error) => {
      assert.equal(error.code, "ERR_TARGET_BACKUP");
      assert.equal(error.message.includes("secret"), false);
      if (mode === "unreaped") assert.equal(error.terminationConfirmed, false);
      if (["unreaped", "durability", "cleanup", "restore-cleanup"].includes(mode)) {
        assert.equal(error.durabilityUncertain, true);
        assert.equal(error.recoveryRequired, true);
      }
      return true;
    });
    if (["unreaped", "durability", "cleanup", "restore-cleanup"].includes(mode))
      assert.ok(await lstat(join(f.f.root, ".deploy.lock")));
    if (
      !["unreaped", "durability", "cleanup", "restore-cleanup", "final-observation"].includes(mode)
    )
      assert.equal(f.workerCommands(), 0);
  });
}

test("target backup rejects an already held deployment lock", async (t) => {
  const f = await fixture(t);
  await withHostState(f.f.root, async () => {
    await assert.rejects(invoke(f));
    assert.equal(f.workerCommands(), 0);
    assert.equal(f.boundaries(), 0);
  });
});

test("target backup excludes concurrent deployment at every boundary", async (t) => {
  const f = await fixture(t);
  const original = f.input.verifySources;
  f.input.verifySources = async () => {
    await assert.rejects(
      withHostState(f.f.root, () => assert.fail("concurrent owner entered")),
      { code: "ERR_HOST_STATE" },
    );
    await original();
  };
  await invoke(f);
  assert.equal(f.boundaries(), 4);
});

for (const purpose of ["archive", "restore"])
  test(`target backup retains lock when ${purpose} cleanup and failure evidence persistence both fail`, async (t) => {
    const f = await fixture(t);
    const original = f.options.runProcess;
    const worker = `markiro-backup-${f.input.operation.identity.operationId}-${purpose}-worker`;
    const directory = join(
      f.f.root,
      `${purpose === "archive" ? "backup" : "restore"}-${f.input.operation.identity.operationId}`,
    );
    f.options.runProcess = async (request) => {
      const args = request.args.slice(2);
      if (args[0] === "container" && args[1] === "rm" && args.at(-1) === worker) {
        // Actual protected writer fails with EEXIST before publication, replacing
        // the producer's cleanup error with durabilityUncertain=false.
        await writeFile(join(directory, "failure.json"), "existing failure evidence", {
          mode: 0o600,
          flag: "wx",
        });
        throw new Error("controlled cleanup failure");
      }
      return original(request);
    };
    let failure;
    try {
      await invoke(f);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "ERR_TARGET_BACKUP");
    assert.equal(f.docker.containers.has(worker), true);
    assert.ok(await lstat(join(f.f.root, ".deploy.lock")));
    assert.equal(failure.durabilityUncertain, true);
    assert.equal(failure.recoveryRequired, true);
    await assert.rejects(
      withHostState(f.f.root, () => assert.fail("uncertain producer released lock")),
      { code: "ERR_HOST_STATE" },
    );
    for (const name of purpose === "archive"
      ? ["database.dump", "inventory.json"]
      : ["evidence.json"])
      await assert.rejects(lstat(join(directory, name)), { code: "ENOENT" });
  });

test("target backup never issues another process command after unconfirmed termination", async (t) => {
  const f = await fixture(t, "unreaped");
  const original = f.options.runProcess;
  let unreaped = false,
    laterCommands = 0;
  f.options.runProcess = async (request) => {
    if (unreaped) laterCommands++;
    try {
      return await original(request);
    } catch (error) {
      if (error.terminationConfirmed === false) unreaped = true;
      throw error;
    }
  };
  await assert.rejects(invoke(f), { terminationConfirmed: false, durabilityUncertain: true });
  assert.equal(unreaped, true);
  assert.equal(laterCommands, 0);
});

for (const mode of [
  "valid",
  "different-executor",
  "wrong-runtime-executor",
  "missing-recovery-runtime",
  "wrong-runtime-operation",
  "changed-source-runtime",
  "changed-recovery-runtime",
  "forged",
  "wrong-phase",
  "changed-sidecar",
  "wrong-root",
  "expired",
  "cleanup",
  "restore-cleanup",
  "unreaped",
]) {
  test(`held target backup validates recovery boundary: ${mode}`, async (t) => {
    const uncertain = ["cleanup", "restore-cleanup", "unreaped"].includes(mode);
    const f = await fixture(t, uncertain ? mode : undefined);
    const prior = structuredClone(f.input.operation.identity);
    prior.operationId = randomUUID();
    if (mode === "different-executor") {
      prior.executorSha = "1".repeat(40);
      await f.save("backup-runtime.json", {
        ...f.runtime,
        executorSha: prior.executorSha,
        image: `sha256:${"9".repeat(64)}`,
      });
    }
    if (mode !== "missing-recovery-runtime")
      await f.save(
        `recovery-backup-runtime-${f.input.operation.identity.operationId}.json`,
        f.runtime,
      );
    if (mode === "wrong-runtime-executor")
      await f.save(`recovery-backup-runtime-${f.input.operation.identity.operationId}.json`, {
        ...f.runtime,
        executorSha: "2".repeat(40),
      });
    if (mode === "wrong-runtime-operation")
      await rename(
        join(f.f.root, `recovery-backup-runtime-${f.input.operation.identity.operationId}.json`),
        join(f.f.root, `recovery-backup-runtime-${randomUUID()}.json`),
      );
    const originalRuntime = await readFile(join(f.f.root, "backup-runtime.json"));
    if (["changed-source-runtime", "changed-recovery-runtime"].includes(mode)) {
      const verify = f.input.verifySources;
      f.input.verifySources = async () => {
        await verify();
        const name =
          mode === "changed-source-runtime"
            ? "backup-runtime.json"
            : `recovery-backup-runtime-${f.input.operation.identity.operationId}.json`;
        await f.save(name, (await readFile(join(f.f.root, name))).toString() + " ");
      };
    }
    const state = {
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    };
    const bytes = Buffer.from(JSON.stringify(state));
    await f.save("state.json", bytes.toString());
    const admission = {
      version: 1,
      kind: "platform-failed-activation-recovery",
      identity: f.input.operation.identity,
      predecessor: {
        identity: prior,
        sequence: 14,
        stateSha256: createHash("sha256").update(bytes).digest("hex"),
      },
      executorCi: { runId: "123456789", runAttempt: "1" },
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    };
    await assert.rejects(invoke(f));
    assert.equal(f.workerCommands(), 0);
    const execution = withRecoveryState(f.f.root, admission, async (store) => {
      await store.complete("admitted");
      await store.enter("target-stopped");
      await store.complete("target-stopped");
      await store.enter("backup-verified");
      const call = () =>
        store.produceBackup(async (capability) => {
          if (mode === "changed-sidecar" || mode === "wrong-phase") {
            const ledger = JSON.parse(await readFile(join(f.f.root, "recovery-state.json")));
            if (mode === "wrong-phase") ledger.phase = "target-stopped";
            else ledger.admission.identity.operationId = randomUUID();
            await f.save("recovery-state.json", ledger);
          }
          const input =
            mode === "wrong-root"
              ? { ...f.input, operation: { ...f.input.operation, root: join(f.f.root, "other") } }
              : f.input;
          const admitted =
            mode === "expired"
              ? { ...admission, expiresAt: new Date(Date.now() - 1000).toISOString() }
              : admission;
          return targetBackup.createHeldTargetRecoveryBackup(
            input,
            mode === "forged" ? {} : capability,
            admitted,
            f.options,
          );
        });
      if (!["valid", "different-executor"].includes(mode)) await assert.rejects(call());
      else {
        const result = await call();
        const evidence = JSON.parse(await readFile(result.restoreEvidence.evidencePath));
        const inventory = JSON.parse(await readFile(result.backup.inventoryPath));
        assert.equal(evidence.status, "completed");
        for (const document of [inventory, evidence]) {
          assert.equal(document.executorSha, f.input.operation.identity.executorSha);
          assert.equal(document.runtime.image, f.runtime.image);
        }
        assert.equal(f.boundaries(), 4);
        assert.equal(f.docker.containers.size + f.docker.volumes.size, 0);
      }
    });
    if (uncertain) {
      await assert.rejects(execution, { durabilityUncertain: true });
      await lstat(join(f.f.root, ".deploy.lock"));
      assert.ok(f.workerCommands() > 0);
    } else await execution;
    assert.deepEqual(await readFile(join(f.f.root, "state.json")), bytes);
    if (mode !== "changed-source-runtime")
      assert.deepEqual(await readFile(join(f.f.root, "backup-runtime.json")), originalRuntime);
    if (!["valid", "different-executor"].includes(mode) && !uncertain)
      assert.equal(f.workerCommands(), 0);
  });
}
