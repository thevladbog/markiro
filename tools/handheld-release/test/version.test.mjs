import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHandheldManifest, handheldArtifactUrl } from "../manifest.mjs";
import {
  bumpHandheldVersion,
  HANDHELD_DISTRIBUTION_BASELINE,
  nextHandheldRelease,
} from "../version.mjs";

const published = (versionName, versionCode) =>
  JSON.stringify(
    buildHandheldManifest({
      versionName,
      versionCode,
      sha256: "a".repeat(64),
      bytes: 10,
      url: handheldArtifactUrl({ channel: "stable", versionName }),
      notes: "предыдущая",
      releasedAt: "2026-09-11T10:00:00.000Z",
      sourceSha: "b".repeat(40),
    }),
  );

test("a bump moves exactly one component and zeroes the ones below it", () => {
  assert.equal(bumpHandheldVersion("0.4.7", "patch"), "0.4.8");
  assert.equal(bumpHandheldVersion("0.4.7", "minor"), "0.5.0");
  assert.equal(bumpHandheldVersion("0.4.7", "major"), "1.0.0");
  assert.throws(() => bumpHandheldVersion("0.4.7", "nightly"));
  for (const bad of ["0.4", "v1.0.0", "1.0.0-rc1", "01.0.0", ""]) {
    assert.throws(() => bumpHandheldVersion(bad, "patch"), undefined, `accepted ${bad}`);
  }
});

/**
 * The number nobody types is the number nobody gets wrong. A repeated
 * `versionCode` is an update every installed terminal silently refuses, and it
 * is visible on a factory floor and nowhere else.
 */
test("the versionCode is taken from the channel and always grows by one", () => {
  assert.deepEqual(nextHandheldRelease({ publishedText: published("0.4.7", 12), bump: "patch" }), {
    versionName: "0.4.8",
    versionCode: 13,
    first: false,
  });
  assert.deepEqual(nextHandheldRelease({ publishedText: published("0.4.7", 12), bump: "major" }), {
    versionName: "1.0.0",
    versionCode: 13,
    first: false,
  });
});

test("an empty channel publishes the baseline, and says so", () => {
  const first = nextHandheldRelease({ publishedText: null, bump: "patch" });
  assert.deepEqual(first, {
    versionName: HANDHELD_DISTRIBUTION_BASELINE,
    versionCode: 1,
    first: true,
  });
  // `bump` has nothing to apply to on an empty channel, and must not silently
  // look as though it did.
  assert.deepEqual(nextHandheldRelease({ publishedText: null, bump: "major" }), first);
});

test("a published manifest this build cannot read stops the release", () => {
  // Treating it as «nothing is published» would restart the versionCode at 1,
  // and every terminal would refuse the update.
  for (const bad of ["not json", "{}", JSON.stringify({ versionCode: 4 })]) {
    assert.throws(() => nextHandheldRelease({ publishedText: bad, bump: "patch" }));
  }
});

test("a versionCode at the Android ceiling refuses rather than wrapping", () => {
  assert.throws(
    () => nextHandheldRelease({ publishedText: published("0.4.7", 2 ** 31 - 1), bump: "patch" }),
    /run out of Android int/,
  );
});
