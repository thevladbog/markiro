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
        return {
          code: 0,
          stdout: `${image.replace(`:${tag}`, "")}@sha256:${marker.repeat(64)}`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const previousTag = "f".repeat(40);

async function fixture({ failures, readiness, smokeError, priorTag = previousTag, previous } = {}) {
  const releaseDirectory = await mkdtemp(join(tmpdir(), "markiro-deploy-test-"));
  if (priorTag) {
    const priorRelease = previous || {
      tag: priorTag,
      previousTag: null,
      apiDigest: `ghcr.io/thevladbog/markiro-api@sha256:${"c".repeat(64)}`,
      edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`,
      state: "healthy",
      createdAt: "2026-08-03T09:00:00.000Z",
    };
    await (
      await import("node:fs/promises")
    ).writeFile(
      join(releaseDirectory, `2026-08-03T09-00-00-000Z-${priorTag}.json`),
      JSON.stringify(priorRelease),
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
  assert.equal(release.previousTag, previousTag);
  assert.match(release.apiDigest, /markiro-api/);
  assert.match(release.edgeDigest, /markiro-edge/);
  const files = await readdir(releaseDirectory);
  assert.equal(files.length, 2);
  assert.equal(
    files.some((file) => file.endsWith(".tmp")),
    false,
  );
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

test("uses only a structurally valid newest healthy release as the previous tag", async () => {
  const { dependencies, releaseDirectory } = await fixture({
    previous: {
      tag: "not-a-sha",
      previousTag: null,
      apiDigest: "ghcr.io/thevladbog/markiro-api@sha256:missing",
      edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`,
      state: "healthy",
      createdAt: "not-a-date",
    },
  });

  const release = await deployRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.equal(release.previousTag, null);
});

test("rejects an inspect value that is not the expected immutable digest", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    if (args.includes("image") && args.includes("inspect"))
      return { code: 0, stdout: "<no value>", stderr: "private output" };
    return run(command, args, childEnvironment);
  };

  await assert.rejects(
    deployRelease({ environment, releaseDirectory }, dependencies),
    /image digest is invalid/,
  );
  assert.equal(
    runner.calls.some(({ args }) => args.includes("migrate")),
    false,
  );
});

test(
  "marks the pending record failed after a timed out injected migration command",
  { timeout: 100 },
  async () => {
    const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
    const run = runner.run;
    runner.run = async (command, args, childEnvironment) => {
      if (args.includes("migrate")) return new Promise(() => undefined);
      return run(command, args, childEnvironment);
    };

    await assert.rejects(
      deployRelease({ environment, releaseDirectory, commandTimeoutMs: 5 }, dependencies),
      /docker timed out after 5ms/,
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
    assert.equal(record.state, "failed");
  },
);

test("emits the full lifecycle trace without environment values", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture();
  const trace = [];
  const preflight = dependencies.runPreflight;
  dependencies.runPreflight = async (...args) => {
    trace.push("preflight");
    return preflight(...args);
  };
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    const operation = args.includes("pull")
      ? "pull"
      : args.includes("inspect")
        ? "inspect"
        : args.includes("migrate")
          ? "migrate"
          : args.some((argument) => argument.includes("healthcheck"))
            ? "readiness"
            : args.includes("api") && args.includes("up")
              ? "api up"
              : "edge up";
    trace.push(operation);
    return run(command, args, childEnvironment);
  };
  dependencies.log = (event) => trace.push(event);
  dependencies.runSmoke = async () => trace.push("public smoke");

  await deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies);

  assert.deepEqual(trace, [
    "preflight",
    "preflight",
    "docker",
    "pull",
    "docker",
    "inspect",
    "docker",
    "inspect",
    "release pending",
    "docker",
    "migrate",
    "docker",
    "api up",
    "readiness",
    "docker",
    "docker",
    "edge up",
    "public smoke",
    "release healthy",
  ]);
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
    { state: "failed", previousTag },
  );
  assert.match(record.apiDigest, /markiro-api/);
  assert.match(record.edgeDigest, /markiro-edge/);
  const output = JSON.stringify(logs);
  for (const value of Object.values(environment))
    assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
