import assert from "node:assert/strict";
import test from "node:test";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareConfigurationOperation } from "../host/dadata-prepare.mjs";
import { privateFixture } from "./host-fixtures.mjs";
import { retainedCatalogWorkerFixture } from "./retained-catalog-worker-fixture.mjs";
import { containerRecipe } from "../host/container-recipe.mjs";
import { digest } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { validateConfigurationPlan } from "../host/configuration-plan.mjs";

const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
const hash = (c) => c.repeat(64);
function container(c, service, stopped = false) {
  return {
    Id: hash(c),
    Name: `/markiro-platform-${service}-1`,
    Image: `sha256:${hash("d")}`,
    Config: {
      Image: `fixture/api@sha256:${hash("d")}`,
      Env: ["NODE_ENV=production"],
      Labels: {
        "com.docker.compose.project": "markiro-platform",
        "com.docker.compose.service": service,
        "com.docker.compose.config-hash": hash("a"),
      },
    },
    HostConfig: { Mounts: [] },
    Mounts: [],
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
  };
}
const descriptor = (c) => ({ id: c.Id, imageId: c.Image, recipeSha256: containerRecipe(c) });
async function fixture(t, options = {}) {
  const f = await privateFixture(t, { nested: true });
  const host = dirname(f.root),
    operationId = randomUUID(),
    acceptedOperationId = randomUUID();
  const composeDirectory = join(host, "bundle/deploy/platform");
  const activationDirectory = join(
    host,
    "upgrade-operations",
    acceptedOperationId,
    "post-migration-activate",
  );
  const acceptedDirectory = join(f.root, "forward-recovery-operations", acceptedOperationId);
  for (const directory of [
    join(host, "bundle"),
    join(host, "bundle/deploy"),
    composeDirectory,
    join(host, "upgrade-operations"),
    dirname(activationDirectory),
    activationDirectory,
    join(f.root, "forward-recovery-operations"),
    acceptedDirectory,
  ])
    await mkdir(directory, { mode: 0o700 });
  const api = container("1", "api"),
    edge = container("2", "edge"),
    postgres = container("3", "postgres");
  const retained = await Promise.all(
    ["4", "5"].map((digit) => retainedCatalogWorkerFixture(host, acceptedOperationId, digit)),
  );
  const workers = retained.map((entry) => entry.worker);
  const composeFiles = ["compose.yml", "compose.compact.yml", "compose.catalog.yml"].map((name) =>
    join(composeDirectory, name),
  );
  api.Config.Labels["com.docker.compose.project.config_files"] = composeFiles.join(",");
  api.Config.Labels["com.docker.compose.project.working_dir"] = composeDirectory;
  const schemaProof = {
    systemId: "12",
    migrationCount: "202",
    schemaSha256: hash("b"),
    migrationSha256: hash("c"),
  };
  const accepted = {
    sequence: 14,
    phase: "healthy",
    status: "completed",
    admission: { identity: { operationId: acceptedOperationId } },
  };
  const files = new Map([
    [
      join(f.root, "state.json"),
      encode({ version: 1, sequence: 0, current: null, previousHealthy: null }),
    ],
    [join(acceptedDirectory, "state.json"), encode(accepted)],
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
      join(f.root, "migration.env"),
      Buffer.from("DATABASE_URL=postgresql://fixture.invalid/markiro\n"),
    ],
    [
      join(activationDirectory, "operation.json"),
      encode({
        operation: {
          configuration: {
            runtimeSnapshot: { path: f.envFile },
            migrationSnapshot: { path: join(f.root, "migration.env") },
          },
        },
      }),
    ],
    [f.envFile, await readFile(f.envFile)],
    ...composeFiles.map((path) => [path, Buffer.from("services: {}\n")]),
    ...retained.flatMap((entry) =>
      Object.entries(entry.records).map(([name, value]) => [
        join(entry.directory, name),
        encode(value),
      ]),
    ),
  ]);
  for (const [path, bytes] of files) await writeFile(path, bytes, { mode: 0o600 });
  let sourceChecks = 0;
  const input = {
    operationId,
    executorSha: "f".repeat(40),
    executorCi: { runId: "123", runAttempt: "1" },
    seed: {
      acceptedOperationId,
      containers: { api: descriptor(api), edge: descriptor(edge), postgres: descriptor(postgres) },
      workers: workers.map(descriptor),
      guards: [...files].map(([path, bytes]) => ({
        path: relative(host, path),
        sha256: digest(bytes),
      })),
      schemaProof,
    },
    dadata: { DADATA_TOKEN: "  fixture-private-token  ", DADATA_SECRET: "   " },
    verifySources: async () => {
      sourceChecks++;
    },
  };
  const commands = [];
  const deps = {
    hostRoot: host,
    captureInvariants: async () => ({
      schemaProof,
      catalogSha256: hash("8"),
      journalSha256: hash("7"),
    }),
    runProcess: async (command) => {
      commands.push(command);
      const args = command.args.slice(2),
        output = (v) => ({
          stdout: Buffer.from(typeof v === "string" ? v : JSON.stringify(v)),
          stderr: Buffer.alloc(0),
        });
      if (args[0] === "ps")
        return output([api, edge, postgres, ...workers].map((c) => c.Id).join("\n"));
      if (args[0] === "inspect") return output([api, edge, postgres, ...workers]);
      if (args[0] === "compose" && args.includes("config")) {
        const runtime = await readProtectedEnv(command.env.MARKIRO_PLATFORM_ENV_FILE);
        const candidate = command.env.MARKIRO_PLATFORM_ENV_FILE.endsWith(
          `/configuration-operations/${operationId}/runtime.env`,
        );
        const configHash = hash(
          runtime.DADATA_TOKEN === "fixture-next-token" ? "c" : runtime.DADATA_TOKEN ? "b" : "a",
        );
        if (args.includes("--hash")) return output(`api ${configHash}\n`);
        return output({
          services: {
            api: {
              image: api.Config.Image,
              environment: {
                ...runtime,
                ...(candidate ? (options.extraEnvironment ?? {}) : {}),
              },
            },
            edge: { image: "edge" },
            postgres: { image: "postgres" },
          },
        });
      }
      throw new Error("unexpected child");
    },
  };
  return { f, host, input, deps, commands, files, api, retained, sourceChecks: () => sourceChecks };
}

test("preparer stages only private files, preserves predecessor bytes and returns secret-free metadata", async (t) => {
  const f = await fixture(t),
    result = await prepareConfigurationOperation(f.input, f.deps);
  assert.equal(result.productionMutated, false);
  assert.equal(result.beforeApiId, f.api.Id);
  assert.equal(JSON.stringify(result).includes("fixture-private-token"), false);
  const root = join(f.f.root, "configuration-operations", f.input.operationId);
  const bytes = await readFile(join(root, "operation.json"));
  const plan = validateConfigurationPlan(JSON.parse(bytes));
  assert.equal(
    plan.guards.find((g) => g.path.endsWith("/before-inventory.json")).sha256,
    digest(await readFile(join(root, "before-inventory.json"))),
  );
  assert.equal(result.planSha256, digest(bytes));
  assert.equal(plan.runtime.sha256, result.candidateRuntimeSha256);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  for (const name of [
    "runtime.env",
    "before-container.json",
    "before-inventory.json",
    "invariants.json",
    "operation.json",
  ])
    assert.equal((await lstat(join(root, name))).mode & 0o777, 0o600);
  const runtime = (await readFile(plan.runtime.path)).toString();
  assert.match(runtime, /DADATA_TOKEN=fixture-private-token\n/u);
  assert.equal(runtime.includes("DADATA_SECRET="), false);
  assert.deepEqual(runtime.trimEnd().split("\n"), runtime.trimEnd().split("\n").sort());
  for (const [path, original] of f.files) assert.deepEqual(await readFile(path), original);
  assert.ok(f.sourceChecks() >= f.commands.length * 2);
  assert.equal(
    f.commands.some((c) =>
      c.args.some((a) => ["up", "restart", "stop", "rm", "run", "create"].includes(a)),
    ),
    false,
  );
  await assert.rejects(access(join(f.f.root, "config-index.json")));
  assert.equal(
    plan.guards.some(
      (g) => g.path === "state/config-index.json" || g.path === "state/config-pending.json",
    ),
    false,
  );
  await assert.rejects(prepareConfigurationOperation(f.input, f.deps));
});

test("preparer rejects credential shape before writing or invoking children", async (t) => {
  const f = await fixture(t);
  f.input.dadata.EXTRA = "fixture-private-token";
  await assert.rejects(
    prepareConfigurationOperation(f.input, f.deps),
    (error) => !error.message.includes("fixture-private-token"),
  );
  assert.equal(f.commands.length, 0);
  await assert.rejects(access(join(f.f.root, "configuration-operations")));
});
for (const kind of ["seed", "image", "recipe", "pending", "unexpected-environment"]) {
  test(`preparer refuses ${kind} drift without daemon mutation`, async (t) => {
    const f = await fixture(
      t,
      kind === "unexpected-environment" ? { extraEnvironment: { SMTP_HOST: "changed" } } : {},
    );
    if (kind === "seed") f.input.seed.guards[0].sha256 = hash("0");
    if (kind === "image") f.api.Image = `sha256:${hash("e")}`;
    if (kind === "recipe") f.api.Config.Env.push("EXTRA=changed");
    if (kind === "pending")
      await writeFile(join(f.f.root, "config-pending.json"), encode({ pending: true }), {
        mode: 0o600,
      });
    await assert.rejects(
      prepareConfigurationOperation(f.input, f.deps),
      (error) => !error.message.includes("fixture-private-token"),
    );
    assert.equal(
      f.commands.some((c) => c.args.includes("up")),
      false,
    );
    for (const [path, original] of f.files) assert.deepEqual(await readFile(path), original);
  });
}

test("preparer resolves the accepted configuration successor rather than reusing original API identity", async (t) => {
  const f = await fixture(t);
  const first = await prepareConfigurationOperation(f.input, f.deps);
  const directory = join(f.f.root, "configuration-operations", first.operationId);
  const plan = JSON.parse(await readFile(join(directory, "operation.json")));
  f.api.Id = hash("6");
  f.api.Config.Labels["com.docker.compose.config-hash"] = hash("b");
  f.api.Config.Env = Object.entries(await readProtectedEnv(plan.runtime.path)).map(
    ([key, value]) => `${key}=${value}`,
  );
  const receipt = {
    version: 1,
    kind: "platform-configuration-successor",
    operationId: first.operationId,
    acceptedOperationId: f.input.seed.acceptedOperationId,
    planSha256: first.planSha256,
    previousOperationId: null,
    previousReceiptSha256: null,
    status: "healthy",
    before: { api: plan.before.api, runtime: plan.before.runtime },
    after: { api: descriptor(f.api), runtime: plan.runtime },
    dispatch: { toolingSha: f.input.executorSha, runId: "456", runAttempt: "1" },
    authorization: {
      actorId: "1",
      actorLogin: "actor",
      reviewerId: "2",
      reviewerLogin: "reviewer",
      environmentId: "3",
    },
  };
  await writeFile(join(directory, "receipt.json"), encode(receipt), { mode: 0o600 });
  const head = { operationId: first.operationId, receiptSha256: digest(encode(receipt)) };
  await writeFile(
    join(f.f.root, "config-index.json"),
    encode({ version: 1, kind: "platform-configuration-index", head }),
    { mode: 0o600 },
  );
  const nextInput = {
    ...f.input,
    operationId: randomUUID(),
    dadata: { DADATA_TOKEN: "fixture-next-token" },
  };
  const result = await prepareConfigurationOperation(nextInput, f.deps);
  const nextPlan = JSON.parse(
    await readFile(
      join(f.f.root, "configuration-operations", nextInput.operationId, "operation.json"),
    ),
  );
  assert.equal(result.beforeApiId, f.api.Id);
  assert.deepEqual(nextPlan.before.runtime, plan.runtime);
  assert.equal(nextPlan.previousOperationId, head.operationId);
  assert.equal(nextPlan.previousReceiptSha256, head.receiptSha256);
  assert.equal(result.beforeConfigHash, hash("b"));
  assert.equal(result.afterConfigHash, hash("c"));
  const retained = JSON.parse(await readFile(join(f.f.root, "config-index.json")));
  assert.deepEqual(retained.head, head);
});

test("preparer refuses baseline authority mismatch before any child", async (t) => {
  const f = await fixture(t);
  const base = {
    acceptedOperationId: f.input.seed.acceptedOperationId,
    api: { ...f.input.seed.containers.api, id: hash("9") },
    runtime: { path: f.f.envFile, sha256: digest(await readFile(f.f.envFile)) },
  };
  await writeFile(join(f.f.root, "config-base.json"), encode(base), { mode: 0o600 });
  await assert.rejects(prepareConfigurationOperation(f.input, f.deps));
  assert.equal(f.commands.length, 0);
});

test("preparer rejects credential accessors without evaluating them", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  Object.defineProperty(f.input.dadata, "DADATA_TOKEN", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("fixture-private-token");
    },
  });
  await assert.rejects(
    prepareConfigurationOperation(f.input, f.deps),
    (error) => !error.message.includes("fixture-private-token"),
  );
  assert.equal(reads, 0);
  assert.equal(f.commands.length, 0);
});

test("preparer rechecks source integrity after a child and sanitizes its failure", async (t) => {
  const f = await fixture(t);
  f.input.verifySources = async () => {
    if (f.commands.length > 0) throw new Error("fixture-private-token");
  };
  await assert.rejects(
    prepareConfigurationOperation(f.input, f.deps),
    (error) => !error.message.includes("fixture-private-token"),
  );
  assert.equal(f.commands.length, 1);
  await assert.rejects(access(join(f.f.root, "configuration-operations")));
});

test("preparer rejects stopped workers without independent accepted custody even with matching seeded bytes", async (t) => {
  const f = await fixture(t);
  const retained = f.retained[0];
  const completed = {
    ...retained.records["completed.json"],
    authorization: {
      actorId: "1",
      actorLogin: "actor",
      reviewerId: "1",
      reviewerLogin: "actor",
      environmentId: "3",
    },
  };
  const path = join(retained.directory, "completed.json"),
    bytes = encode(completed);
  await writeFile(path, bytes, { mode: 0o600 });
  f.input.seed.guards.find((g) => g.path === relative(f.host, path)).sha256 = digest(bytes);
  await assert.rejects(prepareConfigurationOperation(f.input, f.deps));
  assert.equal(
    f.commands.some((c) => c.args.includes("compose")),
    false,
  );
});
