import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deployRelease } from "../deploy.mjs";

const tag = "0123456789abcdef0123456789abcdef01234567";
const environment = {
  MARKIRO_IMAGE_TAG: tag,
  MARKIRO_ENV_FILE: "/private/production.env",
  MARKIRO_DOMAIN: "app.markiro.example",
  ACME_EMAIL: "ops@example.test",
  DATABASE_URL: "postgres://private:password@database/markiro",
};

function fakeRunner({ failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args, childEnvironment) {
      calls.push({ command, args, environmentKeys: Object.keys(childEnvironment).sort() });
      const key = [command, ...args].join(" ");
      if (failures[key]) return { code: failures[key], stdout: "", stderr: "private stderr" };
      if (args.includes("image") && args.includes("inspect")) {
        const image = args.at(-1);
        const marker = image.includes("markiro-api") ? "a" : "b";
        return { code: 0, stdout: `${image}@sha256:${marker}`.padEnd(71, marker), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

async function fixture({ failures, readiness, smokeError, previousTag = "previous-sha" } = {}) {
  const releaseDirectory = await mkdtemp(join(tmpdir(), "markiro-deploy-test-"));
  if (previousTag) {
    const previous = {
      tag: previousTag,
      previousTag: null,
      apiDigest: "api@sha256:previous",
      edgeDigest: "edge@sha256:previous",
      state: "healthy",
      createdAt: "2026-08-03T09:00:00.000Z",
    };
    await (
      await import("node:fs/promises")
    ).writeFile(
      join(releaseDirectory, "2026-08-03T09-00-00-000Z-previous-sha.json"),
      JSON.stringify(previous),
      { mode: 0o600 },
    );
  }
  const runner = fakeRunner({ failures });
  let readinessCall = 0;
  const logs = [];
  const dependencies = {
    runPreflight: async () => ({ imageTag: tag, envFile: environment.MARKIRO_ENV_FILE }),
    runner,
    runSmoke: async () => {
      if (smokeError) throw smokeError;
    },
    sleep: async () => undefined,
    now: () => new Date("2026-08-04T10:20:30.000Z"),
    log: (message) => logs.push(message),
  };
  if (readiness) dependencies.isReady = async () => readiness[readinessCall++] ?? false;
  return { dependencies, logs, releaseDirectory, runner };
}

const compose = [
  "compose",
  "--env-file",
  environment.MARKIRO_ENV_FILE,
  "-f",
  "compose.production.yml",
];

test("deploys immutable images in migration, readiness, edge, and public-smoke order", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture();

  const release = await deployRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.deepEqual(
    runner.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", [...compose, "pull", "api", "edge"]],
      [
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{index .RepoDigests 0}}",
          `ghcr.io/thevladbog/markiro-api:${tag}`,
        ],
      ],
      [
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{index .RepoDigests 0}}",
          `ghcr.io/thevladbog/markiro-edge:${tag}`,
        ],
      ],
      ["docker", [...compose, "run", "--rm", "migrate"]],
      ["docker", [...compose, "up", "-d", "--no-deps", "api"]],
      ["docker", [...compose, "exec", "-T", "api", "node", "/opt/markiro/healthcheck.mjs"]],
      ["docker", [...compose, "up", "-d", "--no-deps", "edge"]],
    ],
  );
  assert.equal(release.state, "healthy");
  assert.equal(release.tag, tag);
  assert.equal(release.previousTag, "previous-sha");
  assert.match(release.apiDigest, /markiro-api/);
  assert.match(release.edgeDigest, /markiro-edge/);
  const files = await readdir(releaseDirectory);
  assert.equal(files.length, 2);
  const record = JSON.parse(
    await readFile(
      join(
        releaseDirectory,
        files.find((file) => file.includes(tag)),
      ),
      "utf8",
    ),
  );
  assert.equal(record.state, "healthy");
  const releaseStat = await stat(
    join(
      releaseDirectory,
      files.find((file) => file.includes(tag)),
    ),
  );
  assert.equal(releaseStat.mode & 0o777, 0o600);
});

test("does not switch either service when migration fails", async () => {
  const failures = { [`docker ${[...compose, "run", "--rm", "migrate"].join(" ")}`]: 1 };
  const { dependencies, runner, releaseDirectory } = await fixture({ failures });

  await assert.rejects(
    deployRelease({ environment, releaseDirectory }, dependencies),
    /docker failed with exit 1/,
  );

  assert.equal(
    runner.calls.some(({ args }) => args.includes("up")),
    false,
  );
});

test("does not switch edge when API readiness never succeeds", async () => {
  const { dependencies, runner, releaseDirectory } = await fixture({ readiness: [false] });

  await assert.rejects(
    deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies),
    /API readiness failed/,
  );

  assert.equal(
    runner.calls.some(({ args }) => args.at(-1) === "edge" && args.includes("up")),
    false,
  );
});

test("records a failed public smoke with image evidence and never rolls back", async () => {
  const { dependencies, logs, releaseDirectory, runner } = await fixture({
    smokeError: new Error("private smoke detail"),
  });

  await assert.rejects(
    deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies),
    /Public smoke failed/,
  );

  assert.equal(
    runner.calls.some(({ args }) => args.includes("down") || args.includes("rollback")),
    false,
  );
  const files = await readdir(releaseDirectory);
  const record = JSON.parse(
    await readFile(
      join(
        releaseDirectory,
        files.find((file) => file.includes(tag)),
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    { state: record.state, previousTag: record.previousTag },
    { state: "failed", previousTag: "previous-sha" },
  );
  assert.match(record.apiDigest, /markiro-api/);
  assert.match(record.edgeDigest, /markiro-edge/);
  const output = JSON.stringify(logs);
  for (const value of Object.values(environment))
    assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
