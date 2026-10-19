/** Only the synthetic local harness calls this; never writes live acceptance. */
import assert from "node:assert/strict";
import { X509Certificate, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostEnv, hostIdentity, envBytes } from "../test/host-fixtures.mjs";
import {
  fingerprintHostConfiguration,
  snapshotHostConfig,
  snapshotMigrationConfig,
} from "../host/config.mjs";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { createCleanupObserver } from "../host/observe.mjs";
import { withHostState } from "../host/state.mjs";
import { digest } from "./schemas.mjs";

export async function verifyLocalPreparedPath({
  root,
  operationId,
  target,
  executorSha,
  document,
  backup,
  restoreEvidence,
  roleMapping,
  writerFence,
  cmd,
  run,
  executable,
  endpoint,
  imageId,
  owned,
  source,
  fixture,
  appPassword,
  migratorPassword,
  label,
}) {
  assert.match(endpoint, /^unix:\/\/\//u);
  assert.equal(document.provenance, "local-synthetic");
  const identity = { ...hostIdentity(), operationId, target, executorSha };
  const env = hostEnv(identity.admission.manifest, root);
  const pg = join(root, "pg");
  await mkdir(pg, { mode: 0o700 });
  for (const name of ["ca.crt", "server.crt", "server.key", "password"])
    await writeFile(join(pg, name), await readFile(join(fixture, name)), {
      mode: 0o600,
      flag: "wx",
    });
  env.MARKIRO_POSTGRES_IMAGE_DIGEST = imageId;
  const url = new URL("postgresql://db.private/markiro?sslmode=verify-full");
  url.username = "markiro_app";
  url.password = appPassword;
  env.DATABASE_URL = url.href;
  const candidateId = randomUUID(),
    envFile = join(root, "candidate-source.env");
  await writeFile(envFile, envBytes(env), { mode: 0o600, flag: "wx" });
  const runtimeSnapshot = await snapshotHostConfig({
    root,
    candidateId,
    envFile,
    manifest: identity.admission.manifest,
  });
  url.username = "markiro_migrator";
  url.password = migratorPassword;
  const migrationFile = join(root, "migration-source.env");
  await writeFile(migrationFile, `DATABASE_URL=${url.href}\n`, { mode: 0o600, flag: "wx" });
  const migrationSnapshot = await snapshotMigrationConfig({
    root,
    candidateId,
    envFile: migrationFile,
    runtimeSnapshot,
  });
  const configuration = { candidateId, runtimeSnapshot, migrationSnapshot };
  identity.configurationSha256 = (
    await fingerprintHostConfiguration({ root, ...configuration })
  ).configurationSha256;
  const evidence = JSON.parse(await readFile(restoreEvidence.evidencePath));
  const inspected = JSON.parse((await cmd(["inspect", source])).stdout)[0];
  assert.equal(inspected.Image, imageId);
  const image = JSON.parse((await cmd(["image", "inspect", imageId])).stdout)[0];
  const ids = String((await cmd(["exec", source, "id", "-u"])).stdout).trim();
  const gids = String((await cmd(["exec", source, "id", "-g"])).stdout).trim();
  const postgres = {
    image: imageId,
    architecture: image.Architecture,
    os: image.Os,
    uid: Number(ids),
    gid: Number(gids),
  };
  assert.equal(postgres.uid, 999);
  assert.equal(postgres.gid, 999);
  const cert = new X509Certificate(await readFile(join(fixture, "server.crt")));
  assert.equal(cert.checkHost("db.private"), "db.private");
  const tls = { certificateSha256: digest(cert.raw), san: "db.private" };
  const rolePolicySha256 = digest(
    await readFile(new URL("../postgres/roles.mjs", import.meta.url)),
  );
  const producerId = "markiro-local-prepared-ci";
  const attestation = {
    approved: true,
    actor: "synthetic-ci-only",
    reference: "local-fixture-not-operational-acceptance",
  };
  const values = {
    postgres: { ...postgres, postgresVersion: evidence.runtime.postgresVersion },
    tls: {
      ...tls,
      notBefore: new Date(cert.validFrom).toISOString(),
      expiresAt: new Date(cert.validTo).toISOString(),
    },
    rolePolicy: {
      policySha256: rolePolicySha256,
      configurationSha256: identity.configurationSha256,
    },
    restoredSnapshot: {
      snapshotId: document.snapshotId,
      archiveSha256: backup.archiveSha256,
      inventorySha256: backup.inventorySha256,
      restoreEvidenceSha256: restoreEvidence.evidenceSha256,
      roleMappingSha256: evidence.roleMappingSha256,
      restoredInventorySha256: evidence.restoredInventorySha256,
      workerImage: evidence.runtime.image,
      workerArchitecture: evidence.runtime.architecture,
    },
    egress: {
      ...attestation,
      networkPolicySha256: digest({ network: "none", operationId }),
      smtp: "blocked",
      s3: "blocked",
      retainedMail: "held",
      reportJobs: "held",
      legacyQueues: "disabled",
      retention: "disabled",
    },
    keyContinuity: {
      ...attestation,
      keyManifestSha256: digest("synthetic-no-production-keys"),
      decryptionVerified: true,
      signingContinuityVerified: true,
    },
    offHostRecovery: {
      ...attestation,
      archiveSha256: backup.archiveSha256,
      recoveryTestReference: "synthetic-no-offhost-recovery",
      independentKeyAvailable: true,
    },
  };
  const record = {
    version: 1,
    kind: "platform-prepared-target",
    operationId,
    target,
    executorSha,
    provenance: "local-synthetic",
    configurationSha256: identity.configurationSha256,
    fence: Object.fromEntries(
      ["fenceId", "enforcementSha256", "beganAt"].map((k) => [k, document.fence.before[k]]),
    ),
    observations: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          kind: ["egress", "keyContinuity", "offHostRecovery"].includes(key)
            ? "operator-attestation"
            : "measured",
          producerId,
          executorSha,
          operationId,
          target,
          fenceId: document.fence.before.fenceId,
          configurationSha256: identity.configurationSha256,
          snapshotId: document.snapshotId,
          observedAt: new Date().toISOString(),
          value,
        },
      ]),
    ),
  };
  const name = `markiro-backup-ci-${operationId}-migration`;
  owned.push(["container", name]);
  await cmd([
    "create",
    "--name",
    name,
    "--label",
    label,
    "--label",
    `markiro.migration-operation=${operationId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/var/lib/postgresql/data",
    imageId,
    "sleep",
    "infinity",
  ]);
  const initial = JSON.parse((await cmd(["inspect", name])).stdout)[0];
  const containerId = initial.Id;
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  async function inspectOwned() {
    const actual = JSON.parse((await cmd(["inspect", containerId])).stdout)[0];
    assert.equal(actual.Id, containerId);
    assert.equal(actual.Name.replace(/^\//u, ""), name);
    assert.equal(actual.Config.Labels["markiro.migration-operation"], operationId);
    assert.equal(actual.Config.Labels["markiro.backup-fixture"], operationId);
    assert.equal(actual.Image, imageId);
    assert.equal(actual.HostConfig.NetworkMode, "none");
    assert.deepEqual(actual.HostConfig.PortBindings ?? {}, {});
    return {
      version: 1,
      kind: "platform-owned-workload",
      operationId,
      target,
      producerId,
      executorSha,
      observedAt: new Date().toISOString(),
      containerId,
      name,
      ownerOperationId: actual.Config.Labels["markiro.migration-operation"],
      status: actual.State.Status,
    };
  }
  const expected = {
    root,
    identity,
    configuration,
    backup,
    restoreEvidence,
    roleMapping,
    postgres,
    tls,
    rolePolicySha256,
    provenance: "local-synthetic",
    maxAgeMs: 3600000,
    producers: Object.fromEntries(Object.keys(values).map((k) => [k, producerId])),
    writerFence: {
      producerId,
      executorSha,
      observe: async (request) => ({
        ...(await writerFence.observe(request)),
        producerId,
        executorSha,
      }),
    },
    workload: { identity: { containerId, name }, producerId, executorSha, inspect: inspectOwned },
  };
  await cmd(["start", containerId]);
  let cliTerminationConfirmed = false;
  await assert.rejects(
    run({
      executable,
      args: ["--host", endpoint, "wait", containerId],
      cwd: root,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        DOCKER_CONFIG: join(root, "docker"),
      },
      timeoutMs: 300,
      outputLimitBytes: 65536,
    }),
    (error) => {
      assert.equal(error.reason, "timeout");
      assert.equal(error.terminationConfirmed, true);
      cliTerminationConfirmed = true;
      return true;
    },
  );
  assert.equal((await inspectOwned()).status, "running");
  await withHostState(root, async (store) => {
    await store.begin(identity);
    await store.complete("admitted");
    for (const phase of ["images-verified", "target-stopped"]) {
      await store.enter(phase);
      await store.complete(phase);
    }
    await store.enter("backup-verified");
    const before = await store.read();
    for (const action of ["backup-verified", "migrating", "api-started", "recovery"]) {
      await assert.rejects(async () => {
        const result = await validatePreparedTarget(record, expected);
        if (action === "backup-verified") await store.complete(action, result.backupProof);
        else await store.enter(action);
      });
      assert.deepEqual(await store.read(), before);
    }
    await inspectOwned();
    await cmd(["stop", "--time", "1", containerId]);
    assert.equal((await inspectOwned()).status, "exited");
    const held = expected.writerFence.observe;
    expected.writerFence.observe = async (request) => ({ ...(await held(request)), held: false });
    await assert.rejects(validatePreparedTarget(record, expected));
    assert.deepEqual(await store.read(), before);
    expected.writerFence.observe = held;
    const result = await validatePreparedTarget(record, expected);
    await store.complete("backup-verified", result.backupProof);
    await validatePreparedTarget(record, expected);
    await store.enter("migrating");
    // A timeout in an entered migration is terminal in this journal. A stopped
    // workload is necessary for investigation, never authority to clear failure.
    await store.fail();
    await validatePreparedTarget(record, expected);
    await assert.rejects(store.complete("migrating"));
    await assert.rejects(store.enter("api-started"));
    await assert.rejects(store.begin(identity));
    assert.equal((await store.read()).current.status, "recovery-required");
  });
  // The actual restore producer has already removed all four temporary resources.
  // Validate v2 absence against the completed byte-verified cleanup inventory.
  expected.workload = createCleanupObserver(identity, evidence.cleanup.resources, cmd);
  await validatePreparedTarget(record, expected);
  return {
    restoreCleanupAbsenceVerified: true,
    kind: "local-synthetic-prepared-target-timeout",
    executorSha,
    image: imageId,
    architecture: image.Architecture,
    cliTerminationConfirmed,
    workloadRemainedActive: true,
    ownedStopInspected: true,
    releasedFenceRejected: true,
    terminalRecoveryPreserved: true,
    acceptance: "synthetic-only-no-live-key-egress-offhost-acceptance",
  };
}
