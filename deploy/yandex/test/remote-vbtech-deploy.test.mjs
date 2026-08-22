import assert from "node:assert/strict";
import test from "node:test";

import { runHostedVbtechDeploy, runRemoteVbtechDeployCli } from "../remote-vbtech-deploy.mjs";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_REF = `ghcr.io/thevladbog/vbtech-web@${IMAGE_DIGEST}`;
const ACTIVE_EXECUTOR = "/opt/markiro/active-release/deploy/production/vbtech-deploy.mjs";
const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");
const HOST_KEY = `ssh-ed25519 ${Buffer.alloc(32, 7).toString("base64")}`;
const HOST_KEYS_B64 = Buffer.from(HOST_KEY).toString("base64");

function environment(overrides = {}) {
  return {
    PATH: "/runner/private-bin",
    CI: "true",
    DATABASE_URL: "postgres://must-not-reach-ssh",
    YC_IAM_TOKEN: "must-not-reach-ssh",
    YC_APP_PUBLIC_ADDRESS: "203.0.113.55",
    YC_APP_DEPLOY_LOGIN: "markiro-deploy",
    YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/markiro-deploy-key",
    APP_SSH_HOST_KEYS_B64: HOST_KEYS_B64,
    GHCR_USERNAME: "github-actions",
    GHCR_TOKEN: "masked-job-token",
    MARKIRO_DOMAIN: "admin.markiro.example",
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
    MARKIRO_LANDING_DOMAIN: "markiro.example",
    VBTECH_RELEASE_SHA: RELEASE_SHA,
    VBTECH_IMAGE_DIGEST: IMAGE_DIGEST,
    ...overrides,
  };
}

function systemFixture(overrides = {}) {
  const commands = [];
  const writes = [];
  const removals = [];
  const directories = [];
  const system = {
    stat: async () => ({ isFile: () => true, mode: 0o100600, size: PRIVATE_KEY.length }),
    readFile: async () => PRIVATE_KEY,
    mkdtemp: async (prefix) => {
      directories.push(prefix);
      return "/tmp/markiro-vbtech-ssh-test";
    },
    writeFile: async (path, value, options) => writes.push({ path, value, options }),
    rm: async (path, options) => removals.push({ path, options }),
    run: async (command, args, options = {}) => {
      commands.push({ command, args, options });
      return args.includes("contract-version")
        ? "MARKIRO_VBTECH_EXECUTOR 1\n"
        : "MARKIRO_VBTECH_DEPLOY_HEALTHY\n";
    },
    ...overrides,
  };
  return { commands, directories, removals, system, writes };
}

function commandEnvironmentArguments(args) {
  const start = args.indexOf("/usr/bin/env");
  const end = args.indexOf("/usr/bin/node", start + 1);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  return args.slice(start + 1, end);
}

test("hosted wrapper uses the active executor, fixed SSH trust, and an exact remote environment", async () => {
  const fixture = systemFixture();

  assert.equal(await runHostedVbtechDeploy(environment(), fixture.system), undefined);

  assert.equal(fixture.directories.length, 1);
  assert.equal(fixture.directories[0].endsWith("/markiro-vbtech-ssh-"), true);
  assert.deepEqual(fixture.writes, [
    {
      path: "/tmp/markiro-vbtech-ssh-test/known_hosts",
      value: `203.0.113.55 ${HOST_KEY}\n`,
      options: { encoding: "utf8", mode: 0o600 },
    },
  ]);
  assert.deepEqual(fixture.removals, [
    {
      path: "/tmp/markiro-vbtech-ssh-test",
      options: { recursive: true, force: true },
    },
  ]);

  assert.equal(fixture.commands.length, 2);
  const [contract, deployment] = fixture.commands;
  const sshPrefix = [
    "-F",
    "/dev/null",
    "-i",
    "/runner/markiro-deploy-key",
    "-o",
    "UserKnownHostsFile=/tmp/markiro-vbtech-ssh-test/known_hosts",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "markiro-deploy@203.0.113.55",
  ];
  assert.equal(contract.command, "/usr/bin/ssh");
  assert.deepEqual(contract.args, [
    ...sshPrefix,
    "sudo",
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=5s",
    "30s",
    "/usr/bin/node",
    ACTIVE_EXECUTOR,
    "contract-version",
  ]);
  assert.deepEqual(contract.options, { env: {} });

  assert.equal(deployment.command, "/usr/bin/ssh");
  assert.deepEqual(deployment.args.slice(0, sshPrefix.length), sshPrefix);
  assert.deepEqual(commandEnvironmentArguments(deployment.args), [
    "MARKIRO_COMPOSE_PROJECT=markiro-production",
    "MARKIRO_ENV_FILE=/etc/markiro/production.env",
    "MARKIRO_DOMAIN=admin.markiro.example",
    "MARKIRO_SAAS_ADMIN_DOMAIN=saas-admin.markiro.example",
    "MARKIRO_KIOSK_DOMAIN=kiosk.markiro.example",
    "MARKIRO_LANDING_DOMAIN=markiro.example",
    `VBTECH_RELEASE_SHA=${RELEASE_SHA}`,
    `VBTECH_IMAGE_DIGEST=${IMAGE_DIGEST}`,
    `VBTECH_IMAGE_REF=${IMAGE_REF}`,
    "VBTECH_DOMAIN=v-b.tech",
    "VBTECH_WWW_DOMAIN=www.v-b.tech",
    "VBTECH_SUBMISSION_STATE=disabled",
  ]);
  assert.deepEqual(deployment.args.slice(sshPrefix.length), [
    "sudo",
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=30s",
    "16m",
    "/usr/bin/systemd-run",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--property=Requires=markiro-runtime-env.service",
    "--property=After=markiro-runtime-env.service",
    "--property=RuntimeMaxSec=15min",
    "--property=TimeoutStopSec=30s",
    "--working-directory=/opt/markiro/active-release",
    "/usr/bin/env",
    "MARKIRO_COMPOSE_PROJECT=markiro-production",
    "MARKIRO_ENV_FILE=/etc/markiro/production.env",
    "MARKIRO_DOMAIN=admin.markiro.example",
    "MARKIRO_SAAS_ADMIN_DOMAIN=saas-admin.markiro.example",
    "MARKIRO_KIOSK_DOMAIN=kiosk.markiro.example",
    "MARKIRO_LANDING_DOMAIN=markiro.example",
    `VBTECH_RELEASE_SHA=${RELEASE_SHA}`,
    `VBTECH_IMAGE_DIGEST=${IMAGE_DIGEST}`,
    `VBTECH_IMAGE_REF=${IMAGE_REF}`,
    "VBTECH_DOMAIN=v-b.tech",
    "VBTECH_WWW_DOMAIN=www.v-b.tech",
    "VBTECH_SUBMISSION_STATE=disabled",
    "/usr/bin/node",
    "/usr/local/lib/markiro/registry-auth.mjs",
    "run-stdin",
    "/usr/bin/node",
    ACTIVE_EXECUTOR,
    "run",
  ]);
  assert.deepEqual(deployment.options.env, {});
  assert.deepEqual(JSON.parse(deployment.options.input), {
    entries: [
      { key: "GHCR_USERNAME", textValue: "github-actions" },
      { key: "GHCR_TOKEN", textValue: "masked-job-token" },
    ],
  });
  assert.equal(deployment.options.input.endsWith("\n"), true);

  const serializedArguments = JSON.stringify(fixture.commands.map(({ args }) => args));
  const serializedChildEnvironments = JSON.stringify(
    fixture.commands.map(({ options }) => options.env),
  );
  for (const privateValue of [
    "masked-job-token",
    "github-actions",
    "postgres://must-not-reach-ssh",
    "must-not-reach-ssh",
    "/runner/private-bin",
  ]) {
    assert.equal(serializedArguments.includes(privateValue), false);
    assert.equal(serializedChildEnvironments.includes(privateValue), false);
  }
  assert.equal(deployment.args.includes("DOCKER_CONFIG"), false);
  assert.equal(deployment.args.includes("VBTECH_IMAGE_TAG"), false);
  assert.equal(deployment.args.includes("VBTECH_FUNCTION_ORIGIN"), false);
  assert.equal(deployment.args.includes("VBTECH_FUNCTION_PATH"), false);
  assert.equal(
    deployment.args.some((argument) => argument.startsWith("--unit=")),
    false,
  );
  assert.equal(deployment.args.includes("-A"), false);
  assert.equal(deployment.args.includes("StrictHostKeyChecking=no"), false);
  assert.equal(deployment.args.includes("UserKnownHostsFile=/dev/null"), false);
  assert.equal(deployment.args.includes("GlobalKnownHostsFile=/dev/null"), true);
  assert.equal(deployment.args.includes("/usr/bin/bash"), false);
  assert.equal(deployment.args.includes("-c"), false);
  assert.equal(deployment.args.includes("printenv"), false);
});

test("hosted wrapper disables the global known-host store for contract and deploy", async () => {
  const fixture = systemFixture();

  await runHostedVbtechDeploy(environment(), fixture.system);

  assert.equal(fixture.commands.length, 2);
  for (const [stage, command] of ["contract", "deploy"].map((stage, index) => [
    stage,
    fixture.commands[index],
  ])) {
    const globalKnownHosts = command.args.indexOf("GlobalKnownHostsFile=/dev/null");
    const remoteTarget = command.args.indexOf("markiro-deploy@203.0.113.55");
    assert.ok(globalKnownHosts > 0, `${stage}: global known hosts must be disabled`);
    assert.equal(command.args[globalKnownHosts - 1], "-o", stage);
    assert.ok(globalKnownHosts < remoteTarget, `${stage}: trust option must precede remote target`);
    assert.equal(
      command.args.filter((argument) => argument === "GlobalKnownHostsFile=/dev/null").length,
      1,
      stage,
    );
  }
});

test("hosted wrapper accepts only a matching optional image reference", async () => {
  const matching = systemFixture();
  await runHostedVbtechDeploy(environment({ VBTECH_IMAGE_REF: IMAGE_REF }), matching.system);
  assert.equal(matching.commands.length, 2);

  for (const reference of [
    `ghcr.io/thevladbog/vbtech-web@sha256:${"e".repeat(64)}`,
    `ghcr.io/thevladbog/vbtech-web:${RELEASE_SHA}`,
    "ghcr.io/thevladbog/vbtech-web:latest",
    IMAGE_DIGEST,
  ]) {
    const fixture = systemFixture();
    await assert.rejects(
      runHostedVbtechDeploy(environment({ VBTECH_IMAGE_REF: reference }), fixture.system),
      /hosted v-b deployment configuration is invalid/,
    );
    assert.deepEqual(fixture.directories, []);
    assert.deepEqual(fixture.commands, []);
  }
});

test("hosted wrapper rejects malformed, legacy, and caller-controlled fixed input", async () => {
  const cases = [
    ["missing SHA", { VBTECH_RELEASE_SHA: "" }],
    ["uppercase SHA", { VBTECH_RELEASE_SHA: RELEASE_SHA.toUpperCase() }],
    ["uppercase digest", { VBTECH_IMAGE_DIGEST: IMAGE_DIGEST.toUpperCase() }],
    ["digest without algorithm", { VBTECH_IMAGE_DIGEST: "d".repeat(64) }],
    ["legacy image tag", { VBTECH_IMAGE_TAG: RELEASE_SHA }],
    ["submission override", { VBTECH_SUBMISSION_STATE: "disabled" }],
    ["function origin", { VBTECH_FUNCTION_ORIGIN: "https://functions.example/private" }],
    ["function path", { VBTECH_FUNCTION_PATH: "" }],
    ["v-b apex override", { VBTECH_DOMAIN: "v-b.tech" }],
    ["v-b www override", { VBTECH_WWW_DOMAIN: "www.v-b.tech" }],
    ["Compose project override", { MARKIRO_COMPOSE_PROJECT: "markiro-production" }],
    ["environment file override", { MARKIRO_ENV_FILE: "/etc/markiro/production.env" }],
    ["Docker config", { DOCKER_CONFIG: "/run/markiro-registry-auth/session-caller" }],
    ["unknown v-b input", { VBTECH_EXTRA: "private" }],
    ["v-b apex as Markiro domain", { MARKIRO_DOMAIN: "v-b.tech" }],
    ["v-b www as Markiro domain", { MARKIRO_LANDING_DOMAIN: "www.v-b.tech" }],
  ];
  for (const [name, overrides] of cases) {
    const fixture = systemFixture();
    await assert.rejects(
      runHostedVbtechDeploy(environment(overrides), fixture.system),
      /hosted v-b deployment configuration is invalid/,
      name,
    );
    assert.deepEqual(fixture.directories, [], name);
    assert.deepEqual(fixture.commands, [], name);
  }
});

test("hosted wrapper validates the dedicated login, address, host keys, and private key before SSH", async () => {
  const scenarios = [
    ["login", { YC_APP_DEPLOY_LOGIN: "root" }, {}],
    ["address", { YC_APP_PUBLIC_ADDRESS: "127.0.0.1" }, {}],
    ["host key", { APP_SSH_HOST_KEYS_B64: "invalid" }, {}],
    [
      "oversized host keys",
      {
        APP_SSH_HOST_KEYS_B64: Buffer.from(
          `ssh-ed25519 ${Buffer.alloc(64 * 1024, 3).toString("base64")}`,
        ).toString("base64"),
      },
      {},
    ],
    [
      "private key mode",
      {},
      {
        stat: async () => ({
          isFile: () => true,
          mode: 0o100644,
          size: PRIVATE_KEY.length,
        }),
      },
    ],
  ];
  for (const [name, environmentOverrides, systemOverrides] of scenarios) {
    const fixture = systemFixture(systemOverrides);
    await assert.rejects(
      runHostedVbtechDeploy(environment(environmentOverrides), fixture.system),
      undefined,
      name,
    );
    assert.deepEqual(fixture.directories, [], name);
    assert.deepEqual(fixture.commands, [], name);
  }
});

test("hosted wrapper requires the exact active executor contract before deployment", async () => {
  for (const contractOutput of [
    "",
    "MARKIRO_VBTECH_EXECUTOR 2\n",
    "MARKIRO_VBTECH_EXECUTOR 1\nextra\n",
    "private bootstrap failure detail\n",
  ]) {
    const fixture = systemFixture({
      run: async (command, args, options = {}) => {
        fixture.commands.push({ command, args, options });
        return contractOutput;
      },
    });
    await assert.rejects(runHostedVbtechDeploy(environment(), fixture.system), (error) => {
      assert.equal(error.message, "v-b executor bootstrap is required");
      if (contractOutput.trim()) assert.equal(String(error).includes(contractOutput.trim()), false);
      return true;
    });
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].args.includes("contract-version"), true);
    assert.equal(fixture.commands[0].args.includes("/usr/bin/systemd-run"), false);
    assert.equal(fixture.removals.length, 1);
  }
});

test("hosted wrapper treats an absent active executor as the same bounded bootstrap failure", async () => {
  const fixture = systemFixture({
    run: async (command, args, options = {}) => {
      fixture.commands.push({ command, args, options });
      throw new Error("remote path and key detail must stay private");
    },
  });
  await assert.rejects(runHostedVbtechDeploy(environment(), fixture.system), (error) => {
    assert.equal(error.message, "v-b executor bootstrap is required");
    assert.equal(String(error).includes("remote path"), false);
    return true;
  });
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.removals.length, 1);
});

test("hosted wrapper accepts only the exact healthy executor marker", async () => {
  for (const deploymentOutput of [
    "",
    "MARKIRO_VBTECH_DEPLOY_HEALTHY",
    "MARKIRO_VBTECH_DEPLOY_HEALTHY\nextra\n",
    "MARKIRO_VBTECH_DEPLOY_FAILURE candidate-health\n",
  ]) {
    let call = 0;
    const fixture = systemFixture({
      run: async (command, args, options = {}) => {
        fixture.commands.push({ command, args, options });
        call += 1;
        return call === 1 ? "MARKIRO_VBTECH_EXECUTOR 1\n" : deploymentOutput;
      },
    });
    await assert.rejects(
      runHostedVbtechDeploy(environment(), fixture.system),
      /hosted v-b deployment failed/,
    );
    assert.equal(fixture.commands.length, 2);
    assert.equal(fixture.removals.length, 1);
  }
});

test("hosted wrapper cleans temporary trust material and preserves the primary failure", async () => {
  const primary = new Error("private remote deployment failure");
  let call = 0;
  const fixture = systemFixture({
    run: async (command, args, options = {}) => {
      fixture.commands.push({ command, args, options });
      call += 1;
      if (call === 1) return "MARKIRO_VBTECH_EXECUTOR 1\n";
      throw primary;
    },
    rm: async (path, options) => {
      fixture.removals.push({ path, options });
      throw new Error("private cleanup failure");
    },
  });
  await assert.rejects(runHostedVbtechDeploy(environment(), fixture.system), (error) => {
    assert.equal(error, primary);
    return true;
  });
  assert.equal(fixture.removals.length, 1);
});

test("hosted CLI emits only fixed success, bootstrap, or generic failure output", async () => {
  {
    let stdout = "";
    let stderr = "";
    const exitCode = await runRemoteVbtechDeployCli({
      argv: ["run"],
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
      runDeployment: async () => undefined,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "MARKIRO_VBTECH_DEPLOY_HEALTHY\n");
    assert.equal(stderr, "");
  }

  for (const scenario of [
    { argv: [], runDeployment: async () => assert.fail("must not run") },
    { argv: ["wrong"], runDeployment: async () => assert.fail("must not run") },
    {
      argv: ["run"],
      runDeployment: async () => {
        throw new Error("token=private registry and SSH detail");
      },
    },
  ]) {
    let stdout = "";
    let stderr = "";
    const exitCode = await runRemoteVbtechDeployCli({
      ...scenario,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, "MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE\n");
    assert.equal(stderr.includes("private"), false);
  }
});

test("hosted CLI gives a fixed operator-facing bootstrap instruction", async () => {
  const fixture = systemFixture({
    run: async (command, args, options = {}) => {
      fixture.commands.push({ command, args, options });
      return "MARKIRO_VBTECH_EXECUTOR 0\nprivate-detail";
    },
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runRemoteVbtechDeployCli({
    argv: ["run"],
    environment: environment(),
    supplied: fixture.system,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "MARKIRO_VBTECH_EXECUTOR_BOOTSTRAP_REQUIRED an executor-bearing Markiro release must be deployed first\n",
  );
  assert.equal(stderr.includes("private-detail"), false);
});
