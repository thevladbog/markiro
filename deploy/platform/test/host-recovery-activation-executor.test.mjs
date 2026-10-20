import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { productionFixture } from "./production-activation-fixture.mjs";
import { activationHash } from "../host/recovery-activation-admission.mjs";
import { hostIdentity, backupProof } from "./host-fixtures.mjs";
import { withRecoveryState } from "../host/recovery-state.mjs";

async function execute(input, adapters) {
  const module = await import("../host/recovery-activation.mjs").catch(() => ({}));
  assert.equal(typeof module.executeRecoveryActivation, "function", "coordinator must be exported");
  return module.executeRecoveryActivation(input, adapters);
}
const disk = async (root) => JSON.parse(await readFile(join(root, "recovery-state.json"), "utf8"));
async function fixture(t, failAt) {
  const f = await productionFixture(t);
  const prior = {
    ...hostIdentity(),
    configurationSha256: f.identity.configurationSha256,
    admission: f.identity.admission,
  };
  const original = Buffer.from(
    JSON.stringify({
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    }) + "\n",
  );
  await writeFile(join(f.root, "state.json"), original, { mode: 0o600 });
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity: f.identity,
    predecessor: { identity: prior, sequence: 14, stateSha256: activationHash(original) },
    executorCi: { runId: "123456789", runAttempt: "1" },
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const proof = {
    operationId: f.identity.operationId,
    target: f.identity.target,
    archiveSha256: f.backup.archiveSha256,
    restoreEvidenceSha256: f.restoreEvidence.evidenceSha256,
  };
  await withRecoveryState(f.root, admission, async (store) => {
    await store.complete("admitted");
    await store.enter("target-stopped");
    await store.complete("target-stopped");
    await store.enter("backup-verified");
    await store.complete("backup-verified", proof);
  });
  const preparation = await readFile(join(f.root, "recovery-state.json"));
  const { writerFence, workload, root, identity, configuration, ...preparedPolicy } = f.expected;
  const activation = {
    version: 1,
    kind: "platform-recovery-activation",
    admission,
    preparation: { sequence: 6, sha256: activationHash(preparation) },
    preparedTarget: f.record,
    preparedPolicy,
    configuration,
    dispatch: { toolingSha: "a".repeat(40), runId: "123456789", runAttempt: "1" },
  };
  const input = { root, dockerConfig: f.dockerConfig, activation };
  const trace = [];
  const action = async (name) => {
    const state = await disk(root);
    assert.ok(["entered", "recovery-required"].includes(state.status));
    trace.push([name, state.phase, state.status]);
    if (name === failAt) throw new Error("private-command-output");
  };
  const adapters = {
    writerFence,
    workload,
    verifyRelease: () => action("release"),
    verifyImages: () => action("images"),
    smoke: () => action("smoke"),
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
    runProcess: async (request) => {
      assert.equal(request.executable, "/usr/bin/docker");
      assert.deepEqual(request.args.slice(0, 5), [
        "--host",
        "unix:///var/run/docker.sock",
        "compose",
        "--project-name",
        "markiro-platform",
      ]);
      assert.equal(request.env.DATABASE_URL, undefined);
      assert.equal(request.env.COMPOSE_DISABLE_ENV_FILE, "1");
      const command = request.args.slice(9);
      assert.notEqual(command[0], "run", "migration must never run");
      await action(
        command[0] === "pull" ? "pull" : command[0] === "stop" ? "stop" : command.at(-1),
      );
    },
  };
  return { ...f, input, activation, original, preparation, adapters, trace };
}

test("recovery uses real prepared validator and mock commands in durable order preserving original bytes", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await execute(f.input, f.adapters), f.identity);
  assert.deepEqual(f.trace, [
    ["release", "activation-admitted", "entered"],
    ["pull", "images-verified", "entered"],
    ["images", "images-verified", "entered"],
    ["api", "api-started", "entered"],
    ["edge", "edge-started", "entered"],
    ["smoke", "healthy", "entered"],
  ]);
  assert.equal((await disk(f.root)).status, "completed");
  assert.deepEqual(await readFile(join(f.root, "state.json")), f.original);
  assert.deepEqual(await readFile(join(f.root, "recovery-preparation.json")), f.preparation);
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(f.trace.length, 6);
});
for (const failAt of ["api", "edge", "smoke"])
  test(`ordinary ${failAt} failure publishes terminal intent before owned mock cleanup`, async (t) => {
    const f = await fixture(t, failAt);
    await assert.rejects(execute(f.input, f.adapters));
    assert.equal((await disk(f.root)).status, "recovery-required");
    assert.equal(f.trace.at(-1)[0], "stop");
    assert.equal(f.trace.at(-1)[2], "recovery-required");
  });
for (const mutation of ["v1", "synthetic", "archive", "expired", "identity"])
  test(`reject ${mutation} evidence before mock commands`, async (t) => {
    const f = await fixture(t);
    if (mutation === "v1") f.record.version = 1;
    if (mutation === "synthetic") f.activation.preparedPolicy.provenance = "local-synthetic";
    if (mutation === "archive") await writeFile(f.backup.archivePath, "changed");
    if (mutation === "expired")
      f.activation.admission.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mutation === "identity") f.record.operationId = hostIdentity().operationId;
    await assert.rejects(execute(f.input, f.adapters));
    assert.deepEqual(f.trace, []);
  });

test("unreaped mock command retains shared lock and never starts competing cleanup", async (t) => {
  const f = await fixture(t);
  f.adapters.runProcess = async () => {
    throw Object.assign(new Error("private-unreaped"), { terminationConfirmed: false });
  };
  await assert.rejects(execute(f.input, f.adapters), (error) => {
    assert.equal(error.code, "ERR_HOST_RECOVERY_ACTIVATION");
    assert.equal(error.phase, "images-verified");
    assert.equal(error.recoveryRequired, true);
    assert.equal(error.durabilityUncertain, true);
    assert.equal(error.terminationConfirmed, false);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /private-unreaped/u);
    return true;
  });
  assert.equal((await disk(f.root)).phase, "images-verified");
  assert.equal((await disk(f.root)).status, "entered");
  assert.deepEqual(
    f.trace.map((row) => row[0]),
    ["release"],
  );
  assert.ok(await readFile(join(f.root, ".deploy.lock")).catch(() => null));
});

test("release observer changing archive is rejected before pull", async (t) => {
  const f = await fixture(t);
  f.adapters.verifyRelease = async () => {
    await writeFile(f.backup.archivePath, "changed");
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(
    f.trace.some((row) => row[0] === "pull"),
    false,
  );
});

test("foreign writer before API prevents authorized app command", async (t) => {
  const f = await fixture(t);
  const observe = f.adapters.writerFence.observe;
  f.adapters.writerFence.observe = async (request) => {
    if (request.phase === "api-started") throw new Error("foreign-writer");
    return observe(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal(
    f.trace.some((row) => row[0] === "api"),
    false,
  );
});

for (const crossed of ["admission", "source-hold"])
  test(`${crossed} expiry crossed inside async observer terminalizes before bounded stop`, async (t) => {
    const f = await fixture(t),
      start = Date.now();
    let current = start;
    t.mock.method(Date, "now", () => current);
    const inspect = f.adapters.workload.inspect;
    f.adapters.workload.inspect = async (request) => ({
      ...(await inspect(request)),
      observedAt: new Date(current).toISOString(),
    });
    const observe = f.adapters.writerFence.observe;
    f.adapters.writerFence.observe = async (request) => {
      const result = { ...(await observe(request)), observedAt: new Date(current).toISOString() };
      if (request.phase === "api-started")
        current =
          crossed === "admission"
            ? Date.parse(f.activation.admission.expiresAt) + 1
            : Date.parse(f.record.observations.egress.value.sourceHold.expiresAt) + 1;
      return result;
    };
    await assert.rejects(execute(f.input, f.adapters));
    assert.equal((await disk(f.root)).status, "recovery-required");
    assert.equal(
      f.trace.some((row) => row[0] === "api"),
      false,
    );
    assert.deepEqual(f.trace.at(-1), ["stop", "images-verified", "recovery-required"]);
  });

for (const changed of [
  "configuration",
  "ownership",
  "images",
  "release",
  "archive-proof",
  "old-proof",
])
  test(`changed ${changed} rejects protected command`, async (t) => {
    const f = await fixture(t);
    if (changed === "configuration")
      await writeFile(f.expected.configuration.runtimeSnapshot.path, "changed");
    if (changed === "ownership")
      f.adapters.inspectTarget = async () => ({
        target: hostIdentity().target,
        project: "foreign",
        serverProfile: "platform-only",
        uiProfile: "platform-only",
        os: "linux",
        architecture: "amd64",
      });
    if (changed === "images")
      f.adapters.verifyImages = async () => {
        throw new Error("private-images");
      };
    if (changed === "release")
      f.adapters.verifyRelease = async () => {
        throw new Error("private-release");
      };
    if (changed === "archive-proof")
      f.record.observations.restoredSnapshot.value.archiveSha256 = "0".repeat(64);
    if (changed === "old-proof")
      f.record.observations.offHostRecovery.observedAt = new Date(
        Date.now() - 86400000,
      ).toISOString();
    await assert.rejects(execute(f.input, f.adapters));
    assert.equal(
      f.trace.some((row) => row[0] === "api"),
      false,
    );
    if (changed !== "images")
      assert.equal(
        f.trace.some((row) => row[0] === "pull"),
        false,
      );
  });

test("configuration changed by final stopped observer prevents release", async (t) => {
  const f = await fixture(t);
  f.adapters.inspectStoppedWorkloads = async () => {
    await writeFile(f.expected.configuration.runtimeSnapshot.path, "changed");
    return { target: f.identity.target, project: "markiro-platform", active: [] };
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.deepEqual(f.trace, []);
});

test("tampered consumption during API failure never starts cleanup and retains lock", async (t) => {
  const f = await fixture(t);
  const run = f.adapters.runProcess;
  f.adapters.runProcess = async (request) => {
    if (request.args.at(-1) === "api") {
      await writeFile(
        join(f.root, `recovery-activation-${f.identity.operationId}.json`),
        "changed",
      );
      throw new Error("private-api");
    }
    return run(request);
  };
  await assert.rejects(execute(f.input, f.adapters), { durabilityUncertain: true });
  assert.equal(
    f.trace.some((row) => row[0] === "stop"),
    false,
  );
  await readFile(join(f.root, ".deploy.lock"));
});

test("ordinary deployment bundle includes shared validation authority", async () => {
  const { HOST_BUNDLE_FILES } = await import("../host/command.mjs");
  assert.ok(HOST_BUNDLE_FILES.includes("deploy/platform/host/deployment-boundary.mjs"));
});

test("changed protected runtime during API failure cannot feed cleanup command", async (t) => {
  const f = await fixture(t);
  const run = f.adapters.runProcess;
  const attempts = [];
  f.adapters.runProcess = async (request) => {
    attempts.push(request.args.slice(9));
    if (request.args.at(-1) === "api") {
      await writeFile(f.expected.configuration.runtimeSnapshot.path, "changed");
      throw new Error("private-api");
    }
    return run(request);
  };
  await assert.rejects(execute(f.input, f.adapters));
  assert.equal((await disk(f.root)).status, "recovery-required");
  assert.equal(
    attempts.some((args) => args[0] === "stop"),
    false,
  );
});

test("uncertain terminal sidecar publication never starts cleanup", async (t) => {
  const f = await fixture(t, "api");
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.rename;
  fs.rename = async (...args) => {
    if (args[1] === join(f.root, "recovery-state.json")) {
      const pending = JSON.parse(await readFile(args[0], "utf8"));
      if (pending.status === "recovery-required") throw new Error("private-rename-failure");
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(execute(f.input, f.adapters), { durabilityUncertain: true });
    assert.equal(
      f.trace.some((row) => row[0] === "stop"),
      false,
    );
    await readFile(join(f.root, ".deploy.lock"));
    assert.equal((await disk(f.root)).status, "entered");
  } finally {
    fs.rename = original;
    syncBuiltinESMExports();
  }
});

test("stopped own workload gate rejects foreign active workloads before release", async (t) => {
  const f = await fixture(t);
  f.adapters.inspectStoppedWorkloads = async () => ({
    target: f.identity.target,
    project: "markiro-platform",
    active: ["foreign-worker"],
  });
  await assert.rejects(execute(f.input, f.adapters));
  assert.deepEqual(f.trace, []);
});

test("phase-aware writer fence receives new recovery identity and only authorized services", async (t) => {
  const f = await fixture(t),
    observe = f.adapters.writerFence.observe;
  const seen = new Set();
  f.adapters.writerFence.observe = async (request) => {
    assert.equal(request.identity.operationId, f.identity.operationId);
    assert.notEqual(
      request.identity.operationId,
      f.activation.admission.predecessor.identity.operationId,
    );
    const allowed = ["postgres"];
    if (
      ["edge-started", "healthy"].includes(request.phase) ||
      (request.phase === "api-started" && request.transitionBoundary !== "entry")
    )
      allowed.push("api");
    if (
      request.phase === "healthy" ||
      (request.phase === "edge-started" && request.transitionBoundary !== "entry")
    )
      allowed.push("edge");
    assert.deepEqual(request.allowedServices, allowed);
    seen.add(request.phase);
    return observe(request);
  };
  await execute(f.input, f.adapters);
  assert.deepEqual(
    [...seen],
    ["activation-admitted", "images-verified", "api-started", "edge-started", "healthy"],
  );
});

for (const acceptance of ["TLS", "evidence-age"])
  test(`${acceptance} expiry inside final stopped observer rejects pull with activation still valid`, async (t) => {
    const f = await fixture(t),
      start = Date.now();
    let current = start,
      stopped = 0;
    t.mock.method(Date, "now", () => current);
    if (acceptance === "TLS")
      f.record.observations.tls.value.expiresAt = new Date(start + 1000).toISOString();
    const inspect = f.adapters.workload.inspect;
    f.adapters.workload.inspect = async (request) => ({
      ...(await inspect(request)),
      observedAt: new Date(current).toISOString(),
    });
    const observe = f.adapters.writerFence.observe;
    f.adapters.writerFence.observe = async (request) => ({
      ...(await observe(request)),
      observedAt: new Date(current).toISOString(),
    });
    f.adapters.inspectStoppedWorkloads = async (request) => {
      if (request.phase === "images-verified" && ++stopped === 2)
        current = start + (acceptance === "TLS" ? 2000 : 61000);
      return { target: f.identity.target, project: "markiro-platform", active: [] };
    };
    await assert.rejects(execute(f.input, f.adapters));
    assert.ok(Date.parse(f.activation.admission.expiresAt) > current);
    assert.ok(Date.parse(f.record.observations.egress.value.sourceHold.expiresAt) > current);
    assert.equal(
      f.trace.some((row) => row[0] === "pull"),
      false,
    );
    assert.equal((await disk(f.root)).status, "recovery-required");
  });
