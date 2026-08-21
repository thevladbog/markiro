import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { composeQuiet, runPreflight } from "../preflight.mjs";

const release = {
  MARKIRO_IMAGE_TAG: "0123456789abcdef0123456789abcdef01234567",
  MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  MARKIRO_DOMAIN: "app.markiro.example",
  MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
  MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
  MARKIRO_LANDING_DOMAIN: "markiro.example",
  ACME_EMAIL: "ops@example.test",
};

const vbtechRelease = {
  ...release,
  VBTECH_IMAGE_TAG: `ghcr.io/thevladbog/vbtech-web:${"c".repeat(40)}`,
  VBTECH_DOMAIN: "v-b.tech",
  VBTECH_WWW_DOMAIN: "www.v-b.tech",
  VBTECH_FUNCTION_ORIGIN: "https://functions.yandexcloud.net/d4example",
  VBTECH_SUBMISSION_STATE: "disabled",
};

test("documents every digest selector input and output in the preflight interface", async () => {
  const source = await readFile(new URL("../preflight.mjs", import.meta.url), "utf8");

  for (const input of [
    "MARKIRO_IMAGE_TAG",
    "MARKIRO_API_IMAGE_DIGEST",
    "MARKIRO_EDGE_IMAGE_DIGEST",
    "MARKIRO_DOMAIN",
    "MARKIRO_SAAS_ADMIN_DOMAIN",
    "MARKIRO_KIOSK_DOMAIN",
    "MARKIRO_LANDING_DOMAIN",
    "MARKIRO_EDGE_MODE",
    "ACME_EMAIL",
    "MARKIRO_ENV_FILE",
    "MARKIRO_HTTP_PORT",
    "MARKIRO_HTTPS_PORT",
  ])
    assert.match(source, new RegExp(`@property \\{string \\| undefined\\} ${input}`));

  for (const output of [
    "apiImageDigest",
    "edgeImageDigest",
    "domain",
    "saasAdminDomain",
    "kioskDomain",
    "landingDomain",
    "envFile",
  ])
    assert.match(source, new RegExp(`@property \\{string\\} ${output}`));
  assert.match(source, /@property \{string \| undefined\} imageTag/);
  assert.match(source, /@property \{string \| undefined\} acmeEmail/);
  assert.match(source, /@property \{"direct"\} edgeMode/);
});

function dependencies({
  mode = 0o600,
  envText = "KIOSK_ORIGIN=https://kiosk.markiro.example\nSAAS_ADMIN_ORIGIN=https://saas-admin.markiro.example\n",
  composeError,
} = {}) {
  return {
    mode: async () => mode,
    readText: async () => envText,
    composeQuiet: async () => {
      if (composeError) throw composeError;
    },
  };
}

async function assertRejected(environment, expectedMessage) {
  await assert.rejects(runPreflight(environment, dependencies()), (error) => {
    assert.equal(error.message, expectedMessage);
    for (const value of Object.values(environment)) {
      if (value)
        assert.doesNotMatch(
          error.message,
          new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
    }
    return true;
  });
}

test("accepts digest-pinned release inputs and a private environment file", async () => {
  const result = await runPreflight(release, dependencies());

  assert.deepEqual(result, {
    imageTag: release.MARKIRO_IMAGE_TAG,
    apiImageDigest: release.MARKIRO_API_IMAGE_DIGEST,
    edgeImageDigest: release.MARKIRO_EDGE_IMAGE_DIGEST,
    domain: release.MARKIRO_DOMAIN,
    saasAdminDomain: release.MARKIRO_SAAS_ADMIN_DOMAIN,
    kioskDomain: release.MARKIRO_KIOSK_DOMAIN,
    landingDomain: release.MARKIRO_LANDING_DOMAIN,
    acmeEmail: release.ACME_EMAIL,
    envFile: ".env.production",
    edgeMode: "direct",
  });
});

test("accepts a complete isolated v-b overlay and derives only bounded Caddy inputs", async () => {
  let validatedEnvironment;
  const result = await runPreflight(vbtechRelease, {
    ...dependencies(),
    composeQuiet: async (environment) => {
      validatedEnvironment = environment;
    },
  });

  assert.equal(result.vbtechImageTag, vbtechRelease.VBTECH_IMAGE_TAG);
  assert.equal(result.vbtechReleaseSha, "c".repeat(40));
  assert.equal(result.vbtechDomain, "v-b.tech");
  assert.equal(result.vbtechWwwDomain, "www.v-b.tech");
  assert.equal(result.vbtechFunctionPath, "/d4example");
  assert.equal(result.vbtechSubmissionState, "disabled");
  assert.equal(validatedEnvironment.VBTECH_RELEASE_SHA, "c".repeat(40));
  assert.equal(validatedEnvironment.VBTECH_FUNCTION_PATH, "/d4example");
  assert.equal(validatedEnvironment.VBTECH_SUBMISSION_STATE, "disabled");
});

for (const [name, overrides, expected] of [
  ["partial overlay", { VBTECH_FUNCTION_ORIGIN: undefined }, "VBTECH_FUNCTION_ORIGIN is invalid"],
  [
    "mutable image",
    { VBTECH_IMAGE_TAG: "ghcr.io/thevladbog/vbtech-web:latest" },
    "VBTECH_IMAGE_TAG is invalid",
  ],
  ["wrong apex", { VBTECH_DOMAIN: "vb.tech" }, "VBTECH_DOMAIN is invalid"],
  ["wrong www", { VBTECH_WWW_DOMAIN: "www2.v-b.tech" }, "VBTECH_WWW_DOMAIN is invalid"],
  [
    "insecure function",
    { VBTECH_FUNCTION_ORIGIN: "http://functions.yandexcloud.net/d4example" },
    "VBTECH_FUNCTION_ORIGIN is invalid",
  ],
  [
    "foreign function host",
    { VBTECH_FUNCTION_ORIGIN: "https://example.test/d4example" },
    "VBTECH_FUNCTION_ORIGIN is invalid",
  ],
  [
    "function query",
    { VBTECH_FUNCTION_ORIGIN: "https://functions.yandexcloud.net/d4example?token=private" },
    "VBTECH_FUNCTION_ORIGIN is invalid",
  ],
  ["unknown state", { VBTECH_SUBMISSION_STATE: "private" }, "VBTECH_SUBMISSION_STATE is invalid"],
]) {
  test(`rejects ${name} v-b configuration without disclosing it`, () =>
    assertRejected({ ...vbtechRelease, ...overrides }, expected));
}

test("requires ACME email for the only supported direct edge mode", async () => {
  await assertRejected({ ...release, ACME_EMAIL: undefined }, "ACME_EMAIL is invalid");
});

test("rejects an unknown edge mode without disclosing it", async () => {
  await assertRejected(
    { ...release, MARKIRO_EDGE_MODE: "private-value" },
    "MARKIRO_EDGE_MODE is invalid",
  );
});

test("rejects the retired behind-alb mode", async () => {
  await assertRejected(
    { ...release, MARKIRO_EDGE_MODE: "behind-alb" },
    "MARKIRO_EDGE_MODE is invalid",
  );
});

test("passes optional host port overrides unchanged to Compose validation", async () => {
  let validatedEnvironment;

  await runPreflight(
    { ...release, MARKIRO_HTTP_PORT: "18080", MARKIRO_HTTPS_PORT: "18443" },
    {
      ...dependencies({
        envText:
          "KIOSK_ORIGIN=https://kiosk.markiro.example:18443\nSAAS_ADMIN_ORIGIN=https://saas-admin.markiro.example:18443\n",
      }),
      composeQuiet: async (environment) => {
        validatedEnvironment = environment;
      },
    },
  );

  assert.equal(validatedEnvironment.MARKIRO_HTTP_PORT, "18080");
  assert.equal(validatedEnvironment.MARKIRO_HTTPS_PORT, "18443");
});

test("does not inject absent optional host ports into Compose validation", async () => {
  let validatedEnvironment;

  await runPreflight(release, {
    ...dependencies(),
    composeQuiet: async (environment) => {
      validatedEnvironment = environment;
    },
  });

  assert.equal(Object.hasOwn(validatedEnvironment, "MARKIRO_HTTP_PORT"), false);
  assert.equal(Object.hasOwn(validatedEnvironment, "MARKIRO_HTTPS_PORT"), false);
});

test("passes the SaaS admin, kiosk and landing domains to Compose validation", async () => {
  let validatedEnvironment;

  await runPreflight(release, {
    ...dependencies(),
    composeQuiet: async (environment) => {
      validatedEnvironment = environment;
    },
  });

  assert.equal(validatedEnvironment.MARKIRO_SAAS_ADMIN_DOMAIN, release.MARKIRO_SAAS_ADMIN_DOMAIN);
  assert.equal(validatedEnvironment.MARKIRO_KIOSK_DOMAIN, release.MARKIRO_KIOSK_DOMAIN);
  assert.equal(validatedEnvironment.MARKIRO_LANDING_DOMAIN, release.MARKIRO_LANDING_DOMAIN);
});

test("rejects a runtime SaaS origin that does not match the exact production host", async () => {
  await assert.rejects(
    runPreflight(
      release,
      dependencies({
        envText:
          "KIOSK_ORIGIN=https://kiosk.markiro.example\nSAAS_ADMIN_ORIGIN=https://other.markiro.example\n",
      }),
    ),
    /SAAS_ADMIN_ORIGIN does not match MARKIRO_SAAS_ADMIN_DOMAIN/,
  );
});

for (const [variable, value] of [
  ["MARKIRO_API_IMAGE_DIGEST", undefined],
  ["MARKIRO_EDGE_IMAGE_DIGEST", undefined],
  ["MARKIRO_API_IMAGE_DIGEST", "sha256:abc"],
  ["MARKIRO_EDGE_IMAGE_DIGEST", `sha256:${"A".repeat(64)}`],
  ["MARKIRO_API_IMAGE_DIGEST", `SHA256:${"a".repeat(64)}`],
  ["MARKIRO_EDGE_IMAGE_DIGEST", `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`],
  ["MARKIRO_API_IMAGE_DIGEST", "0123456789abcdef0123456789abcdef01234567"],
]) {
  test(`rejects malformed or missing ${variable} without disclosing it`, () =>
    assertRejected({ ...release, [variable]: value }, `${variable} is invalid`));
}

for (const [name, imageTag] of [
  ["latest", "latest"],
  ["7-character hash", "0123456"],
  ["39-character hash", "0123456789abcdef0123456789abcdef0123456"],
  ["41-character hash", "0123456789abcdef0123456789abcdef012345678"],
  ["uppercase hash", "0123456789ABCDEF0123456789abcdef01234567"],
]) {
  test(`rejects ${name} image tags without disclosing them`, () =>
    assertRejected({ ...release, MARKIRO_IMAGE_TAG: imageTag }, "MARKIRO_IMAGE_TAG is invalid"));
}

for (const [name, domain] of [
  ["scheme", "https://app.markiro.example"],
  ["path", "app.markiro.example/admin"],
  ["port", "app.markiro.example:443"],
]) {
  test(`rejects a domain with a ${name} without disclosing it`, () =>
    assertRejected({ ...release, MARKIRO_DOMAIN: domain }, "MARKIRO_DOMAIN is invalid"));
}

for (const [name, domain] of [
  ["missing value", undefined],
  ["scheme", "https://kiosk.markiro.example"],
  ["path", "kiosk.markiro.example/pickup"],
  ["port", "kiosk.markiro.example:443"],
  ["uppercase label", "Kiosk.markiro.example"],
  ["single-label production name", "kiosk"],
]) {
  test(`rejects a kiosk domain with a ${name} without disclosing it`, () =>
    assertRejected(
      { ...release, MARKIRO_KIOSK_DOMAIN: domain },
      "MARKIRO_KIOSK_DOMAIN is invalid",
    ));
}

for (const [name, domain] of [
  ["missing value", undefined],
  ["scheme", "https://markiro.example"],
  ["path", "markiro.example/landing"],
  ["port", "markiro.example:443"],
  ["uppercase label", "Markiro.example"],
  ["single-label production name", "landing"],
]) {
  test(`rejects a landing domain with a ${name} without disclosing it`, () =>
    assertRejected(
      { ...release, MARKIRO_LANDING_DOMAIN: domain },
      "MARKIRO_LANDING_DOMAIN is invalid",
    ));
}

test("rejects equal production domains without disclosing them", () =>
  assertRejected(
    { ...release, MARKIRO_KIOSK_DOMAIN: release.MARKIRO_DOMAIN },
    "production domains must be distinct",
  ));

test("rejects a landing domain equal to another authority", async () => {
  await assertRejected(
    { ...release, MARKIRO_LANDING_DOMAIN: release.MARKIRO_DOMAIN },
    "production domains must be distinct",
  );
  await assertRejected(
    { ...release, MARKIRO_LANDING_DOMAIN: release.MARKIRO_KIOSK_DOMAIN },
    "production domains must be distinct",
  );
});

test("accepts only the explicit local direct-mode domain set", async () => {
  const result = await runPreflight(
    {
      ...release,
      MARKIRO_DOMAIN: "localhost",
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
      MARKIRO_KIOSK_DOMAIN: "kiosk.localhost",
      MARKIRO_LANDING_DOMAIN: "landing.localhost",
    },
    dependencies({
      envText:
        "KIOSK_ORIGIN=https://kiosk.localhost\nSAAS_ADMIN_ORIGIN=https://saas-admin.localhost\n",
    }),
  );

  assert.equal(result.domain, "localhost");
  assert.equal(result.kioskDomain, "kiosk.localhost");
  assert.equal(result.landingDomain, "landing.localhost");
  await assertRejected({ ...release, MARKIRO_DOMAIN: "localhost" }, "MARKIRO_DOMAIN is invalid");
  await assertRejected(
    { ...release, MARKIRO_KIOSK_DOMAIN: "kiosk.localhost" },
    "MARKIRO_KIOSK_DOMAIN is invalid",
  );
  await assertRejected(
    { ...release, MARKIRO_KIOSK_DOMAIN: "localhost" },
    "MARKIRO_KIOSK_DOMAIN is invalid",
  );
  await assertRejected(
    {
      ...release,
      MARKIRO_DOMAIN: "localhost",
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
      MARKIRO_KIOSK_DOMAIN: "kiosk.localhost",
      MARKIRO_LANDING_DOMAIN: "landing.localhost",
      MARKIRO_EDGE_MODE: "behind-alb",
    },
    "MARKIRO_EDGE_MODE is invalid",
  );
});

for (const [name, envText] of [
  ["missing", "OTHER=value\n"],
  [
    "duplicate",
    "KIOSK_ORIGIN=https://kiosk.markiro.example\nKIOSK_ORIGIN=https://kiosk.markiro.example\n",
  ],
  ["empty", "KIOSK_ORIGIN=\n"],
  ["mismatched", "KIOSK_ORIGIN=https://other.markiro.example\n"],
  ["path-bearing", "KIOSK_ORIGIN=https://kiosk.markiro.example/pickup\n"],
  ["production port-bearing", "KIOSK_ORIGIN=https://kiosk.markiro.example:443\n"],
]) {
  test(`rejects a ${name} KIOSK_ORIGIN without disclosing it`, async () => {
    const origin = envText.split("=")[1]?.trim();
    await assert.rejects(runPreflight(release, dependencies({ envText })), (error) => {
      assert.equal(error.message, "KIOSK_ORIGIN does not match MARKIRO_KIOSK_DOMAIN");
      if (origin)
        assert.doesNotMatch(
          error.message,
          new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      return true;
    });
  });
}

test("accepts the direct-mode HTTPS port in the kiosk origin", async () => {
  const result = await runPreflight(
    {
      ...release,
      MARKIRO_DOMAIN: "localhost",
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
      MARKIRO_KIOSK_DOMAIN: "kiosk.localhost",
      MARKIRO_LANDING_DOMAIN: "landing.localhost",
      MARKIRO_HTTPS_PORT: "18443",
    },
    dependencies({
      envText:
        "KIOSK_ORIGIN=https://kiosk.localhost:18443\nSAAS_ADMIN_ORIGIN=https://saas-admin.localhost:18443\n",
    }),
  );

  assert.equal(result.kioskDomain, "kiosk.localhost");
  assert.equal(result.landingDomain, "landing.localhost");
});

test("rejects an invalid ACME email without disclosing it", () =>
  assertRejected({ ...release, ACME_EMAIL: "not-an-email" }, "ACME_EMAIL is invalid"));

test("rejects a missing environment file without disclosing its path", async () => {
  await assert.rejects(
    runPreflight(
      { ...release, MARKIRO_ENV_FILE: "/private/missing.env" },
      {
        ...dependencies(),
        mode: async () => {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        },
      },
    ),
    (error) => error.message === "MARKIRO_ENV_FILE is missing",
  );
});

test("rejects an environment file that is not mode 0600", async () => {
  await assert.rejects(
    runPreflight(release, dependencies({ mode: 0o644 })),
    (error) => error.message === "MARKIRO_ENV_FILE mode must be 0600",
  );
});

test("reports quiet Compose failures without its stderr or environment values", async () => {
  await assert.rejects(
    runPreflight(release, dependencies({ composeError: new Error("secret=do-not-print") })),
    (error) => error.message === "Compose validation failed",
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

test("passes optional host port overrides to the Compose child without other environment values", async () => {
  const child = fakeChild();
  let childEnvironment;
  const validation = composeQuiet(
    {
      ...release,
      MARKIRO_ENV_FILE: "/private/production.env",
      MARKIRO_HTTP_PORT: "18080",
      MARKIRO_HTTPS_PORT: "18443",
    },
    {
      spawn: (_command, _args, options) => {
        childEnvironment = options.env;
        return child;
      },
    },
  );
  child.emit("close", 0);
  await validation;

  assert.equal(childEnvironment.MARKIRO_HTTP_PORT, "18080");
  assert.equal(childEnvironment.MARKIRO_HTTPS_PORT, "18443");
  assert.equal(childEnvironment.MARKIRO_SAAS_ADMIN_DOMAIN, release.MARKIRO_SAAS_ADMIN_DOMAIN);
  assert.equal(childEnvironment.MARKIRO_KIOSK_DOMAIN, release.MARKIRO_KIOSK_DOMAIN);
  assert.equal(childEnvironment.MARKIRO_LANDING_DOMAIN, release.MARKIRO_LANDING_DOMAIN);
});

test("does not add undefined host port keys to the Compose child environment", async () => {
  const child = fakeChild();
  let childEnvironment;
  const validation = composeQuiet(
    { ...release, MARKIRO_ENV_FILE: "/private/production.env" },
    {
      spawn: (_command, _args, options) => {
        childEnvironment = options.env;
        return child;
      },
    },
  );
  child.emit("close", 0);
  await validation;

  assert.equal(Object.hasOwn(childEnvironment, "MARKIRO_HTTP_PORT"), false);
  assert.equal(Object.hasOwn(childEnvironment, "MARKIRO_HTTPS_PORT"), false);
});

function fakeClock() {
  const timers = [];
  return {
    timers,
    schedule(callback, delay) {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.active = false;
    },
    fire(delay) {
      const timer = timers.find((candidate) => candidate.active && candidate.delay === delay);
      assert.ok(timer, `expected an active ${delay}ms timer`);
      timer.active = false;
      timer.callback();
    },
  };
}

test("uses a 30-second Compose deadline and terminates then kills before settling", async () => {
  const child = fakeChild();
  const clock = fakeClock();
  const validation = composeQuiet(
    { ...release, MARKIRO_ENV_FILE: "/private/production.env" },
    {
      spawn: () => child,
      schedule: clock.schedule,
      cancel: clock.cancel,
    },
  );
  const queuedClose = child.listeners("close")[0];
  const queuedError = child.listeners("error")[0];

  clock.fire(30_000);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  clock.fire(1_000);
  await assert.rejects(validation, (error) => error.message === "Compose validation failed");

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    clock.timers.some(({ active }) => active),
    false,
  );
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  queuedClose(0);
  queuedError(new Error("late private child error"));
});

test("bounds Compose stderr without disclosing it", async () => {
  const child = fakeChild();
  const clock = fakeClock();
  const validation = composeQuiet(release, {
    spawn: () => child,
    schedule: clock.schedule,
    cancel: clock.cancel,
    timeoutMs: 30,
    terminationGraceMs: 1,
  });
  let conversions = 0;
  const privateChunk = {
    toString() {
      conversions += 1;
      return "s".repeat(1_024);
    },
  };
  for (let index = 0; index < 128; index += 1) child.stderr.emit("data", privateChunk);
  child.emit("close", 1);

  await assert.rejects(validation, (error) => error.message === "Compose validation failed");
  assert.equal(conversions, 8);
});

test("settles once across a Compose error-close race", async () => {
  const child = fakeChild();
  const clock = fakeClock();
  const validation = composeQuiet(release, {
    spawn: () => child,
    schedule: clock.schedule,
    cancel: clock.cancel,
    timeoutMs: 30,
    terminationGraceMs: 1,
  });
  const queuedClose = child.listeners("close")[0];
  child.emit("error", new Error("private spawn detail"));
  queuedClose(0);

  await assert.rejects(validation, (error) => error.message === "Compose validation failed");
  assert.equal(
    clock.timers.some(({ active }) => active),
    false,
  );
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("sanitizes a synchronous Compose spawn failure", async () => {
  const clock = fakeClock();

  await assert.rejects(
    composeQuiet(release, {
      spawn: () => {
        throw new Error("private synchronous spawn detail");
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
      timeoutMs: 30,
      terminationGraceMs: 1,
    }),
    (error) => error.message === "Compose validation failed",
  );
  assert.equal(clock.timers.length, 0);
});
