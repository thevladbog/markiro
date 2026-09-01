import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTagIsFree,
  buildTauriVersionOverlay,
  bumpSignerVersion,
  compareVersions,
  parseSignerReleaseTag,
  readSignerVersion,
  reconcileStableVersions,
  signerArtifactNames,
  signerReleaseTag,
} from "../version.mjs";

test("reads the version from the signer's own Tauri config", async () => {
  // One source of truth. Anything that names the version a second time
  // eventually disagrees with this one.
  assert.match(await readSignerVersion(), /^\d+\.\d+\.\d+$/);
});

test("derives the tag from the version", () => {
  assert.equal(signerReleaseTag("0.1.0"), "signer-v0.1.0");
});

test("refuses a version that was already published", () => {
  // Re-dispatching after a partial failure is the normal way this workflow
  // gets used. Replacing a published artifact would break the signature
  // clients already trust, so the gate refuses instead of overwriting.
  assert.throws(
    () => assertTagIsFree("signer-v0.1.0", ["signer-v0.0.9", "signer-v0.1.0"]),
    /already published/,
  );
});

test("accepts a version that has never been published", () => {
  assert.doesNotThrow(() => assertTagIsFree("signer-v0.2.0", ["signer-v0.1.0"]));
});

test("names the NSIS installer and its detached signature", () => {
  // With targets: ["nsis"], Tauri 2's updater artifact is the setup .exe
  // itself plus a sibling .sig — there is no .nsis.zip.
  assert.deepEqual(signerArtifactNames("0.1.0"), {
    installer: "markiro-signer-0.1.0-windows-x86_64-setup.exe",
    signature: "markiro-signer-0.1.0-windows-x86_64-setup.exe.sig",
  });
});

test("parses only stable signer release tags", () => {
  assert.equal(parseSignerReleaseTag("signer-v0.1.4"), "0.1.4");
  assert.equal(parseSignerReleaseTag("signer-v0.1.4-beta.1"), null);
  assert.equal(parseSignerReleaseTag("station-v0.1.4"), null);
  assert.equal(parseSignerReleaseTag("signer-v00.1.4"), null);
});

test("compares semantic components numerically", () => {
  assert.equal(compareVersions("10.0.0", "2.99.99"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.99"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.2", "1.2.3"), -1);
});

test("bumps the agreed stable version", () => {
  assert.equal(bumpSignerVersion("0.1.4", "patch"), "0.1.5");
  assert.equal(bumpSignerVersion("0.1.4", "minor"), "0.2.0");
  assert.equal(bumpSignerVersion("0.1.4", "major"), "1.0.0");
  assert.throws(() => bumpSignerVersion("0.1.4", "beta"), /unsupported signer bump/);
});

test("refuses split-brain stable channels", () => {
  assert.throws(
    () => reconcileStableVersions({ githubVersion: "0.1.4", yandexVersion: "0.1.5" }),
    /repair/,
  );
  assert.throws(
    () => reconcileStableVersions({ githubVersion: "0.1.5", yandexVersion: null }),
    /repair/,
  );
});

test("accepts empty, aligned, and one-time migration channel state", () => {
  assert.deepEqual(reconcileStableVersions({ githubVersion: null, yandexVersion: null }), {
    kind: "empty",
  });
  assert.deepEqual(
    reconcileStableVersions({ githubVersion: "0.1.5", yandexVersion: "0.1.5" }),
    { kind: "aligned", version: "0.1.5" },
  );
  assert.deepEqual(
    reconcileStableVersions({ githubVersion: null, yandexVersion: "0.1.4" }),
    { kind: "aligned", version: "0.1.4" },
  );
});

test("builds a one-key Tauri version overlay", () => {
  assert.deepEqual(buildTauriVersionOverlay("0.1.5"), { version: "0.1.5" });
  assert.throws(() => buildTauriVersionOverlay("0.1.5-beta.1"), /stable semantic version/);
});
