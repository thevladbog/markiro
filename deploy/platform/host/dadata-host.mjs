import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonical, digest, ensure, hash, keys } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { assertExclusiveCatalogMounts } from "../catalog-config.mjs";
import {
  verifyConfigurationDispatch,
  assertNoCatalogPeers,
  validateUpgradeAuthorization,
} from "../upgrade-dispatch.mjs";
import { fetchPlatformCi } from "../release-ci.mjs";
import { interpolationKeys } from "./config.mjs";
import { containerRecipe } from "./container-recipe.mjs";
import { verifyRetainedCatalogWorkers } from "./retained-catalog-workers.mjs";
import {
  assertPrivateRootSync,
  readPrivateFile,
  writePrivateFile,
  syncPrivateDirectory,
} from "./files.mjs";
import { withHostState } from "./state.mjs";
import { runHostProcess } from "./process.mjs";
import { sanitizeHostFailure } from "./failure-diagnostic.mjs";
import { upgradeSchemaQuery } from "./upgrade-schema.mjs";
import { validateConfigurationPlan } from "./configuration-plan.mjs";
import { resolveConfigurationRuntime } from "./configuration-chain.mjs";
import { runConfigurationLifecycle } from "./configuration-lifecycle.mjs";
import {
  validateDadataDelta,
  assertDadataComposeDelta,
  assertDadataContainerDelta,
} from "./dadata-policy.mjs";

const HOST = "/opt/markiro-platform";
export function assertConfigurationSuccessorCapacity(existingCount) {
  ensure(Number.isSafeInteger(existingCount) && existingCount >= 0 && existingCount < 32);
}
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
function failure(cause, uncertain = false) {
  const error = new Error("Protected configuration host operation failed.");
  error.code = "ERR_CONFIGURATION_HOST";
  for (const flag of [
    "terminationConfirmed",
    "durabilityUncertain",
    "restored",
    "recoveryRequired",
  ])
    if (typeof cause?.[flag] === "boolean") error[flag] = cause[flag];
  if (uncertain) error.durabilityUncertain = true;
  return error;
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw failure();
}

/** Fixed daemon and explicit environment. No ambient Docker/Compose/proxy variables. */
export function configurationDockerCommand({
  hostRoot = HOST,
  operationRoot,
  runProcess = runHostProcess,
}) {
  return (args, options = {}) =>
    runProcess({
      executable: "/usr/bin/docker",
      args: ["--host", "unix:///var/run/docker.sock", ...args],
      cwd: operationRoot,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        LANG: "C",
        DOCKER_CONFIG: `${hostRoot}/state/docker`,
        ...options.interpolation,
      },
      timeoutMs: options.timeoutMs ?? 30000,
      outputLimitBytes: 1048576,
    });
}

const catalogTables = [
  "epochs",
  "receipts",
  "intents",
  "publications",
  "objects",
  "reservations",
  "channels",
  "channel_events",
  "oidc_bindings",
].map((name) => `release_catalog_${name}`);
const catalogDigestQuery = `SELECT encode(sha256(convert_to((jsonb_build_object(${catalogTables.map((name) => `'${name}',(SELECT coalesce(jsonb_agg(v ORDER BY v::text COLLATE "C"),'[]'::jsonb) FROM (SELECT to_jsonb(t) v FROM public.${name} t) s)`).join(",")}))::text,'UTF8')),'hex')`;
function postgresArgs(id, query) {
  return [
    "exec",
    "--user",
    "70:70",
    "--env",
    "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
    "--env",
    "PGCONNECT_TIMEOUT=10",
    id,
    "psql",
    "-X",
    "--no-password",
    "--username",
    "postgres",
    "--dbname",
    "markiro",
    "--tuples-only",
    "--no-align",
    "--command",
    query,
  ];
}
/** Read-only preparation/acceptance proof. Only hashes, never rows or journal contents, leave this function. */
export async function captureConfigurationInvariants({
  hostRoot = HOST,
  plan,
  command,
  journalOwner = 1000,
  journalGroup = journalOwner,
}) {
  try {
    const schemaProof = JSON.parse(
      (await command(postgresArgs(plan.containers.postgres.id, upgradeSchemaQuery))).stdout,
    );
    same(schemaProof, plan.schemaProof);
    const catalogSha256 = (
      await command(postgresArgs(plan.containers.postgres.id, catalogDigestQuery))
    ).stdout
      .toString()
      .trim();
    ensure(hash(catalogSha256));
    const directory = `${hostRoot}/release-catalog/journal`;
    const info = await lstat(directory);
    ensure(
      info.isDirectory() &&
        info.uid === journalOwner &&
        info.gid === journalGroup &&
        (info.mode & 0o7777) === 0o700 &&
        (await realpath(directory)) === directory,
    );
    const names = (await readdir(directory)).sort();
    ensure(names.length > 0 && names.length <= 1024);
    const entries = [];
    let total = 0;
    for (const name of names) {
      ensure(/^[a-f0-9-]{36}(?:\.attempt|\.stored)?\.json$/u.test(name));
      const file = await open(
        join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat();
        ensure(
          before.isFile() &&
            before.uid === journalOwner &&
            before.gid === journalGroup &&
            before.nlink === 1 &&
            (before.mode & 0o7777) === 0o600 &&
            before.size <= 1048576,
        );
        total += before.size;
        ensure(total <= 16 * 1048576);
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const after = await file.stat(),
          pathInfo = await lstat(join(directory, name));
        ensure(
          bytes.length === before.size &&
            after.size === before.size &&
            after.ctimeMs === before.ctimeMs &&
            after.mtimeMs === before.mtimeMs &&
            pathInfo.ino === before.ino &&
            pathInfo.dev === before.dev,
        );
        entries.push({
          name,
          sha256: digest(bytes),
          uid: before.uid,
          gid: before.gid,
          mode: before.mode & 0o7777,
          ino: String(before.ino),
          dev: String(before.dev),
        });
      } finally {
        await file.close();
      }
    }
    same(names, (await readdir(directory)).sort());
    const after = await lstat(directory);
    ensure(
      after.ino === info.ino &&
        after.dev === info.dev &&
        after.ctimeMs === info.ctimeMs &&
        after.mtimeMs === info.mtimeMs,
    );
    return { schemaProof, catalogSha256, journalSha256: digest(canonical(entries)) };
  } catch (error) {
    throw failure(error);
  }
}

// The probe uses the deployed compiled client, mapper and configuration classes.
// A fresh process/cache forces all three requests to cross the actual provider boundary.
const suggestionsScript = `const {DadataClient}=require('/app/dist/integrations/dadata/dadata.client.js');
const {DadataCache}=require('/app/dist/integrations/dadata/dadata-cache.js');
const {DadataConfig}=require('/app/dist/integrations/dadata/dadata.types.js');
(async()=>{try{const c=new DadataClient(new DadataConfig(process.env.DADATA_TOKEN,process.env.DADATA_SECRET),new DadataCache());const r=[];for(const [method,query]of [['suggestOrganizations','7707083893'],['suggestAddresses','Москва Тверская 1'],['suggestBanks','044525225']]){const v=await c[method](query);if(v.status!=='ready'||!Array.isArray(v.items)||v.items.length===0)throw 0;r.push({status:v.status,count:v.items.length});}process.stdout.write(JSON.stringify(r));}catch{process.exitCode=1;}})();`;

function safeState(container, healthy = false, stopped = false) {
  const state = container.State;
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
function descriptor(container) {
  return { id: container.Id, imageId: container.Image, recipeSha256: containerRecipe(container) };
}
function ownership(container, old, configHash) {
  ensure(container.Name === old.Name && container.Image === old.Image && hash(container.Id));
  const labels = container.Config?.Labels;
  ensure(
    labels?.["com.docker.compose.project"] === "markiro-platform" &&
      labels?.["com.docker.compose.service"] === "api" &&
      labels?.["com.docker.compose.config-hash"] === configHash,
  );
}
// Runtime-assigned endpoints/auto hostname differ after recreate. All declared
// network membership, environment, labels, mounts, capabilities and limits remain exact.
function rollbackRecipe(container) {
  const value = structuredClone(container);
  if (value.Config.Hostname === value.Id.slice(0, 12)) delete value.Config.Hostname;
  if (Array.isArray(value.HostConfig.Mounts))
    value.HostConfig.Mounts.sort((a, b) => a.Target.localeCompare(b.Target));
  value.Mounts.sort((a, b) => a.Destination.localeCompare(b.Destination));
  const networks = value.NetworkSettings;
  delete networks.SandboxID;
  delete networks.SandboxKey;
  for (const network of Object.values(networks.Networks))
    for (const key of [
      "EndpointID",
      "IPAddress",
      "IPPrefixLen",
      "Gateway",
      "IPv6Gateway",
      "GlobalIPv6Address",
      "GlobalIPv6PrefixLen",
      "MacAddress",
      "DNSNames",
    ])
      delete network[key];
  return {
    Name: value.Name,
    Image: value.Image,
    Config: value.Config,
    HostConfig: value.HostConfig,
    Mounts: value.Mounts,
    NetworkSettings: networks,
  };
}
function candidateRecipe(old, next, plan, requireHealthy = true) {
  ownership(next, old, plan.compose.afterConfigHash);
  const check = structuredClone(next);
  if (!requireHealthy && check.State?.Status === "created") {
    ensure(
      check.State.Running === false &&
        check.State.Pid === 0 &&
        check.State.ExitCode === 0 &&
        ["Paused", "Restarting", "Dead", "OOMKilled"].every((key) => check.State[key] === false),
    );
    // Docker has not connected a never-started container yet. Only an empty
    // generated network ID can be completed from the exact recorded membership
    // for the purpose of proving ownership before returning the fixed old env.
    for (const [name, network] of Object.entries(check.NetworkSettings.Networks)) {
      if (network.NetworkID !== "") continue;
      const recorded = old.NetworkSettings.Networks[name];
      ensure(recorded && typeof recorded.NetworkID === "string" && recorded.NetworkID.length > 0);
      network.NetworkID = recorded.NetworkID;
    }
  }
  if (!requireHealthy)
    check.State = {
      ...check.State,
      Status: "running",
      Running: true,
      Health: { Status: "healthy" },
      OOMKilled: false,
      Restarting: false,
      Paused: false,
      Dead: false,
    };
  assertDadataContainerDelta(old, check, {
    beforeConfigHash: plan.compose.beforeConfigHash,
    afterConfigHash: plan.compose.afterConfigHash,
  });
}

/** dependencies are trusted in-process test seams, never received from a serialized operation. */
export async function executeConfigurationOperation(input, dependencies = {}) {
  let lifecycleFailure;
  try {
    const {
      operationId,
      planSha256,
      dispatch,
      token,
      actorLogin,
      executorCiRunId,
      executorCiRunAttempt,
      verifySources,
    } = input;
    ensure(uuid(operationId) && hash(planSha256) && typeof verifySources === "function");
    const host = dependencies.hostRoot ?? HOST,
      state = `${host}/state`,
      root = `${state}/configuration-operations/${operationId}`;
    assertPrivateRootSync(root);
    const bytes = await readPrivateFile(root, "operation.json");
    ensure(digest(bytes) === planSha256);
    const plan = validateConfigurationPlan(JSON.parse(bytes));
    ensure(
      plan.operationId === operationId &&
        plan.executorSha === dispatch.toolingSha &&
        plan.executorCi.runId === executorCiRunId &&
        plan.executorCi.runAttempt === executorCiRunAttempt &&
        executorCiRunAttempt === "1" &&
        plan.runtime.path === `${root}/runtime.env`,
    );
    const guards = new Map(plan.guards.map((g) => [g.path, g.sha256]));
    for (const path of [
      "state/config-base.json",
      `${relative(host, root)}/before-container.json`,
      `${relative(host, root)}/before-inventory.json`,
      `${relative(host, root)}/invariants.json`,
      relative(host, plan.compose.migrationPath),
      ...plan.compose.files.map((path) => relative(host, path)),
    ])
      ensure(guards.has(path));
    ensure(
      guards.get(relative(host, plan.runtime.path)) === plan.runtime.sha256 &&
        !guards.has("state/config-index.json") &&
        !guards.has("state/config-pending.json"),
    );
    const request = dependencies.request ?? fetch;
    let authorization,
      recoveryAuthorization,
      previousIndex,
      pending = false,
      accepted = false,
      restored = false,
      current;
    const rawCommand = configurationDockerCommand({
      hostRoot: host,
      operationRoot: root,
      runProcess: dependencies.runProcess ?? runHostProcess,
    });
    const read = (path) => readPrivateFile(host, relative(host, path), { maxBytes: 2 * 1048576 });
    const json = async (path) => JSON.parse(await read(path));
    const pendingBytes = encode({
      version: 1,
      kind: "platform-configuration-pending",
      operationId,
      planSha256,
    });
    const verifyFiles = async ({ checkIndex = true } = {}) => {
      await verifySources();
      ensure(digest(await readPrivateFile(root, "operation.json")) === planSha256);
      for (const guard of plan.guards)
        ensure(
          digest(await readPrivateFile(host, guard.path, { maxBytes: 2 * 1048576 })) ===
            guard.sha256,
        );
      ensure(digest(await read(plan.runtime.path)) === plan.runtime.sha256);
      if (pending)
        ensure((await readPrivateFile(state, "config-pending.json")).equals(pendingBytes));
      if (checkIndex && previousIndex !== undefined) {
        if (previousIndex === null) await absent(`${state}/config-index.json`);
        else ensure((await read(`${state}/config-index.json`)).equals(previousIndex));
      }
    };
    const command = async (args, options) => {
      await verifyFiles();
      const result = await rawCommand(args, options);
      await verifyFiles();
      return result;
    };
    const authorize = async () => {
      await verifyFiles();
      authorization = await (dependencies.verifyDispatch ?? verifyConfigurationDispatch)(
        dispatch,
        token,
        { actorLogin, request },
      );
      await (dependencies.assertNoPeers ?? assertNoCatalogPeers)(dispatch, token, request);
      const response = await request(
        "https://api.github.com/repos/thevladbog/markiro/git/ref/heads/main",
        {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      ensure(response.ok);
      const ref = await response.json();
      ensure(
        ref.ref === "refs/heads/main" &&
          ref.object?.type === "commit" &&
          ref.object.sha === plan.executorSha,
      );
      const ci = await (dependencies.fetchCi ?? fetchPlatformCi)(
        {
          repository: "thevladbog/markiro",
          sourceSha: plan.executorSha,
          runId: plan.executorCi.runId,
        },
        token,
        request,
      );
      ensure(String(ci.run.run_attempt) === "1");
      await verifyFiles();
    };
    const before = await json(`${root}/before-container.json`),
      retainedInventory = await json(`${root}/before-inventory.json`),
      invariants = await json(`${root}/invariants.json`);
    keys(invariants, ["schemaProof", "catalogSha256", "journalSha256"]);
    same(invariants.schemaProof, plan.schemaProof);
    ensure(hash(invariants.catalogSha256) && hash(invariants.journalSha256));
    same(descriptor(before), plan.before.api);
    ownership(before, before, plan.compose.beforeConfigHash);
    const retainedExpected = [plan.before.api, ...Object.values(plan.containers), ...plan.workers];
    ensure(
      Array.isArray(retainedInventory) &&
        retainedInventory.length === retainedExpected.length &&
        new Set(retainedInventory.map((c) => c.Id)).size === retainedExpected.length,
    );
    for (const expected of retainedExpected) {
      const row = retainedInventory.find((c) => c.Id === expected.id);
      ensure(row);
      same(descriptor(row), expected);
      ensure(row.NetworkSettings && typeof row.NetworkSettings === "object");
    }
    same(retainedInventory.find((c) => c.Id === before.Id).NetworkSettings, before.NetworkSettings);
    const originalApi = (observed) => {
      same(descriptor(observed), plan.before.api);
      same(observed.NetworkSettings, before.NetworkSettings);
      safeState(observed, true);
    };
    const oldEnv = await readProtectedEnv(plan.before.runtime.path),
      nextEnv = await readProtectedEnv(plan.runtime.path);
    validateDadataDelta(oldEnv, nextEnv);
    const compose = (runtime) => {
      const env = Object.fromEntries(
        interpolationKeys.map((key) => [
          key,
          key === "MARKIRO_PLATFORM_ENV_FILE" ? runtime : oldEnv[key],
        ]),
      );
      env.MARKIRO_PLATFORM_MIGRATION_ENV_FILE = plan.compose.migrationPath;
      ensure(
        Object.values(env).every(
          (v) => typeof v === "string" && v.length > 0 && !/[\s\0]/u.test(v),
        ),
      );
      return {
        args: [
          "compose",
          "--project-name",
          "markiro-platform",
          "--project-directory",
          plan.compose.directory,
          ...plan.compose.files.flatMap((file) => ["--file", file]),
        ],
        env,
      };
    };
    const render = async () => {
      const documents = [];
      for (const [runtime, configHash] of [
        [plan.before.runtime.path, plan.compose.beforeConfigHash],
        [plan.runtime.path, plan.compose.afterConfigHash],
      ]) {
        const spec = compose(runtime);
        documents.push(
          JSON.parse(
            (
              await command([...spec.args, "config", "--format", "json"], {
                interpolation: spec.env,
              })
            ).stdout,
          ),
        );
        const output = (
          await command([...spec.args, "config", "--hash", "api"], { interpolation: spec.env })
        ).stdout
          .toString()
          .trim();
        ensure(output === `api ${configHash}`);
      }
      assertDadataComposeDelta(...documents);
      ensure(
        documents[0].services.api.image === before.Config.Image &&
          documents[1].services.api.image === before.Config.Image,
      );
    };
    const inventory = async ({ allowMissingApi = false } = {}) => {
      const ids = (await command(["ps", "-aq", "--no-trunc"])).stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      ensure(
        (ids.length === 3 + plan.workers.length ||
          (allowMissingApi && ids.length === 2 + plan.workers.length)) &&
          ids.length <= 32 &&
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
      const fixed = [...Object.values(plan.containers), ...plan.workers];
      for (const expected of fixed) {
        const c = rows.find((row) => row.Id === expected.id);
        ensure(c);
        same(descriptor(c), expected);
        same(
          c.NetworkSettings,
          retainedInventory.find((row) => row.Id === expected.id).NetworkSettings,
        );
        safeState(
          c,
          c.Id === plan.containers.postgres.id,
          plan.workers.some((worker) => worker.id === c.Id),
        );
      }
      const candidates = rows.filter((c) => !fixed.some((expected) => expected.id === c.Id));
      ensure(candidates.length === 1 || (allowMissingApi && candidates.length === 0));
      await verifyRetainedCatalogWorkers({
        hostRoot: host,
        acceptedOperationId: plan.acceptedOperationId,
        expected: plan.workers,
        inventory: rows,
        guards,
      });
      const retainedIds = new Set(plan.workers.map((worker) => worker.id));
      assertExclusiveCatalogMounts(
        rows.filter((row) => !retainedIds.has(row.Id)),
        candidates[0]?.Id,
      );
      return candidates[0] ?? null;
    };
    const verifyInvariants = async () =>
      same(
        await (dependencies.captureInvariants ?? captureConfigurationInvariants)({
          hostRoot: host,
          plan,
          command,
        }),
        invariants,
      );
    const authorizeRecovery = async () => {
      try {
        ensure(pending && !accepted && recoveryAuthorization);
        validateUpgradeAuthorization(recoveryAuthorization);
        await verifyFiles();
        await inventory({ allowMissingApi: true });
        authorization = recoveryAuthorization;
      } catch (error) {
        throw failure(error, true);
      }
    };
    const checkpoint = async (phase) => {
      if (["returning-old", "returned-old"].includes(phase)) await authorizeRecovery();
      else await authorize();
      await writePrivateFile(
        root,
        `${phase}.json`,
        encode({
          version: 1,
          kind: "platform-configuration-checkpoint",
          operationId,
          planSha256,
          phase,
          dispatch,
          authorization,
        }),
      );
    };
    const verifyRestoreSource = async () => {
      const observed = await inventory({ allowMissingApi: true });
      if (observed !== null) {
        if (observed.Id === before.Id) same(descriptor(observed), plan.before.api);
        else candidateRecipe(before, observed, plan, false);
        ensure(
          observed.State &&
            observed.State.Paused === false &&
            observed.State.Restarting === false &&
            observed.State.Dead === false &&
            (!observed.State.Running
              ? observed.State.Pid === 0
              : observed.State.Status === "running"),
        );
      }
      await verifyInvariants();
    };
    const replace = async (runtime) => {
      if (runtime === plan.runtime.path) {
        await authorize();
        const observed = await inventory();
        originalApi(observed);
        await verifyInvariants();
      } else {
        await authorizeRecovery();
        await verifyRestoreSource();
      }
      const spec = compose(runtime);
      try {
        await command(
          [
            ...spec.args,
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "--no-deps",
            "--force-recreate",
            "api",
          ],
          { interpolation: spec.env, timeoutMs: 180000 },
        );
      } catch (cause) {
        const evidence = sanitizeHostFailure(cause, {
          operationId,
          phase: "admitted",
          boundary: "command",
          commandCategory: "api-up",
        });
        const knownProcessOutcome =
          cause?.code === "ERR_HOST_PROCESS" &&
          cause.terminationConfirmed === true &&
          (cause.reason === "spawn" ||
            (cause.reason === "exit" &&
              evidence.executable === "docker" &&
              Number.isSafeInteger(evidence.exitStatus) &&
              evidence.exitStatus > 0));
        // Reaping the Docker CLI does not drain daemon-side create/start work.
        // Only a confirmed spawn refusal or a recorded ordinary nonzero CLI
        // exit can be reconciled through inventory before returning the old API.
        throw failure(cause, !knownProcessOutcome);
      }
    };
    return await withHostState(state, (store) =>
      store.guardPersistence(async () => {
        await verifyFiles();
        for (const phase of [
          "admitted",
          "applying",
          "api-replaced",
          "verified",
          "returning-old",
          "returned-old",
          "receipt",
        ])
          await absent(`${root}/${phase}.json`);
        await absent(`${state}/config-pending.json`);
        const baseline = await json(`${state}/config-base.json`);
        same(await resolveConfigurationRuntime({ root: state, baseline }), plan.before);
        try {
          previousIndex = await read(`${state}/config-index.json`);
        } catch {
          await absent(`${state}/config-index.json`);
          previousIndex = null;
        }
        if (previousIndex === null)
          ensure(plan.previousOperationId === null && plan.previousReceiptSha256 === null);
        else {
          const value = JSON.parse(previousIndex);
          same(value.head, {
            operationId: plan.previousOperationId,
            receiptSha256: plan.previousReceiptSha256,
          });
          let pointer = value.head;
          let depth = 0;
          for (; pointer !== null; depth++) {
            ensure(depth < 32);
            const receipt = await json(
              `${state}/configuration-operations/${pointer.operationId}/receipt.json`,
            );
            ensure(receipt.dispatch.runId !== dispatch.runId);
            pointer =
              receipt.previousOperationId === null
                ? null
                : { operationId: receipt.previousOperationId };
          }
          assertConfigurationSuccessorCapacity(depth);
        }
        const acceptedBytes = await read(
            `${state}/forward-recovery-operations/${plan.acceptedOperationId}/state.json`,
          ),
          acceptedState = JSON.parse(acceptedBytes),
          acceptedIndex = await json(`${state}/upgrade-index.json`);
        ensure(
          acceptedState.sequence === 14 &&
            acceptedState.phase === "healthy" &&
            acceptedState.status === "completed" &&
            acceptedState.admission?.identity?.operationId === plan.acceptedOperationId,
        );
        ensure(
          acceptedIndex.kind === "platform-forward-recovery-index" &&
            acceptedIndex.operationId === plan.acceptedOperationId &&
            acceptedIndex.stateSha256 === digest(acceptedBytes),
        );
        return runConfigurationLifecycle({
          verifyBefore: async () => {
            await authorize();
            await render();
            current = await inventory();
            originalApi(current);
            await verifyInvariants();
            await verifyFiles();
          },
          checkpoint,
          apply: async () => {
            await authorize();
            current = await inventory();
            originalApi(current);
            await verifyInvariants();
            await authorize();
            recoveryAuthorization = Object.freeze(structuredClone(authorization));
            validateUpgradeAuthorization(recoveryAuthorization);
            await writePrivateFile(state, "config-pending.json", pendingBytes);
            pending = true;
            await replace(plan.runtime.path);
          },
          inspectCandidate: async () => {
            current = await inventory();
            candidateRecipe(before, current, plan);
            return descriptor(current);
          },
          verifyAfter: async () => {
            const observed = await inventory();
            same(descriptor(observed), descriptor(current));
            safeState(observed, true);
            if (restored) {
              ownership(observed, before, plan.compose.beforeConfigHash);
              same(rollbackRecipe(before), rollbackRecipe(observed));
            } else candidateRecipe(before, observed, plan);
            await verifyInvariants();
            await verifyFiles();
          },
          suggestions: async () => {
            const response = JSON.parse(
              (
                await command(
                  ["exec", "--user", "1000:1000", current.Id, "node", "--eval", suggestionsScript],
                  { timeoutMs: 30000 },
                )
              ).stdout,
            );
            ensure(Array.isArray(response) && response.length === 3);
            for (const item of response) {
              keys(item, ["status", "count"]);
              ensure(
                item.status === "ready" &&
                  Number.isSafeInteger(item.count) &&
                  item.count > 0 &&
                  item.count <= 10,
              );
            }
          },
          restoreBefore: async () => {
            if (accepted || !pending) throw failure(undefined, true);
            try {
              await replace(plan.before.runtime.path);
            } catch (error) {
              throw failure(error, true);
            }
            restored = true;
          },
          inspectRestored: async () => {
            current = await inventory();
            ownership(current, before, plan.compose.beforeConfigHash);
            ensure(current.Id !== before.Id);
            safeState(current, true);
            same(rollbackRecipe(before), rollbackRecipe(current));
            return descriptor(current);
          },
          accept: async (status, api) => {
            if (status === "returned-old") await authorizeRecovery();
            else await authorize();
            await verifyInvariants();
            const observed = await inventory();
            same(descriptor(observed), api);
            safeState(observed, true);
            if (restored) same(rollbackRecipe(before), rollbackRecipe(observed));
            else candidateRecipe(before, observed, plan);
            if (status === "returned-old") await authorizeRecovery();
            else await authorize();
            const after = {
              api,
              runtime: status === "healthy" ? plan.runtime : plan.before.runtime,
            };
            const receipt = {
              version: 1,
              kind: "platform-configuration-successor",
              operationId,
              acceptedOperationId: plan.acceptedOperationId,
              planSha256,
              previousOperationId: plan.previousOperationId,
              previousReceiptSha256: plan.previousReceiptSha256,
              status,
              before: { api: plan.before.api, runtime: plan.before.runtime },
              after,
              dispatch,
              authorization,
            };
            // Once terminal publication starts, any persistence ambiguity forbids rollback.
            accepted = true;
            try {
              const receiptBytes = encode(receipt);
              await writePrivateFile(root, "receipt.json", receiptBytes);
              await verifyFiles();
              ensure((await readPrivateFile(root, "receipt.json")).equals(receiptBytes));
              const indexBytes = encode({
                version: 1,
                kind: "platform-configuration-index",
                head: { operationId, receiptSha256: digest(receiptBytes) },
              });
              await writePrivateFile(state, "config-index.json", indexBytes, {
                replace: previousIndex !== null,
              });
              await verifyFiles({ checkIndex: false });
              ensure((await readPrivateFile(state, "config-index.json")).equals(indexBytes));
              await unlink(`${state}/config-pending.json`);
              await syncPrivateDirectory(state);
              pending = false;
              same(await resolveConfigurationRuntime({ root: state, baseline }), {
                acceptedOperationId: plan.acceptedOperationId,
                ...after,
              });
            } catch (error) {
              throw failure(error, true);
            }
            return { status, operationId, apiId: api.id };
          },
        }).catch((error) => {
          lifecycleFailure = error;
          throw error;
        });
      }),
    );
  } catch (error) {
    const safe = failure(error);
    if (lifecycleFailure?.restored === true) safe.restored = true;
    if (lifecycleFailure?.recoveryRequired === true) safe.recoveryRequired = true;
    throw safe;
  }
}
