import assert from "node:assert/strict";
import test from "node:test";
import {
  observeDatasetInitializeFailures,
  runDatasetPositiveChild,
} from "./support/dataset-command-positive-fixture.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(command, close) {
  const original = {
    command(mode) {
      assert.equal(this, original);
      return command(mode);
    },
    close() {
      assert.equal(this, original);
      return close();
    },
  };
  return original;
}
function record(line) {
  assert.ok(line.startsWith("US_DEMO_VIEWER_INITIALIZE_OBSERVATION "));
  const result = JSON.parse(line.slice("US_DEMO_VIEWER_INITIALIZE_OBSERVATION ".length));
  assert.ok(Object.values(result).every(Number.isSafeInteger));
  assert.ok(Buffer.byteLength(line) < 1024);
  return result;
}

test("retains real bounded child rejection and emits numeric evidence only after close", async () => {
  const lines = [],
    closing = deferred();
  const command = runDatasetPositiveChild(
    process.execPath,
    ["-e", "process.stderr.write('private-secret');process.exit(7)"],
    { cap: 10000 },
  );
  let calls = 0,
    closes = 0;
  const owned = fixture(
    (mode) => {
      assert.equal(mode, "initialize");
      calls++;
      return command;
    },
    () => {
      closes++;
      return closing.promise;
    },
  );
  const observed = observeDatasetInitializeFailures(owned, (line) => lines.push(line));
  assert.equal(observed.command("initialize"), command);
  let error;
  await assert.rejects(command, (value) => {
    error = value;
    return value.message === "us_dataset_positive_child_failed";
  });
  assert.equal(lines.length, 0);
  assert.equal(observed.close(), closing.promise);
  assert.equal(lines.length, 0);
  closing.resolve("closed");
  assert.equal(await closing.promise, "closed");
  await tick();
  assert.equal(lines.length, 1);
  const value = record(lines[0]);
  assert.equal(value.kind, 1);
  assert.equal(value.exitCode, 7);
  assert.equal(value.timedOut, 0);
  assert.equal(value.overflow, 0);
  assert.ok(value.elapsedMs >= 0);
  assert.ok(!lines[0].includes("private-secret"));
  assert.equal(error.evidence.code, 7);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
});

test("observes rejection once after failed disposal without changing either error or promise", async () => {
  const failure = Object.freeze(new Error("us_dataset_positive_pool_failed"));
  const disposal = new Error("private-disposal");
  const command = Promise.reject(failure),
    closing = Promise.reject(disposal);
  let attempts = 0;
  const observed = observeDatasetInitializeFailures(
    fixture(
      () => command,
      () => closing,
    ),
    (line) => {
      attempts++;
      assert.equal(record(line).kind, 2);
      throw new Error("sink");
    },
  );
  assert.equal(observed.command("initialize"), command);
  await assert.rejects(command, (error) => error === failure);
  assert.equal(observed.close(), closing);
  await assert.rejects(closing, (error) => error === disposal);
  observed.close();
  await tick();
  assert.equal(attempts, 1);
});

test("successful initialize and verify failures have no observation", async () => {
  const success = Promise.resolve({ original: true });
  const failure = Promise.reject(new Error("us_dataset_positive_child_failed"));
  const closed = Promise.resolve(17);
  const lines = [];
  const observed = observeDatasetInitializeFailures(
    fixture(
      (mode) => (mode === "initialize" ? success : failure),
      () => closed,
    ),
    (line) => lines.push(line),
  );
  assert.equal(observed.command("initialize"), success);
  assert.deepEqual(await success, { original: true });
  assert.equal(observed.command("verify"), failure);
  await assert.rejects(failure);
  assert.equal(observed.close(), closed);
  assert.equal(await closed, 17);
  await tick();
  assert.deepEqual(lines, []);
});

test("late initialize rejection after completed close cannot replay a diagnostic", async () => {
  const command = deferred(),
    closing = Promise.resolve();
  const lines = [];
  const observed = observeDatasetInitializeFailures(
    fixture(
      () => command.promise,
      () => closing,
    ),
    (line) => lines.push(line),
  );
  observed.command("initialize");
  await observed.close();
  command.reject(new Error("us_dataset_positive_pool_failed"));
  await assert.rejects(command.promise);
  await observed.close();
  await tick();
  assert.deepEqual(lines, []);
});

async function project(error) {
  const command = Promise.reject(error),
    lines = [];
  const observed = observeDatasetInitializeFailures(
    fixture(
      () => command,
      () => Promise.resolve(),
    ),
    (line) => lines.push(line),
  );
  observed.command("initialize");
  await assert.rejects(command, (value) => value === error);
  await observed.close();
  await tick();
  assert.equal(lines.length, 1);
  return { line: lines[0], value: record(lines[0]) };
}

test("projects only finite own data and never calls payload accessors or serialization hooks", async () => {
  let getters = 0;
  const failure = new Error("us_dataset_positive_child_failed");
  const evidence = {
    code: 143,
    timedOut: true,
    overflow: false,
    elapsedMs: 900188.698,
    secret: "private-secret",
  };
  Object.defineProperty(evidence, "diagnostic", {
    get() {
      getters++;
      throw new Error("private-getter");
    },
  });
  failure.evidence = evidence;
  failure.command = {
    measurement: { maximumRssKiB: 1905372 },
    provider: { reads: 47, mutations: 19, failures: 0, active: 0 },
  };
  failure.toJSON = () => {
    throw new Error("must-not-serialize");
  };
  const { value, line } = await project(Object.freeze(failure));
  assert.equal(value.kind, 1);
  assert.equal(value.exitCode, 143);
  assert.equal(value.timedOut, 1);
  assert.equal(value.elapsedMs, 900188);
  assert.equal(value.maximumRssKiB, 1905372);
  assert.equal(value.reads, 47);
  assert.equal(value.mutations, 19);
  assert.equal(value.failures, 0);
  assert.equal(value.active, 0);
  assert.equal(getters, 0);
  assert.ok(!line.includes("private"));
});

test("rejects inherited, accessor, excessive and nonfinite numeric values", async () => {
  const failure = Object.assign(new Error("us_dataset_positive_child_failed"), {
    evidence: Object.assign(Object.create({ code: 7 }), {
      timedOut: "true",
      overflow: 1,
      elapsedMs: Infinity,
    }),
    command: {
      measurement: { maximumRssKiB: 33554433 },
      provider: { reads: 1000001, mutations: -1, failures: 1.5, active: NaN },
    },
  });
  const { value } = await project(failure);
  for (const key of [
    "exitCode",
    "timedOut",
    "overflow",
    "elapsedMs",
    "maximumRssKiB",
    "reads",
    "mutations",
    "failures",
    "active",
  ])
    assert.equal(value[key], -1);
});

for (const [witness, expected] of [
  ["await_send:code:ECONNRESET", 1],
  ["await_send:code:ECONNRESET:new-before-response", 2],
  ["await_send:code:ECONNRESET:reused-before-response", 3],
  ["await_send:code:ECONNRESET:new-after-response", 4],
  ["await_send:code:ECONNRESET:reused-after-response", 5],
])
  test(`finite transport projection ${expected} requires the complete existing diagnostic conjunction`, async () => {
    const diagnostic = {
      code: "us_dataset_command_failed",
      unitKey: "request_september",
      stage: "package",
      verificationOperation: "read_private_object",
      verificationArtifact: "manifest.json",
      verificationStorageCode: "us_request_package_storage_transport_failed",
      verificationTransportWitness: witness,
    };
    const error = () =>
      Object.assign(new Error("us_dataset_positive_child_failed"), { evidence: { diagnostic } });
    const { value } = await project(error());
    assert.equal(value.failed, 1);
    assert.equal(value.unit, 3);
    assert.equal(value.packageStage, 1);
    assert.equal(value.operation, 1);
    assert.equal(value.artifact, 1);
    assert.equal(value.storage, 5);
    assert.equal(value.transport, expected);
    for (const key of [
      "code",
      "unitKey",
      "stage",
      "verificationOperation",
      "verificationStorageCode",
    ]) {
      const saved = diagnostic[key];
      diagnostic[key] = "private-secret";
      assert.equal((await project(error())).value.transport, 0);
      diagnostic[key] = saved;
    }
  });

test("hostile descriptor traps cannot replace rejection or leak arbitrary error properties", async () => {
  const hostile = new Proxy(new Error("private-secret"), {
    getOwnPropertyDescriptor() {
      throw new Error("private-trap");
    },
  });
  const { line, value } = await project(hostile);
  assert.deepEqual(value, { kind: 0 });
  assert.ok(!line.includes("private"));
});
