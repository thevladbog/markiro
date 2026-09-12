import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function changelogWith(headings) {
  const dir = await mkdtemp(join(tmpdir(), "markiro-changelog-"));
  const path = join(dir, "CHANGELOG.md");
  await writeFile(
    path,
    `# Изменения\n\n${headings.map((h) => `## ${h}\n\n- что-то\n`).join("\n")}`,
  );
  return path;
}

test("the next version comes from the channel, not from a person", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "minor",
    publish: false,
    fetchImpl: serving(published("0.4.7", 12)),
  });
  assert.deepEqual(next, { versionName: "0.5.0", versionCode: 13, first: false });
});

test("an empty channel publishes the baseline", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "patch",
    publish: false,
    fetchImpl: empty,
  });
  assert.deepEqual(next, { versionName: "0.1.0", versionCode: 1, first: true });
});

/**
 * The version is computed, so the operator cannot know which heading to write
 * without being told. The refusal names it.
 */
test("a missing changelog entry is refused and says which version it wanted", async () => {
  const changelog = await changelogWith(["0.4.7"]);
  await assert.rejects(
    () =>
      resolveRelease({
        channel: "stable",
        bump: "patch",
        publish: true,
        fetchImpl: serving(published("0.4.7", 12)),
        changelog,
      }),
    /has no "## 0\.4\.8".*lands on 0\.4\.8/s,
  );
});

test("a present entry lets the release through", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "patch",
    publish: true,
    fetchImpl: serving(published("0.4.7", 12)),
    changelog: await changelogWith(["0.4.8", "0.4.7"]),
  });
  assert.equal(next.versionName, "0.4.8");
});

test("a build that is not publishing does not need an entry yet", async () => {
  const next = await resolveRelease({
    channel: "stable",
    bump: "patch",
    publish: false,
    fetchImpl: serving(published("0.4.7", 12)),
    changelog: await changelogWith(["0.4.7"]),
  });
  assert.equal(next.versionName, "0.4.8");
});

test("a channel pointer that answers neither 200 nor 404 stops the release", async () => {
  // Treating a 500 as «nothing is published» would restart the versionCode at
  // 1, and every installed terminal would refuse the update.
  await assert.rejects(
    () =>
      resolveRelease({
        channel: "stable",
        bump: "patch",
        publish: false,
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
      }),
    /answered 500/,
  );
});
