import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deployRelease, writeRelease } from "../deploy.mjs";

const tag = "0123456789abcdef0123456789abcdef01234567";
const apiImageDigest = `sha256:${"a".repeat(64)}`;
const edgeImageDigest = `sha256:${"b".repeat(64)}`;
const apiImage = `ghcr.io/thevladbog/markiro-api@${apiImageDigest}`;
const edgeImage = `ghcr.io/thevladbog/markiro-edge@${edgeImageDigest}`;
const vbtechReleaseSha = "e".repeat(40);
const vbtechImageDigest = `sha256:${"d".repeat(64)}`;
const vbtechImageRef = `ghcr.io/thevladbog/vbtech-web@${vbtechImageDigest}`;
const environment = {
  MARKIRO_IMAGE_TAG: tag,
  MARKIRO_API_IMAGE_DIGEST: apiImageDigest,
  MARKIRO_EDGE_IMAGE_DIGEST: edgeImageDigest,
  MARKIRO_ENV_FILE: "/private/production.env",
  MARKIRO_DOMAIN: "app.markiro.example",
  MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
  MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
  MARKIRO_LANDING_DOMAIN: "markiro.example",
  MARKIRO_LANDING_DEMO_SUBMISSION_STATE: "disabled",
  MARKIRO_HTTPS_PORT: "443",
  ACME_EMAIL: "ops@example.test",
  DATABASE_URL: "postgres://private:password@database/markiro",
};

function fakeRunner({ failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args, childEnvironment, timeoutMs) {
      calls.push({
        command,
        args,
        environmentKeys: Object.keys(childEnvironment).sort(),
        timeoutMs,
      });
      const key = [command, ...args].join(" ");
      if (failures[key]) return { code: failures[key], stdout: "", stderr: "private stderr" };
      if (args.includes("image") && args.includes("inspect")) {
        const image = args.at(-1);
        return {
          code: 0,
          stdout: JSON.stringify([`ghcr.io/example/unrelated@sha256:${"f".repeat(64)}`, image]),
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
    runPreflight: async () => ({
      imageTag: tag,
      apiImageDigest,
      edgeImageDigest,
      envFile: environment.MARKIRO_ENV_FILE,
    }),
    runner,
    runSmoke: async () => {
      if (smokeError) throw smokeError;
    },
    probeEdgeTls: async () => ({ status: 200 }),
    sleep: async () => undefined,
    monotonicNow: () => 0,
    now: () => new Date("2026-08-04T10:20:30.000Z"),
    log: (message) => logs.push(message),
  };
  if (readiness) dependencies.isReady = async () => readiness[readinessCall++] ?? false;
  return { dependencies, logs, releaseDirectory, runner };
}

const compose = [
  "compose",
  "--project-name",
  "markiro-production",
  "--env-file",
  environment.MARKIRO_ENV_FILE,
  "-f",
  "compose.production.yml",
];

test("deploys approved digest-backed images in migration, readiness, edge, and public-smoke order", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture();

  const release = await deployRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.deepEqual(
    runner.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", [...compose, "pull", "api", "edge"]],
      ["docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", apiImage]],
      ["docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", edgeImage]],
      ["docker", [...compose, "run", "--rm", "migrate"]],
      ["docker", [...compose, "up", "-d", "--no-deps", "api"]],
      ["docker", [...compose, "exec", "-T", "api", "node", "/opt/markiro/healthcheck.mjs"]],
      ["docker", [...compose, "up", "-d", "--no-deps", "edge"]],
    ],
  );
  assert.equal(release.state, "healthy");
  assert.equal(release.tag, tag);
  assert.equal(release.previousTag, previousTag);
  assert.equal(release.apiDigest, apiImage);
  assert.equal(release.edgeDigest, edgeImage);
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

test("uses stage-specific deadlines while leaving migration completion to database bounds", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture();

  await deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies);

  const timeoutFor = (predicate) => runner.calls.find(({ args }) => predicate(args))?.timeoutMs;
  assert.equal(
    timeoutFor((args) => args.includes("pull")),
    600_000,
  );
  assert.equal(
    timeoutFor((args) => args.includes("image") && args.includes("inspect")),
    30_000,
  );
  assert.equal(
    timeoutFor((args) => args.includes("migrate")),
    null,
  );
  assert.equal(
    timeoutFor((args) => args.includes("up") && args.at(-1) === "api"),
    300_000,
  );
  assert.equal(
    timeoutFor((args) => args.some((argument) => argument.includes("healthcheck"))),
    30_000,
  );
  assert.equal(
    timeoutFor((args) => args.includes("up") && args.at(-1) === "edge"),
    300_000,
  );
});

test(
  "does not apply the short command deadline to a database-bounded migration",
  { timeout: 200 },
  async () => {
    const { dependencies, releaseDirectory, runner } = await fixture();
    const run = runner.run.bind(runner);
    runner.run = async (command, args, childEnvironment, timeoutMs) => {
      if (args.includes("migrate")) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return run(command, args, childEnvironment, timeoutMs);
    };

    const release = await deployRelease(
      { environment, releaseDirectory, readinessAttempts: 1, commandTimeoutMs: 5 },
      dependencies,
    );

    assert.equal(release.state, "healthy");
    assert.equal(runner.calls.find(({ args }) => args.includes("migrate"))?.timeoutMs, null);
  },
);

test("passes all configured authorities and the immutable tag to public smoke", async () => {
  const { dependencies, releaseDirectory } = await fixture();
  let smokeOptions;
  let readinessUrl;
  dependencies.probeEdgeTls = async ({ url }) => {
    readinessUrl = url;
    return { status: 200 };
  };
  dependencies.runSmoke = async (options) => {
    smokeOptions = options;
  };

  await deployRelease(
    {
      environment: { ...environment, MARKIRO_HTTPS_PORT: "18443" },
      releaseDirectory,
      readinessAttempts: 1,
    },
    dependencies,
  );

  assert.equal(smokeOptions.adminBaseUrl, "https://app.markiro.example:18443");
  assert.equal(smokeOptions.kioskBaseUrl, "https://kiosk.markiro.example:18443");
  assert.equal(smokeOptions.landingBaseUrl, "https://markiro.example:18443");
  assert.equal(smokeOptions.expectedReleaseSha, tag);
  assert.equal(smokeOptions.landingDemoSubmissionState, "disabled");
  assert.equal(readinessUrl, "https://app.markiro.example:18443/health/live");
});

test("deploys and smokes an independently digest-pinned v-b service before switching the shared edge", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture();
  let smokeOptions;
  dependencies.runPreflight = async () => ({
    imageTag: tag,
    apiImageDigest,
    edgeImageDigest,
    envFile: environment.MARKIRO_ENV_FILE,
    vbtechImageRef,
    vbtechImageDigest,
    vbtechReleaseSha,
    vbtechDomain: "v-b.tech",
    vbtechWwwDomain: "www.v-b.tech",
    vbtechFunctionPath: "",
    vbtechSubmissionState: "disabled",
  });
  dependencies.runSmoke = async (options) => {
    smokeOptions = options;
  };

  const release = await deployRelease(
    {
      environment: {
        ...environment,
        VBTECH_IMAGE_REF: vbtechImageRef,
        VBTECH_RELEASE_SHA: vbtechReleaseSha,
        VBTECH_FUNCTION_PATH: "",
        VBTECH_SUBMISSION_STATE: "disabled",
        VBTECH_DOMAIN: "v-b.tech",
        VBTECH_WWW_DOMAIN: "www.v-b.tech",
      },
      releaseDirectory,
      readinessAttempts: 1,
    },
    dependencies,
  );

  const commands = runner.calls.map(({ args }) => args);
  assert.ok(commands.some((args) => args.includes("pull") && args.includes("vbtech-web")));
  assert.ok(
    commands.some(
      (args) =>
        args.at(-1) === vbtechImageRef &&
        args.includes("inspect") &&
        args.includes("{{json .RepoDigests}}"),
    ),
  );
  assert.ok(commands.some((args) => args.at(-1) === "vbtech-web" && args.includes("up")));
  assert.ok(
    commands.findIndex((args) => args.at(-1) === "vbtech-web" && args.includes("up")) <
      commands.findIndex((args) => args.at(-1) === "edge" && args.includes("up")),
  );
  assert.deepEqual(release.vbtech, {
    imageRef: vbtechImageRef,
    imageDigest: vbtechImageDigest,
    releaseSha: vbtechReleaseSha,
    functionPath: "",
    submissionState: "disabled",
  });
  assert.equal(smokeOptions.environment.VBTECH_IMAGE_REF, vbtechImageRef);
  assert.equal(Object.hasOwn(smokeOptions.environment, "VBTECH_IMAGE_TAG"), false);
  assert.equal(smokeOptions.vbtechBaseUrl, "https://v-b.tech");
  assert.equal(smokeOptions.vbtechWwwBaseUrl, "https://www.v-b.tech");
  assert.equal(smokeOptions.expectedVbtechReleaseSha, vbtechReleaseSha);
  assert.equal(smokeOptions.vbtechSubmissionState, "disabled");
});

test("rejects the retired v-b image tag before deployment mutation", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  const before = await readdir(releaseDirectory);

  await assert.rejects(
    deployRelease(
      {
        environment: {
          ...environment,
          VBTECH_IMAGE_TAG: `ghcr.io/thevladbog/vbtech-web:${vbtechReleaseSha}`,
        },
        releaseDirectory,
        readinessAttempts: 1,
      },
      dependencies,
    ),
    /caller v-b selector conflicts with preserved release/,
  );

  assert.deepEqual(runner.calls, []);
  assert.deepEqual(await readdir(releaseDirectory), before);
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

test("rejects an inspect value that does not contain the approved digest", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    if (args.includes("image") && args.includes("inspect"))
      return {
        code: 0,
        stdout: JSON.stringify([`ghcr.io/example/other@sha256:${"c".repeat(64)}`]),
        stderr: "private output",
      };
    return run(command, args, childEnvironment);
  };

  await assert.rejects(
    deployRelease({ environment, releaseDirectory }, dependencies),
    /approved image digest is not present/,
  );
  assert.equal(
    runner.calls.some(({ args }) => args.includes("migrate")),
    false,
  );
});

test("accepts the approved digest anywhere in the inspect RepoDigests array", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    if (args.includes("image") && args.includes("inspect")) {
      const expected = args.at(-1);
      return {
        code: 0,
        stdout: JSON.stringify([
          `ghcr.io/example/unrelated@sha256:${"e".repeat(64)}`,
          expected,
          `ghcr.io/example/another@sha256:${"f".repeat(64)}`,
        ]),
        stderr: "",
      };
    }
    return run(command, args, childEnvironment);
  };

  const release = await deployRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  assert.equal(release.apiDigest, apiImage);
  assert.equal(release.edgeDigest, edgeImage);
});

test("rejects swapped API and edge digests before migrations", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  dependencies.runPreflight = async () => ({
    imageTag: tag,
    apiImageDigest: edgeImageDigest,
    edgeImageDigest: apiImageDigest,
    envFile: environment.MARKIRO_ENV_FILE,
  });
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    if (args.includes("image") && args.includes("inspect")) {
      const actual = args.at(-1).includes("markiro-api") ? apiImage : edgeImage;
      return { code: 0, stdout: JSON.stringify([actual]), stderr: "" };
    }
    return run(command, args, childEnvironment);
  };

  await assert.rejects(
    deployRelease({ environment, releaseDirectory }, dependencies),
    /approved image digest is not present/,
  );
  assert.equal(
    runner.calls.some(({ args }) => args.includes("migrate")),
    false,
  );
});

test("marks the pending record failed when the database-bounded migration exits non-zero", async () => {
  const failures = { [`docker ${[...compose, "run", "--rm", "migrate"].join(" ")}`]: 1 };
  const { dependencies, releaseDirectory } = await fixture({ failures, priorTag: null });

  await assert.rejects(
    deployRelease({ environment, releaseDirectory, commandTimeoutMs: 5 }, dependencies),
    /docker failed with exit 1/,
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
});

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
  const realWriter = writeRelease;
  dependencies.writeRelease = async (directory, release) => {
    trace.push(`write ${release.state}`);
    await realWriter(directory, release);
  };
  dependencies.probeEdgeTls = async () => {
    trace.push("edge TLS readiness");
    return { status: 200 };
  };
  dependencies.runSmoke = async () => trace.push("public smoke");

  await deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies);

  assert.deepEqual(trace, [
    "preflight",
    "pull",
    "inspect",
    "inspect",
    "write pending",
    "migrate",
    "api up",
    "readiness",
    "edge up",
    "edge TLS readiness",
    "public smoke",
    "write healthy",
  ]);
});

test("retries transient edge connection, TLS, and status failures before one full smoke", async () => {
  const { dependencies, releaseDirectory } = await fixture();
  const trace = [];
  const results = [new Error("private certificate detail"), { status: 503 }, { status: 200 }];
  dependencies.probeEdgeTls = async ({ url, timeoutMs }) => {
    trace.push(["probe", url, timeoutMs]);
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  dependencies.sleep = async (milliseconds) => trace.push(["sleep", milliseconds]);
  dependencies.runSmoke = async () => trace.push(["smoke"]);

  const release = await deployRelease(
    {
      environment,
      releaseDirectory,
      readinessAttempts: 1,
      edgeReadinessAttempts: 3,
      edgeReadinessIntervalMs: 11,
      edgeReadinessTimeoutMs: 17_000,
    },
    dependencies,
  );

  assert.equal(release.state, "healthy");
  assert.deepEqual(trace, [
    ["probe", "https://app.markiro.example/health/live", 17_000],
    ["sleep", 11],
    ["probe", "https://app.markiro.example/health/live", 17_000],
    ["sleep", 11],
    ["probe", "https://app.markiro.example/health/live", 17_000],
    ["smoke"],
  ]);
});

test("fails closed after bounded edge readiness with a sanitized last status and no smoke", async () => {
  const { dependencies, logs, releaseDirectory } = await fixture();
  let smokeCalls = 0;
  let probes = 0;
  dependencies.probeEdgeTls = async () => {
    probes += 1;
    if (probes === 1) throw new Error("private TLS certificate and hostname detail");
    return { status: 503 };
  };
  dependencies.runSmoke = async () => {
    smokeCalls += 1;
  };

  await assert.rejects(
    deployRelease(
      {
        environment,
        releaseDirectory,
        readinessAttempts: 1,
        edgeReadinessAttempts: 2,
        edgeReadinessIntervalMs: 1,
        edgeReadinessTimeoutMs: 9_000,
      },
      dependencies,
    ),
    (error) => error.message === "Edge/TLS readiness failed after 9000ms (last cause: HTTP 503)",
  );

  assert.equal(probes, 2);
  assert.equal(smokeCalls, 0);
  assert.doesNotMatch(JSON.stringify(logs), /private TLS|certificate|hostname/);
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
});

test("edge readiness stops at its stage timeout and preserves the deployment failure", async () => {
  const { dependencies, releaseDirectory } = await fixture();
  const clock = [0, 0, 5_001];
  const originalWriter = dependencies.writeRelease ?? writeRelease;
  dependencies.monotonicNow = () => clock.shift() ?? 5_001;
  dependencies.probeEdgeTls = async () => ({ status: 502 });
  dependencies.writeRelease = async (directory, release) => {
    if (release.state === "failed") throw new Error("private failed-state persistence detail");
    await originalWriter(directory, release);
  };

  await assert.rejects(
    deployRelease(
      {
        environment,
        releaseDirectory,
        readinessAttempts: 1,
        edgeReadinessAttempts: 30,
        edgeReadinessIntervalMs: 2_000,
        edgeReadinessTimeoutMs: 5_000,
      },
      dependencies,
    ),
    (error) => error.message === "Edge/TLS readiness failed after 5000ms (last cause: HTTP 502)",
  );
});

test("writes a failed release record through the injected atomic writer", async () => {
  const { dependencies, releaseDirectory } = await fixture({
    smokeError: new Error("private smoke failure"),
  });
  const writes = [];
  const realWriter = writeRelease;
  dependencies.writeRelease = async (directory, release) => {
    writes.push(release.state);
    await realWriter(directory, release);
  };

  await assert.rejects(
    deployRelease({ environment, releaseDirectory, readinessAttempts: 1 }, dependencies),
    /Public smoke failed/,
  );

  assert.deepEqual(writes, ["pending", "failed"]);
});

function releaseFileName(record) {
  return `${record.createdAt.replace(/[:.]/g, "-")}-${record.tag}.json`;
}

function healthyRecord({ tag, createdAt }) {
  return {
    tag,
    previousTag: null,
    apiDigest: `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`,
    edgeDigest: `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`,
    state: "healthy",
    createdAt,
  };
}

async function persistCandidate(
  directory,
  record,
  { filename = releaseFileName(record), mode = 0o600 } = {},
) {
  const path = join(directory, filename);
  await writeFile(path, JSON.stringify(record), { mode });
  await chmod(path, mode);
}

test("chooses only the newest structurally valid private release record", async () => {
  const { dependencies, releaseDirectory } = await fixture({ priorTag: null });
  const oldTag = "1".repeat(40);
  const newestTag = "2".repeat(40);
  await persistCandidate(
    releaseDirectory,
    healthyRecord({ tag: oldTag, createdAt: "2026-08-01T00:00:00.000Z" }),
  );
  await persistCandidate(
    releaseDirectory,
    healthyRecord({ tag: newestTag, createdAt: "2026-08-03T00:00:00.000Z" }),
  );
  const malformed = healthyRecord({ tag: "3".repeat(40), createdAt: "2026-08-04T00:00:00.000Z" });
  malformed.apiDigest = `ghcrXio/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
  await persistCandidate(releaseDirectory, malformed);
  await persistCandidate(
    releaseDirectory,
    healthyRecord({ tag: "4".repeat(40), createdAt: "2026-08-05T00:00:00.000Z" }),
    { filename: "renamed.json" },
  );
  await persistCandidate(
    releaseDirectory,
    healthyRecord({ tag: "5".repeat(40), createdAt: "2026-08-06T00:00:00.000Z" }),
    { mode: 0o644 },
  );
  await persistCandidate(
    releaseDirectory,
    healthyRecord({ tag: "6".repeat(40), createdAt: "2026-08-07T00:00:00.000Z" }),
    { filename: "2026-08-08T00-00-00-000Z-666.json" },
  );

  const release = await deployRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.equal(release.previousTag, newestTag);
});

test("rejects a deceptive repository name in image inspect output", async () => {
  const { dependencies, releaseDirectory, runner } = await fixture({ priorTag: null });
  const run = runner.run;
  runner.run = async (command, args, childEnvironment) => {
    if (args.includes("image") && args.includes("inspect"))
      return {
        code: 0,
        stdout: JSON.stringify([`ghcrXio/thevladbog/markiro-api@sha256:${"a".repeat(64)}`]),
        stderr: "private",
      };
    return run(command, args, childEnvironment);
  };

  await assert.rejects(
    deployRelease({ environment, releaseDirectory }, dependencies),
    /approved image digest is not present/,
  );
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

test("readiness retries transient timeout and spawn throws through the attempt budget", async () => {
  const { dependencies, runner, releaseDirectory } = await fixture();
  const run = runner.run.bind(runner);
  let probes = 0;
  let sleeps = 0;
  runner.run = async (command, args, childEnvironment) => {
    if (args.some((argument) => argument.includes("healthcheck"))) {
      probes += 1;
      if (probes === 1) throw new Error("docker timed out after 17ms");
      if (probes === 2) throw new Error("private readiness spawn failure");
    }
    return run(command, args, childEnvironment);
  };
  dependencies.sleep = async () => {
    sleeps += 1;
  };

  const release = await deployRelease(
    {
      environment,
      releaseDirectory,
      readinessAttempts: 3,
      readinessIntervalMs: 1,
      commandTimeoutMs: 17,
    },
    dependencies,
  );

  assert.equal(release.state, "healthy");
  assert.equal(probes, 3);
  assert.equal(sleeps, 2);
  assert.equal(
    runner.calls.some(({ args }) => args.at(-1) === "edge" && args.includes("up")),
    true,
  );
});

test("all thrown readiness probes exhaust retries without switching edge or leaking details", async () => {
  const { dependencies, logs, runner, releaseDirectory } = await fixture();
  const run = runner.run.bind(runner);
  let probes = 0;
  let sleeps = 0;
  runner.run = async (command, args, childEnvironment) => {
    if (args.some((argument) => argument.includes("healthcheck"))) {
      probes += 1;
      throw new Error(`private readiness failure ${probes}`);
    }
    return run(command, args, childEnvironment);
  };
  dependencies.sleep = async () => {
    sleeps += 1;
  };

  await assert.rejects(
    deployRelease(
      { environment, releaseDirectory, readinessAttempts: 3, readinessIntervalMs: 1 },
      dependencies,
    ),
    (error) => error.message === "API readiness failed",
  );

  assert.equal(probes, 3);
  assert.equal(sleeps, 2);
  assert.equal(
    runner.calls.some(({ args }) => args.at(-1) === "edge" && args.includes("up")),
    false,
  );
  assert.doesNotMatch(JSON.stringify(logs), /private readiness failure/);
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
});

test("a failed-state write cannot mask the original deployment error", async () => {
  const { dependencies, logs, releaseDirectory } = await fixture({ readiness: [false] });
  const originalError = new Error("readiness retry scheduling failed");
  const rawWriteError = new Error("private failed-record write detail");
  const realWriter = writeRelease;
  const log = dependencies.log;
  let failedStateSeen = false;
  dependencies.sleep = async () => {
    throw originalError;
  };
  dependencies.writeRelease = async (directory, release) => {
    if (release.state === "failed") {
      failedStateSeen = true;
      throw rawWriteError;
    }
    await realWriter(directory, release);
  };
  dependencies.log = (message) => {
    log(message);
    if (message === "failed release record write failed")
      throw new Error("private failed-record log detail");
  };

  await assert.rejects(
    deployRelease(
      { environment, releaseDirectory, readinessAttempts: 2, readinessIntervalMs: 1 },
      dependencies,
    ),
    (error) => error === originalError && error.message === originalError.message,
  );

  assert.equal(failedStateSeen, true);
  assert.equal(logs.includes("failed release record write failed"), true);
  assert.doesNotMatch(JSON.stringify(logs), /private failed-record (?:write|log) detail/);
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
