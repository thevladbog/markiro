import assert from "node:assert/strict";
import test from "node:test";
import {
  validateRehearsalImage,
  rehearsalLabel,
  rehearsalStagingNetwork,
  assertFreshRehearsalName,
  rehearsalImages,
  validateRehearsalDaemon,
  validateRehearsalEnvironment,
  captureRehearsalResources,
  cleanupRehearsalResources,
} from "../upgrade-ci-guards.mjs";
const invocationId = "12345678-1234-4234-8234-123456789012";
const name = `markiro-upgrade-ci-${invocationId}`;
import { rehearsalFixture as fixture } from "./rehearsal-fixture.mjs";

test("rehearsal daemon requires exact owned isolated namespace before any application launch", () => {
  assert.doesNotThrow(() => validateRehearsalDaemon(fixture()));
});
for (const mutation of [
  "network",
  "route4",
  "route6",
  "host socket",
  "foreign volume",
  "foreign owner",
  "foreign image",
  "published port",
  "host pid",
  "recreated",
])
  test(`rehearsal rejects ${mutation} before launch`, () => {
    const f = fixture();
    const expected = captureRehearsalResources(f);
    if (mutation === "network")
      f.container.NetworkSettings.Networks.bridge = { NetworkID: "b".repeat(64) };
    if (mutation === "route4") f.routes.ipv4 = "default via 172.17.0.1 dev eth0";
    if (mutation === "route6") f.routes.ipv6 = "default via fe80::1 dev eth0";
    if (mutation === "host socket")
      f.container.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/var/run/docker.sock",
        RW: true,
      });
    if (mutation === "foreign volume") f.container.Mounts[0].Name = "shared";
    if (mutation === "foreign owner") f.volume.Labels[rehearsalLabel] = "different";
    if (mutation === "foreign image") f.container.Image = "sha256:" + "f".repeat(64);
    if (mutation === "published port")
      f.container.HostConfig.PortBindings = { "2375/tcp": [{ HostPort: "2375" }] };
    if (mutation === "host pid") f.container.HostConfig.PidMode = "host";
    if (mutation === "recreated") f.container.Id = "b".repeat(64);
    assert.throws(() => validateRehearsalDaemon(f, expected));
  });
const generated = {
  DATABASE_URL:
    "postgresql://markiro_app:" + "a".repeat(64) + "@db.private/markiro?sslmode=verify-full",
  S3_ENDPOINT: "https://storage.invalid",
  SMTP_HOST: "mail.invalid",
  PLATFORM_AUTH_URL: "https://saas-admin.localhost",
  PLATFORM_AUTH_SECRET: "b".repeat(64),
  MARKIRO_POSTGRES_CA_FILE: "/private/tmp/markiro-upgrade-ci-example/state/pg/ca.crt",
};
test("only generated private fixture environment can enter the rehearsal", () => {
  assert.doesNotThrow(() =>
    validateRehearsalEnvironment(generated, generated, "/private/tmp/markiro-upgrade-ci-example"),
  );
  for (const [key, value] of [
    ["DATABASE_URL", "postgresql://prod:secret@201.34.136.19/markiro"],
    ["S3_ENDPOINT", "https://s3.timeweb.cloud"],
    ["PLATFORM_AUTH_SECRET", "copied-production-secret"],
    ["MARKIRO_POSTGRES_CA_FILE", "/opt/markiro-platform/ca.crt"],
  ])
    assert.throws(() =>
      validateRehearsalEnvironment(
        { ...generated, [key]: value },
        generated,
        "/private/tmp/markiro-upgrade-ci-example",
      ),
    );
});
test("cleanup rechecks exact resources and never removes a replacement/shared volume", async () => {
  const f = fixture(),
    expected = captureRehearsalResources(f),
    trace = [];
  await cleanupRehearsalResources(expected, {
    inspectContainer: async () => f.container,
    inspectVolume: async () => f.volume,
    removeContainer: async (id) => trace.push(id),
    removeVolume: async (n) => trace.push(n),
  });
  assert.deepEqual(trace, [f.container.Id, f.volume.Name]);
  for (const which of ["container", "volume"]) {
    const bad = structuredClone(f);
    if (which === "container") bad.container.Id = "b".repeat(64);
    else bad.volume.CreatedAt = "2026-10-24T01:00:00Z";
    const removed = [];
    await assert.rejects(
      cleanupRehearsalResources(expected, {
        inspectContainer: async () => bad.container,
        inspectVolume: async () => bad.volume,
        removeContainer: async (id) => removed.push(id),
        removeVolume: async (n) => removed.push(n),
      }),
    );
    assert.deepEqual(removed, []);
  }
});
test("local Podman volume and private PID namespace remain exact-owned without host binds", () => {
  const f = fixture();
  f.volume.Mountpoint = `/var/lib/containers/storage/volumes/${f.volume.Name}/_data`;
  f.container.Mounts[0].Source = f.volume.Mountpoint;
  f.container.HostConfig.PidMode = "private";
  f.container.HostConfig.IpcMode = "shareable";
  f.container.HostConfig.Binds = [
    `${f.volume.Name}:/var/lib/docker:rw,rprivate,nosuid,nodev,rbind`,
  ];
  assert.doesNotThrow(() => validateRehearsalDaemon(f));
  const expected = captureRehearsalResources(f);
  f.volume.Mountpoint = "/var/lib/containers/storage/volumes/shared/_data";
  f.container.Mounts[0].Source = f.volume.Mountpoint;
  assert.throws(() => validateRehearsalDaemon(f, expected));
});

test("only one known staging bridge is detached and reused names are refused", () => {
  for (const network of ["bridge", "podman"]) {
    const c = fixture().container;
    c.NetworkSettings.Networks = { [network]: { NetworkID: "b".repeat(64) } };
    assert.equal(rehearsalStagingNetwork(c), network);
  }
  for (const network of ["host", "none", "shared"]) {
    const c = fixture().container;
    c.NetworkSettings.Networks = { [network]: { NetworkID: "b".repeat(64) } };
    assert.throws(() => rehearsalStagingNetwork(c));
  }
  assert.doesNotThrow(() =>
    assertFreshRehearsalName(name, { containers: ["other"], volumes: ["shared"] }),
  );
  for (const key of ["containers", "volumes"])
    assert.throws(() =>
      assertFreshRehearsalName(name, { containers: [], volumes: [], [key]: [name] }),
    );
});

for (const repository of ["docker", "docker.io/library/docker"]) {
  test(`rehearsal accepts pinned daemon digest represented by ${repository}`, () => {
    validateRehearsalImage({
      Id: rehearsalImages.daemonId,
      Architecture: "amd64",
      Os: "linux",
      RepoDigests: [rehearsalImages.daemon.replace("docker:28-dind", repository)],
    });
  });
}
for (const field of ["Id", "Architecture", "Os", "repository", "digest"]) {
  test(`rehearsal rejects changed daemon ${field}`, () => {
    const daemon = {
      Id: rehearsalImages.daemonId,
      Architecture: "amd64",
      Os: "linux",
      RepoDigests: [rehearsalImages.daemon.replace("docker:28-dind", "docker")],
    };
    if (field === "repository")
      daemon.RepoDigests = [daemon.RepoDigests[0].replace("docker@", "foreign@")];
    else if (field === "digest") daemon.RepoDigests = [`docker@sha256:${"0".repeat(64)}`];
    else daemon[field] = "foreign";
    assert.throws(() => validateRehearsalImage(daemon));
  });
}

test("rehearsal configuration binds the written private snapshots and rejects later mutation", async (t) => {
  const { createRehearsalConfiguration } = await import("../upgrade-ci.mjs");
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { readFile, lstat, appendFile } = await import("node:fs/promises");
  const { fingerprintHostConfiguration } = await import("../host/config.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const f = await privateFixture(t, { nested: true });
  const result = await createRehearsalConfiguration(f.root, f.env, f.env.DATABASE_URL);
  for (const key of ["runtimeSnapshot", "migrationSnapshot"]) {
    const snapshot = result.configuration[key];
    assert.equal((await lstat(snapshot.path)).mode & 0o777, 0o600);
    assert.equal(snapshot.sha256, digest(await readFile(snapshot.path)));
  }
  assert.equal(
    (await fingerprintHostConfiguration({ root: f.root, ...result.configuration }))
      .configurationSha256,
    result.sha256,
  );
  await appendFile(result.configuration.migrationSnapshot.path, "CHANGED=1\n");
  await assert.rejects(fingerprintHostConfiguration({ root: f.root, ...result.configuration }));
});

test("safe rehearsal failures retain only sanitized error and process metadata", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  assert.deepEqual(
    rehearsalFailure("copy generated private tree", {
      name: "Error",
      code: 1,
      rehearsalCommand: "docker cp",
      rehearsalExecutable: "docker",
      stdout: "private",
      argv: ["private"],
      stderr: "DO NOT PUBLISH fixture secret",
      stack: "private",
    }),
    {
      phase: "copy generated private tree",
      code: "PROCESS_EXIT_1",
      command: "docker cp",
      name: "Error",
      exitStatus: 1,
      executable: "docker",
      processReason: null,
    },
  );
  assert.equal(
    JSON.stringify(
      rehearsalFailure("fixed phase", {
        name: "private secret",
        code: "bad secret",
        rehearsalCommand: "private secret",
        cmd: "/private/secret",
      }),
    ).includes("secret"),
    false,
  );
});

test("safe rehearsal process metadata rejects invalid exit statuses and arbitrary names", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  for (const code of [undefined, null, "1", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = rehearsalFailure("fixed phase", {
      name: "Error private",
      code,
      rehearsalCommand: "/private/docker exec secret",
      rehearsalExecutable: "/private/docker",
    });
    assert.equal(result.name, "Error");
    assert.equal(result.exitStatus, null);
    assert.equal(result.executable, null);
  }
  const result = rehearsalFailure("fixed phase", { name: "TypeError", code: "ENOENT" });
  assert.equal(result.name, "TypeError");
  assert.equal(result.code, "ENOENT");
  assert.equal(result.exitStatus, null);
});

test("safe rehearsal executable permits only known basenames independently of command verbs", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  assert.equal(
    rehearsalFailure("fixed phase", {
      name: "Error",
      code: "ENOENT",
      rehearsalExecutable: "which",
      rehearsalCommand: "which docker",
    }).executable,
    "which",
  );
  for (const rehearsalExecutable of [undefined, "/usr/bin/docker", "docker secret", "arbitrary"])
    assert.equal(rehearsalFailure("fixed phase", { rehearsalExecutable }).executable, null);
});

test("safe rehearsal failures expose only fixed filesystem and runtime error categories", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  for (const [suffix, expected] of [
    ["No such file or directory", "missing-path"],
    ["Operation not permitted", "permission-denied"],
    ["Permission denied", "permission-denied"],
    ["Read-only file system", "read-only-filesystem"],
    ["No space left on device", "capacity"],
  ]) {
    const value = rehearsalFailure("fixed phase", {
      name: "Error",
      code: 1,
      rehearsalExecutable: "docker",
      rehearsalCommand: "docker exec",
      stderr: `chown: /private/NEVER_PUBLISH: ${suffix}\n`,
    });
    assert.equal(value.processReason, expected);
    assert.ok(!JSON.stringify(value).includes("NEVER_PUBLISH"));
  }
  assert.equal(rehearsalFailure("fixed phase", { stderr: "arbitrary secret" }).processReason, null);
});

test("private rehearsal tree is streamed and every received file is byte-bound", async (t) => {
  const { stageRehearsalTree } = await import("../upgrade-ci.mjs");
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { mkdir, writeFile, readFile, lstat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { runHostProcess } = await import("../host/process.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const source = await privateFixture(t, { nested: true });
  await mkdir(join(source.root, "pg"), { mode: 0o700, recursive: true });
  await writeFile(join(source.root, "pg/ca.crt"), "PRIVATE fixture bytes", { mode: 0o600 });
  const run = promisify(execFile);
  for (const corrupt of [false, "bytes", "mode"]) {
    const target = await privateFixture(t, { nested: true });
    let streamed = false;
    const io = {
      archive: async (root) =>
        (await run("tar", ["-C", root, "-cf", "-", "."], { encoding: "buffer" })).stdout,
      extract: async (bytes) => {
        assert.ok(Buffer.isBuffer(bytes));
        await runHostProcess({
          executable: "/usr/bin/tar",
          args: ["--no-same-owner", "-xpf", "-", "-C", target.root],
          cwd: target.root,
          env: { PATH: process.env.PATH },
          input: bytes,
          timeoutMs: 10000,
          outputLimitBytes: 1048576,
        });
        streamed = true;
        if (corrupt === "bytes") await writeFile(join(target.root, "pg/ca.crt"), "changed");
        if (corrupt === "mode") {
          const { chmod } = await import("node:fs/promises");
          const mode = (await lstat(join(source.root, "pg/ca.crt"))).mode & 0o777;
          await chmod(join(target.root, "pg/ca.crt"), mode === 0o600 ? 0o644 : 0o600);
        }
      },
      inspectFile: async (relative) => {
        assert.equal(streamed, true);
        const path = join(target.root, relative),
          s = await lstat(path);
        return { sha256: digest(await readFile(path)), size: s.size, mode: s.mode & 0o777 };
      },
    };
    if (corrupt) await assert.rejects(stageRehearsalTree(source.root, io));
    else assert.ok((await stageRehearsalTree(source.root, io)).files > 0);
  }
});

test("private rehearsal staging rejects linked source files before transmission", async (t) => {
  const { stageRehearsalTree } = await import("../upgrade-ci.mjs");
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { symlink, link, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const source = await privateFixture(t, { nested: true });
  let transmitted = false;
  const io = {
    archive: async () => {
      transmitted = true;
      throw Error("must not archive");
    },
  };
  const path = join(source.root, "linked");
  await symlink("pg/ca.crt", path);
  await assert.rejects(stageRehearsalTree(source.root, io));
  await unlink(path);
  await link(join(source.root, "pg/ca.crt"), path);
  await assert.rejects(stageRehearsalTree(source.root, io));
  assert.equal(transmitted, false);
});

test("safe rehearsal archive errors retain a fixed executable category without argv", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  const value = rehearsalFailure("fixed phase", {
    name: "Error",
    code: 1,
    rehearsalExecutable: "tar",
    rehearsalCommand: "tar archive",
    argv: ["private"],
    stderr: "private",
  });
  assert.equal(value.executable, "tar");
  assert.equal(value.command, "tar archive");
  assert.equal(value.exitStatus, 1);
  assert.ok(!JSON.stringify(value).includes("private"));
});

test("safe docker load diagnostics recognize native errors without publishing private text", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  const { forwardRehearsalFailure } = await import("../forward-ci.mjs");
  // Representative native/load errors, not recovered text from the failed CI.
  for (const [message, expected] of [
    ["open /private/NEVER_PUBLISH: no such file or directory", "missing-path"],
    ["write /private/NEVER_PUBLISH: no space left on device", "capacity"],
    ["write /private/NEVER_PUBLISH: disk quota exceeded", "capacity"],
    ["chmod /private/NEVER_PUBLISH: operation not permitted", "permission-denied"],
    ["open /private/NEVER_PUBLISH: permission denied", "permission-denied"],
    ["write /private/NEVER_PUBLISH: read-only file system", "read-only-filesystem"],
    ["lsetxattr /private/NEVER_PUBLISH: operation not supported", "filesystem-not-supported"],
    ["archive/tar: invalid tar header /private/NEVER_PUBLISH", "invalid-archive"],
    [
      'invalid diffID for layer 2: expected "NEVER_PUBLISH", got "NEVER_PUBLISH"',
      "layer-digest-mismatch",
    ],
    ["open /private/NEVER_PUBLISH: unexpected EOF", "unexpected-eof"],
    ["Cannot connect to the Docker daemon at unix:///private/NEVER_PUBLISH", "daemon-unavailable"],
  ]) {
    const problem = rehearsalFailure("load current ICU worker archive", {
      name: "Error",
      code: 1,
      rehearsalExecutable: "docker",
      rehearsalCommand: "docker exec",
      stderr: `Error response from daemon: ${message}\n`,
    });
    assert.equal(problem.processReason, expected);
    const safe = forwardRehearsalFailure(problem);
    assert.equal(safe.processReason, expected);
    assert.doesNotMatch(JSON.stringify(safe), /NEVER_PUBLISH|private/);
  }
  const unknown = rehearsalFailure("load current ICU worker archive", {
    code: 1,
    rehearsalExecutable: "docker",
    rehearsalCommand: "docker exec",
    stderr: "unrecognized NEVER_PUBLISH private child text",
  });
  assert.equal(unknown.processReason, null);
  assert.doesNotMatch(JSON.stringify(unknown), /NEVER_PUBLISH|private/);
});

test("missing-path diagnostics distinguish fixed staging boundaries without exposing paths", async () => {
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  const { forwardRehearsalFailure } = await import("../forward-ci.mjs");
  for (const [stderr, expected] of [
    ["open /tmp/forward-worker.tar: no such file or directory", "worker-archive-missing"],
    [
      "open /var/lib/docker/tmp/docker-import-123456789/blobs/sha256/PRIVATE/json: no such file or directory",
      "docker-import-file-missing",
    ],
    [
      "open /var/lib/docker/vfs/dir/PRIVATE: no such file or directory",
      "docker-storage-file-missing",
    ],
    ["stat /private/NEVER_PUBLISH: no such file or directory", "missing-path"],
  ]) {
    const problem = rehearsalFailure("load current ICU worker archive", {
      code: 1,
      rehearsalCommand: "docker exec",
      rehearsalExecutable: "docker",
      stderr,
    });
    assert.equal(problem.processReason, expected);
    assert.equal(forwardRehearsalFailure(problem).processReason, expected);
    assert.ok(!JSON.stringify(problem).includes("PRIVATE"));
  }
});

test("rehearsal preserves trusted host-process exit metadata without output or argv", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { runHostProcess } = await import("../host/process.mjs");
  const { rehearsalFailure } = await import("../upgrade-ci-guards.mjs");
  const { root } = await privateFixture(t);
  await mkdir(join(root, "bin"), { mode: 0o700 });
  const executable = join(root, "bin", "docker");
  await writeFile(executable, "#!/bin/sh\necho PRIVATE >&2\nexit 7\n", { mode: 0o700 });
  await assert.rejects(
    runHostProcess({
      executable,
      args: ["PRIVATE"],
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 5000,
      outputLimitBytes: 65536,
    }),
    (error) => {
      const result = rehearsalFailure("execute exact candidate migrations", error);
      assert.equal(result.exitStatus, 7);
      assert.equal(result.executable, "docker");
      assert.equal(result.processReason, "host-exit");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      return true;
    },
  );
});

test("synthetic old database restore preserves database owner and complete ACL", async () => {
  const { restoreRehearsalDatabase } = await import("../upgrade-ci.mjs");
  const postgresId = "d".repeat(64);
  const calls = [];
  const before = { stdout: Buffer.from('{"owner":"10","acl":[["10","20","CREATE",false]]}\n') };
  const sql = async (text, database) => {
    calls.push(["sql", text, database]);
    return before;
  };
  const nested = async (args) => {
    calls.push(["docker", args]);
    return { stdout: "" };
  };
  await restoreRehearsalDatabase({ postgresId, sql, nested });
  assert.equal(calls.length, 4);
  assert.equal(calls[1][1], "DROP DATABASE markiro;");
  assert.equal(calls[1][2], "postgres");
  assert.deepEqual(calls[2][1], [
    "exec",
    "--user",
    "70:70",
    postgresId,
    "pg_restore",
    "--exit-on-error",
    "--create",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "/tmp/rehearsal.dump",
  ]);
  assert.equal(calls[0][1], calls[3][1]);
  assert.match(calls[0][1], /aclexplode/u);
  assert.match(calls[0][1], /datdba/u);
  assert.match(calls[0][1], /is_grantable/u);
});

test("synthetic old database restore rejects lost or broadened database grants", async () => {
  const { restoreRehearsalDatabase } = await import("../upgrade-ci.mjs");
  let reads = 0;
  await assert.rejects(
    restoreRehearsalDatabase({
      postgresId: "d".repeat(64),
      sql: async () => ({ stdout: ++reads === 1 ? "original ACL\n" : "changed ACL\n" }),
      nested: async () => ({ stdout: "" }),
    }),
  );
});
