import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compileFunction } from "node:vm";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = "apps/api/scripts/build-us-hosted-release.mjs";
const run = (args) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, COREPACK_ENABLE_NETWORK: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });

test("separate dependency evidence hashes a regular binary larger than B1's file limit", async () => {
  const app = await mkdtemp(join(tmpdir(), "us-hosted-dependency-"));
  try {
    const file = join(app, "native.node");
    await writeFile(file, "synthetic-public-binary");
    await truncate(file, 33 * 1024 * 1024);
    const expected = createHash("sha256");
    for await (const chunk of createReadStream(file)) expected.update(chunk);
    const source = readFileSync(new URL("../../../" + script, import.meta.url), "utf8");
    const start = source.indexOf("  async function inventory(");
    const end = source.indexOf("\n  const files =", start);
    assert.ok(start >= 0 && end > start);
    const refuse = () => {
      throw new Error("us_hosted_package_refused");
    };
    let hashDependencyFile;
    const helperStart = source.indexOf("async function hashDependencyFile(");
    if (helperStart >= 0) {
      const helperEnd = source.indexOf("\n// No callable", helperStart);
      assert.ok(helperEnd > helperStart);
      hashDependencyFile = compileFunction(
        "return (" + source.slice(helperStart, helperEnd) + ");",
        ["open", "lstat", "constants", "createHash", "refuse"],
      )(open, lstat, constants, createHash, refuse);
    }
    const inventory = compileFunction("return (" + source.slice(start, end) + ");", [
      "readdir",
      "lstat",
      "readlink",
      "readFile",
      "resolve",
      "dirname",
      "join",
      "sha",
      "refuse",
      "app",
      "hashDependencyFile",
    ])(
      readdir,
      lstat,
      readlink,
      readFile,
      resolve,
      dirname,
      join,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
      refuse,
      app,
      hashDependencyFile,
    );
    assert.deepEqual(await inventory(app, "", true), [
      { path: "native.node", byteSize: 33 * 1024 * 1024, sha256: expected.digest("hex") },
    ]);
    await assert.rejects(inventory(app, "", false), /us_hosted_package_refused/);
    assert.equal(typeof hashDependencyFile, "function");
    await assert.rejects(hashDependencyFile(file, true), /us_hosted_package_refused/);
    const link = join(app, "link.node");
    await symlink(file, link);
    await assert.rejects(hashDependencyFile(link), /us_hosted_package_refused/);
    const bytes = Buffer.from('{"name":"synthetic-public","version":"1.0.0"}\n');
    const metadata = join(app, "package.json");
    await writeFile(metadata, bytes);
    const captured = await hashDependencyFile(metadata, true);
    assert.deepEqual(captured.metadata, bytes);
    assert.equal(captured.sha256, createHash("sha256").update(bytes).digest("hex"));
    captured.metadata.fill(0);
  } finally {
    await rm(app, { recursive: true });
  }
});

test("package producer rejects extra arguments with a redacted refusal", () => {
  const result = run(["--root=/untrusted"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "us_hosted_package_refused\n");
});

test("package producer refuses this dirty source before any build", (context) => {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(status.status, 0);
  // This test deliberately applies to an uncommitted candidate, never a clean release gate.
  if (!status.stdout) return context.skip("requires an uncommitted candidate checkout");
  const stage = new URL("../../../.superpowers/us-hosted-package", import.meta.url);
  const before = lstatSync(stage, { throwIfNoEntry: false });
  const result = run([]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "us_hosted_package_refused\n");
  assert.deepEqual(lstatSync(stage, { throwIfNoEntry: false }), before);
});

test("package specification pins complete artifacts and separate dependency/deployment evidence", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../../../deploy/us-synthetic/package-spec.json", import.meta.url)),
  );
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.edition, "US");
  assert.equal(spec.purpose, "synthetic-demo");
  assert.equal(spec.publicOrigin, "https://us-demo.invalid");
  assert.equal(spec.stage, ".superpowers/us-hosted-package");
  assert.deepEqual(spec.entrypoints, {
    api: "apps/api/dist/main.us-hosted.js",
    worker: "apps/api/dist/main.us-hosted-worker.js",
  });
  assert.deepEqual(spec.trees, [
    "apps/api/dist",
    "packages/db/dist",
    "packages/domain/dist",
    "packages/platform-contracts/dist",
    "apps/admin/dist-us",
    "packages/db/migrations",
  ]);
  assert.deepEqual(spec.metadata, [
    "pnpm-lock.yaml",
    "apps/api/package.json",
    "packages/db/package.json",
    "packages/domain/package.json",
    "packages/platform-contracts/package.json",
  ]);
  assert.equal(spec.deploymentReady, false);
  assert.equal(spec.releaseEnabled, false);
  assert.equal(spec.provisioning, "separate-reviewed-admin-contract-required");
  assert.deepEqual(spec.deploymentFiles, [
    "deploy/us-synthetic/package-spec.json",
    "deploy/us-synthetic/compose.synthetic.yml",
    "deploy/us-synthetic/ingress.conf",
    "deploy/us-synthetic/runtime.Dockerfile",
    "deploy/us-synthetic/README.md",
  ]);
});

test("inert deployment files require pinned images, fixed mounts and locked acceptance", () => {
  const read = (name) =>
    readFileSync(new URL("../../../deploy/us-synthetic/" + name, import.meta.url), "utf8");
  const dockerfile = read("runtime.Dockerfile");
  assert.match(dockerfile, /FROM node@sha256:\$\{US_NODE_BASE_SHA256\}/);
  assert.doesNotMatch(dockerfile, /ARG US_NODE_BASE_SHA256=/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /chmod 0444/);
  assert.doesNotMatch(dockerfile, /(?:npm|pnpm) (?:install|add)/);
  const compose = read("compose.synthetic.yml");
  assert.match(compose, /US_RUNTIME_IMAGE_SHA256:\?/);
  assert.match(compose, /US_INGRESS_IMAGE_SHA256:\?/);
  assert.match(compose, /pull_policy: never/);
  assert.doesNotMatch(compose, /env_file:|environment:|privileged:|\/var\/run\/docker/);
  assert.match(compose, /create_host_path: false/);
  assert.match(compose, /main\.us-hosted-worker\.js/);
  assert.match(compose, /main\.us-hosted\.js/);
  const ingress = read("ingress.conf");
  assert.match(ingress, /server_name us-demo\.invalid;/);
  assert.match(ingress, /proxy_ssl_verify on;/);
  assert.match(ingress, /proxy_ssl_name api\.us-demo\.internal;/);
  assert.match(ingress, /proxy_set_header Host us-demo\.invalid;/);
  assert.match(ingress, /access_log off;/);
  assert.match(ingress, /error_log \/dev\/null crit;/);
  assert.match(ingress, /return 404;/);
  const docs = read("README.md");
  assert.match(docs, /NOT READY TO DEPLOY/);
  assert.match(docs, /us_hosted_provisioning_required/);
  assert.match(docs, /never promote/i);
});

test("ingress route map admits public US operations and rejects aliases and wrong verbs", () => {
  const source = readFileSync(
    new URL("../../../deploy/us-synthetic/ingress.conf", import.meta.url),
    "utf8",
  );
  const patterns = source.split("\n").flatMap((line) => {
    const match = /^\s+("~.*") 1;$/.exec(line);
    return match ? [new RegExp(JSON.parse(match[1]).slice(1))] : [];
  });
  assert.ok(patterns.length > 30);
  const allows = (value) => patterns.some((pattern) => pattern.test(value));
  const id = "11111111-1111-4111-8111-111111111111";
  for (const value of [
    "GET:/api/us/deployment",
    "GET:/api/us/health/ready",
    "POST:/api/us-auth/sign-in/email",
    "POST:/api/us-auth/two-factor/verify-totp",
    `POST:/api/us/traceability/requests/${id}/prepare`,
    `GET:/api/us/traceability/export-runs/${id}/artifacts/package_zip`,
    `GET:/api/us/traceability/receiving/${id}/export.csv`,
    `GET:/api/us/traceability/lots/${id}/card/evidence`,
  ])
    assert.ok(allows(value), value);
  for (const value of [
    "GET:/api/health/ready",
    "POST:/api/us-auth/sign-up/email",
    "GET:/api/us-auth/sign-in/email",
    `PUT:/api/us/traceability/requests/${id}`,
    `POST:/api/us/traceability/export-runs/${id}/artifacts/package_zip`,
    `GET:/api/us/traceability/receiving/${id}/exportXcsv`,
    `GET:/api/us/traceability/requests/${id}/`,
    `GET:/api/us/traceability/requests/%31${id.slice(1)}`,
  ])
    assert.equal(allows(value), false, value);
});

test("the source-admission prefix refuses dirty Git before artifact work", (context) => {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(status.status, 0);
  if (!status.stdout) return context.skip("requires an uncommitted candidate checkout");
  const source = readFileSync(new URL("../../../" + script, import.meta.url), "utf8");
  const boundary = "  const packageJson =";
  const location = "fileURLToPath(import.meta.url)";
  const guard = '  if (git(["status", "--porcelain=v1", "--untracked-files=all"])) refuse();';
  assert.equal(source.split(boundary).length, 2);
  assert.equal(source.split(location).length, 2);
  assert.equal(source.split(guard).length, 2);
  // Execute only actual source/Git admission. Artifact/build/resource code is
  // excluded from this candidate; there is no positive runtime authority seam.
  let prefix = source.slice(0, source.indexOf(boundary));
  if (process.env.US_HOSTED_TEST_DIRTY_MUTANT === "1") prefix = prefix.replace(guard, "");
  prefix = prefix.replace(location, JSON.stringify(root + script));
  const candidate =
    prefix +
    '\n  process.stdout.write("source-admitted\\n");\n} catch { process.stderr.write("us_hosted_package_refused\\n"); process.exitCode = 1; }';
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", candidate, "fixture"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, COREPACK_ENABLE_NETWORK: "0" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.stdout, "");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "us_hosted_package_refused\n");
});
