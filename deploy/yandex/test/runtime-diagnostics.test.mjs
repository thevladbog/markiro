import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { load } from "js-yaml";

import {
  RUNTIME_CONFIGURATION_ISSUES,
  RUNTIME_ERROR_CLASSES,
  collectRuntimeSnapshot,
  runRuntimeProbeCli,
  validateRuntimeSnapshot,
} from "../runtime-diagnostics-probe.mjs";
import { runHostedRuntimeDiagnostics, runRuntimeDiagnosticsCli } from "../runtime-diagnostics.mjs";

const API_DIGEST = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE_DIGEST = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const VBTECH_IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;
const VBTECH_IMAGE_REF = `ghcr.io/thevladbog/vbtech-web@${VBTECH_IMAGE_DIGEST}`;
const CURRENT = "a2ff20fd3847db6612a0d9ca3dd226cc3e971d90";
const CANDIDATE = "ecdb3f1033237246e6b00e9fb34dd1ad61566c68";
const VBTECH_RELEASE = "f3a640dcf5b85df3a0563ea1df0b1f05e52e5c23";
const FAILED_ENABLED_VBTECH_RELEASE = "b".repeat(40);
const FAILED_ENABLED_VBTECH_IMAGE_DIGEST = `sha256:${"f".repeat(64)}`;
const FAILED_ENABLED_VBTECH_IMAGE_REF = `ghcr.io/thevladbog/vbtech-web@${FAILED_ENABLED_VBTECH_IMAGE_DIGEST}`;
const COMPOSE_NETWORK = "markiro-production_default";
const MARKIRO_RELEASE_DIRECTORY = "/var/lib/markiro/releases";
const VBTECH_RELEASE_DIRECTORY = "/var/lib/markiro/vbtech/releases";
const CPU_SAMPLE_INTERVAL_MS = 100;
const PRIVATE_FRAGMENTS = [
  "postgres://markiro:private-password@database.internal/markiro",
  "smtp-secret-value",
  "/etc/markiro/production.env",
  "GHCR_TOKEN=private-registry-token",
  "private-stack-frame.ts:99:12",
  "10.0.0.17",
];

const VBTECH_PENDING = Object.freeze({
  releaseSha: VBTECH_RELEASE,
  imageRef: VBTECH_IMAGE_REF,
  imageDigest: VBTECH_IMAGE_DIGEST,
  submissionState: "disabled",
  createdAt: "2026-08-21T10:11:12.000Z",
  state: "pending",
});
const VBTECH_HEALTHY = Object.freeze({ ...VBTECH_PENDING, state: "healthy" });
const FAILED_ENABLED_VBTECH_PENDING = Object.freeze({
  releaseSha: FAILED_ENABLED_VBTECH_RELEASE,
  imageRef: FAILED_ENABLED_VBTECH_IMAGE_REF,
  imageDigest: FAILED_ENABLED_VBTECH_IMAGE_DIGEST,
  submissionState: "enabled",
  createdAt: "2026-08-23T03:51:04.000Z",
  state: "pending",
});
const FAILED_ENABLED_VBTECH_TERMINAL = Object.freeze({
  ...FAILED_ENABLED_VBTECH_PENDING,
  state: "failed",
});

function commandKey(command, args) {
  return `${command}\0${args.join("\0")}`;
}

function serviceListArguments(service) {
  return [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
  ];
}

function vbtechRecordFileName(record) {
  return `${record.createdAt.replace(/[:.]/g, "-")}-${record.releaseSha}-${record.imageDigest.slice(7)}.${record.state}.json`;
}

function vbtechClaimFileName(kind, generation, record = VBTECH_PENDING) {
  return `.vbtech-release-state.${record.releaseSha}-${record.imageDigest.slice(7)}.${kind}-${generation}.claim`;
}

function fixtureDependencies(overrides = {}) {
  const calls = [];
  const resourceCalls = [];
  const outputs = new Map([
    [commandKey("systemctl", ["is-active", "docker.service"]), "active\n"],
    [commandKey("systemctl", ["is-active", "markiro-runtime-env.service"]), "active\n"],
    [
      commandKey("docker", [
        "network",
        "ls",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--format",
        "{{.Name}}",
      ]),
      `${COMPOSE_NETWORK}\n`,
    ],
    [commandKey("docker", serviceListArguments("api")), "a1b2c3d4e5f6\tapi\n"],
    [commandKey("docker", serviceListArguments("edge")), "b1c2d3e4f5a6\tedge\n"],
    [commandKey("docker", serviceListArguments("vbtech-web")), "c1d2e3f4a5b6\tvbtech-web\n"],
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
      commandKey("docker", ["inspect", "--format", "{{json .State}}", "c1d2e3f4a5b6"]),
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
      commandKey("docker", ["inspect", "--format", "{{.Image}}", "c1d2e3f4a5b6"]),
      `sha256:${"3".repeat(64)}\n`,
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
      commandKey("docker", [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        `sha256:${"3".repeat(64)}`,
      ]),
      `${JSON.stringify([VBTECH_IMAGE_REF])}\n`,
    ],
    [
      commandKey("docker", ["logs", "--tail", "200", "a1b2c3d4e5f6"]),
      {
        stdout: "",
        stderr: `ZodError: required environment value is missing at LANDING_ORIGIN and SMARTCAPTCHA_SERVER_KEY. PostgreSQL database connection refused. ${PRIVATE_FRAGMENTS.join(" ")}\n`,
      },
    ],
    [
      commandKey("docker", ["logs", "--tail", "200", "b1c2d3e4f5a6"]),
      "dial tcp vbtech-web:8080: connect: connection refused (ECONNREFUSED)\n",
    ],
    [commandKey("docker", ["logs", "--tail", "200", "c1d2e3f4a5b6"]), ""],
  ]);

  const currentRecord = JSON.stringify({
    tag: CURRENT,
    state: "healthy",
    apiDigest: API_DIGEST,
    edgeDigest: EDGE_DIGEST,
    createdAt: "2026-08-16T05:49:00.000Z",
  });
  const candidateRecord = JSON.stringify({
    tag: CANDIDATE,
    state: "failed",
    apiDigest: `ghcr.io/thevladbog/markiro-api@sha256:${"c".repeat(64)}`,
    edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`,
    createdAt: "2026-08-20T05:42:00.000Z",
  });
  const pendingFile = vbtechRecordFileName(VBTECH_PENDING);
  const healthyFile = vbtechRecordFileName(VBTECH_HEALTHY);
  const pendingClaim = vbtechClaimFileName("pending", 1);
  const terminalClaim = vbtechClaimFileName("terminal", 1);
  const fileContents = new Map([
    [join(MARKIRO_RELEASE_DIRECTORY, "current.healthy.json"), currentRecord],
    [join(MARKIRO_RELEASE_DIRECTORY, "candidate.failed.json"), candidateRecord],
    [join(VBTECH_RELEASE_DIRECTORY, pendingFile), JSON.stringify(VBTECH_PENDING)],
    [join(VBTECH_RELEASE_DIRECTORY, healthyFile), JSON.stringify(VBTECH_HEALTHY)],
    [
      join(VBTECH_RELEASE_DIRECTORY, pendingClaim),
      JSON.stringify({ kind: "pending", generation: 1, record: VBTECH_PENDING }),
    ],
    [
      join(VBTECH_RELEASE_DIRECTORY, terminalClaim),
      JSON.stringify({ kind: "terminal", generation: 1, record: VBTECH_HEALTHY }),
    ],
  ]);
  const directoryEntries = new Map([
    [MARKIRO_RELEASE_DIRECTORY, ["ignored.tmp", "current.healthy.json", "candidate.failed.json"]],
    [VBTECH_RELEASE_DIRECTORY, [pendingFile, healthyFile, pendingClaim, terminalClaim]],
  ]);
  const fileSizeOverrides = new Map();
  const cpuSamples = [
    { idle: 1_000, total: 4_000 },
    { idle: 1_150, total: 5_000 },
  ];

  function missingPathError() {
    const error = new Error("missing fixture path");
    error.code = "ENOENT";
    return error;
  }

  function metadata(path, linkMetadata = false) {
    if (directoryEntries.has(path))
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
        mode: 0o40700,
        size: 0,
      };
    if (!fileContents.has(path)) throw missingPathError();
    return {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => linkMetadata && false,
      mode: 0o100600,
      size: fileSizeOverrides.get(path) ?? Buffer.byteLength(`${fileContents.get(path)}\n`, "utf8"),
    };
  }

  let cpuSampleIndex = 0;
  return {
    calls,
    resourceCalls,
    outputs,
    fileContents,
    directoryEntries,
    fileSizeOverrides,
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
      if (!directoryEntries.has(path)) throw missingPathError();
      return [...directoryEntries.get(path)];
    },
    readFile: async (path) => {
      if (!fileContents.has(path)) throw missingPathError();
      return fileContents.get(path);
    },
    lstat: async (path) => metadata(path, true),
    stat: async (path) => metadata(path),
    sampleCpu: async () => {
      resourceCalls.push("sampleCpu");
      const value = cpuSamples[cpuSampleIndex];
      cpuSampleIndex += 1;
      if (!value) throw new Error("too many CPU samples");
      return value;
    },
    readMemory: async () => {
      resourceCalls.push("readMemory");
      return { totalBytes: 8_589_934_592, availableBytes: 3_221_225_472 };
    },
    readRootFilesystem: async () => {
      resourceCalls.push("readRootFilesystem");
      return { totalBytes: 53_687_091_200, availableBytes: 21_474_836_480 };
    },
    sleep: async (milliseconds) => {
      resourceCalls.push(`sleep:${milliseconds}`);
    },
    ...overrides,
  };
}

function validSnapshot() {
  return collectRuntimeSnapshot(fixtureDependencies());
}

const HOSTED_ENVIRONMENT = Object.freeze({
  YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
  YC_APP_DEPLOY_LOGIN: "markiro-deploy",
  YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
  APP_SSH_HOST_KEYS_B64: Buffer.from(
    `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
  ).toString("base64"),
});

function hostedDependencies(output, commands = []) {
  return {
    validatePrivateKey: async () => undefined,
    readProbe: async () => "probe-source-with-private-looking-fixture",
    run: async (command, args, options) => {
      commands.push({ command, args, options });
      return output;
    },
    mkdtemp: async () => "/runner/known-hosts-dir",
    writeFile: async () => undefined,
    rm: async () => undefined,
  };
}

test("runtime probe emits only the closed version 3 diagnostic schema and safe categories", async () => {
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
    "upstream_connectivity",
    "resources",
    "healthcheck",
    "process_crash",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(RUNTIME_ERROR_CLASSES), true);

  const dependencies = fixtureDependencies();
  const snapshot = await collectRuntimeSnapshot(dependencies);
  assert.deepEqual(snapshot, {
    version: 3,
    docker: "active",
    runtimeEnv: "active",
    activeRelease: CURRENT,
    candidateRelease: CANDIDATE,
    composeNetwork: COMPOSE_NETWORK,
    resources: {
      cpuBusyBasisPoints: 8_500,
      memoryTotalBytes: 8_589_934_592,
      memoryAvailableBytes: 3_221_225_472,
      rootFilesystemTotalBytes: 53_687_091_200,
      rootFilesystemAvailableBytes: 21_474_836_480,
    },
    activeVbtech: {
      releaseSha: VBTECH_RELEASE,
      imageDigest: VBTECH_IMAGE_DIGEST,
    },
    api: {
      state: "exited",
      health: "unhealthy",
      exitCode: 1,
      oomKilled: false,
      release: CURRENT,
      errorClasses: ["configuration", "database_connection", "healthcheck", "process_crash"],
      configurationIssues: ["LANDING_ORIGIN", "SMARTCAPTCHA_SERVER_KEY"],
    },
    edge: {
      state: "running",
      health: "healthy",
      exitCode: 0,
      oomKilled: false,
      release: CURRENT,
      errorClasses: ["upstream_connectivity"],
      configurationIssues: [],
    },
    vbtechWeb: {
      state: "running",
      health: "healthy",
      exitCode: 0,
      oomKilled: false,
      release: VBTECH_RELEASE,
      errorClasses: [],
      configurationIssues: [],
    },
  });
  assert.ok(Number.isSafeInteger(snapshot.resources.cpuBusyBasisPoints));
  assert.ok(snapshot.resources.cpuBusyBasisPoints >= 0);
  assert.ok(snapshot.resources.cpuBusyBasisPoints <= 10_000);
  for (const [availableKey, totalKey] of [
    ["memoryAvailableBytes", "memoryTotalBytes"],
    ["rootFilesystemAvailableBytes", "rootFilesystemTotalBytes"],
  ]) {
    assert.ok(Number.isSafeInteger(snapshot.resources[totalKey]));
    assert.ok(snapshot.resources[totalKey] > 0);
    assert.ok(Number.isSafeInteger(snapshot.resources[availableKey]));
    assert.ok(snapshot.resources[availableKey] >= 0);
    assert.ok(snapshot.resources[availableKey] <= snapshot.resources[totalKey]);
  }
  assert.equal(dependencies.resourceCalls.filter((value) => value === "sampleCpu").length, 2);
  assert.deepEqual(
    dependencies.resourceCalls.filter((value) => value.startsWith("sleep:")),
    [`sleep:${CPU_SAMPLE_INTERVAL_MS}`],
  );
  const serialized = JSON.stringify(snapshot);
  for (const fragment of PRIVATE_FRAGMENTS) assert.equal(serialized.includes(fragment), false);
});

test("runtime probe executes only the exact read-only and allowlisted Docker inventory", async () => {
  const dependencies = fixtureDependencies();
  await collectRuntimeSnapshot(dependencies);
  assert.equal(dependencies.calls.length, 18);
  const inspectedServices = [];
  for (const [command, args] of dependencies.calls) {
    assert.ok(["systemctl", "docker"].includes(command));
    if (command === "systemctl") assert.deepEqual(args.slice(0, 1), ["is-active"]);
    if (command === "docker")
      assert.ok(["network", "ps", "inspect", "image", "logs"].includes(args[0]), args.join(" "));
    const serviceFilter = args.find((value) =>
      value.startsWith("label=com.docker.compose.service="),
    );
    if (serviceFilter)
      inspectedServices.push(serviceFilter.slice(serviceFilter.lastIndexOf("=") + 1));
    assert.doesNotMatch(
      `${command} ${args.join(" ")}`,
      /\bdocker\s+(?:compose|run|exec|start|stop|restart|rm|kill)\b|\bsystemctl\s+(?:enable|disable|start|stop|restart)\b|NetworkSettings|IPAddress/,
    );
  }
  assert.deepEqual(inspectedServices.toSorted(), ["api", "edge", "vbtech-web"]);
  assert.deepEqual(
    dependencies.calls.filter(([command, args]) => command === "docker" && args[0] === "network"),
    [
      [
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=com.docker.compose.project=markiro-production",
          "--format",
          "{{.Name}}",
        ],
      ],
    ],
  );
  assert.equal(
    dependencies.calls.filter(
      ([command, args]) =>
        command === "docker" && args[0] === "logs" && args[1] === "--tail" && args[2] === "200",
    ).length,
    3,
  );
});

test("version 3 validation rejects stale, widened, and invalid snapshots", async () => {
  const snapshot = await validSnapshot();
  const invalidCases = [
    ["version 2", (value) => (value.version = 2)],
    ["extra top-level key", (value) => (value.processes = [])],
    ["missing top-level key", (value) => delete value.composeNetwork],
    ["unsafe network", (value) => (value.composeNetwork = "../../docker0")],
    ["CPU below range", (value) => (value.resources.cpuBusyBasisPoints = -1)],
    ["CPU above range", (value) => (value.resources.cpuBusyBasisPoints = 10_001)],
    ["fractional CPU", (value) => (value.resources.cpuBusyBasisPoints = 1.5)],
    ["zero memory total", (value) => (value.resources.memoryTotalBytes = 0)],
    [
      "memory available above total",
      (value) => (value.resources.memoryAvailableBytes = value.resources.memoryTotalBytes + 1),
    ],
    [
      "unsafe filesystem total",
      (value) => (value.resources.rootFilesystemTotalBytes = Number.MAX_SAFE_INTEGER + 1),
    ],
    ["extra resource key", (value) => (value.resources.resizeRecommended = true)],
    ["invalid v-b SHA", (value) => (value.activeVbtech.releaseSha = "F".repeat(40))],
    [
      "invalid v-b digest",
      (value) => (value.activeVbtech.imageDigest = `sha256:${"F".repeat(64)}`),
    ],
    ["extra v-b key", (value) => (value.activeVbtech.imageRef = VBTECH_IMAGE_REF)],
    ["extra service key", (value) => (value.vbtechWeb.containerName = "private-name")],
  ];
  for (const [name, mutate] of invalidCases) {
    const value = structuredClone(snapshot);
    mutate(value);
    assert.throws(() => validateRuntimeSnapshot(value), /runtime diagnostics are invalid/, name);
  }
});

test("network and service identity discovery fail closed", async () => {
  const networkKey = commandKey("docker", [
    "network",
    "ls",
    "--filter",
    "label=com.docker.compose.project=markiro-production",
    "--format",
    "{{.Name}}",
  ]);
  for (const [name, output] of [
    ["missing network", ""],
    ["multiple networks", "markiro-production_default\nmarkiro-production_other\n"],
    ["unsafe network", "markiro production default\n"],
  ]) {
    const dependencies = fixtureDependencies();
    dependencies.outputs.set(networkKey, output);
    await assert.rejects(
      () => collectRuntimeSnapshot(dependencies),
      /runtime diagnostics are invalid/,
      name,
    );
  }

  const dependencies = fixtureDependencies();
  dependencies.outputs.set(
    commandKey("docker", serviceListArguments("edge")),
    "b1c2d3e4f5a6\tdatabase\n",
  );
  await assert.rejects(
    () => collectRuntimeSnapshot(dependencies),
    /runtime diagnostics are invalid/,
  );
});

test("private v-b state accepts authoritative terminal claims and rejects malformed state", async () => {
  const unpersisted = fixtureDependencies();
  const healthyFile = vbtechRecordFileName(VBTECH_HEALTHY);
  unpersisted.directoryEntries.set(
    VBTECH_RELEASE_DIRECTORY,
    unpersisted.directoryEntries
      .get(VBTECH_RELEASE_DIRECTORY)
      .filter((value) => value !== healthyFile),
  );
  unpersisted.fileContents.delete(join(VBTECH_RELEASE_DIRECTORY, healthyFile));
  assert.deepEqual((await collectRuntimeSnapshot(unpersisted)).activeVbtech, {
    releaseSha: VBTECH_RELEASE,
    imageDigest: VBTECH_IMAGE_DIGEST,
  });

  const malformed = fixtureDependencies();
  const terminalOne = vbtechClaimFileName("terminal", 1);
  const terminalTwo = vbtechClaimFileName("terminal", 2);
  malformed.directoryEntries.set(
    VBTECH_RELEASE_DIRECTORY,
    malformed.directoryEntries
      .get(VBTECH_RELEASE_DIRECTORY)
      .map((value) => (value === terminalOne ? terminalTwo : value)),
  );
  malformed.fileContents.delete(join(VBTECH_RELEASE_DIRECTORY, terminalOne));
  malformed.fileContents.set(
    join(VBTECH_RELEASE_DIRECTORY, terminalTwo),
    JSON.stringify({ kind: "terminal", generation: 2, record: VBTECH_HEALTHY }),
  );
  await assert.rejects(() => collectRuntimeSnapshot(malformed), /runtime diagnostics are invalid/);

  const oversized = fixtureDependencies();
  const pendingPath = join(VBTECH_RELEASE_DIRECTORY, vbtechRecordFileName(VBTECH_PENDING));
  oversized.fileSizeOverrides.set(pendingPath, 16 * 1024 + 1);
  await assert.rejects(() => collectRuntimeSnapshot(oversized), /runtime diagnostics are invalid/);
});

test("private v-b state accepts failed enabled history while keeping the disabled release active", async () => {
  const dependencies = fixtureDependencies();
  const pendingFile = vbtechRecordFileName(FAILED_ENABLED_VBTECH_PENDING);
  const failedFile = vbtechRecordFileName(FAILED_ENABLED_VBTECH_TERMINAL);
  const pendingClaim = vbtechClaimFileName("pending", 1, FAILED_ENABLED_VBTECH_PENDING);
  const terminalClaim = vbtechClaimFileName("terminal", 1, FAILED_ENABLED_VBTECH_PENDING);
  dependencies.directoryEntries
    .get(VBTECH_RELEASE_DIRECTORY)
    .push(pendingFile, failedFile, pendingClaim, terminalClaim);
  dependencies.fileContents.set(
    join(VBTECH_RELEASE_DIRECTORY, pendingFile),
    JSON.stringify(FAILED_ENABLED_VBTECH_PENDING),
  );
  dependencies.fileContents.set(
    join(VBTECH_RELEASE_DIRECTORY, failedFile),
    JSON.stringify(FAILED_ENABLED_VBTECH_TERMINAL),
  );
  dependencies.fileContents.set(
    join(VBTECH_RELEASE_DIRECTORY, pendingClaim),
    JSON.stringify({ kind: "pending", generation: 1, record: FAILED_ENABLED_VBTECH_PENDING }),
  );
  dependencies.fileContents.set(
    join(VBTECH_RELEASE_DIRECTORY, terminalClaim),
    JSON.stringify({ kind: "terminal", generation: 1, record: FAILED_ENABLED_VBTECH_TERMINAL }),
  );

  assert.deepEqual((await collectRuntimeSnapshot(dependencies)).activeVbtech, {
    releaseSha: VBTECH_RELEASE,
    imageDigest: VBTECH_IMAGE_DIGEST,
  });
});

test("an absent private v-b state and service are explicit", async () => {
  const dependencies = fixtureDependencies();
  dependencies.directoryEntries.delete(VBTECH_RELEASE_DIRECTORY);
  dependencies.outputs.set(commandKey("docker", serviceListArguments("vbtech-web")), "");
  const snapshot = await collectRuntimeSnapshot(dependencies);
  assert.equal(snapshot.activeVbtech, null);
  assert.deepEqual(snapshot.vbtechWeb, {
    state: "missing",
    health: "none",
    exitCode: null,
    oomKilled: false,
    release: "unknown",
    errorClasses: ["unknown"],
    configurationIssues: [],
  });
});

test("a disappearing private v-b directory fails closed instead of becoming absent", async () => {
  const dependencies = fixtureDependencies();
  const originalStat = dependencies.stat;
  dependencies.stat = async (path) => {
    if (path === VBTECH_RELEASE_DIRECTORY) {
      const error = new Error("fixture state race");
      error.code = "ENOENT";
      throw error;
    }
    return originalStat(path);
  };
  await assert.rejects(
    () => collectRuntimeSnapshot(dependencies),
    /runtime diagnostics are invalid/,
  );
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
  const snapshot = await validSnapshot();
  const commands = [];
  const result = await runHostedRuntimeDiagnostics(
    HOSTED_ENVIRONMENT,
    hostedDependencies(`MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`, commands),
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

test("hosted diagnostic makes configured host keys the exclusive SSH trust source", async () => {
  const snapshot = await validSnapshot();
  const commands = [];
  await runHostedRuntimeDiagnostics(
    HOSTED_ENVIRONMENT,
    hostedDependencies(`MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`, commands),
  );

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "ssh");
  const remoteTarget = "markiro-deploy@203.0.113.42";
  const remoteTargetIndex = commands[0].args.indexOf(remoteTarget);
  assert.deepEqual(commands[0].args.slice(0, remoteTargetIndex + 1), [
    "-F",
    "/dev/null",
    "-i",
    "/runner/private-key",
    "-o",
    "UserKnownHostsFile=/runner/known-hosts-dir/known_hosts",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    remoteTarget,
  ]);
  assert.equal(commands[0].args.filter((value) => value === "-F").length, 1);
  assert.equal(commands[0].args.filter((value) => value === "/dev/null").length, 1);
  assert.equal(
    commands[0].args.filter((value) => value.startsWith("UserKnownHostsFile=")).length,
    1,
  );
  assert.equal(
    commands[0].args.filter((value) => value.startsWith("GlobalKnownHostsFile=")).length,
    1,
  );
});

test("hosted parser rejects stale, widened, and non-canonical remote responses", async () => {
  const snapshot = await validSnapshot();
  const stale = structuredClone(snapshot);
  stale.version = 2;
  const widened = structuredClone(snapshot);
  widened.environment = { leaked: true };
  const oversized = `${JSON.stringify(snapshot)}${" ".repeat(17 * 1024)}`;
  for (const output of [
    `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(stale)}\n`,
    `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(widened)}\n`,
    `MARKIRO_RUNTIME_DIAGNOSTICS ${oversized}\n`,
    `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\ntrailing\n`,
    `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}`,
  ]) {
    await assert.rejects(
      () => runHostedRuntimeDiagnostics(HOSTED_ENVIRONMENT, hostedDependencies(output)),
      /runtime diagnostic response is invalid/,
    );
  }
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
