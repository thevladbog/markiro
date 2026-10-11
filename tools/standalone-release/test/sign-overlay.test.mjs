import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { buildSignOverlay } from "../sign-overlay.mjs";

const THUMBPRINT = "0123456789abcdef0123456789abcdef01234567";

test("builds the Tauri overlay that signs with a certificate from the store", () => {
  assert.deepEqual(
    buildSignOverlay({
      thumbprint: "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67",
      timestampUrl: "http://timestamp.example.org",
    }),
    {
      bundle: {
        windows: {
          certificateThumbprint: THUMBPRINT.toUpperCase(),
          digestAlgorithm: "sha256",
          timestampUrl: "http://timestamp.example.org/",
          tsp: true,
        },
      },
    },
  );
});

test("refuses a thumbprint that is not a SHA-1 and a timestamp server that is no URL", () => {
  for (const thumbprint of ["", "0123", `${THUMBPRINT}00`, "g".repeat(40), undefined]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint, timestampUrl: "http://timestamp.example.org" }),
      /40 hex digits/,
    );
  }
  for (const timestampUrl of ["", "timestamp.example.org", "ftp://timestamp.example.org"]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint: THUMBPRINT, timestampUrl }),
      /http or https/,
    );
  }
});

const SIGN = join(import.meta.dirname, "..", "sign-overlay.mjs");

test("a thumbprint is matched whole: no prefix, no suffix, no other characters", () => {
  const timestampUrl = "https://timestamp.example.org";
  for (const thumbprint of [
    `zz${THUMBPRINT}`,
    `${THUMBPRINT}\n--oops`,
    `0x${THUMBPRINT.slice(2)}`,
  ]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint, timestampUrl }),
      /40 hex digits/,
      thumbprint,
    );
  }
  assert.equal(
    buildSignOverlay({ thumbprint: THUMBPRINT.toUpperCase(), timestampUrl }).bundle.windows
      .timestampUrl,
    "https://timestamp.example.org/",
  );
});

test("only http and https servers without credentials are accepted", () => {
  for (const timestampUrl of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint: THUMBPRINT, timestampUrl }),
      /http or https/,
      timestampUrl,
    );
  }
  for (const timestampUrl of [
    "http://user:pw@ts.example.org",
    "https://user@ts.example.org",
    "https://:pw@ts.example.org",
  ]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint: THUMBPRINT, timestampUrl }),
      /must not contain credentials/,
      timestampUrl,
    );
  }
});

test("the overlay is deterministic and carries nothing but the public certificate id", () => {
  const input = { thumbprint: THUMBPRINT, timestampUrl: "http://timestamp.example.org" };
  assert.equal(JSON.stringify(buildSignOverlay(input)), JSON.stringify(buildSignOverlay(input)));
  assert.deepEqual(Object.keys(buildSignOverlay(input).bundle.windows).sort(), [
    "certificateThumbprint",
    "digestAlgorithm",
    "timestampUrl",
    "tsp",
  ]);
});

test("the command line prints the overlay, and a refusal prints no overlay", () => {
  const ok = spawnSync(
    process.execPath,
    [SIGN, "--thumbprint", THUMBPRINT, "--timestamp-url", "http://timestamp.example.org"],
    { encoding: "utf8" },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    ok.stdout,
    `${JSON.stringify(buildSignOverlay({ thumbprint: THUMBPRINT, timestampUrl: "http://timestamp.example.org" }), null, 2)}\n`,
  );
  const bad = spawnSync(process.execPath, [SIGN, "--thumbprint", "0123"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /40 hex digits/);
  // An option the tool does not know is an error, even beside a valid pair.
  const unknown = spawnSync(
    process.execPath,
    [
      SIGN,
      "--thumbprint",
      THUMBPRINT,
      "--timestamp-url",
      "http://timestamp.example.org",
      "--password",
      "x",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
});

test("importing the module runs nothing", () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${SIGN}`)})`],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
});
