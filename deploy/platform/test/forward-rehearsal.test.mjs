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
    },
    problem: null,
    runs: ["healthy", "replacement-failure"].map((mode, i) => ({
      mode,
      operationId: `${i + 1}1111111-1111-4111-8111-111111111111`,
      failedOperationId: `${i + 3}1111111-1111-4111-8111-111111111111`,
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
            productSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53", executorSha: "a".repeat(40),
            postgresId: "b".repeat(64), schema: { systemId: "1234", migrationCount: "202",
              schemaSha256: "c".repeat(64), migrationSha256: "d".repeat(64) },
            productMigrationProofSha256: "e".repeat(64), archiveSha256: "f".repeat(64),
            restoreEvidenceSha256: "a".repeat(64), terminalSha256: "b".repeat(64) } };
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
