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
const VBTECH_SHA = "e".repeat(40);
const VBTECH_DIGEST = `sha256:${"5".repeat(64)}`;
const VBTECH_IMAGE_REF = `ghcr.io/thevladbog/vbtech-web@${VBTECH_DIGEST}`;
const VBTECH_SELECTOR = {
  imageRef: VBTECH_IMAGE_REF,
  imageDigest: VBTECH_DIGEST,
  releaseSha: VBTECH_SHA,
  functionPath: "",
  submissionState: "disabled",
};
const VBTECH_HEALTHY = {
  imageRef: VBTECH_IMAGE_REF,
  imageDigest: VBTECH_DIGEST,
  releaseSha: VBTECH_SHA,
  submissionState: "disabled",
  createdAt: "2026-08-03T08:00:00.000Z",
  state: "healthy",
};
const PREVIOUS_VBTECH_SHA = "6".repeat(40);
const PREVIOUS_VBTECH_DIGEST = `sha256:${"7".repeat(64)}`;
const PREVIOUS_VBTECH_IMAGE_REF = `ghcr.io/thevladbog/vbtech-web@${PREVIOUS_VBTECH_DIGEST}`;
const PREVIOUS_VBTECH_SELECTOR = {
  imageRef: PREVIOUS_VBTECH_IMAGE_REF,
  imageDigest: PREVIOUS_VBTECH_DIGEST,
  releaseSha: PREVIOUS_VBTECH_SHA,
  functionPath: "",
  submissionState: "disabled",
};
const ENVIRONMENT = {
  MARKIRO_IMAGE_TAG: TAG,
  MARKIRO_API_IMAGE_DIGEST: API_DIGEST,
  MARKIRO_EDGE_IMAGE_DIGEST: EDGE_DIGEST,
  MARKIRO_ENV_FILE: "/private/production.env",
  MARKIRO_DOMAIN: "app.markiro.example",
  MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
  MARKIRO_LANDING_DOMAIN: "markiro.example",
};
const VBTECH_RELEASE_DIRECTORY = "/private/vbtech-releases";
const ENVIRONMENT_WITH_VBTECH_DOMAINS = {
  ...ENVIRONMENT,
  VBTECH_DOMAIN: "v-b.tech",
  VBTECH_WWW_DOMAIN: "www.v-b.tech",
};

function legacyFileName(record) {
  return `${record.createdAt.replace(/[:.]/g, "-")}-${record.tag}.json`;
}

async function fixture({ failure, previousVbtech, withPrevious = true } = {}) {
  const releaseDirectory = await mkdtemp(join(tmpdir(), "markiro-staged-deploy-"));
  const previous = {
    tag: PREVIOUS_TAG,
    previousTag: null,
    apiDigest: PREVIOUS_API,
    edgeDigest: PREVIOUS_EDGE,
    ...(previousVbtech === undefined ? {} : { vbtech: previousVbtech }),
    state: "healthy",
    createdAt: "2026-08-03T09:00:00.000Z",
  };
  if (withPrevious) {
    const previousPath = join(releaseDirectory, legacyFileName(previous));
    await writeFile(previousPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
    await chmod(previousPath, 0o600);
  }

  const calls = [];
  const running = { apiDigest: null, edgeDigest: null, project: null };
  const runner = {
    async run(command, args, environment, timeoutMs) {
      const call = { command, args, environment, timeoutMs };
      calls.push(call);
      if (failure?.(call)) return { code: 1, stdout: "", stderr: "private" };
      if (args.includes("up") && args.at(-1) === "api") {
        running.apiDigest = environment.MARKIRO_API_IMAGE_DIGEST;
        running.project = args[2];
      }
      if (args.includes("up") && args.at(-1) === "edge") {
        running.edgeDigest = environment.MARKIRO_EDGE_IMAGE_DIGEST;
        running.project = args[2];
      }
      if (args.includes("stop")) {
        running.apiDigest = null;
        running.edgeDigest = null;
      }
      if (args.includes("inspect"))
        return { code: 0, stdout: JSON.stringify([args.at(-1)]), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const dependencies = {
    runPreflight: async (environment) => ({
      imageTag: environment.MARKIRO_IMAGE_TAG,
      apiImageDigest: environment.MARKIRO_API_IMAGE_DIGEST,
      edgeImageDigest: environment.MARKIRO_EDGE_IMAGE_DIGEST,
      envFile: environment.MARKIRO_ENV_FILE,
      ...(environment.VBTECH_IMAGE_REF === undefined
        ? {}
        : {
            vbtechImageRef: environment.VBTECH_IMAGE_REF,
            vbtechImageDigest: environment.VBTECH_IMAGE_REF.slice(
              environment.VBTECH_IMAGE_REF.indexOf("@") + 1,
            ),
            vbtechReleaseSha: environment.VBTECH_RELEASE_SHA,
            vbtechDomain: environment.VBTECH_DOMAIN,
            vbtechWwwDomain: environment.VBTECH_WWW_DOMAIN,
            vbtechFunctionPath: environment.VBTECH_FUNCTION_PATH,
            vbtechSubmissionState: environment.VBTECH_SUBMISSION_STATE,
          }),
    }),
    runner,
    isReady: async () => true,
    probeEdgeTls: async () => ({ status: 200 }),
    sleep: async () => undefined,
    monotonicNow: () => 0,
    now: () => new Date("2026-08-05T10:20:30.000Z"),
    log: () => undefined,
  };
  return { calls, dependencies, previous, releaseDirectory, running };
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
  assert.ok(
    calls.every(({ environment }) => environment.MARKIRO_KIOSK_DOMAIN === "kiosk.markiro.example"),
  );
  assert.ok(
    calls.every(({ environment }) => environment.MARKIRO_LANDING_DOMAIN === "markiro.example"),
  );
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

test("prepare preserves the latest healthy v-b selector through preflight and the staged Compose switch", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({
    previousVbtech: VBTECH_SELECTOR,
  });
  const runPreflight = dependencies.runPreflight;
  let preflightEnvironment;
  let selectedDirectory;
  dependencies.latestHealthyVbtechRelease = async (directory) => {
    selectedDirectory = directory;
    return VBTECH_HEALTHY;
  };
  dependencies.runPreflight = async (environment) => {
    preflightEnvironment = environment;
    return runPreflight(environment);
  };

  const candidate = await prepareRelease(
    {
      environment: ENVIRONMENT,
      releaseDirectory,
      vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
      readinessAttempts: 1,
    },
    dependencies,
  );

  assert.equal(selectedDirectory, VBTECH_RELEASE_DIRECTORY);
  assert.deepEqual(
    {
      imageRef: preflightEnvironment.VBTECH_IMAGE_REF,
      releaseSha: preflightEnvironment.VBTECH_RELEASE_SHA,
      functionPath: preflightEnvironment.VBTECH_FUNCTION_PATH,
      submissionState: preflightEnvironment.VBTECH_SUBMISSION_STATE,
    },
    {
      imageRef: VBTECH_IMAGE_REF,
      releaseSha: VBTECH_SHA,
      functionPath: "",
      submissionState: "disabled",
    },
  );
  assert.equal(preflightEnvironment.VBTECH_DOMAIN, "v-b.tech");
  assert.equal(preflightEnvironment.VBTECH_WWW_DOMAIN, "www.v-b.tech");
  assert.equal(Object.hasOwn(preflightEnvironment, "VBTECH_IMAGE_TAG"), false);
  assert.deepEqual(candidate.vbtech, VBTECH_SELECTOR);
  assert.equal(candidate.previousTag, PREVIOUS_TAG);
  assert.ok(calls.some(({ args }) => args.includes("pull") && args.includes("vbtech-web")));
  assert.ok(
    calls.some(
      ({ args }) =>
        args.at(-1) === VBTECH_IMAGE_REF &&
        args.includes("inspect") &&
        args.includes("{{json .RepoDigests}}"),
    ),
  );
  assert.deepEqual(
    calls.filter(({ args }) => args.includes("up")).map(({ args }) => args.at(-1)),
    ["api", "vbtech-web", "edge"],
  );
  const edge = calls.find(({ args }) => args.includes("up") && args.at(-1) === "edge");
  assert.equal(edge.args.includes("--no-deps"), false);
  for (const call of calls) {
    assert.equal(call.environment.VBTECH_IMAGE_REF, VBTECH_IMAGE_REF);
    assert.equal(call.environment.VBTECH_RELEASE_SHA, VBTECH_SHA);
    assert.equal(call.environment.VBTECH_FUNCTION_PATH, "");
    assert.equal(call.environment.VBTECH_SUBMISSION_STATE, "disabled");
    assert.equal(Object.hasOwn(call.environment, "VBTECH_IMAGE_TAG"), false);
  }
});

test("prepare remains Markiro-only when authoritative v-b state is absent", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();
  let selectedDirectory;
  dependencies.latestHealthyVbtechRelease = async (directory) => {
    selectedDirectory = directory;
    return undefined;
  };

  const candidate = await prepareRelease(
    {
      environment: ENVIRONMENT,
      releaseDirectory,
      vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
      readinessAttempts: 1,
    },
    dependencies,
  );

  assert.equal(selectedDirectory, VBTECH_RELEASE_DIRECTORY);
  assert.equal(Object.hasOwn(candidate, "vbtech"), false);
  assert.ok(calls.every(({ args }) => !args.includes("vbtech-web")));
  assert.ok(
    calls.some(
      ({ args }) => args.includes("up") && args.at(-1) === "edge" && args.includes("--no-deps"),
    ),
  );
});

test("prepare rejects every caller v-b input when authoritative state is absent before preflight or mutation", async (t) => {
  const inputs = [
    ["image reference", { VBTECH_IMAGE_REF }],
    ["retired image tag", { VBTECH_IMAGE_TAG: `ghcr.io/thevladbog/vbtech-web:${VBTECH_SHA}` }],
    ["release SHA", { VBTECH_RELEASE_SHA: VBTECH_SHA }],
    ["apex domain", { VBTECH_DOMAIN: "v-b.tech" }],
    ["www domain", { VBTECH_WWW_DOMAIN: "www.v-b.tech" }],
    ["function origin", { VBTECH_FUNCTION_ORIGIN: "https://functions.yandexcloud.net/d4example" }],
    ["function path", { VBTECH_FUNCTION_PATH: "" }],
    ["submission state", { VBTECH_SUBMISSION_STATE: "disabled" }],
    [
      "complete configuration",
      {
        VBTECH_IMAGE_REF,
        VBTECH_RELEASE_SHA: VBTECH_SHA,
        VBTECH_DOMAIN: "v-b.tech",
        VBTECH_WWW_DOMAIN: "www.v-b.tech",
        VBTECH_FUNCTION_PATH: "",
        VBTECH_SUBMISSION_STATE: "disabled",
      },
    ],
  ];

  for (const [name, input] of inputs) {
    await t.test(name, async () => {
      const { calls, dependencies, releaseDirectory } = await fixture();
      const before = await records(releaseDirectory);
      let preflightCalls = 0;
      dependencies.latestHealthyVbtechRelease = async () => undefined;
      dependencies.runPreflight = async () => {
        preflightCalls += 1;
        throw new Error("preflight must not run");
      };

      await assert.rejects(
        prepareRelease(
          {
            environment: { ...ENVIRONMENT, ...input },
            releaseDirectory,
            vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
            readinessAttempts: 1,
          },
          dependencies,
        ),
        /caller v-b selector conflicts with preserved release/,
      );

      assert.equal(preflightCalls, 0);
      assert.deepEqual(calls, []);
      assert.deepEqual(await records(releaseDirectory), before);
    });
  }
});

test("prepare rejects invalid authoritative v-b state before preflight or mutation", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();
  const before = await records(releaseDirectory);
  let preflightCalls = 0;
  dependencies.latestHealthyVbtechRelease = async () => {
    throw new Error("v-b release state is invalid");
  };
  dependencies.runPreflight = async () => {
    preflightCalls += 1;
    throw new Error("preflight must not run");
  };

  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
        readinessAttempts: 1,
      },
      dependencies,
    ),
    /v-b release state is invalid/,
  );

  assert.equal(preflightCalls, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(await records(releaseDirectory), before);
});

for (const [name, overrides] of [
  ["replace", { VBTECH_RELEASE_SHA: "a".repeat(40) }],
  ["replace the trusted apex domain in", { VBTECH_DOMAIN: "other.example" }],
  ["replace the trusted www domain in", { VBTECH_WWW_DOMAIN: "www.other.example" }],
  [
    "remove",
    {
      VBTECH_IMAGE_REF: "",
      VBTECH_RELEASE_SHA: "",
      VBTECH_FUNCTION_PATH: "",
      VBTECH_SUBMISSION_STATE: "",
    },
  ],
]) {
  test(`prepare does not let caller environment ${name} the authoritative v-b selector`, async () => {
    const { calls, dependencies, releaseDirectory } = await fixture();
    let preflightCalls = 0;
    dependencies.latestHealthyVbtechRelease = async () => VBTECH_HEALTHY;
    dependencies.runPreflight = async () => {
      preflightCalls += 1;
      throw new Error("preflight must not run");
    };

    await assert.rejects(
      prepareRelease(
        {
          environment: {
            ...ENVIRONMENT_WITH_VBTECH_DOMAINS,
            VBTECH_IMAGE_REF: VBTECH_IMAGE_REF,
            VBTECH_RELEASE_SHA: VBTECH_SHA,
            VBTECH_FUNCTION_PATH: "",
            VBTECH_SUBMISSION_STATE: "disabled",
            ...overrides,
          },
          releaseDirectory,
          vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
          readinessAttempts: 1,
        },
        dependencies,
      ),
      /caller v-b selector conflicts with preserved release/,
    );

    assert.equal(preflightCalls, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      (await records(releaseDirectory)).map(({ value }) => value.tag),
      [PREVIOUS_TAG],
    );
  });
}

for (const [name, previousVbtech] of [
  [
    "tag-based selector",
    {
      imageTag: `ghcr.io/thevladbog/vbtech-web:${VBTECH_SHA}`,
      releaseSha: VBTECH_SHA,
      functionPath: "/d4example",
      submissionState: "disabled",
    },
  ],
  [
    "partial digest selector",
    {
      imageRef: VBTECH_IMAGE_REF,
      releaseSha: VBTECH_SHA,
      functionPath: "",
      submissionState: "disabled",
    },
  ],
]) {
  test(`prepare rejects a previous Markiro record with a ${name}`, async () => {
    const { calls, dependencies, releaseDirectory } = await fixture({ previousVbtech });

    await assert.rejects(
      prepareRelease(
        {
          environment: ENVIRONMENT,
          releaseDirectory,
          readinessAttempts: 1,
          requirePreviousHealthy: true,
        },
        dependencies,
      ),
      /previous healthy release is unavailable/,
    );

    assert.deepEqual(calls, []);
  });
}

test("staged v-b activation is recorded by digest and rollback to a Markiro-only release stops its service", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();
  dependencies.runPreflight = async (environment) => ({
    imageTag: environment.MARKIRO_IMAGE_TAG,
    apiImageDigest: environment.MARKIRO_API_IMAGE_DIGEST,
    edgeImageDigest: environment.MARKIRO_EDGE_IMAGE_DIGEST,
    envFile: environment.MARKIRO_ENV_FILE,
    vbtechImageRef: VBTECH_IMAGE_REF,
    vbtechImageDigest: VBTECH_DIGEST,
    vbtechReleaseSha: VBTECH_SHA,
    vbtechDomain: "v-b.tech",
    vbtechWwwDomain: "www.v-b.tech",
    vbtechFunctionPath: "",
    vbtechSubmissionState: "disabled",
  });
  const environment = {
    ...ENVIRONMENT,
    VBTECH_IMAGE_REF: VBTECH_IMAGE_REF,
    VBTECH_RELEASE_SHA: VBTECH_SHA,
    VBTECH_FUNCTION_PATH: "",
    VBTECH_SUBMISSION_STATE: "disabled",
    VBTECH_DOMAIN: "v-b.tech",
    VBTECH_WWW_DOMAIN: "www.v-b.tech",
  };

  const candidate = await prepareRelease(
    { environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  assert.deepEqual(candidate.vbtech, VBTECH_SELECTOR);
  assert.ok(calls.some(({ args }) => args.includes("pull") && args.includes("vbtech-web")));
  assert.ok(calls.some(({ args }) => args.at(-1) === "vbtech-web" && args.includes("up")));

  await rollbackPreparedRelease(
    { candidate, environment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  assert.ok(calls.some(({ args }) => args.includes("stop") && args.includes("vbtech-web")));
});

test("two SHA release directories replace one stable Compose project and rollback restores the prior digest pair", async () => {
  const { dependencies, releaseDirectory, running } = await fixture({ withPrevious: false });
  const first = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: first, releaseDirectory });
  const secondEnvironment = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "1".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
  };
  const second = await prepareRelease(
    {
      environment: secondEnvironment,
      releaseDirectory,
      readinessAttempts: 1,
      requirePreviousHealthy: true,
    },
    dependencies,
  );

  assert.deepEqual(running, {
    apiDigest: secondEnvironment.MARKIRO_API_IMAGE_DIGEST,
    edgeDigest: secondEnvironment.MARKIRO_EDGE_IMAGE_DIGEST,
    project: "markiro-production",
  });

  await rollbackPreparedRelease(
    { candidate: second, environment: secondEnvironment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  assert.deepEqual(running, {
    apiDigest: API_DIGEST,
    edgeDigest: EDGE_DIGEST,
    project: "markiro-production",
  });
});

test("a later failed terminal event supersedes an earlier healthy event for the same first candidate", async () => {
  const { dependencies, releaseDirectory } = await fixture({ withPrevious: false });
  const first = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: first, releaseDirectory });
  await rollbackPreparedRelease(
    { candidate: first, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  dependencies.now = () => new Date("2026-08-05T10:20:31.000Z");

  const retry = await prepareRelease(
    {
      environment: ENVIRONMENT,
      releaseDirectory,
      readinessAttempts: 1,
      requireNoPreviousHealthy: true,
    },
    dependencies,
  );

  assert.equal(retry.previousTag, null);
});

test("a healthy retry of the same immutable SHA is the sole effective rollback target", async () => {
  const { dependencies, releaseDirectory, running } = await fixture({ withPrevious: false });
  const first = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: first, releaseDirectory });
  await rollbackPreparedRelease(
    { candidate: first, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );

  dependencies.now = () => new Date("2026-08-05T10:20:31.000Z");
  const retry = await prepareRelease(
    {
      environment: ENVIRONMENT,
      releaseDirectory,
      readinessAttempts: 1,
      requireNoPreviousHealthy: true,
    },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: retry, releaseDirectory });

  dependencies.now = () => new Date("2026-08-05T10:20:32.000Z");
  const nextEnvironment = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "1".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
  };
  const next = await prepareRelease(
    {
      environment: nextEnvironment,
      releaseDirectory,
      readinessAttempts: 1,
      requirePreviousHealthy: true,
    },
    dependencies,
  );

  assert.equal(next.previousTag, TAG);
  await rollbackPreparedRelease(
    { candidate: next, environment: nextEnvironment, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  assert.deepEqual(running, {
    apiDigest: API_DIGEST,
    edgeDigest: EDGE_DIGEST,
    project: "markiro-production",
  });
});

test("an already healthy immutable SHA repeat fails before mutation and leaves the next rollback unambiguous", async () => {
  const nextEnvironment = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "1".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
  };
  let failNextCandidateEdge = false;
  const { calls, dependencies, releaseDirectory, running } = await fixture({
    withPrevious: false,
    failure: ({ args, environment }) =>
      failNextCandidateEdge &&
      args.includes("up") &&
      args.at(-1) === "edge" &&
      environment.MARKIRO_IMAGE_TAG === nextEnvironment.MARKIRO_IMAGE_TAG,
  });
  const logs = [];
  dependencies.log = (event) => logs.push(event);
  const first = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: first, releaseDirectory });
  const recordsBeforeRepeat = (await records(releaseDirectory)).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const repeatCallStart = calls.length;
  const repeatLogStart = logs.length;

  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /requested release is already healthy/,
  );

  assert.deepEqual(logs.slice(repeatLogStart), ["preflight"]);
  assert.deepEqual(calls.slice(repeatCallStart), []);
  assert.deepEqual(
    (await records(releaseDirectory)).sort((left, right) => left.name.localeCompare(right.name)),
    recordsBeforeRepeat,
  );

  dependencies.now = () => new Date("2026-08-05T10:20:31.000Z");
  failNextCandidateEdge = true;
  await assert.rejects(
    prepareRelease(
      {
        environment: nextEnvironment,
        releaseDirectory,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /docker failed/,
  );

  assert.deepEqual(running, {
    apiDigest: API_DIGEST,
    edgeDigest: EDGE_DIGEST,
    project: "markiro-production",
  });
  const persisted = await records(releaseDirectory);
  assert.equal(
    persisted.filter(({ name, value }) => name.endsWith(".healthy.json") && value.tag === TAG)
      .length,
    1,
  );
  assert.equal(
    persisted.filter(
      ({ name, value }) =>
        name.endsWith(".failed.json") && value.tag === nextEnvironment.MARKIRO_IMAGE_TAG,
    ).length,
    1,
  );
});

test("a non-consecutive healthy SHA is rejected before mutation and the next failure rolls back to the sole latest healthy release", async () => {
  const environmentB = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "1".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
  };
  const environmentC = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "2".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"3".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"4".repeat(64)}`,
  };
  let failCandidateC = false;
  const { calls, dependencies, releaseDirectory, running } = await fixture({
    withPrevious: false,
    failure: ({ args, environment }) =>
      failCandidateC &&
      args.includes("up") &&
      args.at(-1) === "edge" &&
      environment.MARKIRO_IMAGE_TAG === environmentC.MARKIRO_IMAGE_TAG,
  });
  const logs = [];
  dependencies.log = (event) => logs.push(event);

  const releaseA = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: releaseA, releaseDirectory });
  dependencies.now = () => new Date("2026-08-05T10:20:31.000Z");
  const releaseB = await prepareRelease(
    {
      environment: environmentB,
      releaseDirectory,
      readinessAttempts: 1,
      requirePreviousHealthy: true,
    },
    dependencies,
  );
  await finalizePreparedRelease({ candidate: releaseB, releaseDirectory });

  const callsBeforeDuplicate = calls.length;
  const logsBeforeDuplicate = logs.length;
  const recordsBeforeDuplicate = (await records(releaseDirectory)).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /requested release is already healthy/,
  );
  assert.deepEqual(calls.slice(callsBeforeDuplicate), []);
  assert.deepEqual(logs.slice(logsBeforeDuplicate), ["preflight"]);
  assert.deepEqual(
    (await records(releaseDirectory)).sort((left, right) => left.name.localeCompare(right.name)),
    recordsBeforeDuplicate,
  );

  dependencies.now = () => new Date("2026-08-05T10:20:32.000Z");
  failCandidateC = true;
  await assert.rejects(
    prepareRelease(
      {
        environment: environmentC,
        releaseDirectory,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /docker failed/,
  );

  assert.deepEqual(running, {
    apiDigest: environmentB.MARKIRO_API_IMAGE_DIGEST,
    edgeDigest: environmentB.MARKIRO_EDGE_IMAGE_DIGEST,
    project: "markiro-production",
  });
  assert.equal(logs.at(-1), "release rolled back");
  const persisted = await records(releaseDirectory);
  assert.equal(
    persisted.filter(({ name, value }) => name.endsWith(".healthy.json") && value.tag === TAG)
      .length,
    1,
  );
  assert.equal(
    persisted.filter(
      ({ name, value }) =>
        name.endsWith(".healthy.json") && value.tag === environmentB.MARKIRO_IMAGE_TAG,
    ).length,
    1,
  );
  assert.equal(
    persisted.filter(
      ({ name, value }) =>
        name.endsWith(".failed.json") && value.tag === environmentC.MARKIRO_IMAGE_TAG,
    ).length,
    1,
  );
});

test("a finalized candidate rolled back after activation failure is not the next repeat baseline", async () => {
  const { dependencies, releaseDirectory } = await fixture();
  const candidate = await prepareRelease(
    { environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  await finalizePreparedRelease({ candidate, releaseDirectory });
  await rollbackPreparedRelease(
    { candidate, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
    dependencies,
  );
  dependencies.now = () => new Date("2026-08-05T10:20:31.000Z");
  const nextEnvironment = {
    ...ENVIRONMENT,
    MARKIRO_IMAGE_TAG: "1".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
    MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"f".repeat(64)}`,
  };

  const next = await prepareRelease(
    {
      environment: nextEnvironment,
      releaseDirectory,
      readinessAttempts: 1,
      requirePreviousHealthy: true,
    },
    dependencies,
  );

  assert.equal(next.previousTag, PREVIOUS_TAG);
});

test("a repeat deployment rejects a missing previous healthy record before migration or service start", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({ withPrevious: false });

  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /previous healthy release is unavailable/,
  );

  assert.equal(
    calls.some(({ args }) => args.includes("migrate") || args.includes("up")),
    false,
  );
});

test("a first deployment rejects an existing healthy release before persistent or Docker mutation", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture();

  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        readinessAttempts: 1,
        requireNoPreviousHealthy: true,
      },
      dependencies,
    ),
    /first deployment requires no previous healthy release/,
  );

  assert.deepEqual(
    (await records(releaseDirectory)).map(({ value }) => ({ state: value.state, tag: value.tag })),
    [{ state: "healthy", tag: PREVIOUS_TAG }],
  );
  assert.equal(
    calls.some(
      ({ args }) => args.includes("migrate") || args.includes("up") || args.includes("stop"),
    ),
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

test("a failing Markiro candidate restores the previous record's exact v-b selector", async () => {
  let candidateEdgeStarts = 0;
  const { calls, dependencies, releaseDirectory } = await fixture({
    previousVbtech: PREVIOUS_VBTECH_SELECTOR,
    failure: ({ args }) => {
      if (args.includes("up") && args.at(-1) === "edge") {
        candidateEdgeStarts += 1;
        return candidateEdgeStarts === 1;
      }
      return false;
    },
  });
  dependencies.latestHealthyVbtechRelease = async () => VBTECH_HEALTHY;

  await assert.rejects(
    prepareRelease(
      {
        environment: ENVIRONMENT,
        releaseDirectory,
        vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
        readinessAttempts: 1,
        requirePreviousHealthy: true,
      },
      dependencies,
    ),
    /docker failed/,
  );

  assert.deepEqual(
    calls.filter(({ args }) => args.includes("up")).map(({ args }) => args.at(-1)),
    ["api", "vbtech-web", "edge", "api", "vbtech-web", "edge"],
  );
  const serviceStarts = calls.filter(({ args }) => args.includes("up"));
  for (const call of serviceStarts.slice(0, 3)) {
    assert.equal(call.environment.VBTECH_IMAGE_REF, VBTECH_IMAGE_REF);
    assert.equal(call.environment.VBTECH_RELEASE_SHA, VBTECH_SHA);
    assert.equal(call.environment.VBTECH_FUNCTION_PATH, "");
    assert.equal(call.environment.VBTECH_SUBMISSION_STATE, "disabled");
  }
  const restoredCalls = serviceStarts.slice(-3);
  for (const call of restoredCalls) {
    assert.equal(call.environment.VBTECH_IMAGE_REF, PREVIOUS_VBTECH_IMAGE_REF);
    assert.equal(call.environment.VBTECH_RELEASE_SHA, PREVIOUS_VBTECH_SHA);
    assert.equal(call.environment.VBTECH_FUNCTION_PATH, "");
    assert.equal(call.environment.VBTECH_SUBMISSION_STATE, "disabled");
    assert.equal(call.environment.VBTECH_DOMAIN, "v-b.tech");
    assert.equal(call.environment.VBTECH_WWW_DOMAIN, "www.v-b.tech");
    assert.equal(Object.hasOwn(call.environment, "VBTECH_IMAGE_TAG"), false);
  }
  assert.ok(
    calls.some(
      ({ args }) => args.includes("pull") && args.includes("vbtech-web") && args.includes("api"),
    ),
  );
  const previousInspectIndex = calls.findIndex(
    ({ args }) =>
      args.at(-1) === PREVIOUS_VBTECH_IMAGE_REF &&
      args.includes("inspect") &&
      args.includes("{{json .RepoDigests}}"),
  );
  const restoredApiIndex = calls.findIndex(
    ({ args, environment }) =>
      args.includes("up") &&
      args.at(-1) === "api" &&
      environment.MARKIRO_IMAGE_TAG === PREVIOUS_TAG,
  );
  assert.ok(previousInspectIndex >= 0);
  assert.ok(previousInspectIndex < restoredApiIndex);
  const persisted = await records(releaseDirectory);
  assert.equal(
    persisted.filter(
      ({ name, value }) =>
        name.endsWith(".json") && value.tag === PREVIOUS_TAG && value.state === "healthy",
    ).length,
    1,
  );
  assert.deepEqual(
    persisted.find(({ value }) => value.tag === PREVIOUS_TAG).value.vbtech,
    PREVIOUS_VBTECH_SELECTOR,
  );
});

test("rollback refuses to start the previous services when its exact v-b digest is absent", async () => {
  const { calls, dependencies, releaseDirectory } = await fixture({
    previousVbtech: PREVIOUS_VBTECH_SELECTOR,
  });
  dependencies.latestHealthyVbtechRelease = async () => VBTECH_HEALTHY;
  const candidate = await prepareRelease(
    {
      environment: ENVIRONMENT,
      releaseDirectory,
      vbtechReleaseDirectory: VBTECH_RELEASE_DIRECTORY,
      readinessAttempts: 1,
    },
    dependencies,
  );
  const originalRun = dependencies.runner.run.bind(dependencies.runner);
  let previousVbtechInspects = 0;
  dependencies.runner.run = async (command, args, childEnvironment, timeoutMs) => {
    if (args.includes("inspect") && args.at(-1) === PREVIOUS_VBTECH_IMAGE_REF) {
      previousVbtechInspects += 1;
      return {
        code: 0,
        stdout: JSON.stringify([`ghcr.io/thevladbog/vbtech-web@sha256:${"8".repeat(64)}`]),
        stderr: "private output",
      };
    }
    return originalRun(command, args, childEnvironment, timeoutMs);
  };
  const rollbackStart = calls.length;

  await assert.rejects(
    rollbackPreparedRelease(
      { candidate, environment: ENVIRONMENT, releaseDirectory, readinessAttempts: 1 },
      dependencies,
    ),
    /approved image digest is not present/,
  );

  const rollbackCalls = calls.slice(rollbackStart);
  assert.equal(previousVbtechInspects, 1);
  assert.equal(
    rollbackCalls.some(({ args }) => args.includes("up")),
    false,
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
