import assert from "node:assert/strict";
import test from "node:test";
import { executeConfigurationOperation } from "../host/dadata-host.mjs";

test("configuration executor rejects invalid admission before any child command", async () => {
  const calls = [];
  await assert.rejects(
    executeConfigurationOperation(
      { operationId: "../unsafe", planSha256: "secret" },
      {
        runProcess: async (command) => {
          calls.push(command);
          throw new Error("must not execute");
        },
      },
    ),
    (error) => !error.message.includes("secret"),
  );
  assert.equal(calls.length, 0);
});

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../backup/schemas.mjs";
import { privateFixture, envBytes } from "./host-fixtures.mjs";
import { containerRecipe } from "../host/container-recipe.mjs";
import { retainedCatalogWorkerFixture } from "./retained-catalog-worker-fixture.mjs";
import { noteHostProcessFailure } from "../host/failure-diagnostic.mjs";
import {
  captureConfigurationInvariants,
  configurationDockerCommand,
  assertConfigurationSuccessorCapacity,
} from "../host/dadata-host.mjs";

const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
const hash = (c) => c.repeat(64);
const auth = {
  actorId: "1",
  actorLogin: "actor",
  reviewerId: "2",
  reviewerLogin: "reviewer",
  environmentId: "3",
};
const clone = (v) => structuredClone(v);
function processFailure(reason = "exit", terminationConfirmed = true, exitStatus = 1) {
  const error = new Error("fixture-private-token");
  error.code = "ERR_HOST_PROCESS";
  error.reason = reason;
  error.terminationConfirmed = terminationConfirmed;
  return noteHostProcessFailure(error, "/usr/bin/docker", exitStatus);
}

function container(c, service = "api", { stopped = false } = {}) {
  const id = hash(c);
  return {
    Id: id,
    Name: `/markiro-platform-${service}-1`,
    Image: `sha256:${hash("d")}`,
    State: {
      Status: stopped ? "exited" : "running",
      Running: !stopped,
      Pid: stopped ? 0 : 42,
      ExitCode: 0,
      Health: { Status: "healthy" },
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
    },
    Config: {
      Hostname: id.slice(0, 12),
      Image: `ghcr.io/thevladbog/markiro-api@sha256:${hash("d")}`,
      Env: ["NODE_ENV=production"],
      Labels: {
        "com.docker.compose.project": "markiro-platform",
        "com.docker.compose.service": service,
        "com.docker.compose.config-hash": hash("a"),
      },
      Cmd: ["node", "dist/main.js"],
      User: "1000",
      WorkingDir: "/app",
    },
    HostConfig: {
      Mounts: [],
      NetworkMode: "markiro-platform_default",
      Memory: 1234,
      Privileged: false,
    },
    Mounts: [],
    NetworkSettings: {
      SandboxID: id,
      SandboxKey: `/var/run/docker/netns/${id.slice(0, 12)}`,
      Networks: {
        markiro: {
          NetworkID: hash("9"),
          Aliases: ["api"],
          Links: null,
          IPAMConfig: null,
          DriverOpts: null,
          IPAddress: "172.16.1.2",
          EndpointID: id,
        },
      },
    },
  };
}
const description = (c) => ({ id: c.Id, imageId: c.Image, recipeSha256: containerRecipe(c) });
async function fixture(t, options = {}) {
  const f = await privateFixture(t, { nested: true }),
    host = dirname(f.root),
    operationId = randomUUID(),
    acceptedOperationId = randomUUID();
  const root = join(f.root, "configuration-operations", operationId);
  await mkdir(join(f.root, "configuration-operations"), { mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const composeDir = join(host, "bundle/deploy/platform");
  for (const directory of [
    join(host, "bundle"),
    join(host, "bundle/deploy"),
    composeDir,
    join(f.root, "forward-recovery-operations"),
    join(f.root, "forward-recovery-operations", acceptedOperationId),
  ])
    await mkdir(directory, { mode: 0o700 });
  const before = container("1"),
    edge = container("2", "edge"),
    postgres = container("3", "postgres");
  const workerFixtures = [
    await retainedCatalogWorkerFixture(host, acceptedOperationId, "4", before.Image),
    await retainedCatalogWorkerFixture(host, acceptedOperationId, "5", before.Image),
  ];
  const workers = workerFixtures.map((f) => f.worker);
  for (const worker of workers)
    for (const mount of worker.Mounts) {
      const suffix = mount.Source.slice(host.length);
      mount.Source = `/opt/markiro-platform${suffix}`;
      mount.Destination = mount.Source;
    }
  before.Config.Env = Object.entries(f.env).map(([key, value]) => `${key}=${value}`);
  const baseline = {
    acceptedOperationId,
    api: description(before),
    runtime: { path: f.envFile, sha256: digest(await readFile(f.envFile)) },
  };
  const schemaProof = {
    systemId: "12",
    migrationCount: "202",
    schemaSha256: hash("b"),
    migrationSha256: hash("c"),
  };
  const invariants = { schemaProof, catalogSha256: hash("8"), journalSha256: hash("7") };
  const accepted = {
    sequence: 14,
    phase: "healthy",
    status: "completed",
    admission: { identity: { operationId: acceptedOperationId } },
  };
  const plan = {
    version: 1,
    kind: "platform-dadata-configuration",
    operationId,
    acceptedOperationId,
    executorSha: "f".repeat(40),
    executorCi: { runId: "123", runAttempt: "1" },
    previousOperationId: null,
    previousReceiptSha256: null,
    before: baseline,
    runtime: { path: join(root, "runtime.env"), sha256: "" },
    containers: { edge: description(edge), postgres: description(postgres) },
    workers: workers.map(description),
    compose: {
      directory: composeDir,
      files: [join(composeDir, "compose.yml"), join(composeDir, "compose.compact.yml")],
      migrationPath: join(f.root, "migration.env"),
      beforeConfigHash: hash("a"),
      afterConfigHash: hash("b"),
    },
    guards: [],
    schemaProof,
  };
  const files = new Map([
    [
      join(f.root, "state.json"),
      encode({ version: 1, sequence: 0, current: null, previousHealthy: null }),
    ],
    [
      join(f.root, "upgrade-index.json"),
      encode({
        version: 1,
        kind: "platform-forward-recovery-index",
        operationId: acceptedOperationId,
        stateSha256: digest(encode(accepted)),
      }),
    ],
    [
      join(f.root, "forward-recovery-operations", acceptedOperationId, "state.json"),
      encode(accepted),
    ],
    [join(f.root, "config-base.json"), encode(baseline)],
    [join(root, "before-container.json"), encode(before)],
    [join(root, "before-inventory.json"), encode([before, edge, postgres, ...workers])],
    [join(root, "invariants.json"), encode(invariants)],
    [
      plan.runtime.path,
      envBytes({
        ...f.env,
        DADATA_TOKEN: "fixture-private-token",
        ...(options.extraEnvironment ?? {}),
      }),
    ],
    [f.envFile, await readFile(f.envFile)],
    [
      plan.compose.migrationPath,
      envBytes({ DATABASE_URL: "postgresql://fixture.invalid/markiro" }),
    ],
    ...plan.compose.files.map((path) => [path, Buffer.from("services: {}\n")]),
  ]);
  plan.runtime.sha256 = digest(files.get(plan.runtime.path));
  plan.guards.push(...workerFixtures.flatMap((fixture) => fixture.guards));
  for (const [path, bytes] of files) {
    await writeFile(path, bytes, { mode: 0o600 });
    plan.guards.push({ path: relative(host, path), sha256: digest(bytes) });
  }
  let current = clone(before),
    commands = [],
    sourceChecks = 0,
    authorizations = 0,
    replacements = 0;
  const update = async () => {
    await writeFile(join(root, "operation.json"), encode(plan), { mode: 0o600 });
    input.planSha256 = digest(encode(plan));
  };
  const input = {
    operationId,
    planSha256: digest(encode(plan)),
    dispatch: { toolingSha: plan.executorSha, runId: "456", runAttempt: "1" },
    token: "fixture-github-token",
    actorLogin: "actor",
    executorCiRunId: "123",
    executorCiRunAttempt: "1",
    verifySources: async () => {
      sourceChecks++;
      if (options.sourceFails) throw new Error("fixture-private-token");
    },
  };
  const document = (candidate) => ({
    name: "markiro-platform",
    services: {
      api: {
        image: before.Config.Image,
        environment: { ...f.env, ...(candidate ? { DADATA_TOKEN: "fixture-private-token" } : {}) },
        volumes: ["catalog:/catalog:ro"],
      },
      edge: { image: "edge@sha256:fixed", ports: ["443:443"] },
      postgres: { image: "postgres@sha256:fixed" },
    },
    networks: { markiro: { external: true } },
  });
  const deps = {
    hostRoot: host,
    request: async (url) => {
      if (options.githubOutageAfterApply && replacements > 0)
        throw new Error("fixture-private-token");
      if (url.includes("/actions/runs/456"))
        return {
          ok: true,
          json: async () => ({
            id: 456,
            run_attempt: 1,
            head_sha: plan.executorSha,
            head_branch: options.tagged ? `configuration-dadata-${plan.executorSha}` : "main",
            event: "workflow_dispatch",
            path: ".github/workflows/configure-platform-dadata.yml",
            repository: { full_name: "thevladbog/markiro" },
            head_repository: { full_name: "thevladbog/markiro" },
            status: "in_progress",
            conclusion: null,
          }),
        };
      if (url.includes("/git/ref/heads/configuration-dadata-")) return { ok: false, status: 404 };
      if (url.includes("/git/ref/tags/configuration-dadata-"))
        return {
          ok: true,
          json: async () => ({
            ref: `refs/tags/configuration-dadata-${plan.executorSha}`,
            object: {
              type: options.annotatedTag ? "tag" : "commit",
              sha: options.movedTag ? "e".repeat(40) : plan.executorSha,
            },
          }),
        };
      if (url.includes("/compare/"))
        return {
          ok: true,
          json: async () => ({
            base_commit: { sha: plan.executorSha },
            merge_base_commit: { sha: options.nonancestor ? "e".repeat(40) : plan.executorSha },
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            commits: [{ sha: "e".repeat(40) }],
          }),
        };
      return {
        ok: true,
        json: async () => ({
          ref: "refs/heads/main",
          object: {
            type: "commit",
            sha:
              options.tagged ||
              options.staleMain ||
              (options.mainDriftAfterApply && replacements > 0)
                ? "e".repeat(40)
                : plan.executorSha,
          },
        }),
      };
    },
    verifyDispatch: async () => {
      authorizations++;
      return clone(auth);
    },
    assertNoPeers: async () => {},
    fetchCi: async () => ({ run: { run_attempt: 1 } }),
    captureInvariants: async () => clone(invariants),
    runProcess: async (command) => {
      commands.push(clone(command));
      const args = command.args.slice(2);
      const output = (v) => ({
        stdout: Buffer.from(typeof v === "string" ? v : JSON.stringify(v)),
        stderr: Buffer.alloc(0),
      });
      if (args[0] === "ps")
        return output(
          [
            ...(current ? [current.Id] : []),
            edge.Id,
            postgres.Id,
            ...workers.map((c) => c.Id),
            ...(options.unknownContainer ? [hash("e")] : []),
          ].join("\n"),
        );
      if (args[0] === "inspect")
        return output([
          ...(current ? [current] : []),
          edge,
          postgres,
          ...workers,
          ...(options.unknownContainer ? [container("e", "unknown")] : []),
        ]);
      if (args[0] === "compose") {
        const candidate = command.env.MARKIRO_PLATFORM_ENV_FILE === plan.runtime.path;
        if (args.includes("up")) {
          replacements++;
          if (options.applyFailure === "before-replacement" && candidate) {
            throw processFailure();
          }
          if (options.applyFailure === "after-removal" && candidate) {
            current = null;
            throw processFailure();
          }
          current = clone(before);
          current.Id = hash(candidate ? "6" : "7");
          current.Config.Hostname = current.Id.slice(0, 12);
          if (candidate) {
            current.Config.Env.push("DADATA_TOKEN=fixture-private-token");
            current.Config.Labels["com.docker.compose.config-hash"] = hash("b");
          }
          if (options.applyFailure === "after-create" && candidate) {
            current.State = {
              ...current.State,
              Status: "created",
              Running: false,
              Pid: 0,
              ExitCode: 0,
            };
            delete current.State.Health;
            for (const network of Object.values(current.NetworkSettings.Networks))
              network.NetworkID = "";
            if (options.createdMutation) options.createdMutation(current);
            throw processFailure();
          }
          if (options.unownedCandidate && candidate) current.Config.Cmd = ["wrong"];
          if (options.edgeNetworkAfter && candidate) edge.NetworkSettings.Networks = {};
          if (options.afterReplace) await options.afterReplace({ root, plan, current, candidate });
          if (options.mutationProcessError && candidate) {
            const { reason, exitStatus = null, typed = true } = options.mutationProcessError;
            const error = processFailure(reason, true, exitStatus);
            if (!typed) delete error.code;
            throw error;
          }

          if (options.applyFailure === "unknown" && candidate) {
            throw processFailure("termination", false, null);
          }
          if (options.applyFailure === "after-replacement" && candidate) {
            throw processFailure();
          }
          return output("");
        }
        if (args.includes("--hash"))
          return output(
            `api ${candidate ? plan.compose.afterConfigHash : plan.compose.beforeConfigHash}\n`,
          );
        const doc = document(candidate);
        if (candidate && options.composeMutation) options.composeMutation(doc);
        return output(doc);
      }
      if (args[0] === "exec") {
        if (options.suggestionsFail) {
          const error = new Error("fixture-private-token");
          error.terminationConfirmed = true;
          throw error;
        }
        return output([
          { status: "ready", count: 1 },
          { status: "ready", count: 2 },
          { status: "ready", count: 1 },
        ]);
      }
      throw new Error("Unexpected command");
    },
  };
  await update();
  if (options.apiNetworkBefore) current.NetworkSettings.Networks = {};
  if (options.edgeNetworkBefore) edge.NetworkSettings.Networks = {};
  if (options.pgNewNetworkBefore)
    postgres.NetworkSettings.Networks.unexpected = { NetworkID: hash("8") };
  return {
    ...f,
    stateRoot: f.root,
    host,
    root,
    plan,
    input,
    deps,
    commands,
    invariants,
    update,
    get current() {
      return current;
    },
    get sourceChecks() {
      return sourceChecks;
    },
    get authorizations() {
      return authorizations;
    },
    get replacements() {
      return replacements;
    },
  };
}

test("successful executor replaces only api, keeps child environment/receipts secret-free and accepts a resolvable identity", async (t) => {
  const f = await fixture(t);
  const prior = await readFile(join(f.stateRoot, "state.json"));
  const result = await executeConfigurationOperation(f.input, f.deps);
  assert.deepEqual(result, {
    status: "healthy",
    operationId: f.plan.operationId,
    apiId: hash("6"),
  });
  assert.equal(f.replacements, 1);
  assert.ok(f.authorizations >= 7);
  assert.ok(f.sourceChecks > f.commands.length * 2);
  const mutation = f.commands.find((c) => c.args.includes("up"));
  assert.deepEqual(
    mutation.args.slice(-8),
    ["up", "-d", "--wait", "--wait-timeout", "120", "--no-deps", "--force-recreate", "api"].slice(
      -10,
    ),
  );
  for (const command of f.commands) {
    assert.equal(command.executable, "/usr/bin/docker");
    assert.deepEqual(command.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    assert.equal(Object.hasOwn(command.env, "DADATA_TOKEN"), false);
    assert.equal(Object.hasOwn(command.env, "DADATA_SECRET"), false);
    assert.equal(Object.hasOwn(command.env, "DATABASE_URL"), false);
    assert.doesNotMatch(
      JSON.stringify(command),
      /fixture-private-token|fixture-github-token|DADATA_SECRET=|DADATA_TOKEN=/u,
    );
  }
  const receipt = JSON.parse(await readFile(join(f.root, "receipt.json")));
  assert.equal(receipt.status, "healthy");
  assert.equal(receipt.after.api.id, hash("6"));
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-private-token/);
  await assert.rejects(access(join(f.stateRoot, "config-pending.json")));
  await assert.rejects(access(join(f.stateRoot, ".deploy.lock")));
  assert.deepEqual(await readFile(join(f.stateRoot, "state.json")), prior);
});

for (const [name, options] of [
  ["source verification", { sourceFails: true }],
  ["main provenance", { staleMain: true }],
  ["unrelated environment key", { extraEnvironment: { SMTP_PASSWORD: "changed" } }],
  [
    "full rendered edge mutation",
    {
      composeMutation: (doc) => {
        doc.services.edge.ports = ["80:80"];
      },
    },
  ],
  ["unknown stopped/running container", { unknownContainer: true }],
  ["disconnected original API network", { apiNetworkBefore: true }],
  ["disconnected preserved edge network", { edgeNetworkBefore: true }],
  ["new preserved PostgreSQL network", { pgNewNetworkBefore: true }],
])
  test(`admission rejects ${name} without any api replacement`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(
      executeConfigurationOperation(f.input, f.deps),
      (error) => !error.message.includes("fixture-private-token"),
    );
    assert.equal(f.replacements, 0);
    await assert.rejects(access(join(f.stateRoot, "config-pending.json")));
  });

for (const stage of ["before-replacement", "after-removal", "after-replacement"])
  test(`confirmed ${stage} failure safely recreates the old recipe and records returned-old identity`, async (t) => {
    const f = await fixture(t, { applyFailure: stage });
    await assert.rejects(
      executeConfigurationOperation(f.input, f.deps),
      (error) => error.restored === true,
    );
    assert.equal(f.replacements, 2);
    const receipt = JSON.parse(await readFile(join(f.root, "receipt.json")));
    assert.equal(receipt.status, "returned-old");
    assert.equal(receipt.after.api.id, hash("7"));
    assert.deepEqual(receipt.after.runtime, f.plan.before.runtime);
    await assert.rejects(access(join(f.stateRoot, "config-pending.json")));
  });

test("provider suggestions failure restores old runtime and emits no response rows", async (t) => {
  const f = await fixture(t, { suggestionsFail: true });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.restored === true,
  );
  assert.equal(f.replacements, 2);
  assert.equal(JSON.parse(await readFile(join(f.root, "receipt.json"))).status, "returned-old");
});

test("unknown compose termination retains pending and the common deployment lock without rollback", async (t) => {
  const f = await fixture(t, { applyFailure: "unknown" });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.terminationConfirmed === false,
  );
  assert.equal(f.replacements, 1);
  await access(join(f.stateRoot, "config-pending.json"));
  await access(join(f.stateRoot, ".deploy.lock"));
  await assert.rejects(access(join(f.root, "receipt.json")));
});

test("unowned daemon candidate is preserved for manual recovery without rollback", async (t) => {
  const f = await fixture(t, { unownedCandidate: true });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(f.replacements, 1);
  await access(join(f.stateRoot, "config-pending.json"));
  await access(join(f.stateRoot, ".deploy.lock"));
});

test("terminal receipt collision retains pending/lock and never rolls back accepted publication", async (t) => {
  const f = await fixture(t, {
    afterReplace: async ({ root, candidate }) => {
      if (candidate) await writeFile(join(root, "receipt.json"), "occupied\n", { mode: 0o600 });
    },
  });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(f.replacements, 1);
  await access(join(f.stateRoot, "config-pending.json"));
  await access(join(f.stateRoot, ".deploy.lock"));
  assert.equal(await readFile(join(f.root, "receipt.json"), "utf8"), "occupied\n");
});

test("read-only invariants hash all nine catalog tables and every accepted journal form without raw contents", async (t) => {
  const f = await privateFixture(t, { nested: true }),
    host = dirname(f.root),
    directory = join(host, "release-catalog/journal"),
    id = randomUUID();
  await mkdir(join(host, "release-catalog"), { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  for (const suffix of [".json", ".attempt.json", ".stored.json"])
    await writeFile(join(directory, `${id}${suffix}`), `private-journal${suffix}\n`, {
      mode: 0o600,
    });
  const schemaProof = {
      systemId: "12",
      migrationCount: "202",
      schemaSha256: hash("b"),
      migrationSha256: hash("c"),
    },
    calls = [];
  const options = {
    hostRoot: host,
    plan: { containers: { postgres: { id: hash("3") } }, schemaProof },
    journalOwner: process.getuid(),
    journalGroup: process.getgid(),
    command: async (args) => {
      calls.push(args);
      return {
        stdout: Buffer.from(calls.length % 2 === 1 ? JSON.stringify(schemaProof) : hash("9")),
      };
    },
  };
  const before = await captureConfigurationInvariants(options);
  assert.deepEqual(before.schemaProof, schemaProof);
  assert.equal(before.catalogSha256, hash("9"));
  assert.match(before.journalSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(before), /private-journal/);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 3), ["exec", "--user", "70:70"]);
    assert.match(args.join(" "), /default_transaction_read_only=on/);
    assert.doesNotMatch(args.join(" "), /INSERT|UPDATE|DELETE|ALTER|DROP|CREATE/);
  }
  for (const name of [
    "epochs",
    "receipts",
    "intents",
    "publications",
    "objects",
    "reservations",
    "channels",
    "channel_events",
    "oidc_bindings",
  ])
    assert.ok(calls[1].at(-1).includes(`public.release_catalog_${name}`));
  await writeFile(join(directory, `${id}.stored.json`), "changed-private-journal\n", {
    mode: 0o600,
  });
  const after = await captureConfigurationInvariants(options);
  assert.notEqual(after.journalSha256, before.journalSha256);
});

test("read-only invariants refuse symlinked journal files", async (t) => {
  const { symlink } = await import("node:fs/promises");
  const f = await privateFixture(t, { nested: true }),
    host = dirname(f.root),
    directory = join(host, "release-catalog/journal");
  await mkdir(join(host, "release-catalog"), { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await symlink(f.envFile, join(directory, `${randomUUID()}.json`));
  const schemaProof = {
    systemId: "12",
    migrationCount: "202",
    schemaSha256: hash("b"),
    migrationSha256: hash("c"),
  };
  let calls = 0;
  await assert.rejects(
    captureConfigurationInvariants({
      hostRoot: host,
      plan: { containers: { postgres: { id: hash("3") } }, schemaProof },
      journalOwner: process.getuid(),
      journalGroup: process.getgid(),
      command: async () => ({
        stdout: Buffer.from(++calls === 1 ? JSON.stringify(schemaProof) : hash("9")),
      }),
    }),
  );
});

test("daemon command builder never inherits ambient credentials or Docker context", async () => {
  const previous = { DADATA_TOKEN: process.env.DADATA_TOKEN, DOCKER_HOST: process.env.DOCKER_HOST };
  process.env.DADATA_TOKEN = "ambient-private-token";
  process.env.DOCKER_HOST = "tcp://untrusted.invalid:2375";
  try {
    let observed;
    await configurationDockerCommand({
      hostRoot: "/opt/markiro-platform",
      operationRoot: "/opt/markiro-platform/state/configuration-operations/example",
      runProcess: async (command) => {
        observed = command;
        return { stdout: Buffer.alloc(0) };
      },
    })(["ps", "-aq", "--no-trunc"]);
    assert.deepEqual(observed.env, {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C",
      DOCKER_CONFIG: "/opt/markiro-platform/state/docker",
    });
    assert.doesNotMatch(JSON.stringify(observed), /ambient-private-token|untrusted.invalid/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("preserved container network drift after API replacement retains pending and lock", async (t) => {
  const f = await fixture(t, { edgeNetworkAfter: true });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(f.replacements, 1);
  await access(join(f.stateRoot, "config-pending.json"));
  await access(join(f.stateRoot, ".deploy.lock"));
});

for (const condition of ["mainDriftAfterApply", "githubOutageAfterApply"])
  test(`same-process rollback remains authorized after ${condition}`, async (t) => {
    const f = await fixture(t, { applyFailure: "after-removal", [condition]: true });
    await assert.rejects(
      executeConfigurationOperation(f.input, f.deps),
      (error) => error.restored === true,
    );
    assert.equal(f.replacements, 2);
    const receipt = JSON.parse(await readFile(join(f.root, "receipt.json")));
    assert.equal(receipt.status, "returned-old");
    assert.deepEqual(receipt.authorization, auth);
    await assert.rejects(access(join(f.stateRoot, "config-pending.json")));
  });

test("configuration admission reserves a terminal resolver slot before any mutation", () => {
  assert.doesNotThrow(() => assertConfigurationSuccessorCapacity(0));
  assert.doesNotThrow(() => assertConfigurationSuccessorCapacity(31));
  for (const count of [32, 33, -1, 1.5])
    assert.throws(() => assertConfigurationSuccessorCapacity(count));
});

test("executor requires a byte-bound complete retained inventory before issuing child commands", async (t) => {
  const f = await fixture(t);
  f.plan.guards = f.plan.guards.filter((guard) => !guard.path.endsWith("/before-inventory.json"));
  await f.update();
  await assert.rejects(executeConfigurationOperation(f.input, f.deps));
  assert.equal(f.commands.length, 0);
});

test("pending ownership drift after replacement retains all recovery evidence without rollback", async (t) => {
  const f = await fixture(t, {
    afterReplace: async ({ root, candidate }) => {
      if (candidate)
        await writeFile(join(dirname(dirname(root)), "config-pending.json"), "changed-owner\n", {
          mode: 0o600,
        });
    },
  });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.durabilityUncertain === true,
  );
  assert.equal(f.replacements, 1);
  assert.equal(await readFile(join(f.stateRoot, "config-pending.json"), "utf8"), "changed-owner\n");
  await access(join(f.stateRoot, ".deploy.lock"));
});

test("confirmed never-started created candidate returns the exact saved old environment", async (t) => {
  const f = await fixture(t, { applyFailure: "after-create" });
  await assert.rejects(
    executeConfigurationOperation(f.input, f.deps),
    (error) => error.restored === true,
  );
  assert.equal(f.replacements, 2);
  assert.equal(JSON.parse(await readFile(join(f.root, "receipt.json"))).status, "returned-old");
});

for (const [name, createdMutation] of [
  [
    "extra network",
    (c) => {
      c.NetworkSettings.Networks.extra = { ...clone(c.NetworkSettings.Networks.markiro) };
    },
  ],
  [
    "changed host configuration",
    (c) => {
      c.HostConfig.Memory += 1;
    },
  ],
  [
    "nonempty unknown network identity",
    (c) => {
      c.NetworkSettings.Networks.markiro.NetworkID = hash("8");
    },
  ],
])
  test(`created candidate with ${name} is preserved without rollback`, async (t) => {
    const f = await fixture(t, { applyFailure: "after-create", createdMutation });
    await assert.rejects(
      executeConfigurationOperation(f.input, f.deps),
      (error) => error.durabilityUncertain === true,
    );
    assert.equal(f.replacements, 1);
    await access(join(f.stateRoot, "config-pending.json"));
    await access(join(f.stateRoot, ".deploy.lock"));
  });

for (const [name, mutationProcessError] of [
  ["timeout with reaped CLI", { reason: "timeout" }],
  ["aborted CLI", { reason: "aborted" }],
  ["output limit with reaped CLI", { reason: "output-limit" }],
  ["stdin failure", { reason: "stdin" }],
  ["stream error", { reason: "stream", exitStatus: 1 }],
  ["signal termination", { reason: "signal" }],
  ["unknown process reason", { reason: "unclassified" }],
  ["signal exit without exit status", { reason: "exit", exitStatus: null }],
  ["untyped generic error", { reason: "exit", exitStatus: 1, typed: false }],
])
  test(`daemon mutation ${name} retains pending and lock without racing a rollback`, async (t) => {
    const f = await fixture(t, { mutationProcessError });
    await assert.rejects(
      executeConfigurationOperation(f.input, f.deps),
      (error) => error.durabilityUncertain === true,
    );
    assert.equal(f.replacements, 1);
    await access(join(f.stateRoot, "config-pending.json"));
    await access(join(f.stateRoot, ".deploy.lock"));
    await assert.rejects(access(join(f.root, "receipt.json")));
  });

test("host accepts exact pinned source after main advance and rejects broken tag provenance before replacement", async (t) => {
  const f = await fixture(t, { tagged: true });
  const result = await executeConfigurationOperation(f.input, f.deps);
  assert.equal(result.status, "healthy");
  for (const change of [{ movedTag: true }, { annotatedTag: true }, { nonancestor: true }]) {
    const bad = await fixture(t, { tagged: true, ...change });
    await assert.rejects(executeConfigurationOperation(bad.input, bad.deps));
    assert.equal(bad.replacements, 0);
  }
});
