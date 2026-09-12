import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHandheldManifest, handheldArtifactUrl } from "../manifest.mjs";
import { resolveRelease } from "../resolve.mjs";

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

const serving = (text) => async () => ({ ok: true, status: 200, text: async () => text });
const empty = async () => ({ ok: false, status: 404, text: async () => "" });

test("the next version comes from the channel, not from a person", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "minor",
    fetchImpl: serving(published("0.4.7", 12)),
  });
  assert.deepEqual(next, { versionName: "0.5.0", versionCode: 13, first: false });
});

test("an empty channel publishes the baseline", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "patch",
    fetchImpl: empty,
  });
  assert.deepEqual(next, { versionName: "0.1.0", versionCode: 1, first: true });
});

test("publishing resolves a new version without a matching changelog entry", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "patch",
    fetchImpl: serving(published("0.4.7", 12)),
  });
  assert.deepEqual(next, { versionName: "0.4.8", versionCode: 13, first: false });
});

test("a channel pointer that answers neither 200 nor 404 stops the release", async () => {
  // Treating a 500 as «nothing is published» would restart the versionCode at
  // 1, and every installed terminal would refuse the update.
  await assert.rejects(
    () =>
      resolveRelease({
        channel: "stable",
        bump: "patch",
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
      }),
    /answered 500/,
  );
});
