import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { startDatasetProviderObservation } from "./dataset-command-provider.mjs";
import {
  datasetObjectStoreConfig,
  datasetObjectStoreContainer,
  assertDatasetObjectStoreContainer,
  verifyDatasetObjectStoreCapabilities,
  datasetObjectStoreFailureCategory,
} from "./dataset-command-object-store.mjs";

export const DATABASE_URL =
  "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
export const datasetFixtureRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(
  /\/$/,
  "",
);

/** This synchronous boundary precedes imports, filesystem, child, DB and network I/O. */
export function assertDatasetPositiveRunner(env = process.env, platform = process.platform) {
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_JOB !== "dataset_command_positive" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    platform !== "linux" ||
    env.US_TEST_DATABASE_URL !== DATABASE_URL ||
    env.NODE_OPTIONS ||
    env.NODE_PATH
  )
    throw new Error("us_dataset_positive_ci_only");
}

/** Pure predicate only; the actual viewer entry always reads the real process. */
export function assertDemoViewerRunner(env = process.env, platform = process.platform) {
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_JOB !== "demo_viewer_acceptance" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    platform !== "linux" ||
    env.US_TEST_DATABASE_URL !== DATABASE_URL ||
    env.NODE_OPTIONS ||
    env.NODE_PATH
  )
    throw new Error("us_demo_viewer_ci_only");
}

export function assertDatasetPositiveDatabase(identity, tables) {
  assert.deepEqual(identity, [
    { name: "markiro_us_dev", owner: "markiro_us", database_owner: "markiro_us" },
  ]);
  assert.equal(tables.length, 0);
}

export function assertDatasetPositiveContainer(item, target) {
  assertDatasetObjectStoreContainer(item, target);
}

// Test-only access to the real bounded child runner; not a fixture/proof override.
export { child as runDatasetPositiveChild, commandDiagnostic as datasetPositiveCommandDiagnostic };

function commandDiagnostic(
  text,
  diagnose,
  projectVerificationFailure,
  projectStorageReadFailureCode,
  projectTransportWitness,
) {
  try {
    if (
      typeof diagnose !== "function" ||
      typeof projectVerificationFailure !== "function" ||
      typeof text !== "string" ||
      text.length > 4096 ||
      !/^\{[^\r\n]*\}\n?$/.test(text)
    )
      return { status: "unavailable" };
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed);
    if (
      !keys.includes("code") ||
      keys.some(
        (key) =>
          ![
            "code",
            "unitKey",
            "stage",
            "verificationFailure",
            "verificationStorageCode",
            "verificationTransportWitness",
          ].includes(key),
      ) ||
      keys.some(
        (key) =>
          key !== "verificationFailure" &&
          key !== "verificationStorageCode" &&
          typeof parsed[key] !== "string",
      ) ||
      keys.includes("unitKey") !== keys.includes("stage") ||
      ![JSON.stringify(parsed), `${JSON.stringify(parsed)}\n`].includes(text)
    )
      return { status: "unavailable" };
    // This is the concrete compiled runtime sanitizer at the actual CLI call site.
    // Never forward the parsed object, raw text, cause, message or extra fields.
    const safe = diagnose({ message: parsed.code, unitKey: parsed.unitKey, stage: parsed.stage });
    let verificationFailure;
    if (keys.includes("verificationFailure")) {
      if (
        parsed.code !== "us_dataset_command_failed" ||
        !["request_scenario_a", "request_april", "request_september"].includes(parsed.unitKey) ||
        parsed.stage !== "package" ||
        safe.code !== parsed.code ||
        safe.unitKey !== parsed.unitKey ||
        safe.stage !== parsed.stage
      )
        return { status: "unavailable" };
      verificationFailure = projectVerificationFailure(parsed.verificationFailure);
      if (!verificationFailure) return { status: "unavailable" };
    }
    let verificationStorageCode;
    if (keys.includes("verificationStorageCode")) {
      if (
        typeof projectStorageReadFailureCode !== "function" ||
        verificationFailure?.operation !== "read_private_object"
      )
        return { status: "unavailable" };
      verificationStorageCode = projectStorageReadFailureCode(parsed.verificationStorageCode);
      if (!verificationStorageCode || verificationStorageCode !== parsed.verificationStorageCode)
        return { status: "unavailable" };
    }
    let verificationTransportWitness;
    if (keys.includes("verificationTransportWitness")) {
      if (
        typeof projectTransportWitness !== "function" ||
        verificationStorageCode !== "us_request_package_storage_transport_failed"
      )
        return { status: "unavailable" };
      verificationTransportWitness = projectTransportWitness(parsed.verificationTransportWitness);
      if (
        !verificationTransportWitness ||
        verificationTransportWitness !== parsed.verificationTransportWitness
      )
        return { status: "unavailable" };
    }
    return {
      status: "available",
      code: safe.code,
      ...(safe.unitKey && safe.stage ? { unitKey: safe.unitKey, stage: safe.stage } : {}),
      ...(verificationFailure
        ? {
            verificationFailure,
            verificationOperation: verificationFailure.operation,
            ...(Object.hasOwn(verificationFailure, "artifact")
              ? { verificationArtifact: verificationFailure.artifact }
              : {}),
          }
        : {}),
      ...(verificationStorageCode ? { verificationStorageCode } : {}),
      ...(verificationTransportWitness ? { verificationTransportWitness } : {}),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export async function retainDatasetPositiveCommandFailure(error, mode, timeFile, observer) {
  try {
    let measurement = { status: "unavailable" };
    let cpu;
    try {
      const time = await readFile(timeFile, "utf8");
      if (time.length <= 16 * 1024) {
        const user = [...time.matchAll(/^\tUser time \(seconds\): ([^\r\n]*)$/gm)];
        const system = [...time.matchAll(/^\tSystem time \(seconds\): ([^\r\n]*)$/gm)];
        if (user.length === 1 && system.length === 1) {
          const values = [user[0][1], system[0][1]];
          const milliseconds = values.map((value) => Math.round(Number(value) * 1000));
          if (
            values.every((value) => /^\d+(?:\.\d{1,6})?$/.test(value)) &&
            milliseconds.every(
              (value) => Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000,
            )
          )
            cpu = { userCpuMs: milliseconds[0], systemCpuMs: milliseconds[1] };
        }
        const rss = [...time.matchAll(/^\tMaximum resident set size \(kbytes\): ([^\r\n]*)$/gm)];
        const exit = [...time.matchAll(/^\tExit status: ([^\r\n]*)$/gm)];
        const maximumRssKiB = Number(rss[0]?.[1]),
          exitStatus = Number(exit[0]?.[1]);
        if (
          rss.length === 1 &&
          exit.length === 1 &&
          /^\d+$/.test(rss[0][1]) &&
          /^\d+$/.test(exit[0][1]) &&
          Number.isSafeInteger(maximumRssKiB) &&
          maximumRssKiB > 0 &&
          Number.isSafeInteger(exitStatus) &&
          exitStatus >= 0 &&
          exitStatus <= 255
        )
          measurement = { status: "available", maximumRssKiB, exitStatus };
      }
    } catch {
      /* Missing/unreadable timing evidence cannot replace the CLI failure. */
    }
    let provider = { status: "unavailable" };
    try {
      const counts = observer.counts();
      const keys = ["reads", "mutations", "failures", "active"];
      const values = keys.map((key) => Object.getOwnPropertyDescriptor(counts, key)?.value);
      if (values.every((value) => Number.isSafeInteger(value) && value >= 0))
        provider = {
          status: "available",
          ...Object.fromEntries(keys.map((key, index) => [key, values[index]])),
        };
    } catch {
      /* Diagnostic counter failures cannot mask the original error. */
    }
    if (["initialize", "verify"].includes(mode))
      error.command = { mode, measurement, provider, ...(cpu ? { cpu } : {}) };
  } catch {
    /* Even a frozen/hostile error must escape unchanged. */
  }
  return error;
}

// Output is held in memory. Never echo raw Docker/provider errors/output.
async function child(
  file,
  args,
  {
    env = process.env,
    cap = 60_000,
    limit = 256 * 1024,
    diagnose,
    projectVerificationFailure,
    projectStorageReadFailureCode,
    projectTransportWitness,
    cwd,
  } = {},
) {
  const started = performance.now();
  const process_ = spawn(file, args, {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    overflow = false,
    timedOut = false;
  let timeoutWork;
  const stop = () => {
    if (timeoutWork) return;
    if (file !== "/usr/bin/time") {
      process_.kill("SIGTERM");
      return;
    }
    // GNU time must remain alive to wait4/reap the sole actual CLI process.
    // Signal its owned child, then await time's close before touching resources.
    timeoutWork = (async () => {
      const children = await readFile(
        `/proc/${process_.pid}/task/${process_.pid}/children`,
        "utf8",
      ).catch(() => "");
      const pids = children.trim().split(/\s+/).filter(Boolean);
      if (pids.length === 1 && /^\d+$/.test(pids[0])) {
        try {
          process.kill(Number(pids[0]), "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    })();
    // Awaited after process close; immediately observe rejection as well.
    void timeoutWork.catch(() => {});
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, cap);
  const capture = (name, bytes) => {
    const previous = name === "stdout" ? stdout : stderr;
    if (previous.length + bytes.length > limit) {
      overflow = true;
      stop();
      return;
    }
    if (name === "stdout") stdout = Buffer.concat([stdout, bytes]);
    else stderr = Buffer.concat([stderr, bytes]);
  };
  process_.stdout.on("data", (bytes) => capture("stdout", bytes));
  process_.stderr.on("data", (bytes) => capture("stderr", bytes));
  let spawnError;
  process_.on("error", () => {
    spawnError = true;
  });
  const result = await new Promise((accept) =>
    process_.on("close", (code, signal) => accept({ code, signal })),
  );
  clearTimeout(timer);
  await timeoutWork;
  const measurement = { elapsedMs: performance.now() - started };
  if (
    timedOut ||
    measurement.elapsedMs > cap ||
    overflow ||
    spawnError ||
    result.code !== 0 ||
    result.signal
  )
    throw Object.assign(new Error("us_dataset_positive_child_failed"), {
      evidence: {
        file,
        code: result.code,
        signal: result.signal,
        timedOut,
        overflow,
        ...measurement,
        ...(diagnose
          ? {
              diagnostic: overflow
                ? { status: "unavailable" }
                : commandDiagnostic(
                    stderr.toString("utf8"),
                    diagnose,
                    projectVerificationFailure,
                    projectStorageReadFailureCode,
                    projectTransportWitness,
                  ),
            }
          : {}),
      },
    });
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), ...measurement };
}

export async function createDatasetPositiveFixture(env = process.env) {
  assertDatasetPositiveRunner(env);
  return acquireDatasetInstallation();
}

export function observeDatasetInitializeFailures(installation, sink) {
  let pending;
  let closed = false;
  let emitted = false;
  const own = (object, key) => {
    if ((typeof object !== "object" || object === null) && typeof object !== "function")
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const integer = (value, maximum) =>
    Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : -1;
  const flag = (value) => (value === true ? 1 : value === false ? 0 : -1);
  const index = (value, values) => values.indexOf(value) + 1;
  const capture = (error) => {
    try {
      if (closed || pending) return;
      const message = own(error, "message");
      const kind = index(message, [
        "us_dataset_positive_child_failed",
        "us_dataset_positive_pool_failed",
      ]);
      const evidence = kind === 1 ? own(error, "evidence") : undefined;
      const diagnostic = own(evidence, "diagnostic");
      const command = kind === 1 ? own(error, "command") : undefined;
      const measurement = own(command, "measurement");
      const provider = own(command, "provider");
      const unit = index(own(diagnostic, "unitKey"), [
        "request_scenario_a",
        "request_april",
        "request_september",
      ]);
      const packageStage = own(diagnostic, "stage") === "package" ? 1 : 0;
      const operation = own(diagnostic, "verificationOperation") === "read_private_object" ? 1 : 0;
      const storage = index(own(diagnostic, "verificationStorageCode"), [
        "us_request_package_storage_scope_invalid",
        "us_request_package_storage_evidence_invalid",
        "us_request_package_storage_timeout",
        "us_request_package_storage_checksum_mismatch",
        "us_request_package_storage_transport_failed",
        "us_request_package_storage_read_failed",
        "us_request_worker_unknown_failure",
      ]);
      const failed = own(diagnostic, "code") === "us_dataset_command_failed" ? 1 : 0;
      const transport =
        failed && unit && packageStage && operation && storage === 5
          ? index(own(diagnostic, "verificationTransportWitness"), [
              "await_send:code:ECONNRESET",
              "await_send:code:ECONNRESET:new-before-response",
              "await_send:code:ECONNRESET:reused-before-response",
              "await_send:code:ECONNRESET:new-after-response",
              "await_send:code:ECONNRESET:reused-after-response",
              "consume_body:code:ECONNRESET",
              "await_send:code:ECONNRESET:reused-before-response:idle-lt-6000:wait-lt-1000",
              "await_send:code:ECONNRESET:reused-before-response:idle-lt-6000:wait-ge-1000",
              "await_send:code:ECONNRESET:reused-before-response:idle-ge-6000:wait-lt-1000",
              "await_send:code:ECONNRESET:reused-before-response:idle-ge-6000:wait-ge-1000",
            ])
          : 0;
      const elapsed = own(evidence, "elapsedMs");
      pending = `US_DEMO_VIEWER_INITIALIZE_OBSERVATION ${JSON.stringify({
        kind,
        exitCode: integer(own(evidence, "code"), 255),
        timedOut: flag(own(evidence, "timedOut")),
        overflow: flag(own(evidence, "overflow")),
        elapsedMs:
          typeof elapsed === "number" &&
          Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed <= 1_000_000
            ? Math.floor(elapsed)
            : -1,
        failed,
        unit,
        packageStage,
        operation,
        storage,
        transport,
        artifact: index(own(diagnostic, "verificationArtifact"), [
          "manifest.json",
          "package.zip",
          "plan.pdf",
          "records.xlsx",
          "request-report.pdf",
          "validation.json",
        ]),
        maximumRssKiB: integer(own(measurement, "maximumRssKiB"), 33_554_432),
        userCpuMs: integer(own(own(command, "cpu"), "userCpuMs"), 86_400_000),
        systemCpuMs: integer(own(own(command, "cpu"), "systemCpuMs"), 86_400_000),
        reads: integer(own(provider, "reads"), 1_000_000),
        mutations: integer(own(provider, "mutations"), 1_000_000),
        failures: integer(own(provider, "failures"), 1_000_000),
        active: integer(own(provider, "active"), 1_000_000),
      })}`;
    } catch {
      pending = 'US_DEMO_VIEWER_INITIALIZE_OBSERVATION {"kind":0}';
    }
  };
  const finish = () => {
    closed = true;
    if (emitted || !pending) return;
    emitted = true;
    const line = pending;
    pending = undefined;
    try {
      sink(line);
    } catch {
      /* Observation cannot mask command or disposal results. */
    }
  };
  return {
    ...installation,
    command(mode) {
      const result = installation.command(mode);
      if (mode === "initialize") void result.then(undefined, capture);
      return result;
    },
    close() {
      const result = installation.close();
      void result.then(finish, finish);
      return result;
    },
  };
}

export async function createDemoViewerInstallationFixture() {
  assertDemoViewerRunner();
  return observeDatasetInitializeFailures(await acquireDatasetInstallation(), (line) =>
    console.error(line),
  );
}

async function acquireDatasetInstallation() {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0)
    throw new Error("us_dataset_object_store_config_failed");
  const setupStarted = performance.now();
  const root = datasetFixtureRoot;
  const git = await child("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(git.stdout, "", "positive requires an actual clean checkout");
  const require = createRequire(resolve(root, "apps/api/package.json"));
  await child("/usr/bin/time", ["--version"]);
  const environment = {
    ...parseEnv(await readFile(resolve(root, "deploy/us-development/local.env.example"), "utf8")),
  };
  const { createDb } = require("@markiro/db");
  const { migrate } = require("drizzle-orm/node-postgres/migrator");
  const sdk = require("@aws-sdk/client-s3");
  const { NodeHttpHandler } = require("@smithy/node-http-handler");
  const compiled = (path) => require(resolve(root, `apps/api/dist/${path}.js`));
  const { loadUsRequestBuildDescriptor } = compiled("deployment/us-request-build-descriptor");
  const checked = await loadUsRequestBuildDescriptor(environment);
  assert.equal(
    checked.document.build.gitSha,
    (await child("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
  );
  assert.ok(
    checked.document.files.some(
      (file) => file.tree === "api" && file.path === "main.us-dataset.js",
    ),
  );
  const owner = randomUUID();
  const buckets = [`dataset-plan-${owner}`, `dataset-package-${owner}`];
  const accounts = ["admin", "plan", "request"].map((role) => ({
    name: `dataset-${role}-${owner}`,
    accountId: `dataset-${role}-${owner}`,
    accessKeyId: randomBytes(16).toString("hex"),
    secretAccessKey: randomBytes(32).toString("hex"),
  }));
  const ids = new Map();
  const clients = new Set();
  let poolFailure;
  let databaseOwned = false,
    connection,
    observer,
    directory,
    closed,
    storeContract,
    imageInspection,
    configBytes,
    disposalStarted;
  const remaining = (started) => {
    const cap = Math.floor(60_000 - (performance.now() - started));
    if (cap <= 0) throw new Error("us_dataset_positive_phase_exceeded");
    return cap;
  };
  const docker = async (args) => {
    try {
      return await child("docker", args, { cap: remaining(disposalStarted ?? setupStarted) });
    } catch (error) {
      const operations = new Set([
        "create",
        "inspect",
        "image",
        "start",
        "stop",
        "rm",
        "container",
      ]);
      console.info(
        "Positive fixture provider operation failed",
        JSON.stringify({
          operation: operations.has(args[0]) ? args[0] : "unknown",
          category: datasetObjectStoreFailureCategory(error),
          image: storeContract?.image,
        }),
      );
      throw Object.assign(new Error("us_dataset_object_store_child_failed"), {
        category: datasetObjectStoreFailureCategory(error),
      });
    }
  };
  async function assertConfig() {
    const file = await lstat(storeContract.configPath),
      parent = await lstat(directory);
    if (
      !file.isFile() ||
      file.uid !== uid ||
      file.gid !== gid ||
      (file.mode & 0o777) !== 0o600 ||
      !parent.isDirectory() ||
      parent.uid !== uid ||
      parent.gid !== gid ||
      (parent.mode & 0o777) !== 0o700 ||
      !(await readFile(storeContract.configPath)).equals(configBytes)
    )
      throw new Error("us_dataset_object_store_config_failed");
  }
  async function inspect(id) {
    assert.match(id, /^[a-f0-9]{64}$/);
    const result = JSON.parse((await docker(["inspect", id])).stdout);
    assert.equal(result.length, 1);
    const item = result[0];
    assertDatasetPositiveContainer(item, { ...storeContract, id, uid, gid, imageInspection });
    await assertConfig();
    return item;
  }
  async function ownContainer() {
    await assertConfig();
    const result = await docker(storeContract.args);
    const id = result.stdout.trim();
    const acquired = await docker(["image", "inspect", storeContract.image]);
    let images;
    try {
      images = JSON.parse(acquired.stdout);
    } catch {
      throw new Error("us_dataset_object_store_image_inspection_failed");
    }
    if (
      !Array.isArray(images) ||
      images.length !== 1 ||
      !images[0] ||
      typeof images[0] !== "object"
    )
      throw new Error("us_dataset_object_store_image_inspection_failed");
    // Cache actual acquired metadata; cleanup must attest the same immutable ID.
    imageInspection = images[0];
    // Until inspection succeeds this ID is unknown and cannot be cleaned here.
    const item = await inspect(id);
    ids.set(id, item.Image);
    console.info(
      "Positive fixture container ownership attested",
      JSON.stringify({ id, image: storeContract.image, imageId: item.Image }),
    );
    return id;
  }
  async function remove(id) {
    const imageId = ids.get(id);
    if (!imageId) throw new Error("us_dataset_positive_unknown_container");
    assert.equal((await inspect(id)).Image, imageId);
    await docker(["rm", id]);
    const remaining = (
      await docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`])
    ).stdout.trim();
    assert.equal(remaining, "");
    ids.delete(id);
  }
  function s3(credentials, anonymous = false) {
    const client = new sdk.S3Client({
      endpoint: "http://127.0.0.1:19002",
      region: "us-east-1",
      forcePathStyle: true,
      credentials,
      ...(anonymous ? { signer: { sign: async (request) => request } } : {}),
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3000,
        requestTimeout: 15000,
        socketTimeout: 10000,
        throwOnRequestTimeout: true,
      }),
    });
    clients.add(client);
    return client;
  }
  async function close() {
    if (closed) return closed;
    closed = (async () => {
      disposalStarted = performance.now();
      const failures = [];
      const settle = async (action) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      for (const client of clients) client.destroy();
      await settle(async () => {
        await observer?.close();
      });
      await settle(async () => {
        await connection?.pool.end();
      });
      if (poolFailure) failures.push(poolFailure);
      if (databaseOwned)
        await settle(async () => {
          const admin = createDb(DATABASE_URL.replace("/markiro_us_dev", "/postgres"), {
            max: 2,
            connectionTimeoutMillis: 2000,
            statement_timeout: 15000,
          });
          try {
            assert.deepEqual(
              (await admin.pool.query("SELECT current_database() AS name,current_user AS owner"))
                .rows,
              [{ name: "postgres", owner: "markiro_us" }],
            );
            await admin.pool.query('DROP DATABASE "markiro_us_dev"');
            assert.equal(
              (
                await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [
                  "markiro_us_dev",
                ])
              ).rowCount,
              0,
            );
            console.info("Positive fixture database normally dropped and catalog absence verified");
          } finally {
            await admin.pool.end();
          }
        });
      for (const [id, imageId] of ids)
        await settle(async () => {
          const item = await inspect(id);
          assert.equal(item.Image, imageId);
          if (item.State.Running) await docker(["stop", id]);
          await remove(id);
          console.info(`Positive fixture container normally removed and absence verified: ${id}`);
        });
      if (directory) await settle(() => rm(directory, { recursive: true }));
      if (performance.now() - disposalStarted > 60_000)
        failures.push(new Error("us_dataset_positive_disposal_exceeded"));
      if (failures.length)
        throw new AggregateError(failures, "us_dataset_positive_disposal_failed");
    })();
    return closed;
  }
  try {
    connection = createDb(DATABASE_URL, {
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 15000,
    });
    connection.pool.on("error", (error) => {
      poolFailure ??= error;
    });
    const identityRows = (
      await connection.pool.query(
        "SELECT current_database() AS name,current_user AS owner,pg_get_userbyid(datdba) AS database_owner FROM pg_database WHERE datname=current_database()",
      )
    ).rows;
    const tableRows = (
      await connection.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
      )
    ).rows;
    assertDatasetPositiveDatabase(identityRows, tableRows);
    databaseOwned = true;
    await migrate(connection.db, { migrationsFolder: resolve(root, "packages/db/migrations") });
    const { UsDevelopmentOwnerStore } = compiled("deployment/us-development-owner");
    const { UsProfileStore } = compiled("modules/traceability/profile/us-profile-store");
    const identity = await new UsDevelopmentOwnerStore(connection.db).provision(
      randomBytes(32).toString("hex"),
      randomUUID(),
    );
    assert.equal(identity.status, "created");
    await new UsProfileStore(connection.db).provision(
      identity.tenantId,
      identity.userId,
      { code: "US_FSMA204_PROCESSOR", timeZone: "America/Los_Angeles" },
      randomUUID(),
    );
    directory = await mkdtemp(join(tmpdir(), "us-dataset-positive-"));
    await chmod(directory, 0o700);
    const ts = require("typescript");
    const snapshotSource = await readFile(
      resolve(root, "apps/api/test/support/us-dataset-snapshot.ts"),
      "utf8",
    );
    const snapshotPath = join(directory, "snapshot.cjs");
    await writeFile(
      snapshotPath,
      ts.transpileModule(snapshotSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      { mode: 0o600, flag: "wx" },
    );
    const { snapshotUsDatasetTables } = require(snapshotPath);
    storeContract = datasetObjectStoreContainer({
      owner,
      uid,
      gid,
      configPath: join(directory, "s3.json"),
    });
    configBytes = Buffer.from(
      JSON.stringify(datasetObjectStoreConfig({ ...storeContract, uid, gid, buckets, accounts })),
    );
    await writeFile(storeContract.configPath, configBytes, { mode: 0o600, flag: "wx" });
    const id = await ownContainer();
    await docker(["start", id]);
    const rootClient = s3(accounts[0]);
    const signal = AbortSignal.timeout(remaining(setupStarted));
    // Only readiness is polled; commands, setup probes and dataset calls never retry.
    let healthy = false;
    while (performance.now() - setupStarted < 60_000) {
      try {
        await rootClient.send(new sdk.ListBucketsCommand({}), { abortSignal: signal });
        healthy = true;
        break;
      } catch {
        if (signal.aborted) break;
      }
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (!healthy) throw new Error("us_dataset_object_store_readiness_failed");
    try {
      for (const bucket of buckets)
        await rootClient.send(new sdk.CreateBucketCommand({ Bucket: bucket }), {
          abortSignal: signal,
        });
    } catch (error) {
      throw Object.assign(new Error("us_dataset_object_store_bootstrap_failed"), {
        category: datasetObjectStoreFailureCategory(error),
      });
    }
    const credentials = accounts
      .slice(1)
      .map(({ accessKeyId, secretAccessKey }) => ({ accessKeyId, secretAccessKey }));
    // Only the anonymous negative probes omit signing; real SDK HTTP still runs.
    const anonymous = s3(
      { accessKeyId: "anonymous-probe", secretAccessKey: "anonymous-probe" },
      true,
    );
    const capabilities = await verifyDatasetObjectStoreCapabilities({
      admin: rootClient,
      plan: s3(credentials[0]),
      request: s3(credentials[1]),
      anonymous,
      buckets,
      signal,
    });
    console.info(
      "Positive fixture provider capabilities verified",
      JSON.stringify({ image: storeContract.image, ...capabilities }),
    );
    observer = await startDatasetProviderObservation({ port: 19000, upstreamPort: 19002 });
    for (const [index, prefix] of ["US_PLAN_ARTIFACT_S3", "US_REQUEST_PACKAGE_S3"].entries())
      Object.assign(environment, {
        [`${prefix}_ENDPOINT`]: "http://127.0.0.1:19000",
        [`${prefix}_REGION`]: "us-east-1",
        [`${prefix}_BUCKET`]: buckets[index],
        [`${prefix}_ACCESS_KEY_ID`]: credentials[index].accessKeyId,
        [`${prefix}_SECRET_ACCESS_KEY`]: credentials[index].secretAccessKey,
        [`${prefix}_FORCE_PATH_STYLE`]: "true",
      });
    const { usSixMonthDefinition } = compiled("modules/traceability/demo/us-six-month-definition");
    const { usDatasetCommandDiagnostic } = compiled("deployment/us-dataset-command-runtime");
    const { projectUsRequestVerificationFailure } = compiled(
      "modules/traceability/requests/us-request-verification-failure",
    );
    const pairs = [
      "--database-name",
      "markiro_us_dev",
      "--database-user",
      "markiro_us",
      "--tenant-id",
      identity.tenantId,
      "--owner-id",
      identity.userId,
      "--version",
      usSixMonthDefinition.version,
      "--definition-digest",
      usSixMonthDefinition.digest,
    ];
    assert.ok(performance.now() - setupStarted <= 60_000, "positive setup exceeded 60000ms");
    const invoked = new Set();
    const { projectUsRequestPackageStorageReadFailureCode } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
    const { projectUsRequestPackageTransportWitness } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
    return {
      ...connection,
      identity,
      observer,
      environment,
      compiled,
      require,
      sdk,
      buckets,
      snapshot: () => snapshotUsDatasetTables(connection.pool),
      async command(mode) {
        if (poolFailure) throw new Error("us_dataset_positive_pool_failed", { cause: poolFailure });
        assert.ok(["initialize", "verify"].includes(mode) && !invoked.has(mode));
        if (mode === "verify") assert.ok(invoked.has("initialize"));
        invoked.add(mode);
        const timeFile = join(directory, `time-${mode}.txt`);
        await writeFile(timeFile, "", { mode: 0o600, flag: "wx" });
        let result;
        try {
          result = await child(
            "/usr/bin/time",
            [
              "-v",
              "-o",
              timeFile,
              process.execPath,
              resolve(root, "apps/api/dist/main.us-dataset.js"),
              mode,
              ...(mode === "initialize" ? ["--confirm-local-synthetic-dataset"] : []),
              ...pairs,
            ],
            {
              env: environment,
              cwd: root,
              cap: 900_000,
              diagnose: usDatasetCommandDiagnostic,
              projectVerificationFailure: projectUsRequestVerificationFailure,
              projectStorageReadFailureCode: projectUsRequestPackageStorageReadFailureCode,
              projectTransportWitness: projectUsRequestPackageTransportWitness,
            },
          );
        } catch (error) {
          throw await retainDatasetPositiveCommandFailure(error, mode, timeFile, observer);
        }
        const time = await readFile(timeFile, "utf8");
        const maximumRssKiB = Number(
          time.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1],
        );
        assert.ok(Number.isSafeInteger(maximumRssKiB) && maximumRssKiB > 0);
        await rm(timeFile);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /^\{[^\n]+\}\n$/);
        const summary = JSON.parse(result.stdout);
        if (poolFailure) throw new Error("us_dataset_positive_pool_failed", { cause: poolFailure });
        return { summary, elapsedMs: result.elapsedMs, maximumRssKiB };
      },
      async privateBytes() {
        const values = [];
        for (const bucket of buckets) {
          let listed;
          try {
            listed = await rootClient.send(new sdk.ListObjectsV2Command({ Bucket: bucket }));
          } catch (error) {
            throw Object.assign(new Error("us_dataset_object_store_measurement_failed"), {
              category: datasetObjectStoreFailureCategory(error),
            });
          }
          assert.ok(!listed.IsTruncated);
          values.push((listed.Contents ?? []).reduce((n, object) => n + object.Size, 0));
        }
        return { plan: values[0], packages: values[1] };
      },
      close: async () => {
        const start = performance.now();
        await close();
        assert.ok(performance.now() - start <= 60_000, "positive disposal exceeded 60000ms");
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "us_dataset_positive_setup_and_disposal_failed", {
        cause: cleanup,
      });
    }
    throw error;
  }
}
