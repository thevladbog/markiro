import assert from "node:assert/strict";
import test from "node:test";

import {
  runHostedNationalCatalogDiagnostics,
  runNationalCatalogDiagnosticsCli,
} from "../national-catalog-diagnostics.mjs";

const HOSTED_ENVIRONMENT = Object.freeze({
  YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
  YC_APP_DEPLOY_LOGIN: "markiro-deploy",
  YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
  APP_SSH_HOST_KEYS_B64: Buffer.from(
    `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
  ).toString("base64"),
});

const EVIDENCE = Object.freeze({
  version: 1,
  passed: true,
  checks: [
    { method: "categories", outcome: "ok", resultCount: 3, etagPresent: true },
    {
      method: "categories-repeat",
      outcome: "not_modified",
      resultCount: 0,
      etagPresent: false,
    },
    { method: "attributes", outcome: "ok", resultCount: 42, etagPresent: false },
    { method: "feed-product", outcome: "ok", resultCount: 1, etagPresent: false },
    { method: "product", outcome: "ok", resultCount: 1, etagPresent: true },
    {
      method: "product-repeat",
      outcome: "not_modified",
      resultCount: 0,
      etagPresent: false,
    },
  ],
});

function dependencies(outputs, commands = []) {
  let index = 0;
  return {
    validatePrivateKey: async () => undefined,
    run: async (command, args, options) => {
      commands.push({ command, args, options });
      const output = outputs[index];
      index += 1;
      return output;
    },
    mkdtemp: async () => "/runner/national-catalog-known-hosts",
    writeFile: async () => undefined,
    rm: async () => undefined,
  };
}

test("hosted National Catalog diagnostic can execute only the active API CLI", async () => {
  const commands = [];
  const result = await runHostedNationalCatalogDiagnostics(
    HOSTED_ENVIRONMENT,
    dependencies(
      ["a1b2c3d4e5f6\tapi\n", `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`],
      commands,
    ),
  );

  assert.deepEqual(result, EVIDENCE);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, "ssh");
  assert.deepEqual(commands[0].args.slice(-10), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/bin/docker",
    "ps",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    "label=com.docker.compose.service=api",
    "--format",
    '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
  ]);
  assert.equal(commands[1].command, "ssh");
  assert.deepEqual(commands[1].args.slice(-8), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/bin/docker",
    "exec",
    "-i",
    "a1b2c3d4e5f6",
    "node",
    "dist/national-catalog-live-diagnostic.js",
  ]);
  assert.equal(commands[1].options, undefined);
});

test("hosted National Catalog diagnostic rejects ambiguous containers and widened evidence", async () => {
  for (const outputs of [
    ["a1b2c3d4e5f6\tapi\nb1c2d3e4f5a6\tapi\n"],
    [
      "a1b2c3d4e5f6\tapi\n",
      `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify({ ...EVIDENCE, token: "leak" })}\n`,
    ],
  ]) {
    await assert.rejects(
      () => runHostedNationalCatalogDiagnostics(HOSTED_ENVIRONMENT, dependencies(outputs)),
      /National Catalog diagnostic response is invalid/,
    );
  }
});

test("hosted National Catalog CLI prints safe evidence before failing a refused contract", async () => {
  let stdout = "";
  let stderr = "";
  const refused = {
    version: 1,
    passed: false,
    checks: [{ method: "categories", outcome: "forbidden", resultCount: 0, etagPresent: false }],
  };
  const exitCode = await runNationalCatalogDiagnosticsCli({
    argv: ["run"],
    runDiagnostics: async () => refused,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(refused)}\n`);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /token|gtin|tenant|provider detail/i);
});

test("hosted National Catalog CLI reduces private failures to one fixed line", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runNationalCatalogDiagnosticsCli({
    argv: ["run"],
    runDiagnostics: async () => {
      throw new Error("private-bearer-token tenant-id gtin");
    },
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE\n");
});
