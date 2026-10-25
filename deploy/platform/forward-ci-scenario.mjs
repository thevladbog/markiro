/** Fixed synthetic scenario constructors, callable only by local rehearsal code. */
import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { digest } from "./backup/schemas.mjs";
import { validateWorkerManifest, recoveryRoleMapping } from "./recovery-ci-helpers.mjs";
import { hashArchive } from "./backup/files.mjs";
import { UPGRADE_BUNDLE_FILES } from "./host/upgrade-command.mjs";
import { extractProductMigrationProof } from "./host/forward-product.mjs";
import { observeForwardMigrationLedger } from "./host/forward-ledger.mjs";
import { withUpgradePhaseState } from "./host/upgrade-state.mjs";
import { forwardFixture, forwardDecision } from "./test/forward-fixture.mjs";
import { readFailedUpgradePredecessor } from "./host/forward-admission.mjs";
import {
  createForwardObservers,
  createForwardBaselineVerifier,
} from "./host/forward-observation.mjs";
import { executeForwardPreparation } from "./host/forward-preparation.mjs";
import { executeForwardActivation } from "./host/forward-activation.mjs";
import { createForwardActivationAdapters } from "./host/forward-activation-adapters.mjs";
import { captureForwardRetained } from "./host/forward-retained.mjs";
import { withHeldForwardState } from "./host/forward-state.mjs";
import { createHeldForwardBackup } from "./host/target-backup.mjs";
import { readVerifiedBackup } from "./host/backup-gate.mjs";
import { observerProducer } from "./host/observe.mjs";
import { measureActivationProjection } from "./host/command.mjs";
import { productionAuthorization } from "./test/production-activation-fixture.mjs";
import { stageRehearsalTree } from "./upgrade-ci.mjs";
export const forwardProduct = "6e32b3bf5970ed8793293bcc7e80aef342836e53";
const images = Object.freeze({
  api: {
    reference:
      "ghcr.io/thevladbog/markiro-api@sha256:ea87a7237c0753c067d7b8f115857d88c2b36fefa7c041c7029c182a41ae8629",
    id: "sha256:8ec59901e3ffca497555df96dff65e5262d3e70ca8056a14c86fb557253d1d4f",
  },
  edge: {
    reference:
      "ghcr.io/thevladbog/markiro-platform-edge@sha256:aa50359218764bfb534bf77937038eaea7c220ebea3655007391f7a6bd946efa",
    id: "sha256:ed5c7f000b8068906756749d4f0f62237117a75dc8b76a7aef068d3d943a8ad2",
  },
});
const put = async (path, value, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    Buffer.isBuffer(value)
      ? value
      : typeof value === "string"
        ? value
        : `${JSON.stringify(value)}\n`,
    { mode, flag: "wx" },
  );
};
async function stage(context) {
  const {
    parent,
    root,
    repository,
    command,
    nested,
    outer,
    containerId,
    shell,
    stdinOuter,
    inspect,
  } = context;
  assert.ok(
    process.env.RUNNER_TEMP && process.env.GITHUB_SHA,
    "Exact current ICU worker export is required",
  );
  const sha = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(sha, process.env.GITHUB_SHA);
  const exportRoot = join(process.env.RUNNER_TEMP, "platform-recovery-image-icu");
  const manifest = validateWorkerManifest(
    JSON.parse(await readFile(join(exportRoot, "recovery-image.json"))),
    sha,
  );
  const expected = (
    await command("git", [
      "ls-tree",
      "-r",
      "--name-only",
      sha,
      "--",
      "deploy/platform/backup",
      "deploy/platform/host",
      "deploy/platform/postgres",
      "packages/db/migrations",
      "packages/db/src/runtime-migrate.ts",
    ])
  ).stdout
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(manifest.sources.files.map((file) => file.path).sort(), expected);
  for (const file of manifest.sources.files) {
    assert.match(file.path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u);
    assert.equal(
      file.path.split("/").some((part) => part === ".." || part === "."),
      false,
    );
    const bytes = await readFile(join(repository, file.path));
    assert.equal(digest(bytes), file.sha256);
    assert.deepEqual(
      bytes,
      (await command("git", ["show", `${sha}:${file.path}`], { encoding: "buffer" })).stdout,
    );
  }
  assert.equal(manifest.sources.generated.path, "packages/db/dist/runtime-migrate.js");
  assert.equal(
    digest(await readFile(join(repository, manifest.sources.generated.path))),
    manifest.sources.generated.sha256,
  );
  const archive = await hashArchive(exportRoot, join(exportRoot, "recovery-image.tar"));
  assert.equal(archive.sha256, manifest.archive.sha256);
  assert.equal(archive.bytes, manifest.archive.bytes);
  await outer(
    ["cp", join(exportRoot, "recovery-image.tar"), `${containerId}:/tmp/forward-worker.tar`],
    { timeout: 900000 },
  );
  await nested(["load", "--input", "/tmp/forward-worker.tar"], { timeout: 900000 });
  const worker = await inspect("image", manifest.image.id);
  assert.equal(worker.Id, manifest.image.id);
  assert.equal(worker.Os, "linux");
  assert.equal(worker.Architecture, "amd64");
  assert.equal(worker.Config.User, "postgres");
  for (const selected of Object.values(images)) {
    await nested(["pull", "--platform", "linux/amd64", selected.reference], { timeout: 900000 });
    const actual = await inspect("image", selected.reference);
    assert.equal(actual.Id, selected.id);
    assert.equal(actual.Os, "linux");
    assert.equal(actual.Architecture, "amd64");
    assert.ok(actual.RepoDigests.includes(selected.reference));
  }
  // Only declared source bytes enter the nested namespace, never host bind mounts.
  const current = join(parent, "current-sources");
  await mkdir(current, { mode: 0o700 });
  for (const path of UPGRADE_BUNDLE_FILES)
    await put(
      join(current, path),
      await readFile(join(repository, path)),
      path.endsWith("pg_hba.conf") ? 0o644 : 0o600,
    );
  await shell(["mkdir", "-p", repository]);
  const tar = (await command("tar", ["-C", current, "-cf", "-", "."], { encoding: "buffer" }))
    .stdout;
  await stdinOuter(
    ["exec", "-i", containerId, "tar", "--no-same-owner", "-xpf", "-", "-C", repository],
    tar,
  );
  for (const path of UPGRADE_BUNDLE_FILES) {
    const actual = (await shell(["sha256sum", join(repository, path)])).stdout;
    assert.equal(actual.slice(0, 64), digest(await readFile(join(repository, path))));
  }
  return {
    workerImage: manifest.image.id,
    sourceSha: sha,
    root,
    sourceFiles: Object.fromEntries(
      await Promise.all(
        UPGRADE_BUNDLE_FILES.map(async (path) => [
          path,
          digest(await readFile(join(repository, path))),
        ]),
      ),
    ),
  };
}
export function createForwardScenario(mode) {
  assert.ok(["healthy", "replacement-failure"].includes(mode));
  const checks = {};
  return {
    kind: "synthetic-forward",
    checks,
    stage,
    values: () => ({
      MARKIRO_API_IMAGE_DIGEST: images.api.reference.split("@")[1],
      MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: images.edge.reference.split("@")[1],
      MARKIRO_SOURCE_SHA: forwardProduct,
      MARKIRO_TOOLING_SHA: forwardProduct,
    }),
    candidate: async (candidate) => {
      candidate.executorSha = "c".repeat(40); // synthetic failed predecessor executor, never production authorization
      const admission = candidate.admission;
      const old = admission.manifest.sourceSha;
      admission.manifest.sourceSha = forwardProduct;
      admission.manifest.toolingSha = forwardProduct;
      admission.verified.sourceSha = forwardProduct;
      admission.verified.toolingSha = forwardProduct;
      for (const service of ["api", "edge"]) {
        const selected = images[service];
        admission.manifest[service] = selected.reference;
        admission.registry[service] = {
          reference: selected.reference,
          imageId: selected.id,
          platform: "linux/amd64",
        };
        admission.verified.images[service].id = selected.id;
        admission.verified.images[service].tag = admission.verified.images[service].tag.replace(
          old,
          forwardProduct,
        );
      }
    },
    run: async (c) => runScenario(c, mode, checks),
  };
}
function runtimeInterpolation(configuration, values) {
  const names = [
    "MARKIRO_API_IMAGE_DIGEST",
    "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
    "MARKIRO_SAAS_ADMIN_DOMAIN",
    "MARKIRO_LANDING_DOMAIN",
    "MARKIRO_RETIRED_ADMIN_DOMAIN",
    "MARKIRO_RETIRED_KIOSK_DOMAIN",
    "MARKIRO_RELEASES_DOMAIN",
    "MARKIRO_RELEASES_BUCKET",
    "MARKIRO_SOURCE_SHA",
    "S3_PUBLIC_ORIGIN",
    "ACME_EMAIL",
    "MARKIRO_POSTGRES_IMAGE_DIGEST",
    "MARKIRO_POSTGRES_CA_FILE",
    "MARKIRO_POSTGRES_SERVER_CERT_FILE",
    "MARKIRO_POSTGRES_SERVER_KEY_FILE",
    "MARKIRO_POSTGRES_PASSWORD_FILE",
  ];
  configuration.runtimeSnapshot.interpolation = {
    ...Object.fromEntries(names.map((name) => [name, values[name]])),
    MARKIRO_PLATFORM_ENV_FILE: configuration.runtimeSnapshot.path,
  };
}
export function createForwardRehearsalProcess(c, trace = []) {
  const privatePath = (path) => {
    assert.equal(typeof path, "string");
    assert.ok(path.startsWith(`${c.root}/`));
    assert.ok(!path.split("/").includes(".."));
    return path;
  };
  const copyInput = async (path) => {
    const source = path.replace(/\/\.$/u, "");
    privatePath(source);
    const stat = await lstat(source);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, process.getuid());
    if (stat.isDirectory()) {
      await c.shell(["mkdir", "-p", source]);
      await stageRehearsalTree(source, {
        archive: async (directory) =>
          (await c.command("tar", ["-C", directory, "-cf", "-", "."], { encoding: "buffer" }))
            .stdout,
        extract: (bytes) =>
          c.stdinOuter(
            ["exec", "-i", c.containerId, "tar", "--no-same-owner", "-xpf", "-", "-C", source],
            bytes,
          ),
        inspectFile: async (relative) => {
          const p = join(source, relative);
          const sha = (await c.shell(["sha256sum", p])).stdout.slice(0, 64);
          const [mode, size] = (await c.shell(["stat", "-c", "%a:%s", p])).stdout.trim().split(":");
          return { sha256: sha, mode: Number.parseInt(mode, 8), size: Number(size) };
        },
      });
    } else {
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
      await c.shell(["mkdir", "-p", dirname(source)]);
      await c.outer(["cp", source, `${c.containerId}:${source}`]);
    }
  };
  return async (request, recheck) => {
    await c.verifyIsolation();
    for (const [path, sha] of Object.entries(c.forwardStage?.sourceFiles ?? {}))
      assert.equal(digest(await readFile(join(c.repository, path))), sha);
    assert.equal(request.executable, "/usr/bin/docker");
    assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    const args = request.args.slice(2);
    assert.equal(request.env.DOCKER_CONFIG, join(c.root, "docker"));
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "NODE_OPTIONS", "NODE_PATH"])
      assert.equal(request.env[key], undefined);
    assert.equal(
      args.some((a) => ["--privileged", "--pid", "--ipc", "--publish", "-p"].includes(a)),
      false,
    );
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--network")
        assert.ok(
          ["none", "markiro-platform_database", c.policy?.networks.database.id].includes(
            args[i + 1],
          ),
        );
      if (args[i] !== "--mount") continue;
      const parts = Object.fromEntries(
        args[i + 1].split(",").map((part) => {
          const n = part.indexOf("=");
          return [n === -1 ? part : part.slice(0, n), n === -1 ? true : part.slice(n + 1)];
        }),
      );
      if (parts.type !== "bind") continue;
      const source = parts.source ?? parts.src;
      const worker = join(c.parent, "current-sources", "deploy/platform/host/probe-worker.mjs");
      assert.ok(
        source === worker || (typeof source === "string" && source.startsWith(`${c.root}/`)),
      );
      assert.equal(
        source.split("/").some((part) => part === ".."),
        false,
      );
      if (source !== worker) await copyInput(source);
      else
        assert.equal(
          digest(await readFile(source)),
          digest(await readFile(new URL("./host/probe-worker.mjs", import.meta.url))),
        );
      const st = await lstat(source);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
      await c.shell(["chown", `${st.uid}:${st.gid}`, source]);
    }
    trace.push([...args]);
    // Never pass generated credential values in an OS argv. Docker reads this
    // private local env-file and conveys the fixed child environment directly.
    const envFile = join(c.parent, `forward-child-env-${randomUUID()}`);
    await put(
      envFile,
      Object.entries(request.env)
        .map(([key, value]) => {
          assert.match(key, /^[A-Z_][A-Z0-9_]*$/u);
          assert.equal(/[\r\n\0]/u.test(value), false);
          return `${key}=${value}\n`;
        })
        .join(""),
    );
    if (args[0] === "cp" && args[2] !== "-" && !args[1].includes(":")) {
      if (args[1] === join(c.repository, "deploy/platform/host/probe-worker.mjs")) {
        assert.equal(
          digest(await readFile(args[1])),
          digest(await readFile(new URL("./host/probe-worker.mjs", import.meta.url))),
        );
      } else await copyInput(args[1]);
    }
    if (args[0] === "cp" && args[2] !== "-" && args[1].includes(":")) {
      const dest = privatePath(args[2]);
      const st = await lstat(dest).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (st) {
        assert.equal(st.isDirectory(), true);
        assert.equal((await readdir(dest)).length, 0);
        await c.shell(["mkdir", "-p", dest]);
      } else await c.shell(["mkdir", "-p", dirname(dest)]);
    }
    let output;
    const invocation = [
      "exec",
      ...(request.input ? ["-i"] : []),
      "--env-file",
      envFile,
      c.containerId,
      "docker",
      ...request.args,
    ];
    recheck?.();
    if (request.outputLimitBytes > 1048576) {
      assert.equal(request.outputLimitBytes, 16 * 1024 * 1024);
      assert.equal(args[0], "cp");
      assert.equal(args[2], "-");
      output = await c.outer(invocation, {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: request.timeoutMs,
      });
    } else
      output = await c.stdinOuter(invocation, request.input ?? Buffer.alloc(0), request.timeoutMs);
    if (args[0] === "cp" && args[2] !== "-" && args[1].includes(":")) {
      const dest = privatePath(args[2]);
      const st = await lstat(dest).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (st) {
        assert.equal(st.isDirectory(), true);
        assert.equal((await readdir(dest)).length, 0);
      }
      await c.outer(["cp", `${c.containerId}:${dest}${st ? "/." : ""}`, dest], { timeout: 120000 });
    }
    await c.verifyIsolation();
    return output;
  };
}
async function runScenario(c, mode, checks) {
  const {
    root,
    parent,
    repository,
    candidateOperation,
    candidate,
    identity,
    f,
    predecessorContainers,
    policy,
    oldOperation,
  } = c;
  const trace = [],
    runProcess = createForwardRehearsalProcess(c, trace);
  await put(
    join(parent, "forward-retained-containers.json"),
    await Promise.all(Object.values(predecessorContainers).map((id) => c.inspect("container", id))),
  );
  const candidateValues = {
    ...c.values,
    MARKIRO_RELEASES_DOMAIN: "releases.localhost",
    MARKIRO_RELEASES_BUCKET: "synthetic-releases",
    ...createForwardScenario(mode).values(),
  };
  runtimeInterpolation(candidateOperation.configuration, candidateValues);
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    DOCKER_CONFIG: join(root, "docker"),
    COMPOSE_DISABLE_ENV_FILE: "1",
    ...candidateOperation.configuration.runtimeSnapshot.interpolation,
    MARKIRO_PLATFORM_MIGRATION_ENV_FILE: candidateOperation.configuration.migrationSnapshot.path,
  };
  const composeFiles = [
    join(repository, "deploy/platform/compose.yml"),
    join(repository, "deploy/platform/compose.compact.yml"),
  ];
  const journal = join(root, "upgrade-operations", candidate.operationId, "state.json");
  const beforeBytes = await readFile(journal),
    before = JSON.parse(beforeBytes);
  const failedDecision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase: "activate",
    identity: candidate,
    prior: { sequence: 6, sha256: digest(beforeBytes) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { toolingSha: candidate.executorSha, runId: "987654333", runAttempt: "1" },
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  };
  const authorization = {
    actorId: "11",
    actorLogin: "synthetic-actor",
    reviewerId: "12",
    reviewerLogin: "synthetic-reviewer",
    environmentId: "44",
  };
  const base = {
    version: 1,
    kind: "platform-upgrade-host-operation",
    installedRoot: join(parent, "upgrade-bootstrap", candidate.executorSha),
    authorization,
    observationPolicy: policy,
  };
  const operation = {
    root,
    dockerConfig: join(root, "docker"),
    admission: f.input,
    configuration: candidateOperation.configuration,
    predecessorContainers,
  };
  for (const phase of ["prepare", "activate"])
    await put(join(parent, "upgrade-operations", candidate.operationId, phase, "operation.json"), {
      ...base,
      phase,
      dispatch: phase === "prepare" ? f.input.dispatch : failedDecision.dispatch,
      operation: {
        ...operation,
        ...(phase === "prepare"
          ? {
              connectionFile: join(root, "historical-connection.json"),
              roleMapping: { version: 1, roles: [], allowedDeltas: [] },
            }
          : {
              decision: failedDecision,
              preparedTarget: {
                version: 2,
                provenance: "live-source",
                operationId: candidate.operationId,
                executorSha: candidate.executorSha,
                configurationSha256: candidate.configurationSha256,
                target: candidate.target,
                fence: before.preparation.fence,
              },
              preparedPolicy: { provenance: "live-source" },
            }),
      },
    });
  c.progress("apply candidate migrations once, then fail canonically before API-up");
  let migrations = 0;
  await assert.rejects(
    withUpgradePhaseState(root, failedDecision, async (store) => {
      await store.complete("activation-admitted");
      await store.enter("migration-entered");
      migrations++;
      await runProcess({
        executable: "/usr/bin/docker",
        args: [
          "--host",
          "unix:///var/run/docker.sock",
          "compose",
          "--project-name",
          "markiro-platform",
          ...composeFiles.flatMap((file) => ["--file", file]),
          "run",
          "--rm",
          "--no-deps",
          "migrate",
        ],
        cwd: root,
        env,
        timeoutMs: 300000,
        outputLimitBytes: 65536,
      });
      await store.complete("migration-entered");
      await store.enter("migrated");
      await store.complete("migrated");
      await store.enter("api-started");
      throw Error("synthetic failure after actual migrations before API-up");
    }),
  );
  const failedState = JSON.parse(await readFile(journal));
  assert.equal(failedState.sequence, 14);
  assert.equal(failedState.migrationEntered, true);
  assert.equal(failedState.phase, "api-started");
  assert.equal(failedState.status, "recovery-required");
  const forwardIdentity = {
    ...structuredClone(candidate),
    operationId: randomUUID(),
    executorSha: c.forwardStage.sourceSha,
  };
  const proof = await extractProductMigrationProof({
    root,
    identity: forwardIdentity,
    verifySources: c.deps.verifySources,
    runProcess,
  });
  const ledger = await observeForwardMigrationLedger({
    postgresId: predecessorContainers.postgres,
    proof,
    root,
    runProcess,
  });
  const built = forwardFixture({
    root,
    upgrade: f,
    newIdentity: forwardIdentity,
    retainedIds: predecessorContainers,
    failedConfiguration: candidateOperation.configuration,
    candidateConfigurationSha256: candidate.configurationSha256,
  });
  const admission = built.input;
  admission.failed.hashes = Object.fromEntries(
    Object.entries(await readFailedUpgradePredecessor(root, candidate.operationId)).map(
      ([key, bytes]) => [key, digest(bytes)],
    ),
  );
  admission.baseline = {
    containers: predecessorContainers,
    schema: ledger.schema,
    productMigrationProofSha256: proof.proofSha256,
  };
  admission.expiresAt = new Date(Date.now() + 3600000).toISOString();
  const forwardOperation = { ...candidateOperation, identity: forwardIdentity };
  const descriptors = [
    ["backup-runtime.json", JSON.parse(f.predecessorBytes.original).current.identity.executorSha],
    [`recovery-backup-runtime-${identity.operationId}.json`, identity.executorSha],
    [`upgrade-backup-runtime-${candidate.operationId}.json`, candidate.executorSha],
    [`forward-backup-runtime-${forwardIdentity.operationId}.json`, forwardIdentity.executorSha],
  ];
  for (const [name, executorSha] of descriptors)
    await put(join(root, name), {
      version: 1,
      executorSha,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///var/run/docker.sock",
      image: c.forwardStage.workerImage,
      provenance: "live-source",
    });
  const historical = new Map();
  for (const name of [
    "state.json",
    "recovery-state.json",
    "recovery-preparation.json",
    `recovery-activation-${identity.operationId}.json`,
    `upgrade-operations/${candidate.operationId}/state.json`,
  ])
    historical.set(name, await readFile(join(root, name)));
  const roles = JSON.parse(
    (
      await c.sql(
        "SELECT json_agg(row_to_json(r)) FROM (SELECT rolname AS name,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname !~ '^pg_') r;",
      )
    ).stdout,
  );
  const roleMapping = recoveryRoleMapping({ roles, objects: [] });
  await put(
    join(root, "forward-service.conf"),
    "[backup]\nhost=db.private\nport=5432\ndbname=markiro\nuser=postgres\nsslmode=verify-full\nsslrootcert=/input/ca.crt\n",
  );
  await put(join(root, "forward-pass"), `db.private:5432:markiro:postgres:${c.password}\n`);
  const connectionFile = join(root, "forward-connection.json");
  await put(connectionFile, {
    version: 1,
    kind: "platform-backup-connection",
    operationId: forwardIdentity.operationId,
    target: forwardIdentity.target,
    service: "backup",
    serviceFile: join(root, "forward-service.conf"),
    passFile: join(root, "forward-pass"),
    caFile: join(root, "pg/ca.crt"),
    network: policy.networks.database.name,
  });
  const hbaSha256 = digest(await readFile(join(parent, "postgres/pg_hba.conf")));
  const deps = { ...c.deps, runProcess, hbaSha256 };
  const authority = {
    oldOperation,
    candidateOperation: forwardOperation,
    retainedIds: predecessorContainers,
    baseline: admission.baseline,
    productMigrationProof: proof,
    policy,
  };
  const observers = createForwardObservers(authority, deps),
    verifyBaseline = createForwardBaselineVerifier(authority, deps);
  const options = { productMigrationProof: proof, verifyBaseline };
  const prepareDirectory = join(
    parent,
    "upgrade-operations",
    forwardIdentity.operationId,
    "post-migration-prepare",
  );
  await mkdir(prepareDirectory, { recursive: true, mode: 0o700 });
  let backupResult;
  c.progress(
    "forward preparation performs actual source dump, isolated restore, cleanup and Linux index handoff",
  );
  await executeForwardPreparation(
    { root, admission, configuration: forwardOperation.configuration },
    {
      verifyAdmission: (_context, cap) =>
        withHeldForwardState(cap, async (held) => {
          await held.verify();
          await captureForwardRetained(
            { root, admission, postgresImageId: policy.postgresImageId, runProcess },
            cap,
          );
          return forwardIdentity;
        }),
      inspectSource: (_context, cap) => observers.inspectSource(cap),
      inspectSchema: (_context, cap) => observers.inspectSchema(cap),
      createBackup: async (_context, cap) => {
        backupResult = await createHeldForwardBackup(
          {
            operation: forwardOperation,
            observationPolicy: policy,
            hbaPath: join(parent, "postgres/pg_hba.conf"),
            hbaSha256,
            connectionFile,
            roleMapping,
            verifySources: c.deps.verifySources,
          },
          cap,
          admission,
          { ...deps, productMigrationProof: proof },
        );
        return {
          backup: backupResult.backup,
          restoreEvidence: backupResult.restoreEvidence,
          fence: backupResult.fence,
        };
      },
    },
    options,
  );
  assert.ok(backupResult);
  const verified = await readVerifiedBackup({
    root,
    identity: forwardIdentity,
    backup: backupResult.backup,
    restoreEvidence: backupResult.restoreEvidence,
  });
  assert.equal(verified.evidence.checks.length, 10);
  assert.equal(verified.evidence.cleanup.verified, true);
  const statePath = join(
      root,
      "forward-recovery-operations",
      forwardIdentity.operationId,
      "state.json",
    ),
    preparedState = JSON.parse(await readFile(statePath));
  assert.equal(preparedState.sequence, 6);
  assert.equal(preparedState.migrationEntered, true);
  const success = JSON.parse(
    await readFile(
      join(
        root,
        "forward-recovery-operations",
        forwardIdentity.operationId,
        "handoff-success.json",
      ),
    ),
  );
  assert.ok(success);
  for (const [path, bytes] of historical) assert.deepEqual(await readFile(join(root, path)), bytes);
  checks.migrationAppliedOnce = migrations === 1;
  checks.fullLedger = true;
  checks.realBackupRestore = true;
  checks.linuxHandoff = true;
  const decision = forwardDecision({ input: admission }, preparedState);
  decision.expiresAt = new Date(Date.now() + 3600000).toISOString();
  const activationDirectory = join(
    parent,
    "upgrade-operations",
    forwardIdentity.operationId,
    "post-migration-activate",
  );
  await mkdir(activationDirectory, { recursive: true, mode: 0o700 });
  const { preparedTarget, preparedPolicy } = await activationInputs(
    c,
    forwardIdentity,
    forwardOperation.configuration,
    verified,
    backupResult,
    roleMapping,
    runProcess,
  );
  const loaded = {
    operationDirectory: activationDirectory,
    receipt: {
      files: {
        "deploy/platform/postgres/pg_hba.conf": hbaSha256,
        "deploy/platform/postgres/roles.mjs": preparedPolicy.rolePolicySha256,
      },
    },
    record: {
      installedRoot: join(parent, "current-sources"),
      operation: {
        root,
        dockerConfig: join(root, "docker"),
        admission,
        decision,
        configuration: forwardOperation.configuration,
        predecessorContainers,
        preparedTarget,
        preparedPolicy,
      },
      observationPolicy: policy,
    },
    verifySources: c.deps.verifySources,
  };
  const adapters = createForwardActivationAdapters(
    loaded,
    oldOperation,
    async (held) => {
      await held.verify();
      return forwardIdentity;
    },
    verified,
    { ...deps },
  );
  // A fault belongs only to this disposable namespace; no production envelope
  // accepts it. It fires after normal Compose replacement and actual health.
  let replacedApi;
  const start = async (request, recheck) => {
    const result = await runProcess(request, recheck);
    if (request.args.includes("up") && request.args.at(-1) === "api") {
      replacedApi = (await c.inspect("container", "markiro-platform-api-1")).Id;
      assert.notEqual(replacedApi, predecessorContainers.api);
      if (mode === "replacement-failure")
        throw Object.assign(Error("synthetic post-replacement failure"), {
          terminationConfirmed: true,
        });
    }
    return result;
  };
  const smoke = async () => {
    await actualSmoke(c, forwardProduct);
    checks.externalTls = true;
  };
  c.progress(`forward activation ${mode}, never a second migrator or old-ID start`);
  const activate = () =>
    executeForwardActivation(
      {
        root,
        dockerConfig: join(root, "docker"),
        decision,
        configuration: forwardOperation.configuration,
        preparedTarget,
        preparedPolicy,
      },
      {
        ...adapters,
        runProcess: start,
        inspectCandidate: (_context, cap) => observers.inspectCandidate(cap),
        inspectSchema: (_context, cap) => observers.inspectSchema(cap),
        smoke: (_context, cap) =>
          withHeldForwardState(cap, async (held) => {
            await held.verify();
            await smoke();
            await held.verify();
          }),
      },
      options,
    );
  if (mode === "healthy") {
    await activate();
    const terminal = JSON.parse(await readFile(statePath));
    assert.equal(terminal.sequence, 14);
    assert.equal(terminal.phase, "healthy");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.migrationEntered, true);
    checks.forwardHealthy = true;
  } else {
    await assert.rejects(activate());
    assert.ok(replacedApi);
    const stopped = await c.inspect("container", replacedApi);
    assert.equal(stopped.State.Running, false);
    const terminal = JSON.parse(await readFile(statePath));
    assert.equal(terminal.status, "recovery-required");
    const diagnostic = JSON.parse(await readFile(join(activationDirectory, "failure.json")));
    assert.equal(diagnostic.operationId, forwardIdentity.operationId);
    assert.equal(diagnostic.phase, "api-started");
    assert.equal(Object.hasOwn(diagnostic, "stdout"), false);
    assert.equal(Object.hasOwn(diagnostic, "stderr"), false);
    assert.equal(JSON.stringify(diagnostic).includes("synthetic post-replacement failure"), false);
    checks.replacementFailureCleanup = true;
  }
  assert.equal(
    (await c.inspect("container", "markiro-platform-postgres-1")).Id,
    predecessorContainers.postgres,
  );
  const finalLedger = await observeForwardMigrationLedger({
    postgresId: predecessorContainers.postgres,
    proof,
    root,
    runProcess,
  });
  assert.deepEqual(finalLedger.schema, ledger.schema);
  for (const [path, bytes] of historical) assert.deepEqual(await readFile(join(root, path)), bytes);
  assert.equal(trace.filter((args) => args.includes("migrate") && args.includes("run")).length, 1);
  assert.equal(
    trace.some(
      (args) =>
        args[0] === "start" && Object.values(predecessorContainers).some((id) => args.includes(id)),
    ),
    false,
  );
  assert.equal(
    trace.some(
      (args) =>
        ["stop", "rm"].includes(args[1]) &&
        Object.values(predecessorContainers).some((id) => args.includes(id)),
    ),
    false,
  );
  c.evidence.forward = {
    mode,
    operationId: forwardIdentity.operationId,
    failedOperationId: candidate.operationId,
    productSha: forwardProduct,
    executorSha: forwardIdentity.executorSha,
    postgresId: predecessorContainers.postgres,
    schema: ledger.schema,
    productMigrationProofSha256: proof.proofSha256,
    archiveSha256: backupResult.backup.archiveSha256,
    restoreEvidenceSha256: backupResult.restoreEvidence.evidenceSha256,
    terminalSha256: digest(await readFile(statePath)),
    checks: { ...checks, noOldStarts: true, noSecondMigrator: true },
  };
  checks.noOldStarts = true;
  checks.noSecondMigrator = true;
}
async function activationInputs(
  c,
  identity,
  configuration,
  verified,
  result,
  roleMapping,
  runProcess,
) {
  const { document, evidence } = verified,
    at = new Date().toISOString();
  const certificate = new X509Certificate(await readFile(join(c.root, "pg/server.crt")));
  const postgres = {
    image: c.policy.postgresImageId,
    architecture: "amd64",
    os: "linux",
    uid: 70,
    gid: 70,
  };
  const tls = { certificateSha256: digest(certificate.raw), san: "db.private" };
  const rolePolicySha256 = digest(
    await readFile(join(c.repository, "deploy/platform/postgres/roles.mjs")),
  );
  const values = {
    postgres: { ...postgres, postgresVersion: (await c.sql("SHOW server_version;")).stdout.trim() },
    tls: {
      ...tls,
      notBefore: new Date(certificate.validFrom).toISOString(),
      expiresAt: new Date(certificate.validTo).toISOString(),
    },
    rolePolicy: {
      policySha256: rolePolicySha256,
      configurationSha256: identity.configurationSha256,
    },
    restoredSnapshot: {
      snapshotId: document.snapshotId,
      archiveSha256: result.backup.archiveSha256,
      inventorySha256: result.backup.inventorySha256,
      restoreEvidenceSha256: result.restoreEvidence.evidenceSha256,
      roleMappingSha256: evidence.roleMappingSha256,
      restoredInventorySha256: evidence.restoredInventorySha256,
      workerImage: evidence.runtime.image,
      workerArchitecture: evidence.runtime.architecture,
    },
    egress: null,
    // Syntax-only synthetic attestations for isolated generated data. No external
    // key custody, Mac/S3 export or production approval is claimed by this harness.
    keyContinuity: {
      approved: true,
      actor: "synthetic-ci",
      reference: "generated-test-keys-only",
      keyManifestSha256: digest("synthetic-generated-keys-only"),
      decryptionVerified: true,
      signingContinuityVerified: true,
    },
    offHostRecovery: {
      approved: true,
      actor: "synthetic-ci",
      reference: "isolated-test-only",
      archiveSha256: result.backup.archiveSha256,
      recoveryTestReference: "actual-isolated-restore-synthetic-data",
      independentKeyAvailable: true,
    },
  };
  const producers = Object.fromEntries(
    Object.keys(values).map((name) => [
      name,
      ["egress", "keyContinuity", "offHostRecovery"].includes(name)
        ? "synthetic-ci-attestations"
        : observerProducer,
    ]),
  );
  const preparedTarget = {
    version: 2,
    kind: "platform-prepared-target",
    operationId: identity.operationId,
    target: identity.target,
    executorSha: identity.executorSha,
    provenance: "live-source",
    configurationSha256: identity.configurationSha256,
    fence: result.fence,
    observations: {},
  };
  values.egress = productionAuthorization(
    preparedTarget,
    { document, backup: result.backup, restoreEvidence: result.restoreEvidence },
    Date.parse(at),
  );
  values.egress.review.projection = await measureActivationProjection(
    { root: c.root, dockerConfig: join(c.root, "docker") },
    c.predecessorContainers.postgres,
    values.egress.review.asOf,
    runProcess,
  );
  values.egress.reviewSha256 = digest(values.egress.review);
  for (const [name, value] of Object.entries(values))
    preparedTarget.observations[name] = {
      kind: ["egress", "keyContinuity", "offHostRecovery"].includes(name)
        ? "operator-attestation"
        : "measured",
      producerId: producers[name],
      executorSha: identity.executorSha,
      operationId: identity.operationId,
      target: identity.target,
      fenceId: result.fence.fenceId,
      configurationSha256: identity.configurationSha256,
      snapshotId: document.snapshotId,
      observedAt: at,
      value,
    };
  c.evidence.differences.push(
    "Forward v2 key/offhost/operator attestations are synthetic test inputs; actual dump/restore/TLS/ledger/physical checks use isolated generated data and do not authorize production",
  );
  return {
    preparedTarget,
    preparedPolicy: {
      backup: result.backup,
      restoreEvidence: result.restoreEvidence,
      roleMapping,
      postgres,
      tls,
      rolePolicySha256,
      provenance: "live-source",
      maxAgeMs: 3600000,
      producers,
    },
  };
}
async function actualSmoke(c, sourceSha) {
  const edge = await c.inspect("container", "markiro-platform-edge-1"),
    api = await c.inspect("container", "markiro-platform-api-1"),
    address = edge.NetworkSettings.Networks["markiro-platform_default"].IPAddress;
  for (const [host, path, status] of [
    ["landing.localhost", "/", 200],
    ["saas-admin.localhost", "/login", 200],
    ["saas-admin.localhost", "/api/platform/tenants", 401],
    ["saas-admin.localhost", "/station/sync", 404],
    ["admin.localhost", "/api/auth/get-session", 410],
    ["kiosk.localhost", "/kiosk/sync", 410],
  ]) {
    const result = JSON.parse(
      (
        await c.stdinNested(
          ["exec", "-i", api.Id, "node", "-e", c.tlsScript],
          JSON.stringify({ address, host, path, ca: c.ca }),
        )
      ).stdout,
    );
    assert.equal(result.status, status);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers["x-markiro-server-profile"], "platform-only");
    assert.equal(result.headers["x-markiro-release-sha"], sourceSha);
  }
}
