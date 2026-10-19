/** Exact tested-image export. Trusted harness only; never production admission. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { canonical, digest, ensure, hash, identity, keys, plain } from "./schemas.mjs";
import { hashArchive, publishArchive } from "./files.mjs";
import { assertPrivateRootSync, syncPrivateDirectory, writePrivateFile } from "../host/files.mjs";
import { runHostProcess } from "../host/process.mjs";

const areas = [
  "deploy/platform/backup",
  "deploy/platform/host",
  "deploy/platform/postgres",
  "packages/db/migrations",
];
const migrationSource = "packages/db/src/runtime-migrate.ts";
const generatedPath = "packages/db/dist/runtime-migrate.js";
const maxBlobBytes = 2 * 1024 * 1024,
  maxSourceBytes = 256 * 1024 * 1024;
const maxFiles = 2048,
  maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const error = () =>
  Object.assign(new Error("Recovery worker image export failed; details withheld."), {
    code: "ERR_RECOVERY_IMAGE",
  });
function bounded(value) {
  ensure(Buffer.byteLength(canonical(value)) <= 1048576);
  return value;
}
function absolute(path) {
  ensure(
    typeof path === "string" &&
      isAbsolute(path) &&
      normalize(path) === path &&
      !/[\0\r\n]/u.test(path) &&
      path !== "/" &&
      !path.endsWith("/"),
  );
  return path;
}
export function parseBackupCiArguments(args) {
  try {
    ensure(Array.isArray(args) && args[0] === "--local-ci");
    if (args.length === 1) return null;
    ensure(args.length === 3 && args[1] === "--export-image");
    return absolute(args[2]);
  } catch {
    throw error();
  }
}
// Git blobs are public repository bytes. A separate bounded local Git invocation
// handles migration snapshots >1 MiB without relaxing the protected Docker runner.
async function git(root, args, limit = 1048576) {
  const result = await promisify(execFile)("/usr/bin/git", ["--no-pager", ...args], {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
    encoding: "buffer",
    timeout: 30000,
    maxBuffer: limit,
  });
  return result.stdout;
}
async function walk(root, path = "", skipDependencies = false) {
  const paths = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (skipDependencies && !path && entry.name === "node_modules") continue;
    const relative = path ? `${path}/${entry.name}` : entry.name;
    ensure(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(relative));
    if (entry.isDirectory()) paths.push(...(await walk(root, relative)));
    else {
      ensure(entry.isFile());
      paths.push(relative);
    }
    ensure(paths.length <= maxFiles);
  }
  return paths.sort();
}
async function sourceBytes(path) {
  const info = await lstat(path);
  ensure(info.isFile() && info.size <= maxBlobBytes);
  const bytes = await readFile(path);
  ensure(bytes.length === info.size && bytes.length <= maxBlobBytes);
  return bytes;
}
function destinations(path) {
  if (path.endsWith("/backup-ci.mjs") || path === migrationSource) return [];
  if (path.startsWith("packages/db/migrations/")) return [path.replace("packages/db/", "fixture/")];
  const result = [path.replace("deploy/platform/", "")];
  if (path.endsWith("/fixture-probe.mjs")) result.push("fixture/probe.mjs");
  return result;
}
async function snapshot(repositoryRoot, contextDirectory) {
  ensure((await realpath(repositoryRoot)) === repositoryRoot);
  const sourceSha = String(await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  ensure(/^[a-f0-9]{40}$/u.test(sourceSha));
  const expected = String(
    await git(repositoryRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      sourceSha,
      "--",
      ...areas,
      migrationSource,
    ]),
  )
    .trim()
    .split("\n")
    .sort();
  ensure(
    expected.length > 0 &&
      expected.length <= maxFiles &&
      expected.includes("deploy/platform/backup/postgres-worker.mjs"),
  );
  const actual = [migrationSource];
  for (const area of areas)
    actual.push(...(await walk(join(repositoryRoot, area))).map((p) => `${area}/${p}`));
  ensure(canonical(actual.sort()) === canonical(expected));
  const files = [];
  let totalBytes = 0;
  for (const path of expected) {
    ensure(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path));
    const bytes = await sourceBytes(join(repositoryRoot, path));
    totalBytes += bytes.length;
    ensure(totalBytes <= maxSourceBytes);
    ensure(bytes.equals(await git(repositoryRoot, ["show", `${sourceSha}:${path}`], maxBlobBytes)));
    const imagePaths = destinations(path);
    if (contextDirectory)
      for (const destination of imagePaths)
        ensure(bytes.equals(await sourceBytes(join(contextDirectory, "runtime", destination))));
    files.push({
      path,
      imagePaths,
      sha256: digest(bytes),
      kind:
        path.startsWith("packages/db/") ||
        /\/(?:fixture-probe|integrity-probe|schema-probe|prepared-ci|roles-ci|roles-probe)\.mjs$/u.test(
          path,
        )
          ? "synthetic-fixture-source"
          : "repository-source",
    });
  }
  const generatedBytes = await sourceBytes(join(repositoryRoot, generatedPath));
  const generated = {
    path: generatedPath,
    imagePath: "fixture/runtime-migrate.mjs",
    sha256: digest(generatedBytes),
    verification: "tested-generated-bytes",
  };
  if (contextDirectory) {
    ensure(
      generatedBytes.equals(
        await sourceBytes(join(contextDirectory, "runtime", generated.imagePath)),
      ),
    );
    const staged = await walk(join(contextDirectory, "runtime"), "", true);
    const expectedStaged = [...files.flatMap((v) => v.imagePaths), generated.imagePath].sort();
    ensure(canonical(staged) === canonical(expectedStaged));
  }
  return bounded({ sourceSha, files, generated });
}
export async function captureRecoveryImageSources({ repositoryRoot, contextDirectory }) {
  try {
    absolute(repositoryRoot);
    absolute(contextDirectory);
    const result = await snapshot(repositoryRoot, contextDirectory);
    return bounded({
      ...result,
      buildRecipeSha256: digest(await sourceBytes(join(contextDirectory, "Dockerfile"))),
      baseImages: String(await sourceBytes(join(contextDirectory, "Dockerfile")))
        .split("\n")
        .filter((line) => line.startsWith("FROM "))
        .map((line) => line.split(" ")[1]),
    });
  } catch {
    throw error();
  }
}
async function verifySources(repositoryRoot, sources) {
  keys(sources, ["sourceSha", "files", "generated", "buildRecipeSha256", "baseImages"]);
  ensure(
    Array.isArray(sources.baseImages) &&
      sources.baseImages.length <= 2 &&
      sources.baseImages.every((v) => typeof v === "string" && /^[a-z0-9:@./-]+$/u.test(v)),
  );
  bounded(sources);
  ensure(hash(sources.buildRecipeSha256));
  const current = await snapshot(repositoryRoot);
  ensure(
    canonical(current) ===
      canonical({
        sourceSha: sources.sourceSha,
        files: sources.files,
        generated: sources.generated,
      }),
  );
}
export async function exportRecoveryImage(
  {
    directory,
    repositoryRoot,
    sources: inputSources,
    imageId,
    operationId,
    dockerExecutable,
    endpoint,
  },
  options = {},
) {
  let created = false,
    scratch,
    dockerRoot;
  try {
    absolute(directory);
    absolute(repositoryRoot);
    absolute(dockerExecutable);
    ensure(/^unix:\/\/\//u.test(endpoint) && /^sha256:[a-f0-9]{64}$/u.test(imageId));
    identity(operationId, { hostId: "synthetic", databaseId: "synthetic", volumeId: "synthetic" });
    const sources = plain(inputSources);
    await verifySources(repositoryRoot, sources);
    ensure((await realpath(dirname(directory))) === dirname(directory));
    dockerRoot = await mkdtemp(join(await realpath(tmpdir()), "markiro-recovery-docker-"));
    await chmod(dockerRoot, 0o700);
    const command = (args) =>
      (options.runProcess ?? runHostProcess)({
        executable: dockerExecutable,
        args: ["--host", endpoint, ...args],
        cwd: dockerRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DOCKER_CONFIG: dockerRoot },
        timeoutMs: 900000,
        outputLimitBytes: 1048576,
      });
    const inspect = async () => {
      const values = JSON.parse((await command(["image", "inspect", imageId])).stdout);
      ensure(Array.isArray(values) && values.length === 1);
      const image = values[0];
      ensure(
        image.Id === imageId &&
          image.Os === "linux" &&
          image.Architecture === "amd64" &&
          image.Config.User === "postgres" &&
          (image.Config.Entrypoint === null ||
            (Array.isArray(image.Config.Entrypoint) && image.Config.Entrypoint.length === 0)) &&
          image.Config.Labels?.["markiro.backup-fixture"] === operationId,
      );
      ensure(canonical(Object.keys(image.Config.Volumes ?? {})) === '["/var/lib/postgresql/data"]');
    };
    await inspect();
    await mkdir(directory, { mode: 0o700 });
    created = true;
    assertPrivateRootSync(directory);
    scratch = join(directory, `recovery-${randomUUID()}.partial`);
    const handle = await open(scratch, "wx", 0o600);
    await handle.close();
    await command(["save", "--output", scratch, imageId]);
    const info = await lstat(scratch);
    ensure(info.size > 0 && info.size <= maxArchiveBytes);
    const saved = await open(scratch, "r+");
    try {
      await saved.sync();
    } finally {
      await saved.close();
    }
    const measured = await hashArchive(directory, scratch);
    ensure(measured.bytes > 0 && measured.bytes <= maxArchiveBytes);
    await inspect();
    await verifySources(repositoryRoot, sources);
    const manifest = bounded({
      version: 1,
      kind: "platform-recovery-worker",
      provenance: "local-synthetic",
      sourceSha: sources.sourceSha,
      image: { id: imageId, os: "linux", architecture: "amd64" },
      archive: { name: "recovery-image.tar", bytes: measured.bytes, sha256: measured.sha256 },
      sources,
      dependencies: {
        verification: "tested-image-only",
        packages: ["pg", "drizzle-orm", "pg-boss"],
      },
    });
    const archive = await publishArchive(directory, scratch, "recovery-image.tar");
    ensure(archive.sha256 === measured.sha256 && archive.bytes === measured.bytes);
    await rm(scratch);
    scratch = undefined;
    await writePrivateFile(
      directory,
      "recovery-image.json",
      Buffer.from(canonical(manifest) + "\n"),
    );
    await syncPrivateDirectory(directory);
    return { archivePath: archive.path, manifestPath: join(directory, "recovery-image.json") };
  } catch {
    if (created) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error();
  } finally {
    if (dockerRoot)
      await rm(dockerRoot, { recursive: true, force: true }).catch(() => {
        throw error();
      });
  }
}

/** The existing harness owns cleanup; export is unreachable on either failure. */
export async function completeRecoveryImageExport({ cleanup, problem, request }, options = {}) {
  await cleanup();
  if (problem) throw problem;
  return request ? exportRecoveryImage(request, options) : null;
}
