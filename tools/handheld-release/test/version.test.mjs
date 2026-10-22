import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildHandheldManifest, handheldArtifactUrl } from "../manifest.mjs";
import {
  bumpHandheldVersion,
  HANDHELD_EMPTY_CHANNEL_CONFIRMATION,
  HANDHELD_LAST_DISTRIBUTED,
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
  assert.deepEqual(nextHandheldRelease({ publishedText: published("1.6.1", 15), bump: "patch" }), {
    versionName: "1.6.2",
    versionCode: 16,
  });
  assert.deepEqual(nextHandheldRelease({ publishedText: published("1.6.1", 15), bump: "major" }), {
    versionName: "2.0.0",
    versionCode: 16,
  });
});

test("the recorded last build is the one terminals in the field may run", () => {
  // Stable 1.6.0 (14) was the last published build; the pilot artifact 1.6.1
  // (15) is newer and may have been installed by hand.
  assert.deepEqual(HANDHELD_LAST_DISTRIBUTED, { versionName: "1.6.1", versionCode: 15 });
  assert.equal(HANDHELD_EMPTY_CHANNEL_CONFIRMATION, "1.6.1 (15)");
});

test("an empty channel continues after the recorded build, never from versionCode 1", () => {
  for (const confirmation of [undefined, "", "1.6.0 (14)", "1.6.1", " 1.6.1 (15)"]) {
    assert.throws(
      () =>
        nextHandheldRelease({
          publishedText: null,
          bump: "minor",
          ...(confirmation === undefined ? {} : { emptyChannelConfirmation: confirmation }),
        }),
      /serves no latest\.json/,
      String(confirmation),
    );
  }
  assert.deepEqual(
    nextHandheldRelease({
      publishedText: null,
      bump: "minor",
      emptyChannelConfirmation: "1.6.1 (15)",
    }),
    { versionName: "1.7.0", versionCode: 16 },
  );
  assert.deepEqual(
    nextHandheldRelease({
      publishedText: null,
      bump: "patch",
      channel: "beta",
      emptyChannelConfirmation: "1.6.1 (15)",
    }),
    { versionName: "1.6.2", versionCode: 16 },
  );
});

test("a channel that serves a pointer refuses the empty-channel confirmation", () => {
  assert.throws(
    () =>
      nextHandheldRelease({
        publishedText: published("1.7.0", 16),
        bump: "patch",
        emptyChannelConfirmation: "1.6.1 (15)",
      }),
    /already serves a pointer/,
  );
});

test("a pointer older than the recorded build cannot step under it", () => {
  // A restored stale pointer (1.6.0, 14) would otherwise publish versionCode
  // 15, which terminals running the pilot build refuse.
  assert.throws(
    () => nextHandheldRelease({ publishedText: published("1.6.0", 14), bump: "patch" }),
    /would not upgrade terminals running 1\.6\.1 \(15\)/,
  );
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

test("the release runbook types the same confirmation the resolver expects", () => {
  const runbook = readFileSync(
    new URL("../../../docs/runbooks/handheld-release.md", import.meta.url),
    "utf8",
  );
  const section = runbook.slice(
    runbook.indexOf("## Первый выпуск в пустой канал"),
    runbook.indexOf("## Подписанный APK для пилота"),
  );
  assert.ok(
    section.includes(
      `\`empty_channel_confirmation\` — ровно\n   \`${HANDHELD_EMPTY_CHANNEL_CONFIRMATION}\``,
    ),
  );
  const next = nextHandheldRelease({
    publishedText: null,
    bump: "minor",
    emptyChannelConfirmation: HANDHELD_EMPTY_CHANNEL_CONFIRMATION,
  });
  assert.ok(section.includes(`\`${next.versionName}\` с \`versionCode ${next.versionCode}\``));
});
