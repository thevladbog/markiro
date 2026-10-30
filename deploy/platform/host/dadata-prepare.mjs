import { lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonical, digest, ensure, hash, keys } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { assertExclusiveCatalogMounts } from "../catalog-config.mjs";
import { interpolationKeys } from "./config.mjs";
import { containerRecipe } from "./container-recipe.mjs";
import { verifyRetainedCatalogWorkers } from "./retained-catalog-workers.mjs";
import {
  assertPrivateRootSync,
  createPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./files.mjs";
import { withHostState } from "./state.mjs";
import { resolveConfigurationRuntime } from "./configuration-chain.mjs";
import { readConfigurationHead } from "./configuration-source.mjs";
import {
  validateConfigurationBaseline,
  validateConfigurationContainer,
  validateConfigurationPlan,
  validateConfigurationRuntime,
} from "./configuration-plan.mjs";
import { validateDadataDelta, assertDadataComposeDelta } from "./dadata-policy.mjs";
import { captureConfigurationInvariants, configurationDockerCommand } from "./dadata-host.mjs";

const HOST = "/opt/markiro-platform";
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const guardPath = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(v) &&
  v.split("/").every((p) => p && p !== "." && p !== "..");
function failure(cause) {
  const error = new Error("Protected configuration preparation failed.");
  error.code = "ERR_CONFIGURATION_PREPARE";
  for (const flag of ["durabilityUncertain", "terminationConfirmed", "lockRetirementUncertain"])
    if (typeof cause?.[flag] === "boolean") error[flag] = cause[flag];
  return error;
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
// Copy descriptors rather than evaluating caller properties, including array slots.
function document(value, depth = 0) {
  ensure(depth < 30);
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    ensure(Number.isSafeInteger(value));
    return value;
  }
  const array = Array.isArray(value);
  ensure(
    value &&
      (array
        ? Object.getPrototypeOf(value) === Array.prototype
        : [Object.prototype, null].includes(Object.getPrototypeOf(value))),
  );
  const descriptors = Object.getOwnPropertyDescriptors(value),
    out = array ? [] : {};
  if (array) ensure(Reflect.ownKeys(descriptors).length === value.length + 1);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    ensure(
      typeof key === "string" &&
        key !== "__proto__" &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value"),
    );
    if (array) ensure(key === String(out.length));
    out[key] = document(descriptor.value, depth + 1);
  }
  return out;
}
function admission(input) {
  keys(input, ["operationId", "executorSha", "executorCi", "seed", "dadata", "verifySources"]);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  ensure(Reflect.ownKeys(descriptors).length === 6);
  for (const descriptor of Object.values(descriptors))
    ensure(descriptor.enumerable && Object.hasOwn(descriptor, "value"));
  const { verifySources } = input;
  ensure(typeof verifySources === "function");
  const value = document(
    Object.fromEntries(
      Object.entries(descriptors)
        .filter(([key]) => key !== "verifySources")
        .map(([key, d]) => [key, d.value]),
    ),
  );
  ensure(uuid(value.operationId) && /^[a-f0-9]{40}$/u.test(value.executorSha));
  keys(value.executorCi, ["runId", "runAttempt"]);
  ensure(/^[1-9][0-9]{0,19}$/u.test(value.executorCi.runId) && value.executorCi.runAttempt === "1");
  const { seed, dadata } = value;
  keys(seed, ["acceptedOperationId", "containers", "workers", "guards", "schemaProof"]);
  ensure(uuid(seed.acceptedOperationId) && seed.acceptedOperationId !== value.operationId);
  keys(seed.containers, ["api", "edge", "postgres"]);
  ensure(Array.isArray(seed.workers) && seed.workers.length <= 29);
  const containers = [...Object.values(seed.containers), ...seed.workers];
  containers.forEach(validateConfigurationContainer);
  ensure(new Set(containers.map((c) => c.id)).size === containers.length);
  keys(seed.schemaProof, ["systemId", "migrationCount", "schemaSha256", "migrationSha256"]);
  ensure(
    [seed.schemaProof.systemId, seed.schemaProof.migrationCount].every(
      (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/u.test(v),
    ) &&
      hash(seed.schemaProof.schemaSha256) &&
      hash(seed.schemaProof.migrationSha256),
  );
  ensure(Array.isArray(seed.guards) && seed.guards.length >= 3 && seed.guards.length <= 990);
  const guards = new Map();
  for (const guard of seed.guards) {
    keys(guard, ["path", "sha256"]);
    ensure(guardPath(guard.path) && hash(guard.sha256));
    ensure(!["state/config-index.json", "state/config-pending.json"].includes(guard.path));
    ensure(!guards.has(guard.path) || guards.get(guard.path) === guard.sha256);
    guards.set(guard.path, guard.sha256);
  }
  for (const name of [
    "state/state.json",
    "state/upgrade-index.json",
    `state/forward-recovery-operations/${seed.acceptedOperationId}/state.json`,
  ])
    ensure(guards.has(name));
  ensure(
    dadata &&
      Object.hasOwn(dadata, "DADATA_TOKEN") &&
      Object.keys(dadata).every((key) => ["DADATA_TOKEN", "DADATA_SECRET"].includes(key)),
  );
  for (const v of Object.values(dadata))
    ensure(typeof v === "string" && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v));
  const token = dadata.DADATA_TOKEN.trim(),
    secret = dadata.DADATA_SECRET?.trim();
  ensure(token.length > 0);
  for (const v of [token, ...(secret ? [secret] : [])])
    ensure(!/^["']/u.test(v) && !v.includes("${"));
  return {
    ...value,
    dadata: { DADATA_TOKEN: token, ...(secret ? { DADATA_SECRET: secret } : {}) },
    verifySources,
    guards,
  };
}
function safeState(c, healthy = false, stopped = false) {
  const state = c.State;
  ensure(
    state && ["OOMKilled", "Restarting", "Paused", "Dead"].every((key) => state[key] === false),
  );
  if (stopped)
    ensure(
      state.Running === false &&
        state.Status === "exited" &&
        state.Pid === 0 &&
        state.ExitCode === 0,
    );
  else {
    ensure(state.Running === true && state.Status === "running");
    if (healthy) ensure(state.Health?.Status === "healthy");
  }
}
const descriptor = (c) => ({ id: c.Id, imageId: c.Image, recipeSha256: containerRecipe(c) });

/** Trusted local preparation only: no daemon mutation, provider requests or chain publication. */
export async function prepareConfigurationOperation(input, dependencies = {}) {
  try {
    const request = admission(input),
      { operationId, executorSha, executorCi, seed, dadata, verifySources, guards } = request;
    const host = dependencies.hostRoot ?? HOST,
      state = join(host, "state"),
      root = join(state, "configuration-operations", operationId);
    assertPrivateRootSync(host);
    assertPrivateRootSync(state);
    return await withHostState(state, (store) =>
      store.guardPersistence(async () => {
        ensure(!(await exists(root)) && !(await exists(join(state, "config-pending.json"))));
        const head = await readConfigurationHead(state);
        const read = (path) => readPrivateFile(host, relative(host, path));
        const json = async (path) => JSON.parse(await read(path));
        const add = async (path, expected) => {
          const name = relative(host, path);
          ensure(guardPath(name));
          const sha256 = digest(await read(path));
          if (expected !== undefined) ensure(sha256 === expected);
          if (guards.has(name)) ensure(guards.get(name) === sha256);
          guards.set(name, sha256);
          return sha256;
        };
        const verify = async () => {
          await verifySources();
          for (const [path, sha256] of guards)
            ensure(digest(await readPrivateFile(host, path)) === sha256);
          same(await readConfigurationHead(state), head);
          ensure(!(await exists(join(state, "config-pending.json"))));
        };
        await verify();
        const acceptedPath = join(
          state,
          "forward-recovery-operations",
          seed.acceptedOperationId,
          "state.json",
        );
        const acceptedBytes = await read(acceptedPath),
          accepted = JSON.parse(acceptedBytes),
          index = await json(join(state, "upgrade-index.json"));
        ensure(
          accepted.sequence === 14 &&
            accepted.phase === "healthy" &&
            accepted.status === "completed" &&
            accepted.admission?.identity?.operationId === seed.acceptedOperationId,
        );
        ensure(
          index.kind === "platform-forward-recovery-index" &&
            index.operationId === seed.acceptedOperationId &&
            index.stateSha256 === digest(acceptedBytes),
        );
        const activationPath = join(
          host,
          "upgrade-operations",
          seed.acceptedOperationId,
          "post-migration-activate",
          "operation.json",
        );
        await add(activationPath);
        const activation = await json(activationPath),
          configuration = activation.operation?.configuration;
        ensure(configuration);
        const runtimePath = configuration.runtimeSnapshot?.path,
          migrationPath = configuration.migrationSnapshot?.path;
        ensure(
          typeof runtimePath === "string" &&
            runtimePath.startsWith(`${state}/`) &&
            typeof migrationPath === "string" &&
            migrationPath.startsWith(`${state}/`) &&
            migrationPath.endsWith("/migration.env"),
        );
        const baseline = validateConfigurationBaseline({
          acceptedOperationId: seed.acceptedOperationId,
          api: seed.containers.api,
          runtime: { path: runtimePath, sha256: await add(runtimePath) },
        });
        await add(migrationPath);
        const basePath = join(state, "config-base.json"),
          baseExists = await exists(basePath);
        if (baseExists) {
          await add(basePath);
          same(await json(basePath), baseline);
        } else ensure(head === null);
        const before = await resolveConfigurationRuntime({ root: state, baseline });
        validateConfigurationRuntime(before.runtime);
        await add(before.runtime.path, before.runtime.sha256);
        const previous = await readProtectedEnv(before.runtime.path);
        await verify();
        const next = { ...previous, ...dadata };
        if (!Object.hasOwn(dadata, "DADATA_SECRET")) delete next.DADATA_SECRET;
        validateDadataDelta(previous, next);
        const runtimeBytes = Buffer.from(
          Object.keys(next)
            .sort()
            .map((key) => `${key}=${next[key]}\n`)
            .join(""),
        );
        ensure(runtimeBytes.length <= 1048576);
        // Commands are restricted here to read-only inventory/render; SQL is fixed in the invariant helper.
        const rawCommand = configurationDockerCommand({
          hostRoot: host,
          operationRoot: host,
          runProcess: dependencies.runProcess,
        });
        const command = async (args, options) => {
          await verify();
          const result = await rawCommand(args, options);
          await verify();
          return result;
        };
        const ids = (await command(["ps", "-aq", "--no-trunc"])).stdout
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean);
        ensure(
          ids.length === 3 + seed.workers.length &&
            ids.every(hash) &&
            new Set(ids).size === ids.length,
        );
        const rows = JSON.parse((await command(["inspect", ...ids])).stdout);
        ensure(
          Array.isArray(rows) &&
            rows.length === ids.length &&
            new Set(rows.map((c) => c.Id)).size === ids.length &&
            rows.every((c) => ids.includes(c.Id)),
        );
        for (const expected of [
          before.api,
          seed.containers.edge,
          seed.containers.postgres,
          ...seed.workers,
        ]) {
          const c = rows.find((row) => row.Id === expected.id);
          ensure(c);
          same(descriptor(c), expected);
          safeState(
            c,
            c.Id === before.api.id || c.Id === seed.containers.postgres.id,
            seed.workers.some((w) => w.id === c.Id),
          );
        }
        const custodyGuards = await verifyRetainedCatalogWorkers({
          hostRoot: host,
          acceptedOperationId: seed.acceptedOperationId,
          expected: seed.workers,
          inventory: rows,
        });
        for (const guard of custodyGuards) await add(join(host, guard.path), guard.sha256);
        const retainedIds = new Set(seed.workers.map((worker) => worker.id));
        assertExclusiveCatalogMounts(
          rows.filter((row) => !retainedIds.has(row.Id)),
          before.api.id,
        );
        const api = rows.find((c) => c.Id === before.api.id),
          labels = api.Config?.Labels;
        ensure(
          labels?.["com.docker.compose.project"] === "markiro-platform" &&
            labels?.["com.docker.compose.service"] === "api",
        );
        const directory = labels["com.docker.compose.project.working_dir"];
        ensure(
          typeof directory === "string" &&
            directory.startsWith(`${host}/`) &&
            directory.endsWith("/deploy/platform"),
        );
        const files = ["compose.yml", "compose.compact.yml", "compose.catalog.yml"].map((name) =>
          join(directory, name),
        );
        ensure(labels["com.docker.compose.project.config_files"] === files.join(","));
        for (const file of files) await add(file);
        await verify();
        if (!baseExists) {
          await writePrivateFile(state, "config-base.json", encode(baseline));
          await add(basePath);
        }
        await createPrivateDirectory(state, "configuration-operations", { exclusive: false });
        await createPrivateDirectory(state, `configuration-operations/${operationId}`);
        await writePrivateFile(root, "runtime.env", runtimeBytes);
        const runtime = { path: join(root, "runtime.env"), sha256: digest(runtimeBytes) };
        await add(runtime.path, runtime.sha256);
        await writePrivateFile(root, "before-container.json", encode(api));
        await add(join(root, "before-container.json"));
        await writePrivateFile(root, "before-inventory.json", encode(rows));
        await add(join(root, "before-inventory.json"));
        same(await readProtectedEnv(runtime.path), next);
        const render = async (runtime) => {
          const env = Object.fromEntries(
            interpolationKeys.map((key) => [
              key,
              key === "MARKIRO_PLATFORM_ENV_FILE" ? runtime : previous[key],
            ]),
          );
          env.MARKIRO_PLATFORM_MIGRATION_ENV_FILE = migrationPath;
          ensure(
            Object.values(env).every(
              (v) => typeof v === "string" && v.length > 0 && !/[\s\0]/u.test(v),
            ),
          );
          const args = [
            "compose",
            "--project-name",
            "markiro-platform",
            "--project-directory",
            directory,
            ...files.flatMap((file) => ["--file", file]),
            "config",
          ];
          const rendered = JSON.parse(
            (await command([...args, "--format", "json"], { interpolation: env })).stdout,
          );
          const result = (await command([...args, "--hash", "api"], { interpolation: env })).stdout
            .toString()
            .trim();
          ensure(/^api [a-f0-9]{64}$/u.test(result));
          return { rendered, configHash: result.slice(4) };
        };
        const old = await render(before.runtime.path),
          candidate = await render(runtime.path);
        ensure(
          old.configHash === labels["com.docker.compose.config-hash"] &&
            old.configHash !== candidate.configHash,
        );
        assertDadataComposeDelta(old.rendered, candidate.rendered);
        ensure(
          old.rendered.services.api.image === api.Config.Image &&
            candidate.rendered.services.api.image === api.Config.Image,
        );
        const plan = {
          version: 1,
          kind: "platform-dadata-configuration",
          operationId,
          acceptedOperationId: seed.acceptedOperationId,
          executorSha,
          executorCi,
          previousOperationId: head?.operationId ?? null,
          previousReceiptSha256: head?.receiptSha256 ?? null,
          before,
          runtime,
          containers: { edge: seed.containers.edge, postgres: seed.containers.postgres },
          workers: seed.workers,
          compose: {
            files,
            directory,
            migrationPath,
            beforeConfigHash: old.configHash,
            afterConfigHash: candidate.configHash,
          },
          guards: [],
          schemaProof: seed.schemaProof,
        };
        const invariants = await (dependencies.captureInvariants ?? captureConfigurationInvariants)(
          { hostRoot: host, plan, command },
        );
        keys(invariants, ["schemaProof", "catalogSha256", "journalSha256"]);
        same(invariants.schemaProof, seed.schemaProof);
        ensure(hash(invariants.catalogSha256) && hash(invariants.journalSha256));
        await writePrivateFile(root, "invariants.json", encode(invariants));
        await add(join(root, "invariants.json"));
        plan.guards = [...guards]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, sha256]) => ({ path, sha256 }));
        validateConfigurationPlan(plan);
        await verify();
        const bytes = encode(plan);
        await writePrivateFile(root, "operation.json", bytes);
        ensure((await readPrivateFile(root, "operation.json")).equals(bytes));
        await verify();
        return {
          operationId,
          planSha256: digest(bytes),
          executorSha,
          candidateRuntimeSha256: runtime.sha256,
          beforeApiId: before.api.id,
          beforeConfigHash: old.configHash,
          afterConfigHash: candidate.configHash,
          productionMutated: false,
        };
      }),
    );
  } catch (error) {
    throw failure(error);
  }
}
