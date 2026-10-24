import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
test("runtime package contains byte-identical canonical validators and supports the API CommonJS runtime", async () => {
  for (const path of [
    "station-release/artifacts.mjs",
    "station-release/origins.mjs",
    "station-release/version.mjs",
    "handheld-release/manifest.mjs",
    "signer-release/artifacts.mjs",
    "signer-release/manifest.mjs",
    "signer-release/version.mjs",
  ]) {
    assert.deepEqual(
      await readFile(new URL(`../dist/${path}`, import.meta.url)),
      await readFile(new URL(`../../../tools/${path}`, import.meta.url)),
    );
  }
  const runtime = require("../dist/index.mjs");
  assert.equal(typeof runtime.validateSignerReleaseFiles, "function");
  assert.equal(typeof runtime.validateStationReleaseFiles, "function");
  assert.equal(runtime.handheldApkName("1.7.0"), "markiro-tsd-1.7.0.apk");
});
