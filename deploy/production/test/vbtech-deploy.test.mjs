import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  VBTECH_EXECUTOR_CONTRACT_VERSION,
  deployVbtechRelease,
  runVbtechDeployCli,
} from "../vbtech-deploy.mjs";
import { latestHealthyVbtechRelease as readHealthyVbtechRelease } from "../vbtech-release-state.mjs";

const markiroSha = "0123456789abcdef0123456789abcdef01234567";
const apiImageDigest = `sha256:${"a".repeat(64)}`;
const edgeImageDigest = `sha256:${"b".repeat(64)}`;
const apiImageRef = `ghcr.io/thevladbog/markiro-api@${apiImageDigest}`;
const edgeImageRef = `ghcr.io/thevladbog/markiro-edge@${edgeImageDigest}`;
const candidateSha = "c".repeat(40);
const candidateImageDigest = `sha256:${"d".repeat(64)}`;
const candidateImageRef = `ghcr.io/thevladbog/vbtech-web@${candidateImageDigest}`;
const previousSha = "e".repeat(40);
const previousImageDigest = `sha256:${"f".repeat(64)}`;
const previousImageRef = `ghcr.io/thevladbog/vbtech-web@${previousImageDigest}`;
const createdAt = "2026-08-21T10:20:30.000Z";
const activeContainerIds = {
  api: "1".repeat(64),
  edge: "2".repeat(64),
  "vbtech-web": "3".repeat(64),
};
const activeImageIds = {
  [activeContainerIds.api]: `sha256:${"4".repeat(64)}`,
  [activeContainerIds.edge]: `sha256:${"5".repeat(64)}`,
  [activeContainerIds["vbtech-web"]]: `sha256:${"6".repeat(64)}`,
};

function environment(overrides = {}) {
  return {
    MARKIRO_COMPOSE_PROJECT: "markiro-production",
    MARKIRO_ENV_FILE: "/etc/markiro/production.env",
    MARKIRO_DOMAIN: "app.markiro.example",
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
    MARKIRO_LANDING_DOMAIN: "markiro.example",
    ACME_EMAIL: "ops@markiro.example",
    VBTECH_RELEASE_SHA: candidateSha,
    VBTECH_IMAGE_DIGEST: candidateImageDigest,
    VBTECH_IMAGE_REF: candidateImageRef,
    VBTECH_DOMAIN: "v-b.tech",
    VBTECH_WWW_DOMAIN: "www.v-b.tech",
    VBTECH_SUBMISSION_STATE: "disabled",
    DOCKER_CONFIG: "/run/markiro-registry-auth/session-test",
    DATABASE_URL: "postgres://private:password@database/markiro",
    SECRET_VALUE: "must-never-reach-a-command",
    ...overrides,
  };
}

function markiroRecord(overrides = {}) {
  return {
    tag: markiroSha,
    previousTag: null,
    apiDigest: apiImageRef,
    edgeDigest: edgeImageRef,
    state: "healthy",
    createdAt,
    ...overrides,
  };
}

function lifecycleRecord({
  releaseSha = previousSha,
  imageDigest = previousImageDigest,
  state = "healthy",
  timestamp = "2026-08-21T10:20:29.000Z",
} = {}) {
  return {
    releaseSha,
    imageRef: `ghcr.io/thevladbog/vbtech-web@${imageDigest}`,
    imageDigest,
    submissionState: "disabled",
    createdAt: timestamp,
    state,
  };
}

function markiroRecordFileName(record) {
  return `${record.createdAt.replace(/[:.]/g, "-")}-${record.tag}.${record.state}.json`;
}

function compose(environmentValue, withVbtech = true) {
  return [
    "compose",
    "--project-name",
    "markiro-production",
    "--env-file",
    "/etc/markiro/production.env",
    "-f",
    "compose.production.yml",
    ...(withVbtech ? ["-f", "deploy/production/compose.vbtech.yml"] : []),
  ];
}

function isComposeMutation(call) {
  if (call.command !== "docker" || call.args[0] !== "compose") return false;
  return call.args.includes("pull") || call.args.includes("up") || call.args.includes("rm");
}

function stageError(error, stage, rollbackStage) {
  assert.equal(error.name, "VbtechDeployStageError");
  assert.equal(error.stage, stage);
  assert.equal(error.rollbackStage, rollbackStage);
  assert.doesNotMatch(
    error.message,
    /password|postgres|private stderr|must-never|sha256|ghcr|markiro\.example/i,
  );
  return true;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "vbtech-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "releases");
  const activeRelease = join(releaseRoot, markiroSha);
  const activeReleaseLink = join(root, "active-release");
  const markiroReleaseDirectory = join(root, "markiro-state");
  const vbtechReleaseDirectory = join(root, "vbtech-state");
  await mkdir(activeRelease, { recursive: true, mode: 0o700 });
  await mkdir(markiroReleaseDirectory, { recursive: true, mode: 0o700 });
  await symlink(activeRelease, activeReleaseLink);
  const activeRecord = markiroRecord(options.markiroRecord);
  await writeFile(
    join(markiroReleaseDirectory, markiroRecordFileName(activeRecord)),
    `${JSON.stringify(activeRecord)}\n`,
    { mode: 0o600 },
  );

  const events = [];
  const calls = [];
  const stateAttempts = [];
  const stateWrites = [];
  const smokeCalls = [];
  const readinessCalls = [];
  const previous = Object.hasOwn(options, "previous") ? options.previous : lifecycleRecord();
  const healthStatuses = [...(options.healthStatuses ?? ["healthy"])];
  const rollbackHealthStatuses = [...(options.rollbackHealthStatuses ?? ["healthy"])];
  const networkNames = options.networkNames ?? ["markiro-production_default"];
  const containerIds = {
    api: [activeContainerIds.api],
    edge: [activeContainerIds.edge],
    "vbtech-web": [activeContainerIds["vbtech-web"]],
    ...options.containerIds,
  };
  let currentStage = "configuration";
  let monotonic = 0;

  function resultFor(command, args) {
    if (options.oversizedOutputAt === currentStage)
      return { code: 0, stdout: "x".repeat(70 * 1024), stderr: "" };
    if (options.failAt === currentStage || options.rollbackFailAt === currentStage)
      return { code: 23, stdout: "private stdout", stderr: "private stderr password" };
    if (command !== "docker") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "network" && args[1] === "ls")
      return {
        code: 0,
        stdout: `${networkNames.map((name) => JSON.stringify(name)).join("\n")}\n`,
        stderr: "",
      };
    if (args[0] === "network" && args[1] === "inspect")
      return {
        code: 0,
        stdout: JSON.stringify({
          "com.docker.compose.project": options.networkProject ?? "markiro-production",
        }),
        stderr: "",
      };
    if (args[0] === "ps") {
      const serviceFilter = args.find((arg) => arg.startsWith("label=com.docker.compose.service="));
      const service = serviceFilter?.split("=").at(-1);
      return { code: 0, stdout: `${(containerIds[service] ?? []).join("\n")}\n`, stderr: "" };
    }
    if (args[0] === "inspect" && args[2] === "{{json .Image}}")
      return { code: 0, stdout: JSON.stringify(activeImageIds[args.at(-1)]), stderr: "" };
    if (args[0] === "inspect" && args[2] === "{{json .State.Health}}") {
      const statuses =
        currentStage === "rollback-health-vbtech-web" ? rollbackHealthStatuses : healthStatuses;
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (status === "malformed") return { code: 0, stdout: "not-json", stderr: "" };
      if (status === "missing") return { code: 0, stdout: "null", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ Status: status, FailingStreak: 0, Log: [] }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const target = args.at(-1);
      const expected =
        target === activeImageIds[activeContainerIds.api]
          ? apiImageRef
          : target === activeImageIds[activeContainerIds.edge]
            ? edgeImageRef
            : target === candidateImageRef
              ? candidateImageRef
              : target === previousImageRef
                ? previousImageRef
                : undefined;
      const repoDigests = options.repoDigestOverrides?.[target] ?? (expected ? [expected] : []);
      return { code: 0, stdout: JSON.stringify(repoDigests), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  const runner = {
    async run(command, args, childEnvironment, timeoutMs, commandOptions) {
      const call = {
        command,
        args: [...args],
        environment: { ...childEnvironment },
        timeoutMs,
        commandOptions: { ...commandOptions },
        stage: currentStage,
      };
      calls.push(call);
      return resultFor(command, args);
    },
  };

  const dependencies = {
    paths: {
      activeReleaseLink,
      markiroReleaseDirectory,
      vbtechReleaseDirectory,
      environmentFile: "/etc/markiro/production.env",
    },
    runner,
    event(stage) {
      currentStage = stage;
      events.push(stage);
    },
    async latestHealthyVbtechRelease(directory) {
      assert.equal(directory, vbtechReleaseDirectory);
      if (options.stateReadError) throw new Error("state contains private data");
      return previous;
    },
    async writePendingVbtechRelease(directory, selector) {
      assert.equal(directory, vbtechReleaseDirectory);
      stateAttempts.push({ kind: "pending" });
      if (options.failAt === currentStage) throw new Error("pending private error");
      await options.pendingDeferred?.promise;
      const pending = lifecycleRecord({
        releaseSha: selector.releaseSha,
        imageDigest: selector.imageDigest,
        state: "pending",
        timestamp: createdAt,
      });
      stateWrites.push({ kind: "pending", value: pending });
      return options.pendingRecord ?? pending;
    },
    async markVbtechReleaseHealthy(directory, pending) {
      assert.equal(directory, vbtechReleaseDirectory);
      stateAttempts.push({ kind: "healthy" });
      if (options.failAt === currentStage) throw new Error("healthy private error");
      assert.equal(
        smokeCalls.some((call) => call.expectedVbtechReleaseSha === candidateSha),
        true,
      );
      await options.healthyDeferred?.promise;
      const healthy = { ...pending, state: "healthy" };
      stateWrites.push({ kind: "healthy", value: healthy });
      return healthy;
    },
    async markVbtechReleaseFailed(directory, pending) {
      assert.equal(directory, vbtechReleaseDirectory);
      stateAttempts.push({ kind: "failed" });
      if (options.failedRecordError) throw new Error("failed record private error");
      stateWrites.push({ kind: "failed", value: { ...pending, state: "failed" } });
      return { ...pending, state: "failed" };
    },
    async vbtechReleaseStatus(directory, selector) {
      assert.equal(directory, vbtechReleaseDirectory);
      const record = stateWrites
        .map(({ value }) => value)
        .filter(
          (value) =>
            value.releaseSha === selector.releaseSha &&
            value.imageRef === selector.imageRef &&
            value.imageDigest === selector.imageDigest,
        )
        .at(-1);
      return record === undefined
        ? { state: "absent", record: null, persisted: false }
        : { state: record.state, record, persisted: true };
    },
    async runPrivateVbtechSmoke(smokeOptions) {
      smokeCalls.push({ ...smokeOptions });
      if (options.failAt === currentStage || options.rollbackFailAt === currentStage)
        throw new Error("private smoke body");
      return {
        scope: "private-routing-content-only",
        publicDns: "not-verified",
        vbtechTls: "not-verified",
      };
    },
    async probeEdge(probeOptions) {
      readinessCalls.push({ ...probeOptions });
      if (options.failAt === currentStage || options.rollbackFailAt === currentStage)
        throw new Error("private readiness error");
      return { status: options.readinessStatus ?? 200 };
    },
    async sleep(delay) {
      monotonic += delay;
    },
    monotonicNow: () => monotonic,
  };

  return {
    activeRecord,
    activeRelease,
    activeReleaseLink,
    calls,
    dependencies,
    events,
    markiroReleaseDirectory,
    root,
    readinessCalls,
    smokeCalls,
    stateAttempts,
    stateWrites,
  };
}

test("deploys the disabled digest candidate in the exact lifecycle order", async (t) => {
  const context = await fixture(t, { healthStatuses: ["starting", "healthy"] });

  const healthy = await deployVbtechRelease({ environment: environment() }, context.dependencies);

  assert.equal(VBTECH_EXECUTOR_CONTRACT_VERSION, 1);
  assert.deepEqual(context.events, [
    "validate",
    "read-active-markiro",
    "read-vbtech-state",
    "pending",
    "pull",
    "inspect-digest",
    "up-vbtech-web",
    "health-vbtech-web",
    "recreate-edge",
    "edge-readiness",
    "private-smoke",
    "healthy",
  ]);
  assert.equal(context.readinessCalls.length, 1);
  assert.equal(healthy.state, "healthy");
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "healthy"],
  );
  assert.deepEqual(context.smokeCalls, [
    {
      transportOrigin: "https://app.markiro.example",
      expectedVbtechReleaseSha: candidateSha,
    },
  ]);

  const mutations = context.calls.filter(isComposeMutation);
  assert.deepEqual(
    mutations.map(({ command, args }) => [command, args]),
    [
      ["docker", [...compose(environment()), "pull", "vbtech-web"]],
      ["docker", [...compose(environment()), "up", "-d", "--no-deps", "vbtech-web"]],
      ["docker", [...compose(environment()), "up", "-d", "--no-deps", "--force-recreate", "edge"]],
    ],
  );
  for (const call of context.calls) {
    assert.equal(Number.isSafeInteger(call.timeoutMs) && call.timeoutMs > 0, true);
    assert.equal(call.commandOptions.maxOutputBytes, 64 * 1024);
    assert.equal(call.commandOptions.cwd, context.activeRelease);
    assert.equal(call.environment.DATABASE_URL, undefined);
    assert.equal(call.environment.SECRET_VALUE, undefined);
    assert.equal(call.environment.MARKIRO_SAAS_ADMIN_DOMAIN, "saas-admin.markiro.example");
    assert.equal(call.environment.ACME_EMAIL, "ops@markiro.example");
  }
  assert.equal(
    context.calls.some(
      ({ command, args }) =>
        command !== "docker" ||
        args.some((arg) =>
          /(?:^|[-_/])(migrate|terraform|yandex|yc|function|database)(?:$|[-_/])/i.test(arg),
        ),
    ),
    false,
  );
});

test("accepts a finite state-transition deadline without changing normal state order", async (t) => {
  const context = await fixture(t);

  await deployVbtechRelease(
    { environment: environment(), stateTransitionTimeoutMs: 100 },
    context.dependencies,
  );

  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "healthy"],
  );
});

test("runs default lifecycle writes inside the bounded state child process", async (t) => {
  const context = await fixture(t);
  for (const key of [
    "markVbtechReleaseFailed",
    "markVbtechReleaseHealthy",
    "vbtechReleaseStatus",
    "writePendingVbtechRelease",
  ])
    delete context.dependencies[key];

  const healthy = await deployVbtechRelease(
    { environment: environment(), stateTransitionTimeoutMs: 2_000 },
    context.dependencies,
  );

  assert.equal(healthy.state, "healthy");
  assert.deepEqual(
    await readHealthyVbtechRelease(context.dependencies.paths.vbtechReleaseDirectory),
    healthy,
  );
  assert.deepEqual(context.stateAttempts, []);
  assert.deepEqual(context.stateWrites, []);
});

test("a delayed pending transition is reconciled to failed before the deployment returns", async (t) => {
  const pendingDeferred = deferred();
  const context = await fixture(t, { pendingDeferred });
  let settled = false;
  const observed = deployVbtechRelease(
    { environment: environment(), stateTransitionTimeoutMs: 10 },
    context.dependencies,
  ).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  observed.then(() => {
    settled = true;
  });

  await delay(30);
  const settledBeforePendingCompleted = settled;
  pendingDeferred.resolve();
  const outcome = await observed;

  assert.equal(settledBeforePendingCompleted, false);
  assert.equal(outcome.status, "rejected");
  assert.equal(stageError(outcome.error, "pending", undefined), true);
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "failed"],
  );
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("a delayed healthy transition settles authoritatively before any rollback or failed write", async (t) => {
  const healthyDeferred = deferred();
  const context = await fixture(t, { healthyDeferred });
  let settled = false;
  const observed = deployVbtechRelease(
    { environment: environment(), stateTransitionTimeoutMs: 10 },
    context.dependencies,
  ).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  observed.then(() => {
    settled = true;
  });

  for (let attempt = 0; attempt < 200 && !context.events.includes("healthy"); attempt += 1)
    await delay(1);
  assert.equal(context.events.includes("healthy"), true);
  await delay(30);
  const settledBeforeHealthyCompleted = settled;
  const rollbackBeforeHealthyCompleted = context.events.some((event) =>
    event.startsWith("rollback-"),
  );
  healthyDeferred.resolve();
  const outcome = await observed;

  assert.equal(settledBeforeHealthyCompleted, false);
  assert.equal(rollbackBeforeHealthyCompleted, false);
  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value.state, "healthy");
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "healthy"],
  );
  assert.equal(
    context.events.some((event) => event.startsWith("rollback-")),
    false,
  );
});

test("fails closed without rollback or a competing terminal when cancellation is unproven", async (t) => {
  const context = await fixture(t);
  const writePending = context.dependencies.writePendingVbtechRelease;
  context.dependencies.startStateTransition = (kind, directory, value) => {
    if (kind === "healthy")
      return {
        promise: new Promise(() => undefined),
        async terminate() {
          throw new Error("password must-never-reach-output");
        },
      };
    const promise = Promise.resolve().then(() => writePending(directory, value));
    return {
      promise,
      async terminate() {
        await promise.catch(() => undefined);
        return true;
      },
    };
  };

  await assert.rejects(
    deployVbtechRelease(
      { environment: environment(), stateTransitionTimeoutMs: 10 },
      context.dependencies,
    ),
    (error) => stageError(error, "healthy", undefined),
  );

  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending"],
  );
  assert.equal(context.events.includes("failed"), false);
  assert.equal(
    context.events.some((event) => event.startsWith("rollback-")),
    false,
  );
});

for (const [name, overrides] of [
  ["source SHA", { VBTECH_RELEASE_SHA: "C".repeat(40) }],
  ["digest", { VBTECH_IMAGE_DIGEST: `sha256:${"D".repeat(64)}` }],
  ["image reference", { VBTECH_IMAGE_REF: `${candidateImageRef}:latest` }],
  ["submission state", { VBTECH_SUBMISSION_STATE: "enabled" }],
  ["v-b apex domain", { VBTECH_DOMAIN: "preview.v-b.tech" }],
  ["v-b www domain", { VBTECH_WWW_DOMAIN: "v-b.tech" }],
  ["Compose project", { MARKIRO_COMPOSE_PROJECT: "foreign-project" }],
  ["environment file", { MARKIRO_ENV_FILE: "/tmp/production.env" }],
  ["Markiro transport domain", { MARKIRO_DOMAIN: "https://app.markiro.example" }],
  [
    "Markiro SaaS admin domain",
    { MARKIRO_SAAS_ADMIN_DOMAIN: "https://saas-admin.markiro.example" },
  ],
  ["Docker credential directory", { DOCKER_CONFIG: "/tmp/foreign-docker-config" }],
  ["retired image tag", { VBTECH_IMAGE_TAG: candidateSha }],
  ["function origin", { VBTECH_FUNCTION_ORIGIN: "https://functions.example" }],
  ["missing ACME email", { ACME_EMAIL: undefined }],
  ["ACME email", { ACME_EMAIL: "invalid email" }],
]) {
  test(`rejects an invalid ${name} before state or Compose mutation`, async (t) => {
    const context = await fixture(t);
    await assert.rejects(
      deployVbtechRelease({ environment: environment(overrides) }, context.dependencies),
      (error) => stageError(error, "validation", undefined),
    );
    assert.equal(context.stateWrites.length, 0);
    assert.equal(context.calls.length, 0);
  });
}

test("rejects a relative active-release symlink before mutation", async (t) => {
  const context = await fixture(t);
  await unlink(context.activeReleaseLink);
  await symlink(markiroSha, context.activeReleaseLink);
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("rejects an uppercase active-release basename before mutation", async (t) => {
  const context = await fixture(t);
  const uppercaseTarget = join(context.root, "releases", "A".repeat(40));
  await mkdir(uppercaseTarget, { recursive: true });
  await unlink(context.activeReleaseLink);
  await symlink(uppercaseTarget, context.activeReleaseLink);
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("rejects a regular active-release path before mutation", async (t) => {
  const context = await fixture(t);
  await unlink(context.activeReleaseLink);
  await writeFile(context.activeReleaseLink, markiroSha);
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("requires exactly one matching healthy active Markiro record", async (t) => {
  const context = await fixture(t);
  const duplicate = markiroRecord({ createdAt: "2026-08-21T10:20:31.000Z" });
  await writeFile(
    join(context.markiroReleaseDirectory, markiroRecordFileName(duplicate)),
    `${JSON.stringify(duplicate)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("excludes an active Markiro healthy record invalidated by its matching failed terminal", async (t) => {
  const context = await fixture(t);
  const failed = markiroRecord({ state: "failed" });
  await writeFile(
    join(context.markiroReleaseDirectory, markiroRecordFileName(failed)),
    `${JSON.stringify(failed)}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.equal(context.calls.length, 0);
});

test("does not invalidate active Markiro healthy evidence with an unrelated failed record", async (t) => {
  const context = await fixture(t);
  const unrelated = markiroRecord({
    apiDigest: `ghcr.io/thevladbog/markiro-api@sha256:${"7".repeat(64)}`,
    state: "failed",
  });
  await writeFile(
    join(context.markiroReleaseDirectory, markiroRecordFileName(unrelated)),
    `${JSON.stringify(unrelated)}\n`,
    { mode: 0o600 },
  );

  const result = await deployVbtechRelease({ environment: environment() }, context.dependencies);

  assert.equal(result.state, "healthy");
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "healthy"],
  );
});

test("rejects ambiguous effective active Markiro records before pending or Docker mutation", async (t) => {
  const context = await fixture(t);
  const second = markiroRecord({ createdAt: "2026-08-21T10:20:31.000Z" });
  const unrelatedFailed = markiroRecord({
    createdAt: "2026-08-21T10:20:32.000Z",
    edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"8".repeat(64)}`,
    state: "failed",
  });
  for (const value of [second, unrelatedFailed])
    await writeFile(
      join(context.markiroReleaseDirectory, markiroRecordFileName(value)),
      `${JSON.stringify(value)}\n`,
      { mode: 0o600 },
    );

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.equal(context.calls.length, 0);
});

test("rejects an unsafe Markiro release-state directory before mutation", async (t) => {
  const context = await fixture(t);
  await chmod(context.markiroReleaseDirectory, 0o755);
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

for (const [name, fixtureOptions] of [
  ["record image digest", { markiroRecord: { apiDigest: `sha256:${"7".repeat(64)}` } }],
  ["network name", { networkNames: ["unsafe network"] }],
  [
    "multiple labeled networks",
    { networkNames: ["markiro-production_default", "markiro-production_other"] },
  ],
  ["network project label", { networkProject: "foreign-project" }],
  [
    "active API RepoDigest",
    {
      repoDigestOverrides: {
        [activeImageIds[activeContainerIds.api]]: [
          `ghcr.io/thevladbog/markiro-api@sha256:${"8".repeat(64)}`,
        ],
      },
    },
  ],
  ["active API container count", { containerIds: { api: [] } }],
]) {
  test(`rejects an invalid ${name} before pending or Compose mutation`, async (t) => {
    const context = await fixture(t, fixtureOptions);
    await assert.rejects(
      deployVbtechRelease({ environment: environment() }, context.dependencies),
      (error) => stageError(error, "active-markiro", undefined),
    );
    assert.equal(context.stateWrites.length, 0);
    assert.deepEqual(context.calls.filter(isComposeMutation), []);
  });
}

test("rejects malformed v-b lifecycle state before pending or Compose mutation", async (t) => {
  const context = await fixture(t, { stateReadError: true });
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "vbtech-state", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("rejects a malformed previous healthy record before pending", async (t) => {
  const context = await fixture(t, {
    previous: lifecycleRecord({ state: "failed" }),
  });
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "vbtech-state", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

for (const [event, failureStage, expectsRollback] of [
  ["pending", "pending", false],
  ["pull", "pull", false],
  ["inspect-digest", "candidate-digest", false],
  ["up-vbtech-web", "candidate-service", true],
  ["recreate-edge", "edge-activation", true],
  ["edge-readiness", "edge-activation", true],
]) {
  test(`classifies a bounded ${event} failure and compensates only after service activation`, async (t) => {
    const context = await fixture(t, { failAt: event });
    await assert.rejects(
      deployVbtechRelease({ environment: environment() }, context.dependencies),
      (error) => stageError(error, failureStage, undefined),
    );
    assert.equal(context.events.includes("rollback-restore-vbtech-web"), expectsRollback);
    assert.equal(context.stateWrites.at(-1)?.kind, event === "pending" ? undefined : "failed");
  });
}

test("bounds command output before pending state mutation", async (t) => {
  const context = await fixture(t, { oversizedOutputAt: "read-active-markiro" });
  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "active-markiro", undefined),
  );
  assert.equal(context.stateWrites.length, 0);
  assert.deepEqual(context.calls.filter(isComposeMutation), []);
});

test("first-install failure removes only the candidate service and restores Markiro-only edge", async (t) => {
  const context = await fixture(t, { previous: undefined, failAt: "private-smoke" });

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "private-smoke", undefined),
  );

  assert.deepEqual(
    context.calls.filter(isComposeMutation).map(({ args }) => args),
    [
      [...compose(environment()), "pull", "vbtech-web"],
      [...compose(environment()), "up", "-d", "--no-deps", "vbtech-web"],
      [...compose(environment()), "up", "-d", "--no-deps", "--force-recreate", "edge"],
      [...compose(environment()), "rm", "--stop", "--force", "vbtech-web"],
      [...compose(environment(), false), "up", "-d", "--no-deps", "--force-recreate", "edge"],
    ],
  );
  for (const call of context.calls.filter(isComposeMutation))
    assert.equal(call.environment.ACME_EMAIL, "ops@markiro.example");
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "failed"],
  );
  assert.equal(context.readinessCalls.length, 2);
});

test("replacement failure restores the exact prior selector, health, edge, readiness, and smoke", async (t) => {
  const context = await fixture(t, { failAt: "private-smoke" });

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "private-smoke", undefined),
  );

  const rollbackUp = context.calls.find(
    ({ stage, args }) => stage === "rollback-restore-vbtech-web" && args.includes("up"),
  );
  assert.ok(rollbackUp);
  assert.equal(rollbackUp.environment.VBTECH_IMAGE_REF, previousImageRef);
  assert.equal(rollbackUp.environment.VBTECH_RELEASE_SHA, previousSha);
  assert.equal(rollbackUp.environment.VBTECH_IMAGE_DIGEST, undefined);
  assert.equal(
    context.calls.some(
      ({ stage, args }) =>
        stage === "rollback-restore-vbtech-web" &&
        args[0] === "image" &&
        args.at(-1) === previousImageRef,
    ),
    true,
  );
  assert.deepEqual(context.smokeCalls.at(-1), {
    transportOrigin: "https://app.markiro.example",
    expectedVbtechReleaseSha: previousSha,
  });
  assert.equal(context.readinessCalls.length, 2);
  assert.deepEqual(
    context.stateWrites.map(({ kind }) => kind),
    ["pending", "failed"],
  );
});

test("a healthy-record failure after edge activation still rolls back", async (t) => {
  const context = await fixture(t, { failAt: "healthy" });

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "healthy", undefined),
  );

  assert.deepEqual(
    context.smokeCalls.map(({ expectedVbtechReleaseSha }) => expectedVbtechReleaseSha),
    [candidateSha, previousSha],
  );
  assert.equal(context.events.includes("rollback-restore-vbtech-web"), true);
  assert.equal(context.events.includes("rollback-recreate-edge"), true);
  assert.equal(context.events.at(-1), "failed");
});

test("rollback failure retains both secret-free stage labels and still records failed", async (t) => {
  const context = await fixture(t, {
    failAt: "private-smoke",
    rollbackFailAt: "rollback-recreate-edge",
  });

  await assert.rejects(
    deployVbtechRelease({ environment: environment() }, context.dependencies),
    (error) => stageError(error, "private-smoke", "rollback-edge"),
  );
  assert.equal(context.stateWrites.at(-1).kind, "failed");
});

for (const [name, fixtureOptions, rollbackStage, deployOverrides] of [
  [
    "service restoration",
    { failAt: "private-smoke", rollbackFailAt: "rollback-restore-vbtech-web" },
    "rollback-service",
  ],
  [
    "restored service health",
    { failAt: "private-smoke", rollbackHealthStatuses: ["unhealthy"] },
    "rollback-health",
  ],
  [
    "edge readiness",
    { failAt: "private-smoke", rollbackFailAt: "rollback-edge-readiness" },
    "rollback-readiness",
    { edgeReadinessAttempts: 1 },
  ],
  [
    "restored private smoke",
    { failAt: "private-smoke", rollbackFailAt: "rollback-private-smoke" },
    "rollback-smoke",
  ],
  ["failed-record publication", { failAt: "pull", failedRecordError: true }, "failed-record"],
]) {
  test(`reports a stable ${name} rollback stage and still attempts failed state`, async (t) => {
    const context = await fixture(t, fixtureOptions);
    await assert.rejects(
      deployVbtechRelease({ environment: environment(), ...deployOverrides }, context.dependencies),
      (error) =>
        stageError(
          error,
          fixtureOptions.failAt === "pull" ? "pull" : "private-smoke",
          rollbackStage,
        ),
    );
    assert.equal(context.stateAttempts.at(-1).kind, "failed");
    assert.equal(
      context.stateWrites.at(-1).kind,
      fixtureOptions.failedRecordError ? "pending" : "failed",
    );
  });
}

for (const healthStatus of ["missing", "malformed", "unhealthy"]) {
  test(`rejects ${healthStatus} image-provided health state and rolls back`, async (t) => {
    const context = await fixture(t, { healthStatuses: [healthStatus] });
    await assert.rejects(
      deployVbtechRelease({ environment: environment() }, context.dependencies),
      (error) => stageError(error, "candidate-health", undefined),
    );
    assert.equal(context.stateWrites.at(-1).kind, "failed");
    assert.equal(context.events.includes("rollback-restore-vbtech-web"), true);
  });
}

test("contract-version prints the exact version and performs no deployment mutation", async () => {
  const stdout = [];
  const stderr = [];
  let deployments = 0;
  const exitCode = await runVbtechDeployCli({
    argv: ["contract-version"],
    environment: environment({ VBTECH_RELEASE_SHA: "invalid" }),
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
    deploy: async () => {
      deployments += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, ["MARKIRO_VBTECH_EXECUTOR 1\n"]);
  assert.deepEqual(stderr, []);
  assert.equal(deployments, 0);
});

test("run CLI emits only bounded stable success and failure lines", async () => {
  const success = [];
  const successExit = await runVbtechDeployCli({
    argv: ["run"],
    stdout: { write: (value) => success.push(value) },
    stderr: { write: () => assert.fail("success must not write stderr") },
    deploy: async () =>
      lifecycleRecord({ releaseSha: candidateSha, imageDigest: candidateImageDigest }),
  });
  assert.equal(successExit, 0);
  assert.deepEqual(success, ["MARKIRO_VBTECH_DEPLOY_HEALTHY\n"]);

  const failure = [];
  const failureExit = await runVbtechDeployCli({
    argv: ["run"],
    stdout: { write: () => assert.fail("failure must not write stdout") },
    stderr: { write: (value) => failure.push(value) },
    deploy: async () => {
      const error = new Error("raw private command output password");
      error.name = "VbtechDeployStageError";
      error.stage = "candidate-health";
      error.rollbackStage = "rollback-edge";
      throw error;
    },
  });
  assert.equal(failureExit, 1);
  assert.deepEqual(failure, [
    "MARKIRO_VBTECH_DEPLOY_FAILURE candidate-health ROLLBACK rollback-edge\n",
  ]);
});
