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
  version: 3,
  passed: true,
  sourceStatus: "ready",
  contractStatus: "conformant",
  capabilities: {
    schemaRead: "available",
    ownedCardRead: "available",
    publishedCardRead: "available",
  },
  checks: [
    {
      method: "categories",
      outcome: "ok",
      resultCount: 3,
      cacheObservation: "etag_present",
      usagePresent: true,
    },
    {
      method: "categories-repeat",
      outcome: "not_modified",
      resultCount: 0,
      cacheObservation: "not_modified",
      usagePresent: false,
    },
    {
      method: "attributes",
      outcome: "ok",
      resultCount: 42,
      cacheObservation: "not_checked",
      usagePresent: true,
    },
    {
      method: "feed-product",
      outcome: "ok",
      resultCount: 1,
      cacheObservation: "not_checked",
      usagePresent: true,
    },
    {
      method: "product",
      outcome: "ok",
      resultCount: 1,
      cacheObservation: "etag_present",
      usagePresent: true,
    },
    {
      method: "product-repeat",
      outcome: "not_modified",
      resultCount: 0,
      cacheObservation: "not_modified",
      usagePresent: false,
    },
  ],
  violations: [],
});

function sourceFailureEvidence(sourceStatus = "active-token-missing") {
  return {
    version: 3,
    passed: false,
    sourceStatus,
    contractStatus: "degraded",
    capabilities: {
      schemaRead: "not_checked",
      ownedCardRead: "not_checked",
      publishedCardRead: "not_checked",
    },
    checks: [],
    violations: [{ capability: "source", code: "source_unavailable" }],
  };
}

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

test("hosted National Catalog diagnostic discovers the active API with shell-safe SSH arguments", async () => {
  const commands = [];
  const result = await runHostedNationalCatalogDiagnostics(
    HOSTED_ENVIRONMENT,
    dependencies(
      ["a1b2c3d4e5f6\n", `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`],
      commands,
    ),
  );

  assert.deepEqual(result, EVIDENCE);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, "ssh");
  assert.deepEqual(commands[0].args.slice(-9), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/local/bin/docker",
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    "label=com.docker.compose.service=api",
  ]);
  assert.equal(commands[1].command, "ssh");
  assert.deepEqual(commands[1].args.slice(-8), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/local/bin/docker",
    "exec",
    "-i",
    "a1b2c3d4e5f6",
    "node",
    "dist/national-catalog-live-diagnostic.js",
  ]);
  assert.equal(commands[1].options, undefined);
});

test("hosted National Catalog diagnostic rejects missing or ambiguous containers and widened evidence", async () => {
  for (const outputs of [
    [""],
    ["a1b2c3d4e5f6\nb1c2d3e4f5a6\n"],
    [
      "a1b2c3d4e5f6\n",
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
  const nonzeroNotModified = structuredClone(EVIDENCE);
  nonzeroNotModified.checks[5].resultCount = 1;
  const inconsistentSource = structuredClone(EVIDENCE);
  inconsistentSource.sourceStatus = "active-token-missing";
  const unknownSource = structuredClone(EVIDENCE);
  unknownSource.sourceStatus = "private-provider-detail";
  const unknownCapability = structuredClone(EVIDENCE);
  unknownCapability.capabilities.schemaRead = "private";
  const unknownCache = structuredClone(EVIDENCE);
  unknownCache.checks[0].cacheObservation = "private";
  const unknownOutcome = structuredClone(EVIDENCE);
  unknownOutcome.checks[0].outcome = "private";
  const negativeCount = structuredClone(EVIDENCE);
  negativeCount.checks[0].resultCount = -1;
  const excessiveCount = structuredClone(EVIDENCE);
  excessiveCount.checks[0].resultCount = 1_000_001;
  const widenedCapability = structuredClone(EVIDENCE);
  widenedCapability.capabilities.tenantId = "private-tenant";
  const widenedCheck = structuredClone(EVIDENCE);
  widenedCheck.checks[0].gtin = "private-gtin";
  const widenedViolation = sourceFailureEvidence();
  widenedViolation.violations[0].message = "private-provider-message";
  const unknownViolation = sourceFailureEvidence();
  unknownViolation.violations[0].code = "private-code";
  const wrongVersion = structuredClone(EVIDENCE);
  wrongVersion.version = 2;
  const unknownVersion = structuredClone(EVIDENCE);
  unknownVersion.version = 4;

  for (const output of [
    "MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS {not-json}\n",
    line(EVIDENCE).trimEnd(),
    `${line(EVIDENCE)}\n`,
    `unexpected output\n${line(EVIDENCE)}`,
    `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${"x".repeat(8 * 1024)}\n`,
    line(wrongOrder),
    line(nonzeroNotModified),
    line(inconsistentSource),
    line(unknownSource),
    line(unknownCapability),
    line(unknownCache),
    line(unknownOutcome),
    line(negativeCount),
    line(excessiveCount),
    line(widenedCapability),
    line(widenedCheck),
    line(widenedViolation),
    line(unknownViolation),
    line(wrongVersion),
    line(unknownVersion),
  ]) {
    await assert.rejects(
      () =>
        runHostedNationalCatalogDiagnostics(
          HOSTED_ENVIRONMENT,
          dependencies(["a1b2c3d4e5f6\n", output]),
        ),
      /National Catalog diagnostic response is invalid/,
    );
  }
});

test("hosted National Catalog diagnostic accepts independent skipped and failing capabilities", async () => {
  const expected = {
    version: 3,
    passed: false,
    sourceStatus: "ready",
    contractStatus: "degraded",
    capabilities: {
      schemaRead: "unavailable",
      ownedCardRead: "unavailable",
      publishedCardRead: "available",
    },
    checks: [
      {
        method: "categories",
        outcome: "unavailable",
        resultCount: 0,
        cacheObservation: "not_checked",
        usagePresent: false,
      },
      EVIDENCE.checks[2],
      {
        method: "feed-product",
        outcome: "forbidden",
        resultCount: 0,
        cacheObservation: "not_checked",
        usagePresent: false,
      },
      { ...EVIDENCE.checks[4], cacheObservation: "etag_missing" },
      {
        method: "product-repeat",
        outcome: "ok",
        resultCount: 1,
        cacheObservation: "same_hash",
        usagePresent: true,
      },
    ],
    violations: [
      { capability: "schema_read", code: "schema_read_failed" },
      { capability: "owned_card_read", code: "owned_card_read_failed" },
      { capability: "published_card_read", code: "cache_contract_degraded" },
    ],
  };
  const result = await runHostedNationalCatalogDiagnostics(
    HOSTED_ENVIRONMENT,
    dependencies([
      "a1b2c3d4e5f6\n",
      {
        exitCode: 1,
        stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(expected)}\n`,
      },
    ]),
  );
  assert.deepEqual(result, expected);
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
    const expected = sourceFailureEvidence(sourceStatus);
    const result = await runHostedNationalCatalogDiagnostics(
      HOSTED_ENVIRONMENT,
      dependencies([
        "a1b2c3d4e5f6\n",
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
  const expected = sourceFailureEvidence();
  const commands = [];
  const result = await runHostedNationalCatalogDiagnostics(HOSTED_ENVIRONMENT, {
    ...dependencies(["a1b2c3d4e5f6\n"], commands),
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
    "/usr/local/bin/docker",
    "exec",
    "-i",
    "a1b2c3d4e5f6",
    "node",
    "dist/national-catalog-live-diagnostic.js",
  ]);
  assert.equal(commands[1].options, undefined);
});

test("hosted National Catalog diagnostic rejects widened or inconsistent remote exits", async () => {
  const refused = sourceFailureEvidence();
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
          dependencies(["a1b2c3d4e5f6\n", execution]),
        ),
      /National Catalog diagnostic response is invalid/,
    );
  }
});

test("hosted National Catalog CLI prints safe evidence before failing a refused contract", async () => {
  let stdout = "";
  let stderr = "";
  const refused = sourceFailureEvidence();
  const exitCode = await runNationalCatalogDiagnosticsCli({
    argv: ["run"],
    runDiagnostics: async () => refused,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(refused)}\n`);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /private-bearer-token|04601234567890|tenant-id|provider detail/i);
});

test("hosted National Catalog CLI reduces unclassified private failures to a fixed stage", async () => {
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
  assert.equal(stderr, 'MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"unknown"}\n');
  assert.doesNotMatch(stderr, /private-bearer-token|tenant-id|gtin/);
});

test("hosted National Catalog CLI classifies the boundary that lost API evidence", async () => {
  for (const testCase of [
    {
      name: "container discovery transport",
      outputs: [],
      run: async () => {
        throw new Error("private SSH or Docker discovery detail");
      },
      stage: "api-container-discovery-transport",
    },
    {
      name: "container discovery result",
      outputs: ["private-container-output\n"],
      stage: "api-container-discovery",
    },
    {
      name: "API CLI transport",
      outputs: ["a1b2c3d4e5f6\n"],
      runDiagnostic: async () => {
        throw new Error("private SSH or Docker detail");
      },
      stage: "api-cli-transport",
    },
    {
      name: "missing API evidence",
      outputs: ["a1b2c3d4e5f6\n", { exitCode: 1, stdout: "" }],
      stage: "api-cli-evidence-missing",
    },
    {
      name: "invalid API evidence",
      outputs: ["a1b2c3d4e5f6\n", { exitCode: 1, stdout: "private malformed evidence\n" }],
      stage: "api-cli-evidence-invalid",
    },
  ]) {
    let stdout = "";
    let stderr = "";
    const supplied = dependencies(testCase.outputs);
    if (testCase.run) supplied.run = testCase.run;
    if (testCase.runDiagnostic) supplied.runDiagnostic = testCase.runDiagnostic;
    const exitCode = await runNationalCatalogDiagnosticsCli({
      argv: ["run"],
      environment: HOSTED_ENVIRONMENT,
      supplied,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    });

    assert.equal(exitCode, 1, testCase.name);
    assert.equal(stdout, "", testCase.name);
    assert.equal(
      stderr,
      `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"${testCase.stage}"}\n`,
      testCase.name,
    );
    assert.doesNotMatch(stderr, /private|container-output|SSH|Docker/i, testCase.name);
  }
});

test("hosted National Catalog CLI revalidates a tampered typed stage before serialization", async () => {
  let typedFailure;
  try {
    await runHostedNationalCatalogDiagnostics(
      { ...HOSTED_ENVIRONMENT, YC_APP_DEPLOY_LOGIN: "private-login" },
      dependencies([]),
    );
  } catch (error) {
    typedFailure = error;
  }
  assert.ok(typedFailure instanceof Error);
  typedFailure.stage = "private-tenant-id";

  let stderr = "";
  const exitCode = await runNationalCatalogDiagnosticsCli({
    argv: ["run"],
    runDiagnostics: async () => {
      throw typedFailure;
    },
    stdout: { write: () => undefined },
    stderr: { write: (value) => (stderr += value) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, 'MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"unknown"}\n');
  assert.doesNotMatch(stderr, /private|tenant|login/i);
});

test("hosted National Catalog CLI classifies remaining host stages and preserves primary failure", async () => {
  const refused = sourceFailureEvidence();
  const cases = [
    {
      name: "configuration",
      environment: { ...HOSTED_ENVIRONMENT, YC_APP_DEPLOY_LOGIN: "private-login" },
      supplied: dependencies([]),
      stage: "configuration",
    },
    {
      name: "credential validation",
      environment: HOSTED_ENVIRONMENT,
      supplied: {
        ...dependencies([]),
        validatePrivateKey: async () => {
          throw new Error("private credential detail");
        },
      },
      stage: "credential-validation",
    },
    {
      name: "workspace setup",
      environment: HOSTED_ENVIRONMENT,
      supplied: {
        ...dependencies([]),
        mkdtemp: async () => {
          throw new Error("private workspace detail");
        },
      },
      stage: "workspace-setup",
    },
    {
      name: "unexpected API CLI exit",
      environment: HOSTED_ENVIRONMENT,
      supplied: dependencies([
        "a1b2c3d4e5f6\n",
        { exitCode: 2, stdout: "private ignored output\n" },
      ]),
      stage: "api-cli-exit",
    },
    {
      name: "API CLI exit mismatch",
      environment: HOSTED_ENVIRONMENT,
      supplied: dependencies([
        "a1b2c3d4e5f6\n",
        {
          exitCode: 0,
          stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(refused)}\n`,
        },
      ]),
      stage: "api-cli-exit-mismatch",
    },
    {
      name: "cleanup",
      environment: HOSTED_ENVIRONMENT,
      supplied: {
        ...dependencies([
          "a1b2c3d4e5f6\n",
          `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`,
        ]),
        rm: async () => {
          throw new Error("private cleanup detail");
        },
      },
      stage: "cleanup",
    },
    {
      name: "primary failure wins over cleanup",
      environment: HOSTED_ENVIRONMENT,
      supplied: {
        ...dependencies(["private-container-output\n"]),
        rm: async () => {
          throw new Error("private cleanup detail");
        },
      },
      stage: "api-container-discovery",
    },
  ];

  for (const testCase of cases) {
    let stdout = "";
    let stderr = "";
    const exitCode = await runNationalCatalogDiagnosticsCli({
      argv: ["run"],
      environment: testCase.environment,
      supplied: testCase.supplied,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    });

    assert.equal(exitCode, 1, testCase.name);
    assert.equal(stdout, "", testCase.name);
    assert.equal(
      stderr,
      `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"${testCase.stage}"}\n`,
      testCase.name,
    );
    assert.doesNotMatch(
      stderr,
      /private-login|private credential detail|private workspace detail|private cleanup detail|private-container-output/i,
    );
  }
});
