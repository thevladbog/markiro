import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { composeQuiet, runPreflight } from "../preflight.mjs";

const release = {
  MARKIRO_IMAGE_TAG: "0123456789abcdef0123456789abcdef01234567",
  MARKIRO_DOMAIN: "app.markiro.example",
  ACME_EMAIL: "ops@example.test",
};

function dependencies({ mode = 0o600, composeError } = {}) {
  return {
    mode: async () => mode,
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

test("accepts immutable release inputs and a private environment file", async () => {
  const result = await runPreflight(release, dependencies());

  assert.deepEqual(result, {
    imageTag: release.MARKIRO_IMAGE_TAG,
    domain: release.MARKIRO_DOMAIN,
    acmeEmail: release.ACME_EMAIL,
    envFile: ".env.production",
  });
});

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
