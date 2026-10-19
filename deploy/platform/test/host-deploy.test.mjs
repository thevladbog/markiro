import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { preparedFixture } from "./prepared-target-fixture.mjs";

const disk = async (root) => JSON.parse(await readFile(join(root, "state.json"), "utf8"));
async function execute(input, adapters) {
  const module = await import("../host/deploy.mjs").catch(() => ({}));
  assert.equal(typeof module.executePreparedDeployment, "function", "coordinator must be exported");
  return module.executePreparedDeployment(input, adapters);
}
async function fixture(t, failAt) {
  const f = await preparedFixture(t);
  const { writerFence, workload, root, identity, configuration, ...preparedPolicy } = f.expected;
  const input = {
    root,
    identity,
    configuration,
    dockerConfig: f.dockerConfig,
    preparedTarget: f.record,
    preparedPolicy,
  };
  const trace = [];
  const action = async (name) => {
    const state = await disk(root);
    assert.ok(["entered", "recovery-required"].includes(state.current.status));
    trace.push([name, state.current.phase]);
    if (name === failAt) throw new Error("fixture-private-subprocess-output");
  };
  const adapters = {
    writerFence,
    workload,
    verifyRelease: () => action("release"),
    verifyImages: () => action("images"),
    inspectTarget: async () => ({
      target: identity.target,
      project: "markiro-platform",
      serverProfile: "platform-only",
      uiProfile: "platform-only",
      os: "linux",
      architecture: "amd64",
    }),
    inspectStoppedWorkloads: async () => ({
      target: identity.target,
      project: "markiro-platform",
      active: [],
    }),
    inspectMigration: async ({ migration: { name } }) => ({
      name,
      ownerOperationId: identity.operationId,
      containerId: null,
      status: "absent",
    }),
    stopMigration: () => action("stop-migration"),
    smoke: () => action("smoke"),
    runProcess: async (request) => {
      assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
      const args = request.args.slice(2);
      assert.deepEqual(args.slice(0, 3), ["compose", "--project-name", "markiro-platform"]);
      assert.equal(args[3], "--file");
      assert.match(args[4], /\/deploy\/platform\/compose\.yml$/u);
      assert.equal(args[5], "--file");
      assert.match(args[6], /\/deploy\/platform\/compose\.compact\.yml$/u);
      const command = args.slice(7);
      const name =
        command[0] === "pull"
          ? "pull"
          : command[0] === "stop"
            ? "stop"
            : command[0] === "run"
              ? "migrate"
              : command.at(-1);
      if (name === "api") assert.deepEqual(command, ["up", "-d", "--wait", "--no-deps", "api"]);
      if (name === "edge") assert.deepEqual(command, ["up", "-d", "--no-deps", "edge"]);
      if (name === "postgres")
        assert.deepEqual(command, ["up", "-d", "--wait", "--no-deps", "postgres"]);
      if (name === "stop") assert.deepEqual(command, ["stop", "edge", "api"]);
      if (name === "migrate") {
        assert.deepEqual(command.slice(0, 3), ["run", "--rm", "--no-deps"]);
        assert.ok(command.includes(`markiro-platform-migrate-${identity.operationId}`));
        assert.ok(command.includes(`io.markiro.operation=${identity.operationId}`));
        assert.equal(command.at(-1), "migrate");
      }
      assert.equal(request.executable, "/usr/bin/docker");
      assert.equal(request.cwd, root);
      assert.ok(request.timeoutMs > 0);
      assert.ok(request.outputLimitBytes > 0);
      assert.equal(request.env.DATABASE_URL, undefined);
      assert.equal(request.env.PLATFORM_AUTH_SECRET, undefined);
      assert.equal(request.env.COMPOSE_DISABLE_ENV_FILE, "1");
      await action(name);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
  return { ...f, input, adapters, trace };
}

test("clean first install journals actions before executing and completes healthy in exact order", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.input.dockerConfig, "config.json"),
    JSON.stringify({ currentContext: "remote-attacker" }),
    { mode: 0o600 },
  );
  assert.deepEqual(await execute(f.input, f.adapters), f.identity);
  assert.deepEqual(f.trace, [
    ["release", "admitted"],
    ["pull", "images-verified"],
    ["images", "images-verified"],
    ["stop", "target-stopped"],
    ["postgres", "backup-verified"],
    ["migrate", "migrating"],
    ["api", "api-started"],
    ["edge", "edge-started"],
    ["smoke", "healthy"],
  ]);
  const state = await disk(f.root);
  assert.equal(state.sequence, 18);
  assert.equal(state.previousHealthy, null);
  assert.equal(state.current.phase, "healthy");
  assert.equal(state.current.status, "completed");
});

test("failed migration never starts either app and retains recovery-required with real backup proof", async (t) => {
  const f = await fixture(t, "migrate");
  await assert.rejects(execute(f.input, f.adapters), (error) => {
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /fixture-private/u);
    return true;
  });
  assert.ok(!f.trace.some(([name]) => ["api", "edge", "smoke"].includes(name)));
  assert.ok(f.trace.some(([name]) => name === "stop-migration"));
  const state = await disk(f.root);
  assert.equal(state.current.phase, "migrating");
  assert.equal(state.current.status, "recovery-required");
  assert.equal(state.current.backup.archiveSha256, f.backup.archiveSha256);
});

for (const [name, expectedPhase] of [
  ["release", "admitted"],
  ["pull", "images-verified"],
  ["images", "images-verified"],
  ["stop", "target-stopped"],
  ["postgres", "backup-verified"],
  ["migrate", "migrating"],
  ["api", "api-started"],
  ["edge", "edge-started"],
  ["smoke", "healthy"],
]) {
  test(`failure at ${name} is terminal and never runs a later startup`, async (t) => {
    const f = await fixture(t, name);
    await assert.rejects(execute(f.input, f.adapters));
    const state = await disk(f.root);
    assert.equal(state.current.phase, expectedPhase);
    assert.equal(state.current.status, "recovery-required");
    const startups = f.trace
      .filter(([n]) => ["migrate", "api", "edge", "smoke"].includes(n))
      .map(([n]) => n);
    const permitted = ["migrate", "api", "edge", "smoke"];
    assert.deepEqual(
      startups,
      permitted.includes(name) ? permitted.slice(0, permitted.indexOf(name) + 1) : [],
    );
    const before = await readFile(join(f.root, "state.json"));
    f.trace.length = 0;
    await assert.rejects(execute(f.input, f.adapters));
    assert.deepEqual(f.trace, []);
    assert.deepEqual(await readFile(join(f.root, "state.json")), before);
  });
}

test("failure during migrated observation stops owned apps without a rollback", async (t) => {
  const f = await fixture(t);
  const inspect = f.adapters.inspectStoppedWorkloads;
  f.adapters.inspectStoppedWorkloads = async (request) => {
    if (request.phase === "migrated") throw new Error("fixture-private-inspection");
    return inspect(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal((await disk(f.root)).current.phase, "migrated");
  assert.equal((await disk(f.root)).current.status, "recovery-required");
  assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
});

test("malformed identity or invalid target inspection cannot invoke cleanup or other commands", async (t) => {
  for (const invalid of ["identity", "target", "callbacks"]) {
    const f = await fixture(t);
    if (invalid === "identity") f.input.identity.admission.manifest.serverProfile = "full";
    if (invalid === "target") f.adapters.inspectTarget = async () => ({ approved: true });
    if (invalid === "callbacks") f.adapters.inspectTarget = true;
    await assert.rejects(execute(f.input, f.adapters));
    assert.deepEqual(f.trace, []);
    await assert.rejects(readFile(join(f.root, "state.json")), { code: "ENOENT" });
  }
});

test("a rejected release cannot stop workloads before release verification succeeds", async (t) => {
  const f = await fixture(t, "release");
  await assert.rejects(execute(f.input, f.adapters));
  assert.deepEqual(f.trace, [["release", "admitted"]]);
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

test("stale prepared evidence and changed on-disk backup fail before target startup", async (t) => {
  for (const invalid of ["expired", "archive", "evidence", "configuration", "interpolation"]) {
    const f = await fixture(t);
    if (invalid === "expired") f.input.preparedPolicy.maxAgeMs = 1;
    if (invalid === "interpolation")
      f.input.configuration.runtimeSnapshot.interpolation = {
        ...f.input.configuration.runtimeSnapshot.interpolation,
        MARKIRO_SOURCE_SHA: "0".repeat(40),
      };
    if (["archive", "evidence", "configuration"].includes(invalid)) {
      const verify = f.adapters.verifyImages;
      f.adapters.verifyImages = async (request) => {
        await verify(request);
        const path =
          invalid === "archive"
            ? f.backup.archivePath
            : invalid === "evidence"
              ? f.restoreEvidence.evidencePath
              : f.input.configuration.migrationSnapshot.path;
        const { appendFile } = await import("node:fs/promises");
        await appendFile(path, "#changed");
      };
    }
    await assert.rejects(execute(f.input, f.adapters));
    assert.ok(!f.trace.some(([n]) => ["postgres", "migrate", "api", "edge"].includes(n)));
  }
});

test("unexpected active writer after stop prevents migration", async (t) => {
  const f = await fixture(t);
  f.adapters.inspectStoppedWorkloads = async () => ({
    target: f.identity.target,
    project: "markiro-platform",
    active: ["legacy-worker"],
  });
  await assert.rejects(execute(f.input, f.adapters));
  assert.ok(!f.trace.some(([n]) => ["migrate", "api", "edge"].includes(n)));
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

test("outsider writer appearing at a later boundary rejects startup", async (t) => {
  const f = await fixture(t);
  const inspect = f.adapters.inspectTarget;
  f.adapters.inspectTarget = async (request) => {
    if (request.phase === "api-started") throw new Error("fixture-private-outsider-writer");
    return inspect(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

for (const reason of ["aborted", "timeout"]) {
  test(`${reason} migration stops its exact daemon-owned container before recovery inspection`, async (t) => {
    const f = await fixture(t);
    const run = f.adapters.runProcess;
    const controls = [];
    let status = "absent";
    f.adapters.runProcess = async (request) => {
      if (request.args.includes("run")) {
        status = "running";
        controls.push("migration-running");
        throw Object.assign(new Error("fixture-private-process-stderr"), {
          reason,
          terminationConfirmed: true,
        });
      }
      return run(request);
    };
    f.adapters.stopMigration = async (request) => {
      assert.equal(request.migration.name, `markiro-platform-migrate-${f.identity.operationId}`);
      assert.equal(request.migration.ownerOperationId, f.identity.operationId);
      assert.deepEqual(request.migration.labels, {
        "io.markiro.operation": f.identity.operationId,
      });
      controls.push("stop-owned");
      status = "exited";
    };
    f.adapters.inspectMigration = async ({ migration }) => {
      controls.push(`inspect-${status}`);
      return {
        name: migration.name,
        ownerOperationId: f.identity.operationId,
        containerId: "a".repeat(64),
        status,
      };
    };
    await assert.rejects(execute(f.input, f.adapters));
    assert.deepEqual(controls, ["migration-running", "stop-owned", "inspect-exited"]);
    assert.equal((await disk(f.root)).current.status, "recovery-required");
    assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
  });
}

test("failed daemon stop/inspection retains terminal state and cannot admit a second deploy", async (t) => {
  const f = await fixture(t, "migrate");
  let inspected = false;
  f.adapters.stopMigration = async () => {
    throw new Error("fixture-private-daemon-still-running");
  };
  f.adapters.inspectMigration = async ({ migration }) => {
    inspected = true;
    return {
      name: migration.name,
      ownerOperationId: f.identity.operationId,
      containerId: "a".repeat(64),
      status: "running",
    };
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(inspected, true);
  const before = await readFile(join(f.root, "state.json"));
  assert.equal((await disk(f.root)).current.status, "recovery-required");
  await assert.rejects(execute(f.input, f.adapters));
  assert.deepEqual(await readFile(join(f.root, "state.json")), before);
});

test("unconfirmed CLI group termination does not race recovery commands", async (t) => {
  const f = await fixture(t);
  const run = f.adapters.runProcess;
  let failed = false;
  const raced = [];
  f.adapters.runProcess = async (request) => {
    if (request.args.includes("run")) {
      failed = true;
      throw Object.assign(new Error("fixture-private-unreaped-cli"), {
        terminationConfirmed: false,
      });
    }
    if (failed) raced.push("compose");
    return run(request);
  };
  f.adapters.stopMigration = async () => {
    raced.push("daemon-stop");
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.deepEqual(raced, []);
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

test("publication failure before execution or after migration/health retains the uncertain lock", async (t) => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  for (const failWrite of [1, 10, 18]) {
    const f = await fixture(t);
    const original = fs.rename;
    let writes = 0;
    fs.rename = async (...args) => {
      if (args[1] === join(f.root, "state.json") && ++writes === failWrite)
        throw new Error("fixture-private-rename-error");
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(execute(f.input, f.adapters), (error) => {
        assert.equal(error.code, "ERR_HOST_STATE");
        assert.equal(error.durabilityUncertain, true);
        assert.doesNotMatch(error.message + error.stack, /fixture-private/u);
        return true;
      });
    } finally {
      fs.rename = original;
      syncBuiltinESMExports();
    }
    const { lstat } = await import("node:fs/promises");
    await lstat(join(f.root, ".deploy.lock"));
    if (failWrite === 1) assert.deepEqual(f.trace, []);
    if (failWrite === 10) assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
    if (failWrite === 18) assert.equal((await disk(f.root)).current.status, "entered");
    const before = f.trace.length;
    await assert.rejects(execute(f.input, f.adapters));
    assert.equal(f.trace.length, before);
  }
});

test("retargeted physical identity prevents every recovery mutation", async (t) => {
  const f = await fixture(t);
  const inspect = f.adapters.inspectTarget;
  const run = f.adapters.runProcess;
  let changed = false;
  let recoveryMutations = 0;
  f.adapters.verifyImages = async () => {
    changed = true;
    throw new Error("fixture-private-retarget");
  };
  f.adapters.inspectTarget = async (request) => {
    const value = await inspect(request);
    return changed ? { ...value, target: { ...value.target, volumeId: "foreign-volume" } } : value;
  };
  f.adapters.runProcess = async (request) => {
    if (changed) recoveryMutations++;
    return run(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(recoveryMutations, 0);
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

test("observer-changing snapshot bytes is caught before the corresponding command", async (t) => {
  const f = await fixture(t);
  const inspect = f.adapters.inspectTarget;
  f.adapters.inspectTarget = async (request) => {
    if (request.phase === "api-started") {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(f.input.configuration.runtimeSnapshot.path, "#changed-at-boundary");
    }
    return inspect(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

test("preexisting unresolved journal is rejected before even trusted observation commands", async (t) => {
  const f = await fixture(t);
  const { withHostState } = await import("../host/state.mjs");
  await withHostState(f.root, (store) => store.begin(f.identity));
  let observations = 0;
  f.adapters.inspectTarget = async () => {
    observations++;
    return {};
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(observations, 0);
  assert.deepEqual(f.trace, []);
  assert.equal((await disk(f.root)).sequence, 1);
});

test("caller mutation during an await cannot rewrite the snapshotted operation", async (t) => {
  const f = await fixture(t);
  const expected = structuredClone(f.identity);
  const release = f.adapters.verifyRelease;
  f.adapters.verifyRelease = async (request) => {
    await release(request);
    f.input.preparedTarget.fence.fenceId = "changed-input";
    f.input.preparedPolicy.maxAgeMs = 0;
    f.input.configuration.runtimeSnapshot.interpolation = {};
    f.input.dockerConfig = "/untrusted-changed-path";
  };
  assert.deepEqual(await execute(f.input, f.adapters), expected);
});

test("a failed upgrade retains prior healthy identity and never replays its binaries", async (t) => {
  const f = await fixture(t, "migrate");
  const { withHostState } = await import("../host/state.mjs");
  const { hostIdentity, backupProof } = await import("./host-fixtures.mjs");
  const previous = hostIdentity();
  await withHostState(f.root, async (store) => {
    await store.begin(previous);
    for (const phase of [
      "admitted",
      "images-verified",
      "target-stopped",
      "backup-verified",
      "migrating",
      "migrated",
      "api-started",
      "edge-started",
      "healthy",
    ]) {
      if (phase !== "admitted") await store.enter(phase);
      await store.complete(phase, ...(phase === "backup-verified" ? [backupProof(previous)] : []));
    }
  });
  const inspect = f.adapters.inspectTarget;
  f.adapters.inspectTarget = async (request) => {
    assert.deepEqual(request.previousHealthy.identity, previous);
    if (["admitted", "images-verified"].includes(request.phase))
      assert.deepEqual(request.allowedServices, ["postgres", "api", "edge"]);
    return inspect(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  const state = await disk(f.root);
  assert.deepEqual(state.previousHealthy.identity, previous);
  assert.equal(state.current.phase, "migrating");
  assert.equal(state.current.status, "recovery-required");
  assert.ok(!f.trace.some(([n]) => ["api", "edge"].includes(n)));
});

test("evidence expiring during smoke cannot publish healthy completion", async (t) => {
  const f = await fixture(t);
  const smoke = f.adapters.smoke;
  f.adapters.smoke = async (request) => {
    await smoke(request);
    const later = Date.now() + 120000;
    t.mock.method(Date, "now", () => later);
  };
  await assert.rejects(execute(f.input, f.adapters));
  const state = await disk(f.root);
  assert.equal(state.current.phase, "healthy");
  assert.equal(state.current.status, "recovery-required");
});

test("trusted AbortSignal remains outside JSON input and cleanup runs without the aborted signal", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.adapters.signal = controller.signal;
  const run = f.adapters.runProcess;
  let recovered = false;
  f.adapters.runProcess = async (request) => {
    if (request.args.includes("run")) {
      assert.equal(request.signal, controller.signal);
      controller.abort();
      throw Object.assign(new Error("fixture-private-aborted"), { terminationConfirmed: true });
    }
    if (controller.signal.aborted) {
      assert.equal(request.signal, undefined);
      recovered = true;
    }
    return run(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(recovered, true);
  assert.equal((await disk(f.root)).current.status, "recovery-required");
});

for (const adapter of ["stopMigration", "inspectMigration"]) {
  test(`unconfirmed ${adapter} termination stops the remaining recovery commands`, async (t) => {
    const f = await fixture(t, "migrate");
    const run = f.adapters.runProcess;
    const stop = f.adapters.stopMigration;
    const inspect = f.adapters.inspectMigration;
    const raced = [];
    let unconfirmed = false;
    f.adapters.runProcess = async (request) => {
      if (unconfirmed) raced.push("compose");
      return run(request);
    };
    f.adapters.stopMigration = async (request) => {
      if (unconfirmed) raced.push("stop-migration");
      if (adapter === "stopMigration") {
        unconfirmed = true;
        throw Object.assign(new Error("fixture-private-unreaped-cleanup"), {
          terminationConfirmed: false,
        });
      }
      return stop(request);
    };
    f.adapters.inspectMigration = async (request) => {
      if (unconfirmed) raced.push("inspect-migration");
      if (adapter === "inspectMigration") {
        unconfirmed = true;
        throw Object.assign(new Error("fixture-private-unreaped-inspection"), {
          terminationConfirmed: false,
        });
      }
      return inspect(request);
    };
    let failure;
    await assert.rejects(execute(f.input, f.adapters), (error) => {
      failure = error;
      return true;
    });
    assert.equal(unconfirmed, true);
    assert.deepEqual(raced, []);
    assert.equal(failure.terminationConfirmed, false);
    assert.doesNotMatch(failure.message + failure.stack, /fixture-private/u);
    assert.equal((await disk(f.root)).current.status, "recovery-required");
    assert.ok(!f.trace.some(([name]) => ["api", "edge", "smoke"].includes(name)));
  });
}
