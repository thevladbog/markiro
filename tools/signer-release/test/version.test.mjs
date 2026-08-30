import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTagIsFree,
  readSignerVersion,
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
