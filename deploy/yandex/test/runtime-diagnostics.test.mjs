import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

import {
  RUNTIME_CONFIGURATION_ISSUES,
  RUNTIME_ERROR_CLASSES,
  collectRuntimeSnapshot,
  runRuntimeProbeCli,
} from "../runtime-diagnostics-probe.mjs";
import { runHostedRuntimeDiagnostics, runRuntimeDiagnosticsCli } from "../runtime-diagnostics.mjs";

const API_DIGEST = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE_DIGEST = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const CURRENT = "a2ff20fd3847db6612a0d9ca3dd226cc3e971d90";
const CANDIDATE = "ecdb3f1033237246e6b00e9fb34dd1ad61566c68";
const PRIVATE_FRAGMENTS = [
  "postgres://markiro:private-password@database.internal/markiro",
  "smtp-secret-value",
  "/etc/markiro/production.env",
  "GHCR_TOKEN=private-registry-token",
  "private-stack-frame.ts:99:12",
];

function commandKey(command, args) {
  return `${command}\0${args.join("\0")}`;
}

function fixtureDependencies(overrides = {}) {
  const calls = [];
  const outputs = new Map([
    [commandKey("systemctl", ["is-active", "docker.service"]), "active\n"],
    [commandKey("systemctl", ["is-active", "markiro-runtime-env.service"]), "active\n"],
    [
      commandKey("docker", [
        "ps",
        "-a",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--filter",
        "label=com.docker.compose.service=api",
        "--format",
        "{{.ID}}",
      ]),
      "a1b2c3d4e5f6\n",
    ],
    [
      commandKey("docker", [
        "ps",
        "-a",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--filter",
        "label=com.docker.compose.service=edge",
        "--format",
        "{{.ID}}",
      ]),
      "b1c2d3e4f5a6\n",
    ],
    [
      commandKey("docker", ["inspect", "--format", "{{json .State}}", "a1b2c3d4e5f6"]),
      `${JSON.stringify({
        Status: "exited",
        ExitCode: 1,
        OOMKilled: false,
        Error: "",
        Health: { Status: "unhealthy" },
      })}\n`,
    ],
    [
      commandKey("docker", ["inspect", "--format", "{{json .State}}", "b1c2d3e4f5a6"]),
      `${JSON.stringify({
        Status: "running",
        ExitCode: 0,
        OOMKilled: false,
        Error: "",
        Health: { Status: "healthy" },
      })}\n`,
    ],
    [
      commandKey("docker", ["inspect", "--format", "{{.Image}}", "a1b2c3d4e5f6"]),
      `sha256:${"1".repeat(64)}\n`,
    ],
    [
      commandKey("docker", ["inspect", "--format", "{{.Image}}", "b1c2d3e4f5a6"]),
      `sha256:${"2".repeat(64)}\n`,
    ],
    [
      commandKey("docker", [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        `sha256:${"1".repeat(64)}`,
      ]),
      `${JSON.stringify([API_DIGEST])}\n`,
    ],
    [
      commandKey("docker", [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        `sha256:${"2".repeat(64)}`,
      ]),
      `${JSON.stringify([EDGE_DIGEST])}\n`,
    ],
    [
      commandKey("docker", ["logs", "--tail", "200", "a1b2c3d4e5f6"]),
      {
        stdout: "",
        stderr: `ZodError: required environment value is missing at LANDING_ORIGIN and SMARTCAPTCHA_SERVER_KEY ${PRIVATE_FRAGMENTS.join(" ")}\n`,
      },
    ],
    [commandKey("docker", ["logs", "--tail", "200", "b1c2d3e4f5a6"]), ""],
  ]);
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, [...args]]);
      const key = commandKey(command, args);
      if (!outputs.has(key)) throw new Error(`unexpected command ${key}`);
      const output = outputs.get(key);
      return typeof output === "string"
        ? { code: 0, stdout: output, stderr: "" }
        : { code: 0, ...output };
    },
    readlink: async (path) => {
      assert.equal(path, "/opt/markiro/active-release");
      return `/opt/markiro/releases/${CURRENT}`;
    },
    readdir: async (path) => {
      assert.equal(path, "/var/lib/markiro/releases");
      return ["ignored.tmp", "current.healthy.json", "candidate.failed.json"];
    },
    readFile: async (path) => {
      if (path.endsWith("current.healthy.json"))
        return JSON.stringify({
          tag: CURRENT,
          state: "healthy",
          apiDigest: API_DIGEST,
          edgeDigest: EDGE_DIGEST,
          createdAt: "2026-08-16T05:49:00.000Z",
        });
      if (path.endsWith("candidate.failed.json"))
        return JSON.stringify({
          tag: CANDIDATE,
          state: "failed",
          apiDigest: `ghcr.io/thevladbog/markiro-api@sha256:${"c".repeat(64)}`,
          edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`,
          createdAt: "2026-08-20T05:42:00.000Z",
        });
      throw new Error("unexpected file");
    },
    ...overrides,
  };
}

test("runtime probe emits only the closed diagnostic schema and safe categories", async () => {
  assert.deepEqual(RUNTIME_CONFIGURATION_ISSUES, [
    "LANDING_DEMO_SUBMISSION_ENABLED",
    "LANDING_ORIGIN",
    "LANDING_DEMO_RECIPIENT",
    "LANDING_DEMO_REPLY_TO",
    "SMARTCAPTCHA_SERVER_KEY",
    "LANDING_DEMO_RATE_WINDOW_SECONDS",
    "LANDING_DEMO_SOURCE_LIMIT",
    "LANDING_DEMO_GLOBAL_LIMIT",
    "SMTP_USER",
    "SMTP_PASSWORD",
  ]);
  assert.equal(Object.isFrozen(RUNTIME_CONFIGURATION_ISSUES), true);
  assert.deepEqual(RUNTIME_ERROR_CLASSES, [
    "configuration",
    "database_connection",
    "database_schema",
    "resources",
    "healthcheck",
    "process_crash",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(RUNTIME_ERROR_CLASSES), true);

  const dependencies = fixtureDependencies();
  const snapshot = await collectRuntimeSnapshot(dependencies);
  assert.deepEqual(snapshot, {
    version: 2,
    docker: "active",
    runtimeEnv: "active",
    activeRelease: CURRENT,
    candidateRelease: CANDIDATE,
    api: {
      state: "exited",
      health: "unhealthy",
      exitCode: 1,
      oomKilled: false,
      release: CURRENT,
      errorClasses: ["configuration", "healthcheck", "process_crash"],
      configurationIssues: ["LANDING_ORIGIN", "SMARTCAPTCHA_SERVER_KEY"],
    },
    edge: {
      state: "running",
      health: "healthy",
      exitCode: 0,
      oomKilled: false,
      release: CURRENT,
      errorClasses: [],
      configurationIssues: [],
    },
  });
  const serialized = JSON.stringify(snapshot);
  for (const fragment of PRIVATE_FRAGMENTS) assert.equal(serialized.includes(fragment), false);
});

test("runtime probe executes only the exact read-only command inventory", async () => {
  const dependencies = fixtureDependencies();
  await collectRuntimeSnapshot(dependencies);
  assert.equal(dependencies.calls.length, 12);
  for (const [command, args] of dependencies.calls) {
    assert.ok(["systemctl", "docker"].includes(command));
    if (command === "systemctl") assert.deepEqual(args.slice(0, 1), ["is-active"]);
    if (command === "docker")
      assert.ok(["ps", "inspect", "image", "logs"].includes(args[0]), args.join(" "));
    assert.doesNotMatch(
      `${command} ${args.join(" ")}`,
      /\bdocker\s+(?:compose|run|exec|start|stop|restart|rm|kill)\b|\bsystemctl\s+(?:enable|disable|start|stop|restart)\b/,
    );
  }
});

test("probe CLI emits one canonical line and never raw evidence", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runRuntimeProbeCli({
    dependencies: fixtureDependencies(),
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /^MARKIRO_RUNTIME_DIAGNOSTICS \{[^\n]+\}\n$/);
  for (const fragment of PRIVATE_FRAGMENTS) assert.equal(stdout.includes(fragment), false);
});

test("hosted diagnostic validates and canonicalizes the remote probe response", async () => {
  const snapshot = await collectRuntimeSnapshot(fixtureDependencies());
  const commands = [];
  const result = await runHostedRuntimeDiagnostics(
    {
      YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
      YC_APP_DEPLOY_LOGIN: "markiro-deploy",
      YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
      APP_SSH_HOST_KEYS_B64: Buffer.from(
        `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
      ).toString("base64"),
    },
    {
      validatePrivateKey: async () => undefined,
      readProbe: async () => "probe-source-with-private-looking-fixture",
      run: async (command, args, options) => {
        commands.push({ command, args, options });
        return `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`;
      },
      mkdtemp: async () => "/runner/known-hosts-dir",
      writeFile: async () => undefined,
      rm: async () => undefined,
    },
  );
  assert.deepEqual(result, snapshot);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "ssh");
  assert.match(commands[0].options.input, /probe-source/);
  assert.deepEqual(commands[0].args.slice(-7), [
    "markiro-deploy@203.0.113.42",
    "sudo",
    "/usr/bin/env",
    "MARKIRO_RUNTIME_DIAGNOSTICS_PROBE=1",
    "/usr/bin/node",
    "--input-type=module",
    "-",
  ]);
});

test("hosted CLI reduces every private failure to one fixed line", async () => {
  for (const scenario of [
    { argv: [], runDiagnostics: async () => assert.fail("must not run") },
    {
      argv: ["run"],
      runDiagnostics: async () => {
        throw new Error(PRIVATE_FRAGMENTS.join(" "));
      },
    },
  ]) {
    let stdout = "";
    let stderr = "";
    const exitCode = await runRuntimeDiagnosticsCli({
      ...scenario,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, "MARKIRO_RUNTIME_DIAGNOSTICS_FAILURE\n");
    for (const fragment of PRIVATE_FRAGMENTS)
      assert.equal(`${stdout}${stderr}`.includes(fragment), false);
  }
});

test("production diagnostics workflow is protected, serialized, read only and cleans its key", async () => {
  const source = await readFile(
    new URL("../../../.github/workflows/diagnose-production.yml", import.meta.url),
    "utf8",
  );
  const workflow = load(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["diagnose"]);
  assert.deepEqual(workflow.concurrency, {
    group: "markiro-production-deployment",
    "cancel-in-progress": false,
  });
  const job = workflow.jobs.diagnose;
  assert.equal(job.environment, "production-deploy");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.env.YC_APP_DEPLOY_LOGIN, "markiro-deploy");
  assert.equal(job.env.YC_APP_PUBLIC_ADDRESS, "${{ vars.YC_APP_PUBLIC_ADDRESS }}");
  assert.equal(job.env.APP_SSH_HOST_KEYS_B64, "${{ vars.APP_SSH_HOST_KEYS_B64 }}");

  const checkout = job.steps.find((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.ok(checkout);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with["persist-credentials"], false);

  const diagnose = job.steps.find((step) => step.name === "Diagnose production runtime");
  assert.ok(diagnose);
  assert.equal(
    diagnose.env.YC_APP_DEPLOY_SSH_PRIVATE_KEY,
    "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  );
  assert.match(diagnose.run, /runtime-diagnostics[.]mjs run/);
  assert.match(diagnose.run, /chmod 600/);

  const cleanup = job.steps.find((step) => step.name === "Remove local diagnostic credentials");
  assert.ok(cleanup);
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /markiro-diagnostic-key/);

  const remoteSurface = `${diagnose.run}\n${source.replace(cleanup.run, "")}`;
  assert.doesNotMatch(
    remoteSurface,
    /deploy[.]mjs|remote-deploy|docker compose|\bsystemctl\s+(?:start|stop|restart|enable|disable)\b|\bdocker\s+(?:run|exec|start|stop|restart|rm|kill)\b|serial|lockbox/i,
  );
});
