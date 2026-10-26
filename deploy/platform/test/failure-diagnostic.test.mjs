import assert from "node:assert/strict";
import { readFile, lstat, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { privateFixture } from "./host-fixtures.mjs";
import { runHostProcess } from "../host/process.mjs";
import { observationError } from "../host/observe.mjs";
import {
  noteHostProcessFailure,
  sanitizeHostFailure,
  writeHostFailure,
} from "../host/failure-diagnostic.mjs";
const context = {
  operationId: "b793db93-0e6b-4b1c-bb5e-5afc3a16230a",
  phase: "api-started",
  boundary: "command",
  commandCategory: "api-up",
};
const secret = "DO-NOT-PERSIST-PRIVATE-SENTINEL";
test("child origin survives observation wrapper without retaining process output", async (t) => {
  const f = await privateFixture(t);
  let error;
  try {
    await runHostProcess({
      executable: process.execPath,
      args: [
        "-e",
        `process.stdout.write('${secret}');process.stderr.write('${secret}');process.exit(23)`,
      ],
      cwd: f.root,
      env: { PRIVATE: secret },
      timeoutMs: 5000,
      outputLimitBytes: 4096,
    });
  } catch (e) {
    error = observationError(e);
  }
  assert.ok(error);
  const record = sanitizeHostFailure(error, context);
  assert.equal(record.code, "ERR_HOST_PROCESS");
  assert.equal(record.errorName, "Error");
  assert.equal(record.exitStatus, 23);
  assert.equal(record.executable, "node");
  assert.equal(record.terminationConfirmed, true);
  assert.ok(Object.isFrozen(record));
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "version",
      "kind",
      ...Object.keys(context),
      "code",
      "errorName",
      "exitStatus",
      "executable",
      "terminationConfirmed",
      "durabilityUncertain",
    ].sort(),
  );
});
test("hostile error properties are never evaluated and unknown values are discarded", () => {
  let reads = 0;
  const error = {};
  for (const key of [
    "message",
    "stack",
    "cause",
    "code",
    "name",
    "exitStatus",
    "executable",
    "terminationConfirmed",
    "durabilityUncertain",
  ])
    Object.defineProperty(error, key, {
      get() {
        reads++;
        throw new Error(secret);
      },
    });
  const record = sanitizeHostFailure(observationError(error), context);
  assert.equal(reads, 0);
  assert.equal(record.code, "ERR_HOST_FAILURE");
  assert.equal(record.errorName, "Error");
  assert.equal(record.exitStatus, null);
  assert.equal(record.executable, null);
  assert.equal(record.terminationConfirmed, false);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  assert.throws(() => sanitizeHostFailure(error, { ...context, boundary: secret }));
});
test("private diagnostic is exclusive and cannot overwrite first failure", async (t) => {
  const f = await privateFixture(t);
  const error = Object.assign(new TypeError(secret), {
    code: "ERR_HOST_OBSERVATION",
    terminationConfirmed: true,
  });
  const record = sanitizeHostFailure(error, context);
  assert.equal(record.errorName, "TypeError");
  await writeHostFailure(f.root, record);
  const bytes = await readFile(join(f.root, "failure.json"));
  assert.ok(bytes.length <= 4096);
  assert.deepEqual(JSON.parse(bytes), record);
  assert.equal((await lstat(join(f.root, "failure.json"))).mode & 0o777, 0o600);
  await assert.rejects(writeHostFailure(f.root, record));
  assert.deepEqual(await readFile(join(f.root, "failure.json")), bytes);
  await assert.rejects(writeHostFailure(f.root, { ...record, extra: secret }));
});
test("symlink and nonprivate directories fail closed", async (t) => {
  const f = await privateFixture(t);
  const record = sanitizeHostFailure(new Error(secret), context);
  await symlink(f.root, join(f.root, "alias"));
  await assert.rejects(writeHostFailure(join(f.root, "alias"), record));
  await chmod(f.root, 0o755);
  await assert.rejects(writeHostFailure(f.root, record));
  await chmod(f.root, 0o700);
});

test("diagnostic rejects a root owned by a different effective operator", async (t) => {
  const f = await privateFixture(t);
  const record = sanitizeHostFailure(new Error(), context);
  const actual = process.getuid();
  const mock = t.mock.method(process, "getuid", () => actual + 1);
  try {
    await assert.rejects(writeHostFailure(f.root, record));
  } finally {
    mock.mock.restore();
  }
});

test("fixed Python ZIP verifier origin records only basename and numeric status", () => {
  const error = Object.assign(new Error(secret), {
    code: "ERR_HOST_PROCESS",
    stdout: secret,
    stderr: secret,
    argv: [secret],
    terminationConfirmed: true,
  });
  noteHostProcessFailure(error, "/usr/bin/python3", 7);
  const record = sanitizeHostFailure(error, {
    ...context,
    boundary: "verifyRelease",
    commandCategory: "validation",
  });
  assert.equal(record.executable, "python3");
  assert.equal(record.exitStatus, 7);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret, "u"));
});

test("only constructor-captured validation sites survive wrappers without private stack text", async (t) => {
  const { preparedFixture } = await import("./prepared-target-fixture.mjs");
  const { validatePreparedTarget } = await import("../host/prepared-target.mjs");
  const { hostFailureSites, carryHostFailure } = await import("../host/failure-diagnostic.mjs");
  const f = await preparedFixture(t, { nested: true });
  f.record.observations.keyContinuity.value.decryptionVerified = false;
  let first;
  await assert.rejects(validatePreparedTarget(f.record, f.expected), (error) => {
    first = error;
    return error.code === "ERR_DATABASE_BACKUP";
  });
  first.stack = secret;
  const wrapped = carryHostFailure(first, new Error(secret));
  const sites = hostFailureSites(carryHostFailure(wrapped, new Error(secret)));
  assert.ok(sites.some((site) => site.module === "host/prepared-target.mjs"));
  assert.ok(sites.length > 0 && sites.length <= 3);
  for (const site of sites) {
    assert.deepEqual(Object.keys(site), ["module", "line"]);
    assert.ok(Number.isInteger(site.line) && site.line > 0 && site.line <= 10000);
    assert.equal(Object.isFrozen(site), true);
  }
  assert.equal(Object.isFrozen(sites), true);
  assert.equal(JSON.stringify(sites).includes(secret), false);
  assert.equal(JSON.stringify(sites).includes(f.root), false);
  assert.equal(Object.hasOwn(sanitizeHostFailure(wrapped, context), "sites"), false);
  const forged = Object.assign(new Error(secret), { code: "ERR_DATABASE_BACKUP" });
  Object.defineProperty(forged, "stack", {
    get() {
      throw new Error(secret);
    },
  });
  assert.deepEqual(hostFailureSites(forged), []);
  assert.deepEqual(hostFailureSites(carryHostFailure(forged, new Error(secret))), []);
});
