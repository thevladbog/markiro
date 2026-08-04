import assert from "node:assert/strict";
import test from "node:test";

import { runPreflight } from "../preflight.mjs";

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
