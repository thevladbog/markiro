import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildHandheldManifest, handheldChannelBaseUrl } from "../manifest.mjs";
import { handheldManifestKey, handheldObjectKey } from "../object-storage.mjs";
import { publishHandheldRelease } from "../publish.mjs";

const apkBytes = Buffer.from("PK pretend this is an APK");
const apkSha256 = createHash("sha256").update(apkBytes).digest("hex");
const versionName = "0.2.0";
const sourceSha = "b".repeat(40);

async function apkOnDisk() {
  const dir = await mkdtemp(join(tmpdir(), "markiro-handheld-release-"));
  const path = join(dir, `markiro-tsd-${versionName}.apk`);
  await writeFile(path, apkBytes);
  return path;
}

/** Records publication order, including the direct download link. */
function fakeStore({ existing = new Map(), failOn = null } = {}) {
  const writes = [];
  return {
    writes,
    objects: existing,
    async head(key) {
      return existing.get(key)?.sha256 ?? null;
    },
    async putImmutable(key, body, contentType, expectedSha256) {
      if (failOn === key) throw new Error("object storage refused the write");
      writes.push({ key, kind: "immutable", contentType });
      existing.set(key, { body, sha256: expectedSha256 });
    },
    async copyDownload({ channel, versionName }) {
      const key = channel === "stable" ? "handheld/download" : "handheld/beta/download";
      if (failOn === key) throw new Error("object storage refused the copy");
      const source = `handheld/${channel}/releases/${versionName}/markiro-tsd-${versionName}.apk`;
      writes.push({ key, kind: "download" });
      existing.set(key, existing.get(source));
    },
    async put(key, body, contentType) {
      if (failOn === key) throw new Error("object storage refused the write");
      writes.push({ key, kind: "mutable", contentType });
      existing.set(key, { body, sha256: createHash("sha256").update(body).digest("hex") });
    },
  };
}

/** Serves whatever the fake store holds, so the read-back check is real. */
function fakeFetch(store) {
  return async (url) => {
    const key = url.replace("https://releases.markiro.app/", "");
    const object = store.objects.get(key);
    if (!object) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = Buffer.isBuffer(object.body) ? object.body : Buffer.from(object.body);
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
}

const release = async (overrides = {}) => ({
  apkPath: await apkOnDisk(),
  versionName,
  versionCode: 2,
  notes: "Первая раздача",
  sourceSha,
  releasedAt: "2026-09-12T10:00:00.000Z",
  channel: "stable",
  ...overrides,
});

test("the artifact lands before the pointer that sends terminals to it", async () => {
  const store = fakeStore();
  const result = await publishHandheldRelease({
    ...(await release()),
    store,
    fetchImpl: fakeFetch(store),
  });

  const keys = store.writes.map((write) => write.key);
  const pointer = handheldManifestKey("stable");
  const apkKey = handheldObjectKey({
    channel: "stable",
    versionName,
    filename: `markiro-tsd-${versionName}.apk`,
  });
  // A pointer moved first sends every terminal to a 404 for as long as the
  // upload takes, and forever if the upload then fails.
  assert.equal(keys.at(-2), pointer);
  assert.equal(keys.at(-1), "handheld/download");
  assert.equal(result.downloadUrl, "https://releases.markiro.app/handheld/download");
  assert.deepEqual(store.objects.get("handheld/download").body, apkBytes);
  assert.ok(keys.indexOf(apkKey) < keys.indexOf(pointer));
  assert.equal(result.manifest.sha256, apkSha256);
  assert.equal(
    result.manifest.url,
    `${handheldChannelBaseUrl("stable")}/releases/${versionName}/markiro-tsd-${versionName}.apk`,
  );
});

test("the APK is stored with the Android content type", async () => {
  const store = fakeStore();
  await publishHandheldRelease({ ...(await release()), store, fetchImpl: fakeFetch(store) });
  const apk = store.writes.find((write) => write.key.endsWith(".apk"));
  assert.equal(apk.contentType, "application/vnd.android.package-archive");
  assert.equal(apk.kind, "immutable");
});

test("a failed artifact upload leaves the pointer untouched", async () => {
  const apkKey = handheldObjectKey({
    channel: "stable",
    versionName,
    filename: `markiro-tsd-${versionName}.apk`,
  });
  const store = fakeStore({ failOn: apkKey });
  await assert.rejects(async () =>
    publishHandheldRelease({ ...(await release()), store, fetchImpl: fakeFetch(store) }),
  );
  assert.equal(store.objects.has(handheldManifestKey("stable")), false);
  assert.equal(store.objects.has("handheld/beta/download"), false);
  assert.equal(store.objects.has("handheld/download"), false);
});

test("a versionCode that does not grow is refused before anything is written", async () => {
  const store = fakeStore();
  const published = buildHandheldManifest({
    versionName: "0.3.0",
    versionCode: 9,
    sha256: "c".repeat(64),
    bytes: 10,
    url: `${handheldChannelBaseUrl("stable")}/releases/0.3.0/markiro-tsd-0.3.0.apk`,
    notes: "предыдущая",
    releasedAt: "2026-09-11T10:00:00.000Z",
    sourceSha: "d".repeat(40),
  });
  store.objects.set(handheldManifestKey("stable"), {
    body: Buffer.from(JSON.stringify(published)),
    sha256: "e".repeat(64),
  });

  await assert.rejects(
    async () =>
      publishHandheldRelease({ ...(await release()), store, fetchImpl: fakeFetch(store) }),
    /versionCode must grow/,
  );
  assert.equal(store.writes.length, 0, "nothing may be written when the release is refused");
});

test("re-publishing the same version with different bytes is refused", async () => {
  const apkKey = handheldObjectKey({
    channel: "stable",
    versionName,
    filename: `markiro-tsd-${versionName}.apk`,
  });
  const store = fakeStore({
    existing: new Map([[apkKey, { body: Buffer.from("different"), sha256: "f".repeat(64) }]]),
  });
  await assert.rejects(
    async () =>
      publishHandheldRelease({ ...(await release()), store, fetchImpl: fakeFetch(store) }),
    /already published/,
  );
});

test("a published object that reads back wrong fails the release", async () => {
  // The put succeeded and the bytes are still wrong: that is exactly the case a
  // release must not report as done.
  const store = fakeStore();
  const lying = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from("something else"),
  });
  await assert.rejects(
    async () => publishHandheldRelease({ ...(await release()), store, fetchImpl: lying }),
    /does not match what was uploaded/,
  );
});

test("publishing to beta keeps stable's pointer alone", async () => {
  const store = fakeStore();
  await publishHandheldRelease({
    ...(await release({ channel: "beta" })),
    store,
    fetchImpl: fakeFetch(store),
  });
  assert.equal(store.objects.has(handheldManifestKey("beta")), true);
  assert.equal(store.objects.has(handheldManifestKey("stable")), false);
  assert.equal(store.objects.has("handheld/beta/download"), true);
  assert.equal(store.objects.has("handheld/download"), false);
});

test("a failed download alias update fails the release and preserves its verified channel for repair", async () => {
  const store = fakeStore({ failOn: "handheld/download" });
  await assert.rejects(
    () =>
      release().then((input) =>
        publishHandheldRelease({ ...input, store, fetchImpl: fakeFetch(store) }),
      ),
    /refused the copy/,
  );
  assert.equal(store.objects.has(handheldManifestKey("stable")), true);
});
