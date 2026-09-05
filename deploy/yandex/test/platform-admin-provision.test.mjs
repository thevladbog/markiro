import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

import {
  parseProvisionResult,
  provisionEmail,
  runHostedPlatformAdminProvision,
  runPlatformAdminProvisionCli,
} from "../platform-admin-provision.mjs";

const PRIVATE_FRAGMENTS = ["private-key-material", "activation-token", "database-password"];

test("platform admin provisioning accepts one bounded email and rejects command injection", () => {
  assert.equal(provisionEmail("vladislav.bogatyrev@gmail.com"), "vladislav.bogatyrev@gmail.com");
  for (const value of [
    "",
    "not-an-email",
    "admin@example.com;id",
    "admin@example.com\n--password=x",
    `${"a".repeat(245)}@example.com`,
  ]) {
    assert.throws(() => provisionEmail(value), /configuration is invalid/);
  }
});

test("platform admin provisioning accepts identifiers only", () => {
  assert.deepEqual(parseProvisionResult('{"userId":"user-123","deliveryId":"delivery-456"}\n'), {
    userId: "user-123",
    deliveryId: "delivery-456",
  });
  for (const output of [
    "",
    '{"userId":"user-123"}\n',
    '{"userId":"user-123","deliveryId":"delivery-456","token":"activation-token"}\n',
    'debug\n{"userId":"user-123","deliveryId":"delivery-456"}\n',
  ]) {
    assert.throws(() => parseProvisionResult(output), /response is invalid/);
  }
});

test("hosted platform admin provisioning pins SSH and delegates container discovery to the probe", async () => {
  const commands = [];
  const removed = [];
  const result = await runHostedPlatformAdminProvision(
    {
      PLATFORM_ADMIN_EMAIL: "vladislav.bogatyrev@gmail.com",
      YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
      YC_APP_DEPLOY_LOGIN: "markiro-deploy",
      YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
      APP_SSH_HOST_KEYS_B64: Buffer.from(
        `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}\n`,
      ).toString("base64"),
    },
    {
      mkdtemp: async () => "/tmp/platform-admin-provision",
      writeFile: async () => undefined,
      rm: async (path) => removed.push(path),
      validatePrivateKey: async () => undefined,
      readProbe: async () => "probe-source",
      run: async (command, args, options) => {
        commands.push({ command, args, options });
        return 'MARKIRO_PLATFORM_ADMIN_PROVISIONED {"userId":"user-123","deliveryId":"delivery-456"}\n';
      },
    },
  );

  assert.deepEqual(result, { userId: "user-123", deliveryId: "delivery-456" });
  assert.deepEqual(removed, ["/tmp/platform-admin-provision"]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "ssh");
  assert.ok(commands[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(commands[0].args.includes("BatchMode=yes"));
  assert.ok(commands[0].args.includes("markiro-deploy@203.0.113.42"));
  assert.ok(commands[0].args.includes("/runner/private-key"));
  assert.ok(commands[0].args.includes("MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE=1"));
  assert.ok(commands[0].args.includes("PLATFORM_ADMIN_EMAIL=vladislav.bogatyrev@gmail.com"));
  assert.ok(commands[0].args.includes("--input-type=module"));
  assert.ok(commands[0].args.includes("-"));
  assert.equal(commands[0].options.input, "probe-source");
  assert.equal(commands[0].args.includes("markiro-production-api-1"), false);
  assert.equal(commands[0].args.includes("/usr/bin/docker"), false);
  assert.equal(
    commands[0].args.some((arg) => /password|token|DATABASE_URL/.test(arg)),
    false,
  );
});

test("hosted provisioning exposes only the closed remote stage returned by the probe", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runPlatformAdminProvisionCli({
    environment: {
      PLATFORM_ADMIN_EMAIL: "vladislav.bogatyrev@gmail.com",
      YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
      YC_APP_DEPLOY_LOGIN: "markiro-deploy",
      YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
      APP_SSH_HOST_KEYS_B64: Buffer.from(
        `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}\n`,
      ).toString("base64"),
    },
    supplied: {
      mkdtemp: async () => "/tmp/platform-admin-provision",
      writeFile: async () => undefined,
      rm: async () => undefined,
      validatePrivateKey: async () => undefined,
      readProbe: async () => "probe-source",
      run: async () => "MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE container\n",
    },
    argv: ["run"],
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE container\n");
});

test("hosted provisioning classifies a malformed success payload as response", async () => {
  let stderr = "";
  const exitCode = await runPlatformAdminProvisionCli({
    environment: {
      PLATFORM_ADMIN_EMAIL: "vladislav.bogatyrev@gmail.com",
      YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
      YC_APP_DEPLOY_LOGIN: "markiro-deploy",
      YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
      APP_SSH_HOST_KEYS_B64: Buffer.from(
        `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}\n`,
      ).toString("base64"),
    },
    supplied: {
      mkdtemp: async () => "/tmp/platform-admin-provision",
      writeFile: async () => undefined,
      rm: async () => undefined,
      validatePrivateKey: async () => undefined,
      readProbe: async () => "probe-source",
      run: async () =>
        'MARKIRO_PLATFORM_ADMIN_PROVISIONED {"userId":"user-123","deliveryId":"delivery-456","token":"activation-token"}\n',
    },
    argv: ["run"],
    stdout: { write: () => undefined },
    stderr: { write: (value) => (stderr += value) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, "MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE response\n");
  assert.equal(stderr.includes("activation-token"), false);
});

test("production provisioning workflow is protected, serialized and cleans its SSH key", async () => {
  const source = await readFile(
    new URL("../../../.github/workflows/provision-platform-admin.yml", import.meta.url),
    "utf8",
  );
  const workflow = load(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["email"]);
  assert.deepEqual(workflow.concurrency, {
    group: "us-development-locked-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["provision"]);
  const job = workflow.jobs.provision;
  assert.equal(job.environment, "production-deploy");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.deepEqual(job.permissions, { contents: "read" });

  const checkout = job.steps.find((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.ok(checkout);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with["persist-credentials"], false);

  const provision = job.steps.find((step) => step.name === "Provision platform administrator");
  assert.ok(provision);
  assert.equal(provision.env.PLATFORM_ADMIN_EMAIL, "${{ inputs.email }}");
  assert.equal(
    provision.env.YC_APP_DEPLOY_SSH_PRIVATE_KEY,
    "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  );
  assert.match(provision.run, /platform-admin-provision[.]mjs run/);
  assert.match(provision.run, /chmod 600/);

  const cleanup = job.steps.find((step) => step.name === "Remove local provisioning credentials");
  assert.ok(cleanup);
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /markiro-platform-admin-key/);

  for (const fragment of PRIVATE_FRAGMENTS) assert.equal(source.includes(fragment), false);
});
