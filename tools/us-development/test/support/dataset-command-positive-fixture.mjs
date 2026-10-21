import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
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

export function assertDatasetPositiveDatabase(identity, tables) {
  assert.deepEqual(identity, [
    { name: "markiro_us_dev", owner: "markiro_us", database_owner: "markiro_us" },
  ]);
  assert.equal(tables.length, 0);
}

export function assertDatasetPositiveContainer(item, target) {
  assertDatasetObjectStoreContainer(item, target);
}

// Output is held in memory. Never echo raw Docker/provider errors/output.
async function child(file, args, { env = process.env, cap = 60_000, limit = 256 * 1024 } = {}) {
  const started = performance.now();
  const process_ = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
      },
    });
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), ...measurement };
}

export async function createDatasetPositiveFixture(env = process.env) {
  assertDatasetPositiveRunner(env);
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0)
    throw new Error("us_dataset_object_store_config_failed");
  const setupStarted = performance.now();
  const root = process.cwd();
  const git = await child("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(git.stdout, "", "positive requires an actual clean checkout");
  const require = createRequire(resolve("apps/api/package.json"));
  await child("/usr/bin/time", ["--version"]);
  const environment = {
    ...parseEnv(await readFile("deploy/us-development/local.env.example", "utf8")),
  };
  const { createDb } = require("@markiro/db");
  const { migrate } = require("drizzle-orm/node-postgres/migrator");
  const sdk = require("@aws-sdk/client-s3");
  const { NodeHttpHandler } = require("@smithy/node-http-handler");
  const compiled = (path) => require(resolve(`apps/api/dist/${path}.js`));
  const { loadUsRequestBuildDescriptor } = compiled("deployment/us-request-build-descriptor");
  const checked = await loadUsRequestBuildDescriptor(environment);
  assert.equal(
    checked.document.build.gitSha,
    (await child("git", ["rev-parse", "HEAD"])).stdout.trim(),
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
    await migrate(connection.db, { migrationsFolder: resolve("packages/db/migrations") });
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
    const snapshotSource = await readFile("apps/api/test/support/us-dataset-snapshot.ts", "utf8");
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
        const result = await child(
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
          { env: environment, cap: 900_000 },
        );
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
