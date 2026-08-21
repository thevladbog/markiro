import assert from "node:assert/strict";
import {
  readFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  latestHealthyVbtechRelease,
  markVbtechReleaseFailed,
  markVbtechReleaseHealthy,
  validateVbtechSelector,
  vbtechReleaseStatus,
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

function claimFileName(kind, generation, releaseSha = firstSha, imageDigest = firstDigest) {
  return `.vbtech-release-state.${releaseSha}-${imageDigest.slice(7)}.${kind}-${generation}.claim`;
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
  assert.deepEqual(
    files.filter((file) => file.endsWith(".json")).sort(),
    [fileName(pending), fileName(healthy)].sort(),
  );
  assert.equal(files.filter((file) => file.endsWith(".claim")).length, 2);
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

test("reports the authoritative pending, healthy, and failed lifecycle status", async () => {
  const absentDirectory = await directory();
  assert.deepEqual(await vbtechReleaseStatus(absentDirectory, selector()), {
    state: "absent",
    record: null,
    persisted: false,
  });

  const healthyDirectory = await directory();
  const pending = await writePendingVbtechRelease(healthyDirectory, selector(), dependencies());
  assert.deepEqual(await vbtechReleaseStatus(healthyDirectory, selector()), {
    state: "pending",
    record: pending,
    persisted: true,
  });
  const healthy = await markVbtechReleaseHealthy(healthyDirectory, pending, dependencies());
  assert.deepEqual(await vbtechReleaseStatus(healthyDirectory, selector()), {
    state: "healthy",
    record: healthy,
    persisted: true,
  });

  const failedDirectory = await directory();
  const failedPending = await writePendingVbtechRelease(
    failedDirectory,
    selector(),
    dependencies(),
  );
  const failed = await markVbtechReleaseFailed(failedDirectory, failedPending, dependencies());
  assert.deepEqual(await vbtechReleaseStatus(failedDirectory, selector()), {
    state: "failed",
    record: failed,
    persisted: true,
  });
});

test("reports a durable terminal claim that still needs record recovery", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const expected = record({ state: "healthy" });
  await assert.rejects(
    markVbtechReleaseHealthy(releases, pending, {
      randomUUID: () => {
        throw new Error("simulated crash after terminal claim");
      },
    }),
    (error) => error.message === "v-b release transition rejected",
  );

  assert.deepEqual(await vbtechReleaseStatus(releases, selector()), {
    state: "healthy",
    record: expected,
    persisted: false,
  });
});

test("reports a durable pending claim that requires fail-closed recovery", async () => {
  const releases = await directory();
  const expected = record({ state: "pending" });
  await assert.rejects(
    writePendingVbtechRelease(releases, selector(), {
      now: () => new Date("2026-08-21T10:20:30.000Z"),
      randomUUID: () => {
        throw new Error("simulated crash after pending claim");
      },
    }),
    (error) => error.message === "v-b release transition rejected",
  );

  assert.deepEqual(await vbtechReleaseStatus(releases, selector()), {
    state: "pending",
    record: expected,
    persisted: false,
  });
});

test("permits a new pending generation after a failed terminal", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:30.000Z"),
  );
  await markVbtechReleaseFailed(releases, first, dependencies("2026-08-21T10:20:30.000Z"));
  const retry = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:31.000Z"),
  );

  assert.deepEqual(retry, record({ createdAt: "2026-08-21T10:20:31.000Z" }));
  assert.equal(
    (await readdir(releases)).includes(
      `.vbtech-release-state.${firstSha}-${firstDigest.slice(7)}.pending-2.claim`,
    ),
    true,
  );
});

test("rejects a release chain with a fully deleted middle generation", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:30.000Z"),
  );
  await markVbtechReleaseFailed(releases, first, dependencies());
  const second = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:31.000Z"),
  );
  const secondFailed = await markVbtechReleaseFailed(releases, second, dependencies());
  await writePendingVbtechRelease(releases, selector(), dependencies("2026-08-21T10:20:32.000Z"));

  for (const file of [
    fileName(second),
    fileName(secondFailed),
    claimFileName("pending", 2),
    claimFileName("terminal", 2),
  ])
    unlinkSync(join(releases, file));

  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("rejects a forged first claim generation", async () => {
  const releases = await directory();
  await writePendingVbtechRelease(releases, selector(), dependencies());
  const originalPath = join(releases, claimFileName("pending", 1));
  const claim = JSON.parse(await readFile(originalPath, "utf8"));
  unlinkSync(originalPath);
  await writeFile(
    join(releases, claimFileName("pending", 7)),
    `${JSON.stringify({ ...claim, generation: 7 })}\n`,
    { mode: 0o600 },
  );

  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("rejects a later generation after a non-failed terminal", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(releases, selector(), dependencies());
  const healthy = await markVbtechReleaseHealthy(releases, first, dependencies());
  const forgedPending = record({ createdAt: "2026-08-21T10:20:31.000Z" });
  await writeRecord(releases, forgedPending);
  await writeFile(
    join(releases, claimFileName("pending", 2)),
    `${JSON.stringify({ kind: "pending", generation: 2, record: forgedPending })}\n`,
    { mode: 0o600 },
  );

  assert.deepEqual(healthy, record({ state: "healthy" }));
  await assertStateRejected(() => latestHealthyVbtechRelease(releases));
});

test("rejects a forged generation gap before the raw failed-count claim can collide", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:30.000Z"),
  );
  await markVbtechReleaseFailed(releases, first, dependencies());
  const second = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:31.000Z"),
  );
  await markVbtechReleaseFailed(releases, second, dependencies());

  for (const kind of ["pending", "terminal"]) {
    const originalPath = join(releases, claimFileName(kind, 2));
    const claim = JSON.parse(await readFile(originalPath, "utf8"));
    unlinkSync(originalPath);
    await writeFile(
      join(releases, claimFileName(kind, 3)),
      `${JSON.stringify({ ...claim, generation: 3 })}\n`,
      { mode: 0o600 },
    );
  }
  const filesBefore = (await readdir(releases)).sort();

  await assertStateRejected(() =>
    writePendingVbtechRelease(releases, selector(), dependencies("2026-08-21T10:20:32.000Z")),
  );
  assert.deepEqual((await readdir(releases)).sort(), filesBefore);
});

test("rejects a colliding retry timestamp without leaving an orphaned claim", async () => {
  const releases = await directory();
  const first = await writePendingVbtechRelease(releases, selector(), dependencies());
  await markVbtechReleaseFailed(releases, first, dependencies());

  await assert.rejects(
    writePendingVbtechRelease(releases, selector(), dependencies()),
    (error) => error.message === "v-b release transition rejected",
  );
  assert.equal(await latestHealthyVbtechRelease(releases), undefined);
  assert.equal(
    (await readdir(releases)).includes(
      `.vbtech-release-state.${firstSha}-${firstDigest.slice(7)}.pending-2.claim`,
    ),
    false,
  );
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

test("serializes concurrent pending writes for one release identity", async () => {
  const releases = await directory();
  const results = await Promise.allSettled([
    writePendingVbtechRelease(releases, selector(), dependencies("2026-08-21T10:20:30.000Z")),
    writePendingVbtechRelease(releases, selector(), dependencies("2026-08-21T10:20:31.000Z")),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    results.find((result) => result.status === "rejected")?.reason.message,
    "v-b release transition rejected",
  );
});

test("atomically fences a concurrent pending write after its claim publishes", async () => {
  const releases = await directory();
  await mkdir(releases, { mode: 0o700 });
  const lock = join(releases, ".vbtech-release-state.lock");
  const successorOwner = "00000000-0000-4000-8000-000000000002";
  await writeFile(
    lock,
    `${JSON.stringify({ owner: "00000000-0000-4000-8000-000000000001", pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  let competing;

  const pending = await writePendingVbtechRelease(releases, selector(), {
    now: () => new Date("2026-08-21T10:20:30.000Z"),
    randomUUID: () => {
      assert.equal(
        existsSync(
          join(
            releases,
            `.vbtech-release-state.${firstSha}-${firstDigest.slice(7)}.pending-1.claim`,
          ),
        ),
        true,
      );
      unlinkSync(lock);
      writeFileSync(lock, `${JSON.stringify({ owner: successorOwner, pid: process.pid })}\n`, {
        mode: 0o600,
      });
      competing = writePendingVbtechRelease(
        releases,
        selector(),
        dependencies("2026-08-21T10:20:31.000Z"),
      );
      competing.catch(() => undefined);
      return "00000000-0000-4000-8000-000000000003";
    },
  });

  await assert.rejects(competing, (error) => error.message === "v-b release transition rejected");
  assert.deepEqual(pending, record());
  assert.equal(
    (await readdir(releases)).filter((file) => file.endsWith(".pending.json")).length,
    1,
  );
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), {
    owner: successorOwner,
    pid: process.pid,
  });
});

test("serializes mutually exclusive concurrent terminal transitions", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const results = await Promise.allSettled([
    markVbtechReleaseHealthy(releases, pending, dependencies()),
    markVbtechReleaseFailed(releases, pending, dependencies()),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    results.find((result) => result.status === "rejected")?.reason.message,
    "v-b release transition rejected",
  );
  const terminals = (await readdir(releases)).filter(
    (file) => file.endsWith(".healthy.json") || file.endsWith(".failed.json"),
  );
  assert.equal(terminals.length, 1);
});

test("recovers a healthy terminal claim after a crash before the record link", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const expected = record({ state: "healthy" });
  const terminalClaim = join(
    releases,
    `.vbtech-release-state.${firstSha}-${firstDigest.slice(7)}.terminal-1.claim`,
  );

  await assert.rejects(
    markVbtechReleaseHealthy(releases, pending, {
      randomUUID: () => {
        assert.equal(existsSync(terminalClaim), true);
        throw new Error("simulated crash before healthy record publication");
      },
    }),
    (error) => error.message === "v-b release transition rejected",
  );

  assert.equal(existsSync(join(releases, fileName(expected))), false);
  assert.deepEqual(await latestHealthyVbtechRelease(releases), expected);
  await assert.rejects(
    markVbtechReleaseFailed(releases, pending, dependencies()),
    (error) => error.message === "v-b release transition rejected",
  );
  assert.deepEqual(await markVbtechReleaseHealthy(releases, pending, dependencies()), expected);
  assert.equal(existsSync(join(releases, fileName(expected))), true);
});

test("recovers a failed terminal claim after a crash before the record link", async () => {
  const releases = await directory();
  const previousPending = await writePendingVbtechRelease(
    releases,
    selector(),
    dependencies("2026-08-21T10:20:29.000Z"),
  );
  const previousHealthy = await markVbtechReleaseHealthy(releases, previousPending, dependencies());
  const failedSelector = selector({
    releaseSha: "c".repeat(40),
    imageDigest: `sha256:${"d".repeat(64)}`,
  });
  const pending = await writePendingVbtechRelease(releases, failedSelector, dependencies());
  const expected = record({
    releaseSha: failedSelector.releaseSha,
    imageDigest: failedSelector.imageDigest,
    state: "failed",
  });
  const terminalClaim = join(
    releases,
    `.vbtech-release-state.${failedSelector.releaseSha}-${failedSelector.imageDigest.slice(7)}.terminal-1.claim`,
  );

  await assert.rejects(
    markVbtechReleaseFailed(releases, pending, {
      randomUUID: () => {
        assert.equal(existsSync(terminalClaim), true);
        throw new Error("simulated crash before failed record publication");
      },
    }),
    (error) => error.message === "v-b release transition rejected",
  );

  assert.equal(existsSync(join(releases, fileName(expected))), false);
  assert.deepEqual(await latestHealthyVbtechRelease(releases), previousHealthy);
  await assert.rejects(
    markVbtechReleaseHealthy(releases, pending, dependencies()),
    (error) => error.message === "v-b release transition rejected",
  );
  assert.deepEqual(await markVbtechReleaseFailed(releases, pending, dependencies()), expected);
  assert.equal(existsSync(join(releases, fileName(expected))), true);
});

test("preserves a valid legacy lock while publishing independent claims", async () => {
  const releases = await directory();
  await mkdir(releases, { mode: 0o700 });
  const lock = join(releases, ".vbtech-release-state.lock");
  await writeFile(
    lock,
    `${JSON.stringify({ owner: "00000000-0000-4000-8000-000000000000", pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());

  assert.deepEqual(pending, record());
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), {
    owner: "00000000-0000-4000-8000-000000000000",
    pid: process.pid,
  });
  assert.equal((await readdir(releases)).includes(".vbtech-release-state.lock"), true);
});

test("atomically fences terminal outcomes after a former lock owner is replaced", async () => {
  const releases = await directory();
  const pending = await writePendingVbtechRelease(releases, selector(), dependencies());
  const lock = join(releases, ".vbtech-release-state.lock");
  const successorOwner = "00000000-0000-4000-8000-000000000002";
  await writeFile(
    lock,
    `${JSON.stringify({ owner: "00000000-0000-4000-8000-000000000001", pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  let competing;

  const healthy = await markVbtechReleaseHealthy(releases, pending, {
    now: () => new Date("2026-08-21T10:20:30.000Z"),
    randomUUID: () => {
      assert.equal(
        existsSync(
          join(
            releases,
            `.vbtech-release-state.${firstSha}-${firstDigest.slice(7)}.terminal-1.claim`,
          ),
        ),
        true,
      );
      unlinkSync(lock);
      writeFileSync(lock, `${JSON.stringify({ owner: successorOwner, pid: process.pid })}\n`, {
        mode: 0o600,
      });
      competing = markVbtechReleaseFailed(releases, pending, dependencies());
      competing.catch(() => undefined);
      return "00000000-0000-4000-8000-000000000003";
    },
  });

  await assert.rejects(competing, (error) => error.message === "v-b release transition rejected");
  assert.deepEqual(healthy, record({ state: "healthy" }));
  const terminalFiles = (await readdir(releases)).filter(
    (file) => file.endsWith(".healthy.json") || file.endsWith(".failed.json"),
  );
  assert.deepEqual(terminalFiles, [fileName(healthy)]);
  assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), {
    owner: successorOwner,
    pid: process.pid,
  });
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

test("fails closed for unexpected non-JSON regular files and symbolic links", async () => {
  const regularFileDirectory = await directory();
  await writePendingVbtechRelease(regularFileDirectory, selector(), dependencies());
  await writeFile(join(regularFileDirectory, "unexpected"), "private value", { mode: 0o600 });
  await assertStateRejected(() => latestHealthyVbtechRelease(regularFileDirectory));

  const symlinkDirectory = await directory();
  await writePendingVbtechRelease(symlinkDirectory, selector(), dependencies());
  const externalDirectory = await mkdtemp(join(tmpdir(), "vbtech-release-state-external-"));
  const externalFile = join(externalDirectory, "record");
  await writeFile(externalFile, "private value", { mode: 0o600 });
  await symlink(externalFile, join(symlinkDirectory, "unexpected-link"));
  await assertStateRejected(() => latestHealthyVbtechRelease(symlinkDirectory));
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
