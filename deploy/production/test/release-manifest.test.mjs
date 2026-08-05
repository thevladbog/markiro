import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { createReleaseManifest, parseReleaseManifest } from "../release-manifest.mjs";

const SHA = "a".repeat(40);
const API_DIGEST = `sha256:${"b".repeat(64)}`;
const EDGE_DIGEST = `sha256:${"c".repeat(64)}`;
const RUN_ID = "123456789";
const CREATED_AT = "2026-08-05T09:00:00.000Z";
const API = `ghcr.io/thevladbog/markiro-api@${API_DIGEST}`;
const EDGE = `ghcr.io/thevladbog/markiro-edge@${EDGE_DIGEST}`;

const manifest = () => ({
  commit: SHA,
  api: API,
  edge: EDGE,
  workflowRunId: RUN_ID,
  createdAt: CREATED_AT,
});

function runCli(args, env = {}, entrypoint = "deploy/production/release-manifest.mjs") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("accepts only the trusted release schema", () => {
  const actual = createReleaseManifest({
    releaseSha: SHA,
    apiDigest: API_DIGEST,
    edgeDigest: EDGE_DIGEST,
    workflowRunId: RUN_ID,
    createdAt: CREATED_AT,
  });

  assert.deepEqual(actual, manifest());
  assert.deepEqual(parseReleaseManifest(JSON.stringify(actual), RUN_ID), actual);
});

test("rejects noncanonical release evidence without echoing its contents", () => {
  const cases = [
    ["extra key", { ...manifest(), extra: "unexpected" }],
    ["wrong API repository", { ...manifest(), api: `ghcr.io/example/markiro-api@${API_DIGEST}` }],
    ["tag selector", { ...manifest(), api: "ghcr.io/thevladbog/markiro-api:main" }],
    ["uppercase commit", { ...manifest(), commit: SHA.toUpperCase() }],
    ["short commit", { ...manifest(), commit: SHA.slice(1) }],
    [
      "uppercase digest",
      { ...manifest(), api: `ghcr.io/thevladbog/markiro-api@sha256:${"B".repeat(64)}` },
    ],
    [
      "swapped selectors",
      {
        ...manifest(),
        api: `ghcr.io/thevladbog/markiro-edge@${EDGE_DIGEST}`,
        edge: `ghcr.io/thevladbog/markiro-api@${API_DIGEST}`,
      },
    ],
    ["non-UTC time", { ...manifest(), createdAt: "2026-08-05T12:00:00.000+03:00" }],
    ["malformed time", { ...manifest(), createdAt: "not-a-timestamp" }],
    ["secret-shaped extra", { ...manifest(), token: "ghp_verySensitiveTestToken" }],
  ];

  for (const [label, input] of cases)
    assert.throws(
      () => parseReleaseManifest(JSON.stringify(input), RUN_ID),
      /invalid release manifest/,
      label,
    );

  assert.throws(
    () => parseReleaseManifest(JSON.stringify(manifest()), "987654321"),
    /invalid release manifest/,
    "wrong workflow run ID",
  );
  assert.throws(
    () =>
      createReleaseManifest({
        releaseSha: SHA,
        apiDigest: API_DIGEST,
        edgeDigest: EDGE_DIGEST,
        workflowRunId: RUN_ID,
        createdAt: CREATED_AT,
        token: "ghp_verySensitiveTestToken",
      }),
    /invalid release manifest/,
    "secret-shaped creation input",
  );
});

test("creates a private manifest atomically and emits only its success message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  const output = join(directory, "release-manifest.json");
  const result = await runCli(["create", output], {
    RELEASE_SHA: SHA,
    API_DIGEST,
    EDGE_DIGEST,
    GITHUB_RUN_ID: RUN_ID,
    CREATED_AT,
  });

  assert.deepEqual(result, { status: 0, stdout: "release manifest created\n", stderr: "" });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), manifest());
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const retry = await runCli(["create", output], {
    RELEASE_SHA: SHA,
    API_DIGEST,
    EDGE_DIGEST,
    GITHUB_RUN_ID: RUN_ID,
    CREATED_AT,
  });
  assert.equal(retry.status, 1);
  assert.equal(retry.stdout, "");
  assert.equal(retry.stderr, "invalid release manifest command\n");
});

test("validates fully before printing approved release selectors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  const valid = join(directory, "valid.json");
  const rejected = join(directory, "rejected.json");
  const secret = "ghp_verySensitiveTestToken";
  await writeFile(valid, JSON.stringify(manifest()));
  await writeFile(rejected, JSON.stringify({ ...manifest(), token: secret }));

  const accepted = await runCli(["validate", valid, RUN_ID]);
  assert.deepEqual(accepted, { status: 0, stdout: `${SHA}\n${API}\n${EDGE}\n`, stderr: "" });

  const invalid = await runCli(["validate", rejected, RUN_ID]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "invalid release manifest\n");
  assert.doesNotMatch(`${invalid.stdout}${invalid.stderr}`, new RegExp(secret));
});

test("runs through a symlinked CLI entrypoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-release-manifest-"));
  const entrypoint = join(directory, "release-manifest.mjs");
  const output = join(directory, "release-manifest.json");
  await symlink(join(process.cwd(), "deploy/production/release-manifest.mjs"), entrypoint);

  const result = await runCli(
    ["create", output],
    {
      RELEASE_SHA: SHA,
      API_DIGEST,
      EDGE_DIGEST,
      GITHUB_RUN_ID: RUN_ID,
      CREATED_AT,
    },
    entrypoint,
  );

  assert.deepEqual(result, { status: 0, stdout: "release manifest created\n", stderr: "" });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), manifest());
});
