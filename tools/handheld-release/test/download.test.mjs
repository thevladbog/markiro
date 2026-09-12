import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { syncHandheldDownload } from "../download.mjs";
import { buildHandheldManifest } from "../manifest.mjs";

function fixture(channel = "stable") {
  const apk = Buffer.from("published APK");
  const sha256 = createHash("sha256").update(apk).digest("hex");
  const base = `https://releases.markiro.app/handheld/${channel}`;
  const manifest = buildHandheldManifest({
    versionName: "0.1.0",
    versionCode: 1,
    sha256,
    bytes: apk.length,
    url: `${base}/releases/0.1.0/markiro-tsd-0.1.0.apk`,
    notes: "Первый релиз",
    releasedAt: "2026-09-12T10:00:00Z",
    sourceSha: "a".repeat(40),
    channel,
  });
  const bytes = Buffer.from(JSON.stringify(manifest));
  const pointerHash = createHash("sha256").update(bytes).digest("hex");
  const downloadUrl = `https://releases.markiro.app/handheld/${channel === "stable" ? "" : "beta/"}download`;
  const objects = new Map([
    [`${base}/latest.json`, bytes],
    [`${base}/releases/0.1.0/manifest.json`, bytes],
    [manifest.url, apk],
  ]);
  const copies = [];
  const store = {
    async head() {
      return pointerHash;
    },
    async copyDownload(input) {
      copies.push(input);
      objects.set(downloadUrl, apk);
    },
  };
  const fetchImpl = async (url) => ({
    ok: objects.has(url),
    status: objects.has(url) ? 200 : 404,
    arrayBuffer: async () => objects.get(url) ?? Buffer.alloc(0),
  });
  return { channel, apk, base, manifest, objects, copies, store, fetchImpl, downloadUrl };
}

for (const channel of ["stable", "beta"]) {
  test(`sync creates the ${channel} download URL from the existing release without changing its version`, async () => {
    const f = fixture(channel);
    const result = await syncHandheldDownload(f);
    assert.equal(result, f.downloadUrl);
    assert.deepEqual(f.copies, [{ channel, versionName: "0.1.0" }]);
    assert.deepEqual(f.objects.get(result), f.apk);
  });
}

for (const failure of [
  "missing-channel",
  "different-immutable-manifest",
  "corrupt-apk",
  "channel-changed",
]) {
  test(`sync refuses ${failure} before touching the download URL`, async () => {
    const f = fixture();
    if (failure === "missing-channel") f.objects.delete(`${f.base}/latest.json`);
    if (failure === "different-immutable-manifest")
      f.objects.set(`${f.base}/releases/0.1.0/manifest.json`, Buffer.from("{}"));
    if (failure === "corrupt-apk") f.objects.set(f.manifest.url, Buffer.from("wrong APK"));
    if (failure === "channel-changed") f.store.head = async () => "b".repeat(64);
    await assert.rejects(() => syncHandheldDownload(f));
    assert.equal(f.copies.length, 0);
  });
}

test("sync reports an unreadable copied APK as a failure", async () => {
  const f = fixture();
  f.store.copyDownload = async () => {};
  await assert.rejects(() => syncHandheldDownload(f), /not readable/);
});
