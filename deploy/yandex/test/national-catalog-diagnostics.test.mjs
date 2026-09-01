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
  version: 2,
  passed: true,
  sourceStatus: "ready",
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
  const next = (command, args, options) => {
    commands.push({ command, args, options });
    const output = outputs[index];
    index += 1;
    return output;
  };
  return {
    validatePrivateKey: async () => undefined,
    run: async (command, args, options) => next(command, args, options),
    runDiagnostic: async (command, args, options) => {
      const output = next(command, args, options);
      return typeof output === "string" ? { exitCode: 0, stdout: output } : output;
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

test("hosted National Catalog diagnostic rejects malformed or inconsistent evidence", async () => {
  const line = (value) => `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(value)}\n`;
  const wrongOrder = structuredClone(EVIDENCE);
  [wrongOrder.checks[0], wrongOrder.checks[1]] = [wrongOrder.checks[1], wrongOrder.checks[0]];
  const emptyFeed = structuredClone(EVIDENCE);
  emptyFeed.checks[3].resultCount = 0;
  const multipleProduct = structuredClone(EVIDENCE);
  multipleProduct.checks[4].resultCount = 2;
  const nonzeroNotModified = structuredClone(EVIDENCE);
  nonzeroNotModified.checks[5].resultCount = 1;
  const inconsistentPassed = structuredClone(EVIDENCE);
  inconsistentPassed.passed = false;
  const inconsistentSource = structuredClone(EVIDENCE);
  inconsistentSource.sourceStatus = "active-token-missing";
  const unknownSource = structuredClone(EVIDENCE);
  unknownSource.sourceStatus = "private-provider-detail";
  const continuedAfterMissingEtag = structuredClone(EVIDENCE);
  continuedAfterMissingEtag.passed = false;
  continuedAfterMissingEtag.checks[0].etagPresent = false;
  const continuedAfterRefusal = structuredClone(EVIDENCE);
  continuedAfterRefusal.passed = false;
  continuedAfterRefusal.checks[2] = {
    method: "attributes",
    outcome: "forbidden",
    resultCount: 0,
    etagPresent: false,
  };
  const continuedAfterCardinalityFailure = structuredClone(EVIDENCE);
  continuedAfterCardinalityFailure.passed = false;
  continuedAfterCardinalityFailure.checks[4].resultCount = 0;

  for (const output of [
    "MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS {not-json}\n",
    line(EVIDENCE).trimEnd(),
    `${line(EVIDENCE)}\n`,
    `unexpected output\n${line(EVIDENCE)}`,
    `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${"x".repeat(8 * 1024)}\n`,
    line(wrongOrder),
    line(emptyFeed),
    line(multipleProduct),
    line(nonzeroNotModified),
    line(inconsistentPassed),
    line(inconsistentSource),
    line(unknownSource),
    line(continuedAfterMissingEtag),
    line(continuedAfterRefusal),
    line(continuedAfterCardinalityFailure),
  ]) {
    await assert.rejects(
      () =>
        runHostedNationalCatalogDiagnostics(
          HOSTED_ENVIRONMENT,
          dependencies(["a1b2c3d4e5f6\tapi\n", output]),
        ),
      /National Catalog diagnostic response is invalid/,
    );
  }
});

test("hosted National Catalog diagnostic accepts only the first failing check as a prefix", async () => {
  for (const checks of [
    [{ method: "categories", outcome: "forbidden", resultCount: 0, etagPresent: false }],
    [{ method: "categories", outcome: "ok", resultCount: 3, etagPresent: false }],
    EVIDENCE.checks
      .slice(0, 4)
      .map((check, index) => (index === 3 ? { ...check, resultCount: 0 } : check)),
  ]) {
    const expected = { version: 2, passed: false, sourceStatus: "ready", checks };
    const result = await runHostedNationalCatalogDiagnostics(
      HOSTED_ENVIRONMENT,
      dependencies([
        "a1b2c3d4e5f6\tapi\n",
        {
          exitCode: 1,
          stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(expected)}\n`,
        },
      ]),
    );
    assert.deepEqual(result, expected);
  }
});

test("hosted National Catalog diagnostic accepts a bounded source status without provider checks", async () => {
  for (const sourceStatus of [
    "encryption-key-missing",
    "active-token-query-failed",
    "active-token-missing",
    "active-token-ambiguous",
    "product-query-failed",
    "product-gtin-unavailable",
    "token-decryption-failed",
  ]) {
    const expected = { version: 2, passed: false, sourceStatus, checks: [] };
    const result = await runHostedNationalCatalogDiagnostics(
      HOSTED_ENVIRONMENT,
      dependencies([
        "a1b2c3d4e5f6\tapi\n",
        {
          exitCode: 1,
          stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(expected)}\n`,
        },
      ]),
    );
    assert.deepEqual(result, expected);
  }
});

test("hosted National Catalog diagnostic preserves bounded evidence from remote exit one", async () => {
  const expected = {
    version: 2,
    passed: false,
    sourceStatus: "active-token-missing",
    checks: [],
  };
  const commands = [];
  const result = await runHostedNationalCatalogDiagnostics(HOSTED_ENVIRONMENT, {
    ...dependencies(["a1b2c3d4e5f6\tapi\n"], commands),
    runDiagnostic: async (command, args, options) => {
      commands.push({ command, args, options });
      return {
        exitCode: 1,
        stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(expected)}\n`,
      };
    },
  });

  assert.deepEqual(result, expected);
  assert.equal(commands.length, 2);
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

test("hosted National Catalog diagnostic rejects widened or inconsistent remote exits", async () => {
  const refused = {
    version: 2,
    passed: false,
    sourceStatus: "active-token-missing",
    checks: [],
  };
  const passedLine = `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`;
  const refusedLine = `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(refused)}\n`;

  for (const execution of [
    { exitCode: 2, stdout: refusedLine },
    { exitCode: 0, stdout: refusedLine },
    { exitCode: 1, stdout: passedLine },
    { exitCode: 1, stdout: refusedLine, stderr: "private" },
  ]) {
    await assert.rejects(
      () =>
        runHostedNationalCatalogDiagnostics(
          HOSTED_ENVIRONMENT,
          dependencies(["a1b2c3d4e5f6\tapi\n", execution]),
        ),
      /National Catalog diagnostic response is invalid/,
    );
  }
});

test("hosted National Catalog CLI prints safe evidence before failing a refused contract", async () => {
  let stdout = "";
  let stderr = "";
  const refused = {
    version: 2,
    passed: false,
    sourceStatus: "ready",
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
