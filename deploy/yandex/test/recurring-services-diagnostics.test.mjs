import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRecurringServicesEvidence,
  runHostedRecurringServicesDiagnostics,
  runRecurringServicesDiagnosticsCli,
} from "../recurring-services-diagnostics.mjs";

const ENVIRONMENT = Object.freeze({
  YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
  YC_APP_DEPLOY_LOGIN: "markiro-deploy",
  YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
  APP_SSH_HOST_KEYS_B64: Buffer.from(
    `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
  ).toString("base64"),
});

const EVIDENCE = Object.freeze({
  version: 1,
  journal: "through_0161",
  btreeGist: "installed",
  schema: "ready",
  constraints: "validated",
});

function dependencies(outputs, commands = []) {
  let index = 0;
  return {
    validatePrivateKey: async () => undefined,
    mkdtemp: async () => "/runner/recurring-services-known-hosts",
    writeFile: async () => undefined,
    rm: async () => undefined,
    run: async (command, args, options) => {
      commands.push({ command, args, options });
      return outputs[index++];
    },
  };
}

test("hosted recurring-services diagnostic runs a read-only probe in the active API", async () => {
  const commands = [];
  const result = await runHostedRecurringServicesDiagnostics(
    ENVIRONMENT,
    dependencies(
      ["a1b2c3d4e5f6\n", `MARKIRO_RECURRING_SERVICES_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`],
      commands,
    ),
  );

  assert.deepEqual(result, EVIDENCE);
  assert.equal(commands.length, 2);
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
  assert.deepEqual(commands[1].args.slice(-11), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/local/bin/docker",
    "exec",
    "-i",
    "-w",
    "/app",
    "a1b2c3d4e5f6",
    "node",
    "--input-type=module",
    "-",
  ]);
  assert.match(commands[1].options.input, /SELECT EXISTS/);
  assert.doesNotMatch(commands[1].options.input, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
});

test("recurring-services evidence is exact and bounded", () => {
  assert.deepEqual(
    parseRecurringServicesEvidence(
      `MARKIRO_RECURRING_SERVICES_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`,
    ),
    EVIDENCE,
  );
  for (const value of [
    { ...EVIDENCE, version: 2 },
    { ...EVIDENCE, journal: "private" },
    { ...EVIDENCE, detail: "leak" },
  ]) {
    assert.throws(
      () =>
        parseRecurringServicesEvidence(
          `MARKIRO_RECURRING_SERVICES_DIAGNOSTICS ${JSON.stringify(value)}\n`,
        ),
      /invalid/,
    );
  }
});

test("recurring-services diagnostic CLI emits only bounded evidence or a stable failure", async () => {
  let stdout = "";
  let stderr = "";
  assert.equal(
    await runRecurringServicesDiagnosticsCli({
      argv: ["run"],
      runDiagnostics: async () => EVIDENCE,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    0,
  );
  assert.equal(stdout, `MARKIRO_RECURRING_SERVICES_DIAGNOSTICS ${JSON.stringify(EVIDENCE)}\n`);
  assert.equal(stderr, "");

  stdout = "";
  stderr = "";
  assert.equal(
    await runRecurringServicesDiagnosticsCli({
      argv: ["run"],
      runDiagnostics: async () => {
        throw new Error("private database detail");
      },
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.equal(stdout, "");
  assert.equal(stderr, "MARKIRO_RECURRING_SERVICES_DIAGNOSTICS_FAILURE\n");
});
