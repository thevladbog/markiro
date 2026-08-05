import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizePreparedRelease, prepareRelease, rollbackPreparedRelease } from "../deploy.mjs";

const TAG = "0123456789abcdef0123456789abcdef01234567";
const PREVIOUS_TAG = "f".repeat(40);
const API_DIGEST = `sha256:${"a".repeat(64)}`;
const EDGE_DIGEST = `sha256:${"b".repeat(64)}`;
const PREVIOUS_API = `ghcr.io/thevladbog/markiro-api@sha256:${"c".repeat(64)}`;
const PREVIOUS_EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`;
const ENVIRONMENT = {
  MARKIRO_IMAGE_TAG: TAG,
  MARKIRO_API_IMAGE_DIGEST: API_DIGEST,
  MARKIRO_EDGE_IMAGE_DIGEST: EDGE_DIGEST,
  MARKIRO_ENV_FILE: "/private/production.env",
  MARKIRO_DOMAIN: "app.markiro.example",
};

function legacyFileName(record) {
  return `${record.createdAt.replace(/[:.]/g, "-")}-${record.tag}.json`;
}

async function fixture({ failure, withPrevious = true } = {}) {
  const releaseDirectory = await mkdtemp(join(tmpdir(), "markiro-staged-deploy-"));
  const previous = {
    tag: PREVIOUS_TAG,
    previousTag: null,
    apiDigest: PREVIOUS_API,
    edgeDigest: PREVIOUS_EDGE,
    state: "healthy",
    createdAt: "2026-08-03T09:00:00.000Z",
  };
  if (withPrevious) {
    const previousPath = join(releaseDirectory, legacyFileName(previous));
    await writeFile(previousPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
    await chmod(previousPath, 0o600);
  }

  const calls = [];
  const runner = {
    async run(command, args, environment, timeoutMs) {
      const call = { command, args, environment, timeoutMs };
      calls.push(call);
      if (failure?.(call)) return { code: 1, stdout: "", stderr: "private" };
      if (args.includes("inspect"))
        return { code: 0, stdout: JSON.stringify([args.at(-1)]), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const dependencies = {
    runPreflight: async () => ({
      imageTag: TAG,
      apiImageDigest: API_DIGEST,
      edgeImageDigest: EDGE_DIGEST,
      envFile: ENVIRONMENT.MARKIRO_ENV_FILE,
    }),
    runner,
    isReady: async () => true,
    probeEdgeTls: async () => ({ status: 200 }),
    sleep: async () => undefined,
    monotonicNow: () => 0,
    now: () => new Date("2026-08-05T10:20:30.000Z"),
    log: () => undefined,
  };
  return { calls, dependencies, previous, releaseDirectory };
}

async function records(directory) {
  return Promise.all(
    (await readdir(directory)).map(async (name) => ({
      name,
      value: JSON.parse(await readFile(join(directory, name), "utf8")),
    })),
  );
}

test("prepare stops after local API and edge readiness with an exclusive pending candidate", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();

  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.equal(candidate.state, "pending");
  assert.equal(candidate.previousTag, PREVIOUS_TAG);
  assert.deepEqual(
    calls
      .filter(({ args }) => args.includes("run") || args.includes("up"))
      .map(({ args }) => (args.includes("migrate") ? "migrate" : args.at(-1))),
    ["migrate", "api", "edge"],
  );
  const persisted = await records(releaseDirectory);
  assert.equal(persisted.filter(({ name }) => name.endsWith(".pending.json")).length, 1);
  assert.equal(
    persisted.some(({ value }) => value.tag === TAG && value.state === "healthy"),
    false,
  );
});

test("finalize validates the exact pending candidate and creates one immutable healthy record", async () => {
  const { dependencies, releaseDirectory } = await fixture();
  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  const healthy = await finalizePreparedRelease({ candidate, releaseDirectory });

  assert.equal(healthy.state, "healthy");
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".healthy.json")).length,
    1,
  );
  await assert.rejects(
    finalizePreparedRelease({ candidate, releaseDirectory }),
    /release state transition rejected/,
  );
  await assert.rejects(
    finalizePreparedRelease({
      candidate: { ...candidate, edgeDigest: PREVIOUS_EDGE },
      releaseDirectory,
    }),
    /release state transition rejected/,
  );
});

test("rollback restores the exact previous digest pair without migrations and verifies both services", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();
  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  const rollbackStart = calls.length;

  const failed = await rollbackPreparedRelease(
    { candidate, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  const rollbackCalls = calls.slice(rollbackStart);
  assert.equal(
    rollbackCalls.some(({ args }) => args.includes("migrate")),
    false,
  );
  assert.deepEqual(
    rollbackCalls.filter(({ args }) => args.includes("up")).map(({ args }) => args.at(-1)),
    ["api", "edge"],
  );
  for (const call of rollbackCalls) {
    assert.equal(
      call.environment.MARKIRO_API_IMAGE_DIGEST,
      PREVIOUS_API.slice(PREVIOUS_API.lastIndexOf("@") + 1),
    );
    assert.equal(
      call.environment.MARKIRO_EDGE_IMAGE_DIGEST,
      PREVIOUS_EDGE.slice(PREVIOUS_EDGE.lastIndexOf("@") + 1),
    );
  }
  assert.equal(failed.state, "failed");
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".failed.json")).length,
    1,
  );
});

test("first-deploy rollback stops both candidate services and terminalizes the candidate failed", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({ withPrevious: false });
  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  const rollbackStart = calls.length;

  const failed = await rollbackPreparedRelease(
    { candidate, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.equal(candidate.previousTag, null);
  assert.deepEqual(
    calls.slice(rollbackStart).map(({ args }) => args.slice(-3)),
    [["stop", "api", "edge"]],
  );
  assert.equal(failed.state, "failed");
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".failed.json")).length,
    1,
  );
});

test("first-deploy rollback records failed even when stopping the candidate fails", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({
    withPrevious: false,
    failure: ({ args }) => args.includes("stop"),
  });
  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  await assert.rejects(
    rollbackPreparedRelease(
      { candidate, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
      dependencies,
    ),
    /first deployment recovery failed/,
  );

  assert.equal(calls.filter(({ args }) => args.includes("stop")).length, 1);
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".failed.json")).length,
    1,
  );
});

test("first-deploy local switch failure surfaces stop cleanup while preserving the primary", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({
    withPrevious: false,
    failure: ({ args }) => args.includes("stop") || (args.includes("up") && args.at(-1) === "edge"),
  });

  let error;
  try {
    await prepareRelease(
      { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
      dependencies,
    );
    assert.fail("deployment unexpectedly succeeded");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.equal(error.cause.message, "docker failed with exit 1");
  assert.equal(calls.filter(({ args }) => args.includes("stop")).length, 1);
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".failed.json")).length,
    1,
  );
});

test("migration failure marks the candidate failed without switching or rollback migration", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({
    failure: ({ args }) => args.includes("migrate"),
  });

  await assert.rejects(
    prepareRelease(
      { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
      dependencies,
    ),
    /docker failed/,
  );

  assert.equal(
    calls.some(({ args }) => args.includes("up")),
    false,
  );
  assert.equal(calls.filter(({ args }) => args.includes("migrate")).length, 1);
  const persisted = await records(releaseDirectory);
  assert.equal(persisted.filter(({ name }) => name.endsWith(".failed.json")).length, 1);
});

test("post-switch local failure restores the previous pair and verifies API and edge", async () => {
  let candidateEdgeStarts = 0;
  const { calls, dependencies, releaseDirectory } = await fixture({
    failure: ({ args }) => {
      if (args.includes("up") && args.at(-1) === "edge") {
        candidateEdgeStarts += 1;
        return candidateEdgeStarts === 1;
      }
      return false;
    },
  });

  await assert.rejects(
    prepareRelease(
      { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
      dependencies,
    ),
    /docker failed/,
  );

  assert.equal(calls.filter(({ args }) => args.includes("migrate")).length, 1);
  assert.deepEqual(
    calls.filter(({ args }) => args.includes("up")).map(({ args }) => args.at(-1)),
    ["api", "edge", "api", "edge"],
  );
  const restored = calls.filter(({ args }) => args.includes("up")).at(-1).environment;
  assert.equal(
    restored.MARKIRO_API_IMAGE_DIGEST,
    PREVIOUS_API.slice(PREVIOUS_API.lastIndexOf("@") + 1),
  );
  assert.equal(
    restored.MARKIRO_EDGE_IMAGE_DIGEST,
    PREVIOUS_EDGE.slice(PREVIOUS_EDGE.lastIndexOf("@") + 1),
  );
  assert.equal(
    (await records(releaseDirectory)).filter(({ name }) => name.endsWith(".failed.json")).length,
    1,
  );
});
