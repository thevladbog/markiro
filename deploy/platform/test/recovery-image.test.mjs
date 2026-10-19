import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../backup/schemas.mjs";

const api = () => import("../backup/recovery-image.mjs").catch(() => ({}));
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "markiro-recovery-export-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repo"),
    contextDirectory = join(root, "context");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(contextDirectory, { mode: 0o700 });
  const sources = {
    "deploy/platform/backup/postgres-worker.mjs": "reviewed worker\n",
    "deploy/platform/backup/backup-ci.mjs": "reviewed harness\n",
    "deploy/platform/backup/fixture-probe.mjs": "synthetic probe source\n",
    "deploy/platform/host/process.mjs": "reviewed process adapter\n",
    "deploy/platform/postgres/roles.mjs": "reviewed role policy\n",
    "deploy/platform/postgres/roles-ci.mjs": "synthetic role harness source\n",
    "deploy/platform/postgres/roles-probe.mjs": "synthetic role probe source\n",
    "packages/db/src/runtime-migrate.ts": "reviewed migration source\n",
    "packages/db/migrations/0000_fixture.sql": "CREATE SCHEMA fixture;\n",
  };
  for (const [path, bytes] of Object.entries(sources)) {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(repositoryRoot, path), bytes);
  }
  const git = (...args) =>
    promisify(execFile)("/usr/bin/git", args, {
      cwd: repositoryRoot,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  await git("init", "--quiet");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Recovery fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture sources",
  );
  const sourceSha = (await git("rev-parse", "HEAD")).stdout.trim();
  for (const area of ["backup", "host", "postgres"])
    await cp(
      join(repositoryRoot, "deploy/platform", area),
      join(contextDirectory, "runtime", area),
      { recursive: true, filter: (path) => !path.endsWith("backup-ci.mjs") },
    );
  await cp(
    join(repositoryRoot, "packages/db/migrations"),
    join(contextDirectory, "runtime/fixture/migrations"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "deploy/platform/backup/fixture-probe.mjs"),
    join(contextDirectory, "runtime/fixture/probe.mjs"),
  );
  await mkdir(join(repositoryRoot, "packages/db/dist"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "packages/db/dist/runtime-migrate.js"),
    "generated migration bytes\n",
  );
  await cp(
    join(repositoryRoot, "packages/db/dist/runtime-migrate.js"),
    join(contextDirectory, "runtime/fixture/runtime-migrate.mjs"),
  );
  await writeFile(join(contextDirectory, "Dockerfile"), "reviewed generated build recipe\n");
  const operationId = randomUUID(),
    imageId = `sha256:${"a".repeat(64)}`;
  const image = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "postgres",
      Entrypoint: [],
      Volumes: { "/var/lib/postgresql/data": {} },
      Labels: { "markiro.backup-fixture": operationId },
    },
  };
  const calls = [];
  const runProcess = async (request) => {
    assert.equal(request.executable, "/usr/bin/docker");
    assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///synthetic.sock"]);
    assert.equal(request.outputLimitBytes, 1048576);
    assert.equal(request.env.DOCKER_HOST, undefined);
    assert.equal(request.env.DOCKER_CONTEXT, undefined);
    calls.push(request.args.slice(2));
    const args = request.args.slice(2);
    if (args[0] === "image" && args[1] === "inspect")
      return { stdout: Buffer.from(JSON.stringify([image])) };
    assert.deepEqual(args.slice(0, 2), ["save", "--output"]);
    assert.equal(args[3], imageId);
    await writeFile(args[2], "synthetic image archive bytes\n", { mode: 0o600 });
    return { stdout: Buffer.alloc(0) };
  };
  return {
    root,
    repositoryRoot,
    contextDirectory,
    sourceSha,
    sources,
    git,
    image,
    calls,
    runProcess,
    request: {
      directory: join(root, "export"),
      repositoryRoot,
      imageId,
      operationId,
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///synthetic.sock",
    },
  };
}
async function captured(f) {
  const module = await api();
  assert.equal(
    typeof module.captureRecoveryImageSources,
    "function",
    "exact source capture must exist",
  );
  return module.captureRecoveryImageSources(f);
}
async function invoke(f, sources) {
  const module = await api();
  assert.equal(typeof module.exportRecoveryImage, "function", "tested image exporter must exist");
  return module.exportRecoveryImage({ ...f.request, sources }, { runProcess: f.runProcess });
}

test("exports only the exact owned tested AMD64 image with private bounded source and archive bindings", async (t) => {
  const f = await fixture(t),
    sources = await captured(f);
  const result = await invoke(f, sources);
  const manifest = JSON.parse(await readFile(result.manifestPath));
  assert.equal(manifest.sourceSha, f.sourceSha);
  assert.equal(manifest.provenance, "local-synthetic");
  assert.equal(manifest.image.id, f.request.imageId);
  assert.equal(manifest.image.architecture, "amd64");
  assert.equal(manifest.archive.sha256, digest("synthetic image archive bytes\n"));
  assert.equal(manifest.archive.bytes, 30);
  assert.equal(
    manifest.sources.files.find((v) => v.path === "deploy/platform/backup/postgres-worker.mjs")
      .sha256,
    digest("reviewed worker\n"),
  );
  assert.equal(
    manifest.sources.files.find((v) => v.path === "deploy/platform/backup/fixture-probe.mjs").kind,
    "synthetic-fixture-source",
  );
  for (const name of ["roles-ci.mjs", "roles-probe.mjs"])
    assert.equal(
      manifest.sources.files.find((v) => v.path === `deploy/platform/postgres/${name}`).kind,
      "synthetic-fixture-source",
    );
  assert.equal(manifest.sources.generated.sha256, digest("generated migration bytes\n"));
  assert.deepEqual(manifest.sources.baseImages, []);
  assert.equal(manifest.dependencies.verification, "tested-image-only");
  assert.equal(manifest.dependencies.treeSha256, undefined);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(f.request.directory)).sort(), [
    "recovery-image.json",
    "recovery-image.tar",
  ]);
  for (const path of [result.manifestPath, result.archivePath])
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.request.directory)).mode & 0o777, 0o700);
});
for (const change of [
  "dirty-source",
  "added-source",
  "deleted-source",
  "staged-source",
  "extra-staged-file",
  "generated-bytes",
]) {
  test(`source capture rejects ${change} before any image operation`, async (t) => {
    const f = await fixture(t);
    const worker = "deploy/platform/backup/postgres-worker.mjs";
    if (change === "dirty-source")
      await writeFile(join(f.repositoryRoot, worker), "unreviewed bytes");
    if (change === "added-source")
      await writeFile(
        join(f.repositoryRoot, "deploy/platform/backup/untracked.mjs"),
        "extra source",
      );
    if (change === "deleted-source") await rm(join(f.repositoryRoot, worker));
    if (change === "staged-source")
      await writeFile(
        join(f.contextDirectory, "runtime/backup/postgres-worker.mjs"),
        "different staged bytes",
      );
    if (change === "extra-staged-file")
      await writeFile(
        join(f.contextDirectory, "runtime/fixture/password"),
        "private data must never be shipped",
      );
    if (change === "generated-bytes")
      await writeFile(
        join(f.contextDirectory, "runtime/fixture/runtime-migrate.mjs"),
        "stale build output",
      );
    await assert.rejects(captured(f), { code: "ERR_RECOVERY_IMAGE" });
    assert.equal(f.calls.length, 0);
  });
}
for (const change of [
  "image-id",
  "image-architecture",
  "image-os",
  "image-owner",
  "dirty-after-build",
  "added-after-build",
  "partial-save",
  "image-changed-during-save",
  "source-changed-during-save",
  "generated-after-build",
  "oversized-save",
  "empty-save",
  "unsafe-output",
  "existing-output",
  "oversized-manifest",
]) {
  test(`image export rejects ${change} and leaves no accepted artifact`, async (t) => {
    const f = await fixture(t),
      sources = await captured(f);
    if (change === "image-id") f.image.Id = `sha256:${"b".repeat(64)}`;
    if (change === "image-architecture") f.image.Architecture = "arm64";
    if (change === "image-os") f.image.Os = "windows";
    if (change === "image-owner") f.image.Config.Labels["markiro.backup-fixture"] = randomUUID();
    if (change === "dirty-after-build")
      await writeFile(
        join(f.repositoryRoot, "deploy/platform/backup/postgres-worker.mjs"),
        "changed source",
      );
    if (change === "added-after-build")
      await writeFile(join(f.repositoryRoot, "deploy/platform/backup/new.mjs"), "new source");
    if (change === "generated-after-build")
      await writeFile(
        join(f.repositoryRoot, "packages/db/dist/runtime-migrate.js"),
        "changed generated bytes",
      );
    if (
      ["image-changed-during-save", "source-changed-during-save", "oversized-save"].includes(change)
    ) {
      const original = f.runProcess;
      f.runProcess = async (request) => {
        const result = await original(request);
        if (request.args[2] === "save") {
          if (change === "image-changed-during-save") f.image.Id = `sha256:${"c".repeat(64)}`;
          if (change === "source-changed-during-save")
            await writeFile(
              join(f.repositoryRoot, "deploy/platform/backup/postgres-worker.mjs"),
              "changed during save",
            );
          if (change === "oversized-save") {
            const { truncate } = await import("node:fs/promises");
            await truncate(request.args[4], 2 * 1024 * 1024 * 1024 + 1);
          }
        }
        return result;
      };
    }
    if (["partial-save", "empty-save"].includes(change)) {
      const original = f.runProcess;
      f.runProcess = async (request) => {
        const args = request.args.slice(2);
        if (args[0] === "save") {
          await writeFile(args[2], change === "empty-save" ? "" : "partial secret child output", {
            mode: 0o600,
          });
          if (change === "partial-save") throw new Error("secret child output");
          return { stdout: Buffer.alloc(0) };
        }
        return original(request);
      };
    }
    if (change === "unsafe-output") {
      await symlink(f.root, join(f.root, "alias"));
      f.request.directory = join(f.root, "alias/export");
    }
    if (change === "existing-output") {
      await mkdir(f.request.directory);
      await writeFile(join(f.request.directory, "owned-by-user"), "preserve");
    }
    if (change === "oversized-manifest") sources.files[0].path += "x".repeat(1048576);
    await assert.rejects(invoke(f, sources), (error) => {
      assert.equal(error.code, "ERR_RECOVERY_IMAGE");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    if (change === "existing-output")
      assert.equal(String(await readFile(join(f.request.directory, "owned-by-user"))), "preserve");
    else await assert.rejects(lstat(f.request.directory), { code: "ENOENT" });
  });
}

test("backup harness image export is explicit and off by default", async () => {
  const module = await api();
  assert.equal(
    typeof module.parseBackupCiArguments,
    "function",
    "explicit export arguments must be parsed",
  );
  assert.equal(module.parseBackupCiArguments(["--local-ci"]), null);
  assert.equal(
    module.parseBackupCiArguments(["--local-ci", "--export-image", "/private/tmp/recovery"]),
    "/private/tmp/recovery",
  );
  for (const args of [
    [],
    ["--export-image", "/tmp/recovery"],
    ["--local-ci", "--export-image"],
    ["--local-ci", "--export-image", "relative"],
    ["--local-ci", "--unknown"],
  ])
    assert.throws(() => module.parseBackupCiArguments(args));
});

for (const failure of [null, "roundtrip", "cleanup"])
  test(`harness completion exports only after verified cleanup: ${failure ?? "success"}`, async (t) => {
    const f = await fixture(t),
      sources = await captured(f),
      module = await api();
    assert.equal(
      typeof module.completeRecoveryImageExport,
      "function",
      "cleanup-ordered export completion must exist",
    );
    const fixtureData = join(f.root, "private-fixture-data");
    await writeFile(fixtureData, "data must be gone before export");
    const original = f.runProcess;
    f.runProcess = async (request) => {
      await assert.rejects(lstat(fixtureData), { code: "ENOENT" });
      return original(request);
    };
    const complete = () =>
      module.completeRecoveryImageExport(
        {
          cleanup: async () => {
            if (failure === "cleanup") throw new Error("cleanup failed");
            await rm(fixtureData);
          },
          problem: failure === "roundtrip" ? new Error("roundtrip failed") : null,
          request: { ...f.request, sources },
        },
        { runProcess: f.runProcess },
      );
    if (failure) {
      await assert.rejects(complete());
      assert.equal(f.calls.length, 0);
      await assert.rejects(lstat(f.request.directory), { code: "ENOENT" });
    } else {
      const result = await complete();
      assert.ok(await lstat(result.manifestPath));
    }
  });

for (const entrypoint of [null, [], ["sh"], "", {}, [null], undefined])
  test(`export accepts only cleared Docker entrypoint representations: ${JSON.stringify(entrypoint)}`, async (t) => {
    const f = await fixture(t),
      sources = await captured(f);
    f.image.Config.Entrypoint = entrypoint;
    if (entrypoint === null || (Array.isArray(entrypoint) && entrypoint.length === 0)) {
      const result = await invoke(f, sources);
      assert.equal(JSON.parse(await readFile(result.manifestPath)).image.id, f.request.imageId);
    } else {
      await assert.rejects(invoke(f, sources), { code: "ERR_RECOVERY_IMAGE" });
      await assert.rejects(lstat(f.request.directory), { code: "ENOENT" });
    }
  });

test("source provenance records exact pinned worker base references and recipe bytes", async (t) => {
  const f = await fixture(t);
  const { workerRecipe, ICU_POSTGRES_BASE, ICU_NODE_BASE } =
    await import("../backup/worker-recipes.mjs");
  const recipe = workerRecipe("icu");
  await writeFile(join(f.contextDirectory, "Dockerfile"), recipe);
  const sources = await captured(f);
  assert.deepEqual(sources.baseImages, [ICU_NODE_BASE, ICU_POSTGRES_BASE]);
  assert.equal(sources.buildRecipeSha256, digest(recipe));
  const result = await invoke(f, sources);
  const manifest = JSON.parse(await readFile(result.manifestPath));
  assert.deepEqual(manifest.sources.baseImages, [ICU_NODE_BASE, ICU_POSTGRES_BASE]);
});
