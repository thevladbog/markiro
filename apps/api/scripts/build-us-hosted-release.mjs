import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => {
  throw new Error("us_hosted_package_refused");
};
const trees = [
  "apps/api/dist",
  "packages/db/dist",
  "packages/domain/dist",
  "packages/platform-contracts/dist",
  "apps/admin/dist-us",
  "packages/db/migrations",
];
const metadata = [
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/platform-contracts/package.json",
];
const deploymentFiles = [
  "deploy/us-synthetic/package-spec.json",
  "deploy/us-synthetic/compose.synthetic.yml",
  "deploy/us-synthetic/ingress.conf",
  "deploy/us-synthetic/runtime.Dockerfile",
  "deploy/us-synthetic/README.md",
];
const entrypoints = {
  api: "apps/api/dist/main.us-hosted.js",
  worker: "apps/api/dist/main.us-hosted-worker.js",
};
const stagePath = ".superpowers/us-hosted-package";
const dependencies = [
  "node_modules",
  "apps/api/node_modules",
  "packages/db/node_modules",
  "packages/domain/node_modules",
  "packages/platform-contracts/node_modules",
];

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  refuse();
}

async function hashDependencyFile(path, captureMetadata = false) {
  const before = await lstat(path);
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) refuse();
  if (captureMetadata && before.size > 1024 * 1024) refuse();
  const same = (stat) =>
    ["dev", "ino", "size", "mode", "uid", "gid", "mtimeMs", "ctimeMs"].every(
      (key) => stat[key] === before[key],
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(64 * 1024);
  const retained = [];
  try {
    if (!same(await handle.stat())) refuse();
    const hash = createHash("sha256");
    let count = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - count + 1),
        count,
      );
      if (!bytesRead) break;
      count += bytesRead;
      if (!Number.isSafeInteger(count) || count > before.size) refuse();
      hash.update(buffer.subarray(0, bytesRead));
      if (captureMetadata) retained.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (count !== before.size || !same(await handle.stat()) || !same(await lstat(path))) refuse();
    return {
      byteSize: count,
      sha256: hash.digest("hex"),
      ...(captureMetadata ? { metadata: Buffer.concat(retained) } : {}),
    };
  } finally {
    buffer.fill(0);
    for (const bytes of retained) bytes.fill(0);
    await handle.close();
  }
}

// No callable root/build/tool/transport override. Invoke the script from a clean,
// committed isolated source snapshot with its own offline dependency installation.
try {
  if (process.argv.length !== 2 || Number(process.versions.node.split(".")[0]) < 24) refuse();
  const script = await realpath(fileURLToPath(import.meta.url));
  const root = resolve(dirname(script), "../../..");
  const env = {
    PATH: process.env.PATH,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    COREPACK_ENABLE_NETWORK: "0",
    VITE_DEPLOYMENT_EDITION: "US",
  };
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  if (git(["rev-parse", "--show-toplevel"]) !== root) refuse();
  if (git(["status", "--porcelain=v1", "--untracked-files=all"])) refuse();
  const sourceSha = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) refuse();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageJson.packageManager !== "pnpm@11.22.0") refuse();
  const spec = JSON.parse(await readFile(join(root, deploymentFiles[0]), "utf8"));
  if (
    !isDeepStrictEqual(spec, {
      schemaVersion: 1,
      edition: "US",
      purpose: "synthetic-demo",
      publicOrigin: "https://us-demo.invalid",
      stage: stagePath,
      entrypoints,
      trees,
      metadata,
      deploymentFiles,
      deploymentReady: false,
      releaseEnabled: false,
      provisioning: "separate-reviewed-admin-contract-required",
    })
  )
    refuse();
  const stage = join(root, stagePath);
  await absent(stage);
  // Refuse stale/other-task build output instead of deleting it or blessing an
  // incremental tree as a fresh artifact. The isolated archive starts empty.
  for (const path of [
    ...trees.slice(0, 5),
    "packages/ui/dist",
    "packages/email/dist",
    "packages/legal-documents/dist",
  ])
    await absent(join(root, path));
  for (const path of deploymentFiles) {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) refuse();
  }
  await mkdir(dirname(stage), { recursive: true });
  const stageParent = await lstat(dirname(stage));
  if (!stageParent.isDirectory() || stageParent.isSymbolicLink()) refuse();
  await mkdir(stage, { recursive: false });
  const run = (args, cwd = root) =>
    execFileSync("corepack", ["pnpm", ...args], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
  // Full Nest compilation also type-checks dormant RU modules. Build their pure
  // workspace type dependencies without importing or starting the RU runtime.
  for (const name of [
    "domain",
    "db",
    "platform-contracts",
    "ui",
    "email",
    "legal-documents",
    "api",
  ])
    run(["--filter", `@markiro/${name}`, "build"]);
  run([
    "--filter",
    "@markiro/admin",
    "exec",
    "vite",
    "build",
    "--config",
    "vite.us-hosted.config.ts",
    "--mode",
    "production",
  ]);
  const api = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));
  const build = { apiVersion: api.version, gitSha: sourceSha, dirty: false };
  const descriptorModule = await import(
    pathToFileURL(join(root, "apps/api/dist/deployment/us-request-build-descriptor.js"))
  );
  const require = createRequire(join(root, "apps/api/package.json"));
  const { canonicalExportDigest } = require("@markiro/domain");
  const descriptor = await descriptorModule.captureUsRequestBuildDescriptor(build, {
    trees: {
      api: join(root, trees[0]),
      db: join(root, trees[1]),
      domain: join(root, trees[2]),
      contracts: join(root, trees[3]),
    },
    lockfile: join(root, "pnpm-lock.yaml"),
  });
  const descriptorPath = "apps/api/dist/us-request-build.json";
  await writeFile(join(root, descriptorPath), `${JSON.stringify(descriptor)}\n`, { flag: "wx" });
  const app = join(stage, "app");
  await mkdir(app);
  for (const path of [...trees, ...metadata]) {
    await mkdir(dirname(join(app, path)), { recursive: true });
    await cp(join(root, path), join(app, path), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  async function inventory(base, relative = "", links = false) {
    const result = [];
    for (const name of (await readdir(join(base, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(base, path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) result.push(...(await inventory(base, path, links)));
      else if (stat.isSymbolicLink() && links) {
        const target = await readlink(absolute);
        if (target.startsWith("/") || !resolve(dirname(absolute), target).startsWith(`${app}/`))
          refuse();
        result.push({ path, link: target });
      } else if (stat.isFile()) {
        if (links) result.push({ path, ...(await hashDependencyFile(absolute)) });
        else {
          if (stat.size > 32 * 1024 * 1024) refuse();
          const bytes = await readFile(absolute);
          result.push({ path, byteSize: bytes.length, sha256: sha(bytes) });
        }
      } else refuse();
    }
    return result;
  }
  const files = (await inventory(app)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const descriptorBytes = await readFile(join(app, descriptorPath));
  const manifest = {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    build,
    requestBuildDescriptor: {
      path: descriptorPath,
      sha256: sha(descriptorBytes),
      digest: canonicalExportDigest(descriptor),
    },
    entrypoints,
    files,
  };
  const { parseUsHostedReleaseManifest } = await import(
    pathToFileURL(join(root, "apps/api/dist/deployment/us-hosted-release-manifest.js"))
  );
  parseUsHostedReleaseManifest(JSON.stringify(manifest));
  const semantics = await import(
    pathToFileURL(join(root, "apps/api/dist/deployment/us-hosted-release-semantics.js"))
  );
  semantics.assertHostedStaticReferences(
    await readFile(join(app, "apps/admin/dist-us/.vite/manifest.json")),
    files.map((file) => file.path),
  );
  semantics.assertHostedMigrationReferences(
    await readFile(join(app, "packages/db/migrations/meta/_journal.json")),
    files.map((file) => file.path),
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(app, "us-synthetic-release.json"), manifestBytes, { flag: "wx" });
  // Dependencies are a separate byte/link inventory, not part of B1 and not a
  // fabricated OCI digest. Never follow links back to this checkout's outputs.
  const dependencyFiles = [];
  for (const path of dependencies) {
    const source = await lstat(join(root, path));
    if (!source.isDirectory() || source.isSymbolicLink()) refuse();
    await mkdir(dirname(join(app, path)), { recursive: true });
    await cp(join(root, path), join(app, path), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    dependencyFiles.push(...(await inventory(app, path, true)));
  }
  dependencyFiles.sort((a, b) => (a.path < b.path ? -1 : 1));
  const sbom = [];
  for (const file of dependencyFiles) {
    if (!file.path.endsWith("/package.json") || file.link) continue;
    const captured = await hashDependencyFile(join(app, file.path), true);
    try {
      if (captured.byteSize !== file.byteSize || captured.sha256 !== file.sha256) refuse();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.metadata));
      if (typeof value.name === "string" && typeof value.version === "string")
        sbom.push({
          path: file.path,
          name: value.name,
          version: value.version,
          sha256: file.sha256,
        });
    } finally {
      captured.metadata.fill(0);
    }
  }
  const deployment = [];
  for (const path of deploymentFiles) {
    const bytes = await readFile(join(root, path));
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), bytes, { flag: "wx" });
    deployment.push({ path, byteSize: bytes.length, sha256: sha(bytes) });
  }
  const dependencyBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, files: dependencyFiles, sbom })}\n`,
  );
  await writeFile(join(stage, "dependency-attestation.json"), dependencyBytes, { flag: "wx" });
  await writeFile(
    join(stage, "deployment-attestation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceSha,
      manifestSha256: sha(manifestBytes),
      files: deployment,
      dependencyAttestationSha256: sha(dependencyBytes),
      imageDigestVerified: false,
      protectedImageAttestationRequired: true,
      deploymentReady: false,
      releaseEnabled: false,
    })}\n`,
    { flag: "wx" },
  );
  if (
    git(["rev-parse", "HEAD"]) !== sourceSha ||
    git(["status", "--porcelain=v1", "--untracked-files=all"])
  )
    refuse();
  process.stdout.write(
    `${JSON.stringify({ sourceSha, manifestSha256: sha(manifestBytes), files: files.length, deploymentReady: false, releaseEnabled: false })}\n`,
  );
} catch {
  // Keep partial invocation-owned output for inspection; never clean unknown
  // output or relabel failure as a package. A subsequent invocation refuses it.
  process.stderr.write("us_hosted_package_refused\n");
  process.exitCode = 1;
}
