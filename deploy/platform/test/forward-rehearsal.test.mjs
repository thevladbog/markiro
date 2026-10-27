import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
const load = () => import("../forward-ci.mjs");
test("forward rehearsal refuses alternate argv and caller-supplied production adapters", async () => {
  const { rehearseForwardRecovery } = await load();
  for (const args of [[], ["--production"], ["--local-ci", "--host", "201.34.136.19"]])
    await assert.rejects(rehearseForwardRecovery(args));
  await assert.rejects(
    rehearseForwardRecovery(["--local-ci"], {
      runProcess: () => {
        throw new Error("unsafe");
      },
    }),
  );
});
test("safe forward evidence rejects private output and incomplete acceptance claims", async () => {
  const { validateForwardRehearsalEvidence, forwardRehearsalFailure } = await load();
  const value = {
    version: 1,
    kind: "synthetic-only-forward-recovery-rehearsal",
    productionAdmission: false,
    invocationId: "11111111-1111-4111-8111-111111111111",
    productSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53",
    completed: true,
    isolated: true,
    cleanup: true,
    checks: {
      migrationAppliedOnce: true,
      fullLedger: true,
      realBackupRestore: true,
      linuxHandoff: true,
      noOldStarts: true,
      noSecondMigrator: true,
      forwardHealthy: true,
      replacementFailureCleanup: true,
      externalTls: true,
      preBackupPredecessor: true,
      directSuccessor: true,
      activationSuccessor: true,
      preservedHistory: true,
    },
    problem: null,
    runs: ["healthy", "replacement-failure"].map((mode, i) => ({
      mode,
      operationId: `${i + 1}1111111-1111-4111-8111-111111111111`,
      failedOperationId: `${i + 3}1111111-1111-4111-8111-111111111111`,
      failedActivationOperationId: `${i + 7}1111111-1111-4111-8111-111111111111`,
      failedActivationStateSha256: "3".repeat(64),
      priorForwardOperationId: `${i + 5}1111111-1111-4111-8111-111111111111`,
      priorForwardStateSha256: "1".repeat(64),
      priorForwardIndexSha256: "2".repeat(64),
      admissionReadStage: "publisher",
      productSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53",
      executorSha: "a".repeat(40),
      postgresId: String(i + 1).repeat(64),
      schema: {
        systemId: "1234",
        schemaSha256: "b".repeat(64),
        migrationSha256: "c".repeat(64),
        migrationCount: "202",
      },
      productMigrationProofSha256: "d".repeat(64),
      archiveSha256: "e".repeat(64),
      restoreEvidenceSha256: "f".repeat(64),
      terminalSha256: "a".repeat(64),
      duration: {
        productProofMs: 1000,
        prepareMs: 2000,
        activationMs: 3000,
        dockerCalls: 123,
        sourceVerifications: 456,
        activationDockerCalls: 100,
        activationSourceVerifications: 400,
        activationDockerTransportMs: 1200,
        activationIsolationMs: 400,
        activationSourceVerificationMs: 200,
      },
    })),
  };
  assert.deepEqual(validateForwardRehearsalEvidence(value), value);
  const failed = structuredClone(value);
  failed.completed = false;
  failed.isolated = false;
  failed.runs = [];
  failed.problem = forwardRehearsalFailure({
    phase: "verify current ICU worker source closure",
    code: "ERR_ASSERTION",
    name: "AssertionError",
  });
  assert.deepEqual(validateForwardRehearsalEvidence(failed), failed);
  const timedOut = structuredClone(value);
  timedOut.completed = false;
  timedOut.problem = failed.problem;
  timedOut.runs[0].duration.activationMs = 40 * 60000;
  // Preserve safe measured failure data, while completed acceptance still
  // rejects the identical over-budget duration below.
  assert.deepEqual(validateForwardRehearsalEvidence(timedOut), timedOut);
  for (const patch of [
    { stdout: "PRIVATE" },
    { argv: ["PRIVATE"] },
    { privateRoot: "/private/root" },
    { phase: "PRIVATE" },
    { code: "PRIVATE" },
    { executable: "/private/bin" },
    { name: "PRIVATE" },
    { exitStatus: 256 },
    { processReason: "PRIVATE" },
  ])
    assert.throws(() =>
      validateForwardRehearsalEvidence({ ...failed, problem: { ...failed.problem, ...patch } }),
    );

  for (const mutate of [
    (v) => (v.privateRoot = "/tmp/private"),
    (v) => (v.stdout = "secret"),
    (v) => (v.productionAdmission = true),
    (v) => (v.checks.realBackupRestore = false),
    (v) => (v.cleanup = false),
    (v) => (v.productSha = "a".repeat(40)),
    (v) => (v.runs[0].privateRoot = "/tmp/private"),
    (v) => (v.runs[0].schema.migrationSha256 = "unknown"),
    (v) => (v.runs[1].operationId = v.runs[0].operationId),
    (v) => delete v.runs[0].priorForwardStateSha256,
    (v) => (v.runs[0].priorForwardOperationId = v.runs[0].operationId),
    (v) => (v.runs[0].admissionReadStage = "private-url"),
    (v) => (v.checks.directSuccessor = false),
    (v) => (v.checks.activationSuccessor = false),
    (v) => delete v.runs[0].failedActivationOperationId,
    (v) => (v.runs[0].failedActivationOperationId = v.runs[0].operationId),
    (v) => (v.runs[0].schema.migrationCount = "2"),
    (v) => delete v.runs[0].duration,
    (v) => (v.runs[0].duration.activationMs = 40 * 60000),
    (v) => (v.runs[0].duration.productProofMs = -1),
    (v) => (v.runs[0].duration.dockerCalls = 0),
    (v) => (v.runs[0].duration.sourceVerifications = 0),
    (v) => (v.runs[0].duration.activationDockerCalls = 124),
    (v) => (v.runs[0].duration.activationSourceVerifications = 457),
    (v) => delete v.runs[0].duration.activationDockerCalls,
    (v) => (v.runs[0].duration.activationDockerTransportMs = -1),
    (v) => (v.runs[0].duration.activationIsolationMs = "PRIVATE"),
    (v) => delete v.runs[0].duration.activationSourceVerificationMs,
    (v) => (v.runs[0].duration.argv = ["PRIVATE"]),
  ]) {
    const bad = structuredClone(value);
    mutate(bad);
    assert.throws(() => validateForwardRehearsalEvidence(bad));
  }
});
import { rehearsalFixture } from "./rehearsal-fixture.mjs";
import { createForwardRehearsalProcess } from "../forward-ci-scenario.mjs";
import { validateRehearsalDaemon, captureRehearsalResources } from "../upgrade-ci-guards.mjs";
for (const fault of [
  "route4",
  "route6",
  "host socket",
  "foreign volume",
  "foreign cleanup ID",
  "external network",
])
  test(`forward process refuses ${fault} through actual isolation guard before command`, async () => {
    const f = rehearsalFixture(),
      owned = captureRehearsalResources(f);
    if (fault === "route4") f.routes.ipv4 = "default via 172.17.0.1";
    if (fault === "route6") f.routes.ipv6 = "default via fe80::1";
    if (fault === "host socket")
      f.container.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/var/run/docker.sock",
        RW: true,
      });
    if (fault === "foreign volume") f.container.Mounts[0].Name = "foreign";
    if (fault === "foreign cleanup ID") f.container.Id = "b".repeat(64);
    if (fault === "external network")
      f.container.NetworkSettings.Networks.bridge = { NetworkID: "b".repeat(64) };
    let commands = 0;
    const run = createForwardRehearsalProcess({
      root: "/tmp/generated/state",
      verifyIsolation: async () => validateRehearsalDaemon(f, owned),
      shell: async () => {
        commands++;
      },
    });
    await assert.rejects(
      run({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", "info"],
        env: { DOCKER_CONFIG: "/tmp/generated/state/docker" },
      }),
    );
    assert.equal(commands, 0);
  });
for (const args of [
  ["create", "--privileged"],
  ["create", "--network", "host"],
  ["create", "--mount", "type=bind,source=/var/run/docker.sock,target=/socket"],
  ["create", "--mount", "type=bind,source=/opt/production/env,target=/input"],
  ["create", "--mount", "type=bind,source=/tmp/generated/state/../outside,target=/input"],
])
  test(`forward rehearsal refuses unsafe workload ${args[1]} before any command`, async () => {
    let commands = 0;
    const run = createForwardRehearsalProcess({
      root: "/tmp/generated/state",
      parent: "/tmp/generated",
      verifyIsolation: async () => {},
      shell: async () => {
        commands++;
      },
    });
    await assert.rejects(
      run({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", ...args],
        env: { DOCKER_CONFIG: "/tmp/generated/state/docker" },
      }),
    );
    assert.equal(commands, 0);
  });
import { createForwardScenario, forwardProduct } from "../forward-ci-scenario.mjs";
import { hostIdentity, hostEnv } from "./host-fixtures.mjs";
import { validateIdentity } from "../host/state-validation.mjs";
import { validateConfig } from "../preflight.mjs";
test("fixed forward product and runtime agree on both product SHAs and exact image identities", async () => {
  const candidate = hostIdentity(),
    scenario = createForwardScenario("healthy");
  await scenario.candidate(candidate);
  validateIdentity(candidate);
  const env = {
    ...hostEnv(candidate.admission.manifest, "/tmp/generated/state"),
    ...scenario.values(),
  };
  validateConfig(env, candidate.admission.manifest);
  assert.equal(env.MARKIRO_SOURCE_SHA, forwardProduct);
  assert.equal(env.MARKIRO_TOOLING_SHA, forwardProduct);
  assert.notEqual(candidate.executorSha, forwardProduct);
});

test("forward failure evidence preserves only allowlisted inner phase and child metadata", async () => {
  const { forwardRehearsalFailure } = await load();
  assert.equal(typeof forwardRehearsalFailure, "function");
  const expected = {
    phase: "verify current ICU worker source closure",
    code: "PROCESS_EXIT_17",
    command: "git show",
    name: "Error",
    exitStatus: 17,
    executable: "git",
    processReason: null,
  };
  assert.deepEqual(
    forwardRehearsalFailure({
      ...expected,
      stdout: "PRIVATE-STDOUT",
      stderr: "PRIVATE-STDERR",
      argv: ["PRIVATE-ARGV"],
      env: { SECRET: "PRIVATE-ENV" },
      privateRoot: "/private/evidence",
    }),
    expected,
  );
  const unknown = forwardRehearsalFailure({
    phase: "PRIVATE-PHASE",
    code: "PRIVATE-CODE",
    command: "PRIVATE-COMMAND",
    name: "PRIVATE-NAME",
    exitStatus: "PRIVATE-STATUS",
    executable: "/private/executable",
    processReason: "PRIVATE-REASON",
  });
  assert.equal(unknown.phase, "isolated forward rehearsal");
  assert.equal(unknown.code, "FORWARD_REHEARSAL_FAILED");
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE/u);
  let getters = 0;
  const hostile = Object.fromEntries(Object.keys(expected).map((key) => [key, null]));
  for (const key of Object.keys(expected))
    Object.defineProperty(hostile, key, {
      get() {
        getters++;
        throw Error("PRIVATE-GETTER");
      },
    });
  assert.doesNotThrow(() => forwardRehearsalFailure(hostile));
  assert.equal(getters, 0);
});

test("synthetic wrapper unit retains delegated failure and cleanup without executing Docker", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const engine = new URL("../upgrade-ci.mjs", import.meta.url).href;
  const target = new URL("../forward-ci.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    let calls = 0;
    mock.module(${JSON.stringify(engine)}, { namedExports: { stageRehearsalTree: () => { throw new Error("Unexpected staging in synthetic wrapper unit"); }, rehearseUpgrade: async (_args, options) => {
      calls++;
      await options.writeResult?.({ completed: false, isolated: false, cleanup: true,
        privateRoot: "PRIVATE-ROOT", problem: {
          phase: "verify current ICU worker source closure", code: "PROCESS_EXIT_17",
          command: "git show", name: "Error", exitStatus: 17, executable: "git", processReason: null,
          stdout: "PRIVATE-OUTPUT"
        } });
      throw new Error("PRIVATE-INNER-ERROR");
    } } });
    // Only the OS prerequisite is mocked in this isolated unit process. The
    // delegated engine above cannot create processes, containers or a Linux proof.
    Object.defineProperty(process, "platform", { value: "linux" });
    const { rehearseForwardRecovery } = await import(${JSON.stringify(target)});
    let result;
    await assert.rejects(rehearseForwardRecovery(["--local-ci"], { writeResult: async value => { result = value; } }));
    assert.equal(calls, 1);
    assert.equal(result.completed, false);
    assert.equal(result.productionAdmission, false);
    assert.equal(result.cleanup, true);
    assert.equal(result.isolated, false);
    assert.deepEqual(result.problem, { phase: "verify current ICU worker source closure", code: "PROCESS_EXIT_17", command: "git show", name: "Error", exitStatus: 17, executable: "git", processReason: null });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    console.log("synthetic wrapper unit only; no Docker or Linux acceptance");
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    {
      timeout: 15000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH },
    },
  );
  assert.match(result.stdout, /synthetic wrapper unit only/u);
});

test("synthetic wrapper never borrows cleanup proof for a later invocation without a result", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const engine = new URL("../upgrade-ci.mjs", import.meta.url).href;
  const target = new URL("../forward-ci.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    let calls = 0;
    mock.module(${JSON.stringify(engine)}, { namedExports: {
      stageRehearsalTree: () => { throw Error("Unexpected staging"); },
      rehearseUpgrade: async (_args, options) => {
        calls++;
        if (calls === 2) throw Error("PRIVATE unsaved terminal result");
        const result = { completed: true, isolated: true, cleanup: true, problem: null,
          forward: { mode: "healthy", operationId: "11111111-1111-4111-8111-111111111111",
            failedOperationId: "22222222-2222-4222-8222-222222222222",
            priorForwardOperationId: "33333333-3333-4333-8333-333333333333",
            failedActivationOperationId: "44444444-4444-4444-8444-444444444444",
            failedActivationStateSha256: "3".repeat(64),
            priorForwardStateSha256: "1".repeat(64), priorForwardIndexSha256: "2".repeat(64), admissionReadStage: "publisher",
            productSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53", executorSha: "a".repeat(40),
            postgresId: "b".repeat(64), schema: { systemId: "1234", migrationCount: "202",
              schemaSha256: "c".repeat(64), migrationSha256: "d".repeat(64) },
            productMigrationProofSha256: "e".repeat(64), archiveSha256: "f".repeat(64),
            restoreEvidenceSha256: "a".repeat(64), terminalSha256: "b".repeat(64), duration: { productProofMs: 1000,
              prepareMs: 2000, activationMs: 3000, dockerCalls: 123, sourceVerifications: 456, activationDockerCalls: 100, activationSourceVerifications: 400,
              activationDockerTransportMs: 1200, activationIsolationMs: 400,
              activationSourceVerificationMs: 200 } } };
        await options.writeResult(result);
        return result;
      }
    } });
    // Synthetic wrapper unit only: the mocked engine cannot execute Docker.
    Object.defineProperty(process, "platform", { value: "linux" });
    const { rehearseForwardRecovery } = await import(${JSON.stringify(target)});
    let result;
    await assert.rejects(rehearseForwardRecovery(["--local-ci"], { writeResult: async value => { result = value; } }));
    assert.equal(calls, 2);
    assert.equal(result.completed, false);
    assert.equal(result.cleanup, false);
    assert.equal(result.isolated, false);
    assert.equal(result.runs.length, 1);
    assert.equal(result.productionAdmission, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    console.log("synthetic missing terminal result regression");
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { timeout: 15000, maxBuffer: 65536, env: { PATH: process.env.PATH } },
  );
  assert.match(result.stdout, /synthetic missing terminal result regression/u);
});

test("worker staging verifies the actual copied archive before its single load", async () => {
  const { loadForwardWorkerArchive } = await import("../forward-ci-scenario.mjs");
  const calls = [];
  const sha256 = "a".repeat(64);
  await loadForwardWorkerArchive({
    archivePath: "/private/synthetic-worker.tar",
    sha256,
    containerId: "b".repeat(64),
    outer: async (args) => calls.push(["outer", args]),
    shell: async (args) => {
      calls.push(["shell", args]);
      return { stdout: `${sha256}  /var/lib/docker/markiro-forward-worker.tar\n` };
    },
    nested: async (args) => calls.push(["nested", args]),
    progress: () => {},
  });
  assert.deepEqual(calls, [
    [
      "outer",
      [
        "cp",
        "/private/synthetic-worker.tar",
        `${"b".repeat(64)}:/var/lib/docker/markiro-forward-worker.tar`,
      ],
    ],
    ["shell", ["sha256sum", "/var/lib/docker/markiro-forward-worker.tar"]],
    ["nested", ["load", "--input", "/var/lib/docker/markiro-forward-worker.tar"]],
  ]);
  for (const result of ["", `${"c".repeat(64)}  /var/lib/docker/markiro-forward-worker.tar\n`]) {
    let loads = 0;
    await assert.rejects(
      loadForwardWorkerArchive({
        archivePath: "/private/synthetic-worker.tar",
        sha256,
        containerId: "b".repeat(64),
        outer: async () => {},
        shell: async () => ({ stdout: result }),
        nested: async () => loads++,
        progress: () => {},
      }),
    );
    assert.equal(loads, 0);
  }
});

test("synthetic migration failure passes through the actual state wrapper without hiding earlier errors", async (t) => {
  const { expectSyntheticMigrationFailure } = await import("../forward-ci-scenario.mjs");
  const { phaseFixture } = await import("./upgrade-phase-fixture.mjs");
  const { withUpgradePhaseState } = await import("../host/upgrade-state.mjs");
  for (const code of [null, "ERR_HOST_STATE", "PROCESS_EXIT_1"]) {
    const f = await phaseFixture(t);
    const decision = await f.phaseInput("activate");
    const original = Object.assign(new Error("private diagnostic"), { code });
    const result = expectSyntheticMigrationFailure(
      (callback) => withUpgradePhaseState(f.root, decision, callback, { now: () => f.phaseNow }),
      async (store, expected) => {
        await store.complete("activation-admitted");
        await store.enter("migration-entered");
        if (code) throw original;
        await store.complete("migration-entered");
        await store.enter("migrated");
        await store.complete("migrated");
        await store.enter("api-started");
        throw expected;
      },
    );
    if (code) await assert.rejects(result, (error) => error === original);
    else {
      await result;
      const state = JSON.parse(await readFile(f.journal));
      assert.equal(state.sequence, 14);
      assert.equal(state.phase, "api-started");
      assert.equal(state.status, "recovery-required");
    }
  }
});

test("expected migration injection cannot hide wrapper durability or termination uncertainty", async () => {
  const { expectSyntheticMigrationFailure } = await import("../forward-ci-scenario.mjs");
  for (const properties of [
    { durabilityUncertain: true },
    { durabilityUncertain: false, terminationConfirmed: false },
  ]) {
    const outer = Object.assign(new Error("wrapper uncertainty"), properties);
    await assert.rejects(
      expectSyntheticMigrationFailure(
        async (callback) => {
          try {
            await callback({});
          } catch {
            throw outer;
          }
        },
        async (_, expected) => {
          throw expected;
        },
      ),
      (error) => error === outer,
    );
  }
  await assert.rejects(
    expectSyntheticMigrationFailure(
      async (callback) => callback({}),
      async () => {},
    ),
  );
});

test("forward transport preserves absent stdin instead of creating an undeclared pipe", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { root } = await privateFixture(t);
  let observed = false;
  const run = createForwardRehearsalProcess({
    root,
    parent: root,
    containerId: "a".repeat(64),
    verifyIsolation: async () => {},
    stdinOuter: async (args, input) => {
      observed = true;
      assert.equal(args.includes("-i"), false);
      assert.equal(input, undefined);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  await run({
    executable: "/usr/bin/docker",
    args: ["--host", "unix:///var/run/docker.sock", "info"],
    env: { DOCKER_CONFIG: `${root}/docker` },
    timeoutMs: 1000,
    outputLimitBytes: 65536,
  });
  assert.equal(observed, true);
});

test("safe evidence retains finite forward preparation boundaries without projecting private strings", async () => {
  const { forwardRehearsalFailure } = await load();
  for (const boundary of ["verifyAdmission", "inspectSource", "inspectSchema", "createBackup"]) {
    const phase = `forward preparation: ${boundary}`;
    assert.equal(forwardRehearsalFailure({ phase }).phase, phase);
  }
  assert.equal(
    forwardRehearsalFailure({ phase: "forward preparation: PRIVATE" }).phase,
    "isolated forward rehearsal",
  );
});

test("compiled prepare adapters enter each single-use capability only once", async (t) => {
  const { forwardPreparationAdapters } = await import("../host/forward-command-runtime.mjs");
  const { forwardRetainedFixture } = await import("./forward-retained-fixture.mjs");
  const { withForwardPreparationState } = await import("../host/forward-state.mjs");
  const { captureForwardRetained } = await import("../host/forward-retained.mjs");
  const { withForwardBackupRuntime } = await import("../backup/local-runtime.mjs");
  const { provisionForwardRuntimes } = await import("./forward-backup-fixture.mjs");
  const { forwardPrepared } = await import("./forward-fixture.mjs");
  const f = await forwardRetainedFixture(t);
  await provisionForwardRuntimes(f);
  let authorized = 0,
    inspected = 0,
    backedUp = 0;
  const adapters = forwardPreparationAdapters({
    verifyReleaseHeld: async (held) => {
      await held.verify();
      authorized++;
      return f.input.identity;
    },
    captureRetained: async (cap, verifyAdmission) => {
      await captureForwardRetained(
        {
          ...f.inputCapture,
          runProcess: (request) => {
            inspected++;
            return f.inputCapture.runProcess(request);
          },
        },
        cap,
        { verifyAdmission },
      );
      return f.input.identity;
    },
    observers: {},
    backup: (cap) =>
      withForwardBackupRuntime(cap, async (held) => {
        await held.verify();
        backedUp++;
        return "verified-backup-boundary";
      }),
  });
  await withForwardPreparationState(
    f.root,
    f.input,
    async (store) => {
      assert.deepEqual(
        await store.guard((cap) => adapters.verifyAdmission({}, cap)),
        f.input.identity,
      );
      assert.equal(authorized, 1);
      assert.equal(inspected, 6);
      await store.complete("admitted", forwardPrepared(f).sourceRuntime);
      await store.enter("source-held");
      await store.complete("source-held");
      await store.enter("backup-verified");
      assert.equal(
        await store.guard((cap) => adapters.createBackup({}, cap)),
        "verified-backup-boundary",
      );
      assert.equal(backedUp, 1);
    },
    f.options,
  );
});

test("backup diagnostic exposes only finite stage and first trusted origin before wrapping", async () => {
  const { forwardBackupFailure } = await import("../forward-ci-scenario.mjs");
  const { noteHostProcessFailure, carryHostFailure } =
    await import("../host/failure-diagnostic.mjs");
  const origin = noteHostProcessFailure(
    Object.assign(new Error("PRIVATE"), { code: "ERR_HOST_PROCESS" }),
    "/usr/bin/docker",
    23,
  );
  const wrapped = carryHostFailure(
    origin,
    Object.assign(new Error("PRIVATE-WRAPPER"), {
      code: "ERR_TARGET_BACKUP",
      targetBackupStage: "archive-production",
    }),
  );
  const result = forwardBackupFailure(wrapped);
  assert.equal(result.stage, "archive-production");
  assert.equal(result.code, "ERR_HOST_PROCESS");
  assert.equal(result.exitStatus, 23);
  assert.equal(result.executable, "docker");
  assert.equal(result.durabilityUncertain, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
  assert.equal(
    forwardBackupFailure({ targetBackupStage: "PRIVATE", stdout: "PRIVATE", argv: ["PRIVATE"] })
      .stage,
    "unclassified",
  );
});

test("backup stages are compiled safe labels and hostile getters cannot enter diagnostics", async () => {
  const { forwardBackupStages, forwardBackupFailure } = await import("../forward-ci-scenario.mjs");
  const { forwardRehearsalFailure } = await load();
  for (const stage of [...forwardBackupStages, "unclassified"]) {
    const phase = `forward preparation backup: ${stage}`;
    assert.equal(forwardRehearsalFailure({ phase }).phase, phase);
  }
  let called = false;
  const hostile = Object.defineProperty({}, "targetBackupStage", {
    get() {
      called = true;
      throw new Error("PRIVATE");
    },
  });
  assert.equal(forwardBackupFailure(hostile).stage, "unclassified");
  assert.equal(called, false);
  assert.equal(
    forwardRehearsalFailure({ phase: "forward preparation backup: PRIVATE" }).phase,
    "isolated forward rehearsal",
  );
});

test("forward restore directory larger than control stdin is copied and fully verified", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { mkdir, writeFile, cp, lstat, chmod } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { digest } = await import("../backup/schemas.mjs");
  const { runHostProcess } = await import("../host/process.mjs");
  const source = await privateFixture(t, { nested: true });
  const input = join(source.root, "restore-input");
  await mkdir(input, { mode: 0o700 });
  await writeFile(join(input, "database.dump"), Buffer.alloc(2 * 1048576, 7), { mode: 0o600 });
  await writeFile(join(input, "request.json"), "fixture inventory", { mode: 0o600 });
  const command = promisify(execFile);
  for (const corrupt of [false, "bytes", "mode", "directory"]) {
    const target = await privateFixture(t, { nested: true });
    const mapped = (path) => join(target.root, relative(source.root, path));
    const seen = new Set();
    let copied = false;
    const run = createForwardRehearsalProcess({
      root: source.root,
      parent: source.root,
      repository: source.root,
      containerId: "a".repeat(64),
      verifyIsolation: async () => {},
      command: (bin, args, options) => command(bin, args, { maxBuffer: 4 * 1048576, ...options }),
      shell: async (args) => {
        if (args[0] === "mkdir") {
          await mkdir(mapped(args.at(-1)), { mode: 0o700, recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "chmod") {
          await chmod(mapped(args.at(-1)), Number.parseInt(args[1], 8));
          return { stdout: "", stderr: "" };
        }
        assert.equal(copied, true);
        const path = mapped(args.at(-1));
        seen.add(relative(mapped(input), path));
        if (args[0] === "sha256sum") return { stdout: digest(await readFile(path)) };
        assert.equal(args[0], "stat");
        const stat = await lstat(path);
        if (args[2] === "%a:%F")
          return {
            stdout: `${(stat.mode & 0o777).toString(8)}:${stat.isDirectory() ? "directory" : "other"}`,
          };
        assert.equal(args[2], "%a:%s");
        return { stdout: `${(stat.mode & 0o777).toString(8)}:${stat.size}` };
      },
      outer: async (args) => {
        assert.deepEqual(args, ["cp", `${input}/.`, `${"a".repeat(64)}:${input}`]);
        await cp(input, mapped(input), { recursive: true, force: false });
        copied = true;
        if (corrupt === "bytes") await writeFile(join(mapped(input), "database.dump"), "changed");
        if (corrupt === "mode") await chmod(join(mapped(input), "request.json"), 0o644);
        if (corrupt === "directory") await chmod(mapped(input), 0o755);
        return { stdout: "", stderr: "" };
      },
      // The old TAR path really reaches the unchanged 1 MiB pre-spawn guard.
      stdinOuter: (_args, input) =>
        runHostProcess({
          executable: "/usr/bin/true",
          args: [],
          cwd: source.root,
          env: { PATH: process.env.PATH },
          timeoutMs: 10000,
          outputLimitBytes: 1048576,
          ...(input === undefined ? {} : { input }),
        }),
    });
    const request = {
      executable: "/usr/bin/docker",
      args: ["--host", "unix:///var/run/docker.sock", "cp", `${input}/.`, "worker:/input/"],
      env: { DOCKER_CONFIG: join(source.root, "docker") },
      timeoutMs: 10000,
      outputLimitBytes: 1048576,
    };
    if (corrupt) await assert.rejects(run(request));
    else {
      await run(request);
      assert.equal(copied, true);
      assert.deepEqual([...seen].sort(), ["", "database.dump", "request.json"]);
    }
  }
});

test("forward activation inputs normalize real Buffer SQL output and retain complete restore proof", async (t) => {
  const { activationInputs } = await import("../forward-ci-scenario.mjs");
  const { productionFixture } = await import("./production-activation-fixture.mjs");
  const { activationTables } = await import("../host/prepared-target.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");
  const f = await productionFixture(t, { nested: true });
  await promisify(execFile)("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=db.private",
    "-keyout",
    join(f.root, "fixture-key"),
    "-out",
    join(f.root, "pg/server.crt"),
  ]);
  const projection = activationTables.map((table) => ({
    table,
    rows: 0,
    pending: 0,
    expired: 0,
    sha256: digest(""),
  }));
  let queries = 0,
    projections = 0;
  const c = {
    root: f.root,
    repository: process.cwd(),
    // Docker Config.Id differs from the registry manifest digest in runtime.env.
    policy: { postgresImageId: `sha256:${digest("docker-config-id-not-manifest")}` },
    predecessorContainers: { postgres: "a".repeat(64) },
    evidence: { differences: [] },
    sql: async (query) => {
      assert.equal(query, "SHOW server_version;");
      queries++;
      return { stdout: Buffer.from("17.11\n"), stderr: Buffer.alloc(0) };
    },
  };
  const result = await activationInputs(
    c,
    f.identity,
    f.expected.configuration,
    { document: f.document, evidence: f.evidence },
    { backup: f.backup, restoreEvidence: f.restoreEvidence, fence: f.record.fence },
    f.expected.roleMapping,
    async (request) => {
      projections++;
      assert.ok(Buffer.isBuffer(request.input));
      assert.ok(
        request.input.toString().startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"),
      );
      return {
        stdout: Buffer.from(projection.map((row) => JSON.stringify(row)).join("\n")),
        stderr: Buffer.alloc(0),
      };
    },
  );
  assert.notEqual(c.policy.postgresImageId, f.expected.postgres.image);
  assert.equal(queries, 1);
  assert.equal(projections, 1);
  assert.equal(result.preparedTarget.observations.postgres.value.postgresVersion, "17.11");
  assert.deepEqual(result.preparedTarget.observations.restoredSnapshot.value, {
    snapshotId: f.document.snapshotId,
    archiveSha256: f.backup.archiveSha256,
    inventorySha256: f.evidence.inventorySha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
    roleMappingSha256: f.evidence.roleMappingSha256,
    restoredInventorySha256: f.evidence.restoredInventorySha256,
    workerImage: f.evidence.runtime.image,
    workerArchitecture: f.evidence.runtime.architecture,
  });
  assert.deepEqual(result.preparedTarget.observations.egress.value.review.projection, projection);
  assert.equal(c.evidence.differences.length, 1);
  const { validatePreparedTarget } = await import("../host/prepared-target.mjs");
  const checked = await validatePreparedTarget(result.preparedTarget, {
    root: f.root,
    identity: f.identity,
    configuration: f.expected.configuration,
    ...result.preparedPolicy,
    writerFence: f.expected.writerFence,
    workload: f.expected.workload,
  });
  // The real contract permits a fresh one-hour activation admission. Native
  // guarded work can legitimately outlast the helper fixture's default30min.
  let now = Date.parse(result.preparedTarget.observations.egress.observedAt) + 31 * 60000;
  t.mock.method(Date, "now", () => now);
  await validatePreparedTarget(result.preparedTarget, {
    root: f.root,
    identity: f.identity,
    configuration: f.expected.configuration,
    ...result.preparedPolicy,
    writerFence: {
      ...f.expected.writerFence,
      observe: async (request) => ({
        ...(await f.expected.writerFence.observe(request)),
        observedAt: new Date(now).toISOString(),
      }),
    },
    workload: {
      ...f.expected.workload,
      inspect: async (request) => ({
        ...(await f.expected.workload.inspect(request)),
        observedAt: new Date(now).toISOString(),
      }),
    },
  });
  const authorization = result.preparedTarget.observations.egress.value;
  assert.equal(authorization.expiresAt, authorization.sourceHold.expiresAt);
  assert.equal(
    Date.parse(authorization.expiresAt) -
      Date.parse(result.preparedTarget.observations.egress.observedAt),
    3600000,
  );
  now = Date.parse(authorization.expiresAt) + 1;
  const { validateProductionAuthorization } = await import("../host/prepared-target.mjs");
  assert.throws(() =>
    validateProductionAuthorization(
      result.preparedTarget,
      f.document,
      f.evidence,
      checked.backupProof,
      now,
    ),
  );
  assert.equal(result.preparedPolicy.postgres.image, f.expected.postgres.image);
  assert.equal(result.preparedTarget.observations.postgres.value.image, f.expected.postgres.image);
});

test("projection transport uses the pinned absolute DinD CLI without widening the host PATH", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { measureActivationProjection } = await import("../host/command.mjs");
  const { activationTables } = await import("../host/prepared-target.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const f = await privateFixture(t, { nested: true });
  const id = "a".repeat(64);
  const rows = activationTables.map((table) => ({
    table,
    rows: 0,
    pending: 0,
    expired: 0,
    sha256: digest(""),
  }));
  let commands = 0,
    isolationChecks = 0;
  const run = createForwardRehearsalProcess({
    root: f.root,
    parent: f.root,
    repository: f.root,
    containerId: id,
    verifyIsolation: async () => {
      isolationChecks++;
    },
    stdinOuter: async (args, input) => {
      commands++;
      const envFile = args[args.indexOf("--env-file") + 1];
      const env = await readFile(envFile, "utf8");
      assert.ok(env.split("\n").includes("PATH=/usr/bin:/bin"));
      assert.equal(args[args.indexOf(id) + 1], "/usr/local/bin/docker");
      assert.ok(Buffer.isBuffer(input));
      assert.ok(input.toString().startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"));
      return {
        stdout: Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n")),
        stderr: Buffer.alloc(0),
      };
    },
  });
  assert.deepEqual(
    await measureActivationProjection(
      { root: f.root, dockerConfig: f.dockerConfig },
      "b".repeat(64),
      new Date().toISOString(),
      run,
    ),
    rows,
  );
  assert.equal(commands, 1);
  assert.equal(isolationChecks, 2);
});

test("forward activation failure retains only validated first-record context and trusted origin", async () => {
  const { forwardActivationFailure } = await import("../forward-ci-scenario.mjs");
  const { noteHostProcessFailure, carryHostFailure } =
    await import("../host/failure-diagnostic.mjs");
  const id = "11111111-1111-4111-8111-111111111111";
  const first = Object.assign(Error("PRIVATE"), {
    code: "ERR_HOST_PROCESS",
    stdout: "PRIVATE",
    argv: ["PRIVATE"],
  });
  noteHostProcessFailure(first, "/usr/bin/docker", 125);
  const error = carryHostFailure(
    first,
    Object.assign(Error("PRIVATE"), { code: "ERR_HOST_FORWARD_ACTIVATION" }),
  );
  const result = forwardActivationFailure(error, id, {
    phase: "api-started",
    boundary: "verifyRoles",
    commandCategory: "validation",
    stdout: "PRIVATE",
  });
  assert.equal(result.phase, "api-started");
  assert.equal(result.boundary, "verifyRoles");
  assert.equal(result.code, "ERR_HOST_PROCESS");
  assert.equal(result.exitStatus, 125);
  assert.equal(result.executable, "docker");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  const hostile = Object.defineProperty({}, "phase", {
    get() {
      throw Error("PRIVATE");
    },
  });
  for (const record of [
    undefined,
    hostile,
    { phase: "PRIVATE", boundary: "PRIVATE", commandCategory: "PRIVATE" },
  ]) {
    const fallback = forwardActivationFailure(error, id, record);
    assert.equal(fallback.phase, "activation-admitted");
    assert.equal(fallback.boundary, "validation");
    assert.ok(!JSON.stringify(fallback).includes("PRIVATE"));
  }
});

test("activation timing includes asynchronous proof construction and subsequent activation", async () => {
  const { prepareTimedForwardActivation } = await import("../forward-ci-scenario.mjs");
  assert.equal(typeof prepareTimedForwardActivation, "function");
  const { setTimeout: delay } = await import("node:timers/promises");
  const window = await prepareTimedForwardActivation(async () => {
    await delay(25);
    return { prepared: true };
  });
  assert.deepEqual(window.inputs, { prepared: true });
  assert.ok(window.elapsedMs() >= 20);
  await delay(25);
  assert.ok(window.elapsedMs() >= 40);
  await assert.rejects(
    prepareTimedForwardActivation(async () => {
      throw new Error("synthetic construction failure");
    }),
    /synthetic construction failure/u,
  );
});

test("forward timing keeps only aggregate costs and preserves action failures", async () => {
  const { createForwardTiming } = await import("../forward-ci-scenario.mjs");
  const timing = createForwardTiming();
  const result = { private: "not telemetry" };
  assert.equal(
    await timing.measure("dockerMs", async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return result;
    }),
    result,
  );
  const failure = new Error("PRIVATE-CHILD-ERROR");
  await assert.rejects(
    timing.measure("sourceMs", async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw failure;
    }),
    (error) => error === failure,
  );
  let called = false;
  await assert.rejects(
    timing.measure("PRIVATE-UNSUPPORTED-CATEGORY", async () => {
      called = true;
    }),
  );
  assert.equal(called, false);
  const observed = timing.snapshot();
  assert.deepEqual(Object.keys(observed), ["dockerMs", "isolationMs", "sourceMs"]);
  assert.ok(observed.dockerMs > 0 && observed.sourceMs > 0);
  assert.equal(observed.isolationMs, 0);
  observed.dockerMs = -1;
  assert.ok(timing.snapshot().dockerMs > 0);
  assert.equal(JSON.stringify(timing.snapshot()).includes("PRIVATE"), false);
});

test("fresh inner inspections retain source, isolation and recheck boundaries and never use CLI fallback after failure", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { root } = await privateFixture(t);
  for (const args of [
    ["container", "inspect", "b".repeat(64)],
    ["image", "inspect", `sha256:${"b".repeat(64)}`],
    ["image", "inspect", `ghcr.io/thevladbog/markiro-api@sha256:${"b".repeat(64)}`],
  ])
    for (const fault of [null, "read", "post-isolation"]) {
      const events = [];
      const run = createForwardRehearsalProcess({
        root,
        parent: root,
        containerId: "a".repeat(64),
        verifyIsolation: async () => {
          events.push("isolation");
          if (fault === "post-isolation" && events.length > 1) throw Error("changed");
        },
        inspectChannel: {
          read: async (request) => {
            events.push("read");
            assert.deepEqual(request.args, args);
            if (fault === "read") throw Error("read failed");
            return { stdout: Buffer.from("[{}]\n"), stderr: Buffer.alloc(0) };
          },
        },
        stdinOuter: async () => {
          events.push("CLI");
          throw Error("unexpected CLI");
        },
      });
      const operation = run(
        {
          executable: "/usr/bin/docker",
          args: ["--host", "unix:///var/run/docker.sock", ...args],
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DOCKER_CONFIG: `${root}/docker` },
          timeoutMs: 1000,
          outputLimitBytes: 1048576,
        },
        () => events.push("recheck"),
      );
      if (fault) await assert.rejects(operation);
      else assert.equal(String((await operation).stdout), "[{}]\n");
      assert.deepEqual(
        events,
        fault === "read"
          ? ["isolation", "recheck", "read"]
          : ["isolation", "recheck", "read", "isolation"],
      );
    }
});
test("unqualified images and caller-specified Docker environment retain the original CLI", async (t) => {
  const { privateFixture } = await import("./host-fixtures.mjs");
  const { root } = await privateFixture(t);
  for (const mode of ["image", "API-version"]) {
    let cli = 0;
    const run = createForwardRehearsalProcess({
      root,
      parent: root,
      containerId: "a".repeat(64),
      verifyIsolation: async () => {},
      inspectChannel: {
        read: () => {
          throw Error("not eligible");
        },
      },
      stdinOuter: async () => {
        cli++;
        return { stdout: Buffer.from("[]"), stderr: Buffer.alloc(0) };
      },
    });
    await run({
      executable: "/usr/bin/docker",
      args: [
        "--host",
        "unix:///var/run/docker.sock",
        mode === "image" ? "image" : "container",
        "inspect",
        "b".repeat(64),
      ],
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        DOCKER_CONFIG: `${root}/docker`,
        ...(mode === "API-version" ? { DOCKER_API_VERSION: "1.48" } : {}),
      },
      timeoutMs: 1000,
      outputLimitBytes: 1048576,
    });
    assert.equal(cli, 1);
  }
});
