import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  latestHealthyVbtechRelease,
  markVbtechReleaseFailed,
  markVbtechReleaseHealthy,
  validateVbtechSelector,
  writePendingVbtechRelease,
} from "../vbtech-release-state.mjs";

const repository = "ghcr.io/thevladbog/vbtech-web";
const firstSha = "a".repeat(40);
const firstDigest = `sha256:${"b".repeat(64)}`;

function selector({ releaseSha = firstSha, imageDigest = firstDigest, ...overrides } = {}) {
  return {
    imageRef: `${repository}@${imageDigest}`,
    imageDigest,
    releaseSha,
    functionPath: "",
    submissionState: "disabled",
    ...overrides,
  };
}

function record({
  releaseSha = firstSha,
  imageDigest = firstDigest,
  createdAt = "2026-08-21T10:20:30.000Z",
  state = "pending",
  ...overrides
} = {}) {
  return {
    releaseSha,
    imageRef: `${repository}@${imageDigest}`,
    imageDigest,
    submissionState: "disabled",
    createdAt,
    state,
    ...overrides,
  };
}

function fileName(value) {
  return `${value.createdAt.replace(/[:.]/g, "-")}-${value.releaseSha}-${value.imageDigest.slice(7)}.${value.state}.json`;
}

function dependencies(createdAt = "2026-08-21T10:20:30.000Z") {
  return {
    now: () => new Date(createdAt),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  };
}

async function directory() {
  return join(await mkdtemp(join(tmpdir(), "vbtech-release-state-test-")), "releases");
}

async function writeRecord(path, value, file = fileName(value)) {
  await writeFile(join(path, file), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function assertStateRejected(action) {
  await assert.rejects(action, (error) => {
    assert.equal(error.message, "v-b release state is invalid");
    assert.doesNotMatch(error.message, /private|secret|sha256|ghcr/i);
    return true;
  });
}

test("accepts an exact disabled digest selector", () => {
  assert.doesNotThrow(() => validateVbtechSelector(selector()));
});

for (const [name, value] of [
  ["an additional key", selector({ extra: "not allowed" })],
  ["an uppercase source SHA", selector({ releaseSha: "A".repeat(40) })],
  ["an uppercase image digest", selector({ imageDigest: `sha256:${"B".repeat(64)}` })],
  ["a mutable image tag", selector({ imageRef: `${repository}:latest`, imageDigest: firstDigest })],
  [
    "a foreign image repository",
    selector({ imageRef: `ghcr.io/example/vbtech-web@${firstDigest}` }),
  ],
  [
    "a mismatched image digest",
    selector({
      imageRef: `${repository}@${firstDigest}`,
      imageDigest: `sha256:${"c".repeat(64)}`,
    }),
  ],
  ["enabled submission", selector({ submissionState: "enabled", functionPath: "/function" })],
  ["a non-empty disabled function path", selector({ functionPath: "/function" })],
]) {
  test(`rejects ${name} without disclosing its value`, () => {
    assert.throws(
      () => validateVbtechSelector(value),
      (error) =>
        error.message === "v-b release selector is invalid" &&
        !error.message.includes(value.imageRef) &&
        !error.message.includes(value.releaseSha),
    );
  });
}

test("writes pending and healthy records with private modes and immutable filenames", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const healthy = await markVbtechReleaseHealthy(releases, pending, dependencies());

  assert.deepEqual(pending, record());
  assert.deepEqual(healthy, record({ state: "healthy" }));
  assert.equal((await stat(releases)).mode & 0o777, 0o700);

  const files = await readdir(releases);
  assert.deepEqual(files.sort(), [fileName(pending), fileName(healthy)].sort());
  for (const file of files) assert.equal((await stat(join(releases, file))).mode & 0o777, 0o600);
  assert.equal(
    files.some((file) => file.includes("00000000-0000-4000-8000-000000000000")),
    false,
  );
});

test("selects the newest effective healthy record deterministically", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:30.000Z"),
  );
  await markVbtechReleaseHealthy(releases, first, dependencies());
  const secondSelector = selector({
    releaseSha: "c".repeat(40),
    imageDigest: `sha256:${"d".repeat(64)}`,
  });
  const second = await writePendingVbtechRelease(
    releases,
    secondSelector,
    dependencies("2026-08-21T10:20:31.000Z"),
  );
  const healthy = await markVbtechReleaseHealthy(releases, second, dependencies());

  assert.deepEqual(await latestHealthyVbtechRelease(releases), healthy);
});

test("excludes a failed terminal candidate from active selection", async () => {
  const releases = await directory();
  const healthyPending = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:30.000Z"),
  );
  const healthy = await markVbtechReleaseHealthy(releases, healthyPending, dependencies());
  const failedPending = await writePendingVbtechRelease(
    releases,
    selector({ releaseSha: "c".repeat(40), imageDigest: `sha256:${"d".repeat(64)}` }),
    dependencies("2026-08-21T10:20:31.000Z"),
  );
  await markVbtechReleaseFailed(releases, failedPending, dependencies());

  assert.deepEqual(await latestHealthyVbtechRelease(releases), healthy);
});

test("rejects a repeated effective healthy SHA and digest before creating a pending record", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  await markVbtechReleaseHealthy(releases, pending, dependencies());

  await assert.rejects(
    writePendingVbtechRelease(releases, selector(), dependencies("2026-08-21T10:20:31.000Z")),
    (error) => error.message === "v-b release transition rejected",
  );
});

test("fails closed for every malformed or oversized JSON state input", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  await markVbtechReleaseHealthy(releases, pending, dependencies());
  await writeFile(join(releases, "malformed.json"), "{private value", { mode: 0o600 });

  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
  await writeFile(join(releases, "malformed.json"), "x".repeat(16 * 1024 + 1), { mode: 0o600 });
  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("fails closed for invalid record dates, filenames, modes, and unreadable records", async () => {
  const invalidDateDirectory = await directory();
  await mkdir(invalidDateDirectory, { mode: 0o700 });
  const invalidDate = record({ createdAt: "2026-08-21 10:20:30Z" });
  await writeRecord(invalidDateDirectory, invalidDate);
  await assertStateRejected(() => latestHealthyVbtechRelease(invalidDateDirectory));

  const mismatchedNameDirectory = await directory();
  await mkdir(mismatchedNameDirectory, { mode: 0o700 });
  await writeRecord(mismatchedNameDirectory, record(), "other.json");
  await assertStateRejected(() => latestHealthyVbtechRelease(mismatchedNameDirectory));

  const permissiveModeDirectory = await directory();
  const pending = await writePendingVbtechRelease(
    permissiveModeDirectory,
    selector(),
    dependencies(),
  );
  await chmod(join(permissiveModeDirectory, fileName(pending)), 0o644);
  await assertStateRejected(() => latestHealthyVbtechRelease(permissiveModeDirectory));

  const unreadableDirectory = await directory();
  const unreadable = await writePendingVbtechRelease(
    unreadableDirectory,
    selector(),
    dependencies(),
  );
  await chmod(join(unreadableDirectory, fileName(unreadable)), 0o000);
  await assertStateRejected(() => latestHealthyVbtechRelease(unreadableDirectory));
});

test("fails closed when an authoritative JSON record is a symbolic link", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const healthy = record({ state: "healthy" });
  const externalDirectory = await mkdtemp(join(tmpdir(), "vbtech-release-state-external-"));
  const externalRecord = join(externalDirectory, "record.json");
  await writeFile(externalRecord, `${JSON.stringify(healthy)}\n`, { mode: 0o600 });
  await symlink(externalRecord, join(releases, fileName(healthy)));

  assert.deepEqual(pending, record());
  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("fails closed for ambiguous newest healthy records", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(releases, selector(), dependencies());
  await markVbtechReleaseHealthy(releases, first, dependencies());
  const second = await writePendingVbtechRelease(
    releases,
    selector({ releaseSha: "c".repeat(40), imageDigest: `sha256:${"d".repeat(64)}` }),
    dependencies(),
  );
  await markVbtechReleaseHealthy(releases, second, dependencies());

  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("rejects duplicate terminal transitions", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  await markVbtechReleaseHealthy(releases, pending, dependencies());

  await assert.rejects(
    markVbtechReleaseFailed(releases, pending, dependencies()),
    (error) => error.message === "v-b release transition rejected",
  );
});

test("returns undefined when the private state directory is absent", async () => {
  assert.equal(await latestHealthyVbtechRelease(await directory()), undefined);
});
