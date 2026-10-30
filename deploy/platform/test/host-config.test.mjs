import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertPrivateRoot, readPrivateFile, writePrivateFile } from "../host/files.mjs";
import * as hostConfig from "../host/config.mjs";
import { hostChildEnvironment, snapshotHostConfig } from "../host/config.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { envBytes, privateFixture } from "./host-fixtures.mjs";

const sentinel = "DO-NOT-LEAK-SECRET-OR-PATH";
const interpolationKeys = [
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
  "MARKIRO_PLATFORM_ENV_FILE",
].sort();
const safeError = (error) => {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /DO-NOT-LEAK|markiro-host-|ENOENT|EEXIST|ELOOP|\/private\//);
  return true;
};

test("private root is canonical, owned, private and behind safe ancestors", async (t) => {
  const f = await privateFixture(t);
  await assertPrivateRoot(f.root);
  for (const root of ["relative", `${f.root}/`, `${f.root}/../${f.root.split("/").at(-1)}`])
    await assert.rejects(assertPrivateRoot(root), safeError);
  await symlink(f.root, join(f.root, "alias"));
  await assert.rejects(assertPrivateRoot(join(f.root, "alias")), safeError);
  await chmod(f.root, 0o750);
  await assert.rejects(assertPrivateRoot(f.root), safeError);
  await chmod(f.root, 0o700);
  await mkdir(join(f.root, "unsafe"), { mode: 0o700 });
  await mkdir(join(f.root, "unsafe", "child"), { mode: 0o700 });
  await chmod(join(f.root, "unsafe"), 0o777);
  await assert.rejects(assertPrivateRoot(join(f.root, "unsafe", "child")), safeError);
});

test("private readers reject traversal, permissive directories and unsafe leaf kinds", async (t) => {
  const f = await privateFixture(t);
  assert.deepEqual(await readPrivateFile(f.root, "source.env"), envBytes(f.env));
  for (const relative of [
    "../source.env",
    "/source.env",
    "./source.env",
    "pg/../source.env",
    "pg//ca.crt",
    "pg\\ca.crt",
    "",
    sentinel + "\0",
  ])
    await assert.rejects(readPrivateFile(f.root, relative), safeError);
  await symlink(f.envFile, join(f.root, "leaf-link"));
  await link(f.envFile, join(f.root, "hard-link"));
  await writeFile(join(f.root, "oversized"), Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  assert.equal(spawnSync("mkfifo", ["-m", "600", join(f.root, "fifo")]).status, 0);
  for (const leaf of ["leaf-link", "source.env", "oversized", "pg", "fifo", sentinel])
    await assert.rejects(readPrivateFile(f.root, leaf), safeError);
  await symlink(join(f.root, "pg"), join(f.root, "directory-link"));
  await assert.rejects(readPrivateFile(f.root, "directory-link/ca.crt"), safeError);
  await chmod(join(f.root, "pg"), 0o750);
  await assert.rejects(readPrivateFile(f.root, "pg/ca.crt"), safeError);
  await chmod(join(f.root, "pg"), 0o700);
  for (const mode of [0o644, 0o400, 0o1600]) {
    await chmod(join(f.root, "pg", "ca.crt"), mode);
    await assert.rejects(readPrivateFile(f.root, "pg/ca.crt"), safeError);
  }
});

test("private writer publishes atomically once and replacement is explicit", async (t) => {
  const f = await privateFixture(t);
  await writePrivateFile(f.root, "record.json", Buffer.from("first\n"));
  assert.equal((await lstat(join(f.root, "record.json"))).mode & 0o7777, 0o600);
  await assert.rejects(writePrivateFile(f.root, "record.json", Buffer.from(sentinel)), safeError);
  assert.equal((await readPrivateFile(f.root, "record.json")).toString(), "first\n");
  await writePrivateFile(f.root, "record.json", Buffer.from("replacement\n"), { replace: true });
  assert.equal((await readPrivateFile(f.root, "record.json")).toString(), "replacement\n");
  assert.equal((await lstat(join(f.root, "record.json"))).nlink, 1);
  assert.deepEqual((await readdir(f.root)).sort(), ["docker", "pg", "record.json", "source.env"]);
});

test("concurrent exclusive writers publish exactly one complete file", async (t) => {
  const f = await privateFixture(t);
  const values = [Buffer.alloc(10000, 65), Buffer.alloc(10000, 66)];
  const outcomes = await Promise.allSettled(
    values.map((bytes) => writePrivateFile(f.root, "race", bytes)),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const actual = await readPrivateFile(f.root, "race");
  assert.ok(values.some((bytes) => bytes.equals(actual)));
  assert.equal((await lstat(join(f.root, "race"))).nlink, 1);
});

test("private writer rejects invalid bytes, unsafe destinations and traversal without modifying existing files", async (t) => {
  const f = await privateFixture(t);
  for (const path of ["../escape", join(f.root, "absolute"), "./relative", "pg/../escape"])
    await assert.rejects(writePrivateFile(f.root, path, Buffer.from(sentinel)), safeError);
  await assert.rejects(writePrivateFile(f.root, "large", Buffer.alloc(1024 * 1024 + 1)), safeError);
  await symlink(f.envFile, join(f.root, "link"));
  await assert.rejects(
    writePrivateFile(f.root, "link", Buffer.from(sentinel), { replace: true }),
    safeError,
  );
  await chmod(join(f.root, "pg"), 0o777);
  await assert.rejects(writePrivateFile(f.root, "pg/new", Buffer.from(sentinel)), safeError);
  assert.deepEqual(await readFile(f.envFile), envBytes(f.env));
});

test("snapshot preserves literal secrets, optional inventory and stable sorted bytes independently of source", async (t) => {
  const f = await privateFixture(t);
  Object.assign(f.env, {
    SMTP_PASSWORD: String.raw`literal$secret#value\\tail`,
    LEAD_TELEGRAM_ENABLED: "true",
    LEAD_TELEGRAM_BOT_TOKEN: "42:fixture-not-a-real-bot-token",
    LEAD_TELEGRAM_CHAT_ID: "42",
    LEAD_TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
    SMTP_REPLY_TO: "reply@markiro.app",
    PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "true",
    STANDALONE_LICENSE_ISSUER: "fixture-issuer",
    STANDALONE_LICENSE_KID: "fixture-kid",
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: String.raw`-----BEGIN PRIVATE KEY-----\nTEST-ONLY\n-----END PRIVATE KEY-----`,
    STANDALONE_LICENSE_KEYSET_JSON: String.raw`{"keys":[{"kid":"$fixture#","x":"literal\\bytes"}]}`,
    STANDALONE_SUPPORT_KEYS_JSON: String.raw`{"history":"literal$#\\"}`,
    CHZ_TOKEN_ENCRYPTION_KEY: "fixture-history",
    RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru",
    RELEASES_S3_REGION: "ru-1",
    RELEASES_S3_BUCKET: "markiro-releases",
    RELEASES_S3_ACCESS_KEY_ID: "fixture-releases-access",
    RELEASES_S3_SECRET_ACCESS_KEY: String.raw`literal$releases#secret`,
    RELEASES_PUBLIC_ORIGIN: "https://releases.markiro.app",
    NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
    NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "false",
    VALIDATION_DM_DUPLICATE_ENABLED: "false",
  });
  await f.writeEnv();
  const result = await snapshotHostConfig(f);
  assert.equal(result.path, join(f.root, "candidates", f.candidateId, "runtime.env"));
  const bytes = await readFile(result.path);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(
    bytes.toString(),
    Object.keys(f.env)
      .sort()
      .map((key) => `${key}=${f.env[key]}\n`)
      .join(""),
  );
  assert.deepEqual({ ...(await readProtectedEnv(result.path)) }, f.env);
  assert.deepEqual(Object.keys(result.interpolation).sort(), interpolationKeys);
  assert.ok(Object.isFrozen(result.interpolation));
  assert.equal(result.interpolation.MARKIRO_PLATFORM_ENV_FILE, result.path);
  await f.writeEnv({ ...f.env, SMTP_PASSWORD: "changed" });
  assert.deepEqual(await readFile(result.path), bytes);
  await assert.rejects(snapshotHostConfig(f), safeError);
  assert.deepEqual(await readFile(result.path), bytes);
});

test("snapshots reject unknown keys and invalid configuration with generic errors", async (t) => {
  const f = await privateFixture(t);
  for (const patch of [
    { UNRECOGNIZED_KEY: sentinel },
    { STANDALONE_UNRECOGNIZED_KEY: sentinel },
    { RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru" },
    { SMTP_PASSWORD: `"${sentinel}"` },
    { SERVER_PROFILE: "legacy" },
    { PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA: "yes" },
    { MARKIRO_SOURCE_SHA: "b".repeat(40) },
    { MARKIRO_POSTGRES_IMAGE_DIGEST: "postgres:17" },
    { MARKIRO_POSTGRES_PASSWORD_FILE: undefined },
  ]) {
    const env = { ...f.env, ...patch };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    await f.writeEnv(env);
    await assert.rejects(snapshotHostConfig({ ...f, candidateId: randomUUID() }), safeError);
  }
  await f.writeEnv();
  for (const candidateId of ["../escape", "not-a-uuid", sentinel, "/absolute"])
    await assert.rejects(snapshotHostConfig({ ...f, candidateId }), safeError);
});

test("snapshot refuses unsafe source ancestors and candidate directories", async (t) => {
  const f = await privateFixture(t);
  await mkdir(join(f.root, "unsafe"), { mode: 0o700 });
  await rename(f.envFile, join(f.root, "unsafe", "source.env"));
  await chmod(join(f.root, "unsafe"), 0o777);
  await assert.rejects(
    snapshotHostConfig({ ...f, envFile: join(f.root, "unsafe", "source.env") }),
    safeError,
  );
  await chmod(join(f.root, "unsafe"), 0o700);
  await rename(join(f.root, "unsafe", "source.env"), f.envFile);
  await symlink(join(f.root, "unsafe"), join(f.root, "candidates"));
  await assert.rejects(snapshotHostConfig(f), safeError);
  assert.deepEqual(await readdir(join(f.root, "unsafe")), []);
});

test("child environment has exact non-secret keys and never inherits ambient values", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  const env = hostChildEnvironment({
    interpolation,
    dockerConfig: f.dockerConfig,
    ambient: { GH_TOKEN: sentinel, HOME: sentinel, PATH: sentinel, SMTP_PASSWORD: sentinel },
  });
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      ...interpolationKeys,
      "MARKIRO_PLATFORM_MIGRATION_ENV_FILE",
      "PATH",
      "LANG",
      "DOCKER_CONFIG",
      "COMPOSE_DISABLE_ENV_FILE",
    ].sort(),
  );
  assert.equal(env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.DOCKER_CONFIG, f.dockerConfig);
  assert.equal(env.COMPOSE_DISABLE_ENV_FILE, "1");
  assert.doesNotMatch(
    JSON.stringify(env),
    /DO-NOT-LEAK|DATABASE_URL|SMTP_PASSWORD|PLATFORM_AUTH_SECRET|LICENSE/,
  );
});

test("child environment rejects all ambient command injection families", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  for (const key of [
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_ANYTHING",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "HTTP_PROXY",
    "http_proxy",
    "Https_Proxy",
    "ALL_PROXY",
    "no_proxy",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
  ]) {
    assert.throws(
      () =>
        hostChildEnvironment({
          interpolation,
          dockerConfig: f.dockerConfig,
          ambient: { [key]: sentinel },
        }),
      safeError,
      key,
    );
  }
});

test("child environment independently validates exact keys and every interpolation field", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  const child = (value) =>
    hostChildEnvironment({ interpolation: value, dockerConfig: f.dockerConfig, ambient: {} });
  for (const key of [...interpolationKeys, "MARKIRO_PLATFORM_MIGRATION_ENV_FILE"]) {
    const missing = { ...interpolation };
    delete missing[key];
    assert.throws(() => child(missing), safeError, key);
    assert.throws(
      () => child({ ...interpolation, [key]: `${interpolation[key]}\n${sentinel}` }),
      safeError,
      key,
    );
  }
  for (const patch of [
    { DATABASE_URL: sentinel },
    { NODE_OPTIONS: sentinel },
    { MARKIRO_POSTGRES_IMAGE_DIGEST: "postgres:17" },
    { MARKIRO_SOURCE_SHA: "main" },
    { S3_PUBLIC_ORIGIN: "http://s3.example.org" },
    { MARKIRO_RETIRED_ADMIN_DOMAIN: interpolation.MARKIRO_LANDING_DOMAIN },
    { MARKIRO_RELEASES_DOMAIN: interpolation.MARKIRO_LANDING_DOMAIN },
    { MARKIRO_RELEASES_BUCKET: "../markiro-private" },
    { ACME_EMAIL: sentinel },
    { MARKIRO_PLATFORM_ENV_FILE: "relative" },
  ])
    assert.throws(() => child({ ...interpolation, ...patch }), safeError);
});

test("Docker directory and snapshot path must remain canonical and private at child construction", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  const child = (dockerConfig) =>
    hostChildEnvironment({ interpolation, dockerConfig, ambient: {} });
  for (const path of ["relative", f.envFile, `${f.dockerConfig}/`, join(f.root, sentinel)])
    assert.throws(() => child(path), safeError);
  await symlink(f.dockerConfig, join(f.root, "docker-link"));
  assert.throws(() => child(join(f.root, "docker-link")), safeError);
  await chmod(f.dockerConfig, 0o755);
  assert.throws(() => child(f.dockerConfig), safeError);
  await chmod(f.dockerConfig, 0o700);
  await chmod(interpolation.MARKIRO_PLATFORM_ENV_FILE, 0o644);
  assert.throws(() => child(f.dockerConfig), safeError);
});

test("PG bind files allow container read permissions but reject unsafe paths and mutations", async (t) => {
  const f = await privateFixture(t);
  for (const key of [
    "MARKIRO_POSTGRES_CA_FILE",
    "MARKIRO_POSTGRES_SERVER_CERT_FILE",
    "MARKIRO_POSTGRES_SERVER_KEY_FILE",
    "MARKIRO_POSTGRES_PASSWORD_FILE",
  ])
    await chmod(f.env[key], 0o640);
  const { interpolation } = await completeSnapshot(f);
  const child = () =>
    hostChildEnvironment({ interpolation, dockerConfig: f.dockerConfig, ambient: {} });
  assert.doesNotThrow(child);
  const path = f.env.MARKIRO_POSTGRES_SERVER_KEY_FILE;
  await chmod(path, 0o660);
  assert.throws(child, safeError);
  await assert.rejects(snapshotHostConfig({ ...f, candidateId: randomUUID() }), safeError);
  await chmod(path, 0o640);
  await link(path, join(f.root, "pg", "hard-key"));
  assert.throws(child, safeError);
});

test("unknown write options fail closed", async (t) => {
  const f = await privateFixture(t);
  await assert.rejects(
    writePrivateFile(f.root, "new", Buffer.from("value"), { overwrite: true }),
    safeError,
  );
});

test("hidden interpolation keys fail closed", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  const hidden = { ...interpolation };
  Object.defineProperty(hidden, "MARKIRO_SOURCE_SHA", {
    value: interpolation.MARKIRO_SOURCE_SHA,
    enumerable: false,
  });
  assert.throws(
    () =>
      hostChildEnvironment({ interpolation: hidden, dockerConfig: f.dockerConfig, ambient: {} }),
    safeError,
  );
});

test("filesystem sync failures distinguish unpublished and potentially visible writes without leaking raw errors", async (t) => {
  const f = await privateFixture(t);
  for (const phase of ["file", "directory"]) {
    const relative = `fault-${phase}`;
    const source = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const originalOpen = fs.open;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (${JSON.stringify(phase)} === "file" ? args[0].endsWith(".tmp") : args[0] === ${JSON.stringify(f.root)})
          handle.sync = async () => { throw new Error(${JSON.stringify(sentinel)}); };
        return handle;
      };
      syncBuiltinESMExports();
      const { writePrivateFile } = await import(${JSON.stringify(new URL("../host/files.mjs", import.meta.url).href)});
      try {
        await writePrivateFile(${JSON.stringify(f.root)}, ${JSON.stringify(relative)}, Buffer.from("complete"));
        process.exitCode = 1;
      } catch (error) {
        console.log(JSON.stringify({ message: error.message, code: error.code, durabilityUncertain: error.durabilityUncertain }));
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, "ERR_HOST_PRIVATE_FILE");
    assert.equal(error.durabilityUncertain, phase === "directory");
    assert.doesNotMatch(error.message, /DO-NOT-LEAK|markiro-host-|\/private\//);
    if (phase === "file")
      await assert.rejects(readFile(join(f.root, relative)), { code: "ENOENT" });
    else assert.equal((await readPrivateFile(f.root, relative)).toString(), "complete");
  }
  assert.ok((await readdir(f.root)).every((name) => !name.endsWith(".tmp")));
});

test("PG bind paths reject symlink ancestors, nonregular files and oversized inputs", async (t) => {
  const f = await privateFixture(t);
  await symlink(join(f.root, "pg"), join(f.root, "pg-alias"));
  await writeFile(join(f.root, "pg", "oversized"), Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  for (const path of [
    join(f.root, "pg-alias", "ca.crt"),
    join(f.root, "pg"),
    join(f.root, "pg", "oversized"),
    "relative",
    join(f.root, sentinel),
  ]) {
    await f.writeEnv({ ...f.env, MARKIRO_POSTGRES_CA_FILE: path });
    await assert.rejects(snapshotHostConfig({ ...f, candidateId: randomUUID() }), safeError);
  }
});

test("snapshot cleanup failures preserve durability uncertainty and sanitized errors", async (t) => {
  for (const phase of ["unlink", "rmdir", "directory"]) {
    await t.test(phase, async (t) => {
      const f = await privateFixture(t);
      // Existing preflight accepts this address; final interpolation validation
      // rejects the control character after publishing the snapshot.
      await f.writeEnv({ ...f.env, ACME_EMAIL: `ops${String.fromCharCode(1)}@markiro.app` });
      const candidate = join(f.root, "candidates", f.candidateId);
      const snapshot = join(candidate, "runtime.env");
      const source = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const phase = ${JSON.stringify(phase)};
        let injected = false;
        let parentSyncs = 0;
        const originalOpen = fs.open;
        const originalUnlink = fs.unlink;
        const originalRmdir = fs.rmdir;
        const failure = () => {
          injected = true;
          throw new Error(${JSON.stringify(sentinel)});
        };
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (phase === "directory" && args[0] === ${JSON.stringify(join(f.root, "candidates"))}) {
            const originalSync = handle.sync.bind(handle);
            handle.sync = async () => {
              if (++parentSyncs === 2) failure();
              await originalSync();
            };
          }
          return handle;
        };
        fs.unlink = async (...args) => {
          if (phase === "unlink" && args[0] === ${JSON.stringify(snapshot)}) failure();
          return originalUnlink(...args);
        };
        fs.rmdir = async (...args) => {
          if (phase === "rmdir" && args[0] === ${JSON.stringify(candidate)}) failure();
          return originalRmdir(...args);
        };
        syncBuiltinESMExports();
        const { snapshotHostConfig } = await import(${JSON.stringify(new URL("../host/config.mjs", import.meta.url).href)});
        const exists = async (path) => {
          try { await fs.lstat(path); return true; }
          catch (error) { if (error.code === "ENOENT") return false; throw error; }
        };
        try {
          await snapshotHostConfig(${JSON.stringify({ root: f.root, candidateId: f.candidateId, envFile: f.envFile, manifest: f.manifest })});
          process.exitCode = 1;
        } catch (error) {
          console.log(JSON.stringify({
            message: error.message, code: error.code,
            durabilityUncertain: error.durabilityUncertain, injected,
            candidateExists: await exists(${JSON.stringify(candidate)}),
            snapshotExists: await exists(${JSON.stringify(snapshot)}),
          }));
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const error = JSON.parse(result.stdout);
      assert.equal(error.injected, true);
      assert.equal(error.code, "ERR_HOST_PRIVATE_FILE");
      assert.equal(error.durabilityUncertain, true);
      assert.equal(error.candidateExists, phase !== "directory");
      assert.equal(error.snapshotExists, phase === "unlink");
      assert.doesNotMatch(error.message, /DO-NOT-LEAK|markiro-host-|\/private\//);
    });
  }
});

async function migrationFixture(t) {
  const f = await privateFixture(t);
  const runtimeSnapshot = await snapshotHostConfig(f);
  const url = new URL(f.env.DATABASE_URL);
  url.username = "markiro_migrator";
  url.password = String.raw`literal$#\'"@:/secret`;
  const envFile = join(f.root, "migration-source.env");
  await writeFile(envFile, envBytes({ DATABASE_URL: url.href }), { mode: 0o600 });
  return { ...f, envFile, runtimeSnapshot, url };
}

test("migration snapshot is exclusive, private, literal and contains only DATABASE_URL", async (t) => {
  assert.equal(typeof hostConfig.snapshotMigrationConfig, "function");
  const f = await migrationFixture(t);
  const result = await hostConfig.snapshotMigrationConfig(f);
  assert.deepEqual(Object.keys(result).sort(), ["path", "sha256"]);
  assert.equal(result.path, join(f.root, "candidates", f.candidateId, "migration.env"));
  const bytes = await readFile(result.path);
  assert.deepEqual(bytes, envBytes({ DATABASE_URL: f.url.href }));
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal((await lstat(result.path)).mode & 0o7777, 0o600);
  await assert.rejects(hostConfig.snapshotMigrationConfig(f), safeError);
  assert.deepEqual(await readFile(result.path), bytes);
});

test("migration snapshot refuses missing, linked, permissive and unknown-key inputs", async (t) => {
  assert.equal(typeof hostConfig.snapshotMigrationConfig, "function");
  const f = await migrationFixture(t);
  await assert.rejects(
    hostConfig.snapshotMigrationConfig({ ...f, envFile: join(f.root, sentinel) }),
    safeError,
  );
  await symlink(f.envFile, join(f.root, "migration-alias"));
  await assert.rejects(
    hostConfig.snapshotMigrationConfig({ ...f, envFile: join(f.root, "migration-alias") }),
    safeError,
  );
  await chmod(f.envFile, 0o644);
  await assert.rejects(hostConfig.snapshotMigrationConfig(f), safeError);
  await chmod(f.envFile, 0o600);
  for (const env of [{}, { DATABASE_URL: f.url.href, SMTP_PASSWORD: sentinel }]) {
    await writeFile(f.envFile, envBytes(env));
    await assert.rejects(hostConfig.snapshotMigrationConfig(f), safeError);
  }
});

test("migration snapshot rejects same login and divergent database or TLS endpoint", async (t) => {
  assert.equal(typeof hostConfig.snapshotMigrationConfig, "function");
  const f = await migrationFixture(t);
  for (const change of [
    (u) => {
      u.username = new URL(f.env.DATABASE_URL).username;
    },
    (u) => {
      u.hostname = "elsewhere.private";
    },
    (u) => {
      u.port = "5433";
    },
    (u) => {
      u.pathname = "/other";
    },
    (u) => {
      u.searchParams.set("sslrootcert", "/other/ca.crt");
    },
    (u) => {
      u.searchParams.set("sslmode", "disable");
    },
    (u) => {
      u.searchParams.append("sslmode", "verify-full");
    },
    (u) => {
      u.searchParams.set("host", "elsewhere.private");
    },
  ]) {
    const url = new URL(f.url);
    change(url);
    await writeFile(f.envFile, envBytes({ DATABASE_URL: url.href }));
    await assert.rejects(hostConfig.snapshotMigrationConfig(f), safeError);
  }
});

test("migration snapshot binds actual runtime bytes and candidate identity", async (t) => {
  assert.equal(typeof hostConfig.snapshotMigrationConfig, "function");
  const f = await migrationFixture(t);
  for (const patch of [
    { candidateId: randomUUID() },
    { runtimeSnapshot: { ...f.runtimeSnapshot, sha256: "0".repeat(64) } },
  ])
    await assert.rejects(hostConfig.snapshotMigrationConfig({ ...f, ...patch }), safeError);
  await writeFile(f.runtimeSnapshot.path, Buffer.from("DATABASE_URL=changed\n"));
  await assert.rejects(hostConfig.snapshotMigrationConfig(f), safeError);
});

test("runtime-only interpolation cannot construct a child environment", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await snapshotHostConfig(f);
  assert.throws(
    () => hostChildEnvironment({ interpolation, dockerConfig: f.dockerConfig, ambient: {} }),
    safeError,
  );
});

async function completeSnapshot(f) {
  const runtime = await snapshotHostConfig(f);
  const migrationFile = join(f.root, "migration-input.env");
  const url = new URL(f.env.DATABASE_URL);
  url.username = "markiro_migrator";
  await writeFile(migrationFile, envBytes({ DATABASE_URL: url.href }), { mode: 0o600 });
  const migration = await hostConfig.snapshotMigrationConfig({
    ...f,
    envFile: migrationFile,
    runtimeSnapshot: runtime,
  });
  return {
    ...runtime,
    interpolation: {
      ...runtime.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: migration.path,
    },
  };
}

test("child interpolation binds the two distinct snapshot paths of one candidate", async (t) => {
  const f = await privateFixture(t);
  const { interpolation } = await completeSnapshot(f);
  const other = await completeSnapshot({ ...f, candidateId: randomUUID() });
  for (const path of [
    interpolation.MARKIRO_PLATFORM_ENV_FILE,
    f.envFile,
    other.interpolation.MARKIRO_PLATFORM_MIGRATION_ENV_FILE,
  ])
    assert.throws(
      () =>
        hostChildEnvironment({
          interpolation: { ...interpolation, MARKIRO_PLATFORM_MIGRATION_ENV_FILE: path },
          dockerConfig: f.dockerConfig,
          ambient: {},
        }),
      safeError,
    );
});
