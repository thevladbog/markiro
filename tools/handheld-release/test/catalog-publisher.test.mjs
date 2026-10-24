import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishHandheldCatalogRelease } from "../catalog-publisher.mjs";
const id = "11111111-1111-4111-8111-111111111111",
  publicationId = "22222222-2222-4222-8222-222222222222";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "markiro-handheld-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("apk fixture"),
    apkPath = join(dir, "release.apk");
  await writeFile(apkPath, bytes);
  const events = [],
    requests = [];
  let manifest;
  const catalog = {
    async getChannel() {
      events.push("snapshot");
      return {
        identity: { product: "handheld", channel: "stable" },
        revision: "0",
        publicationId: null,
        readable: false,
      };
    },
    async createIntent(key, publication) {
      events.push("intent");
      requests.push({ key, publication });
      return { id, files: publication.files };
    },
    async uploadFile(intent, name, body) {
      events.push(`upload:${name}`);
      if (name === "manifest.json") manifest = JSON.parse(body);
      return { name, versionId: `version-${name}` };
    },
    async commitIntent() {
      events.push("commit-with-full-readback");
      return { publicationId };
    },
    async changeChannel(scope, change) {
      events.push("CAS");
      requests.push({ scope, change });
      return { revision: "1" };
    },
  };
  let moved = false;
  const original = catalog.changeChannel;
  catalog.changeChannel = async (...args) => {
    const result = await original(...args);
    moved = true;
    return result;
  };
  const fetchImpl = async (url) => {
    events.push("public");
    if (!moved) return new Response(null, { status: 404 });
    if (String(url).endsWith("/download")) return new Response(bytes);
    return Response.json(manifest);
  };
  return {
    stateDirectory: join(dir, "journal"),
    catalog,
    events,
    requests,
    fetchImpl,
    apkPath,
    bytes,
    versionName: "1.7.0",
    versionCode: 16,
    sourceSha: "a".repeat(40),
    releasedAt: "2026-10-24T00:00:00.000Z",
    notes: "Release",
    channel: "stable",
    emptyChannelConfirmation: "1.6.1 (15)",
    operationId: id,
  };
}
test("registers full APK/manifest then readback then CAS; never writes mutable download or latest", async (t) => {
  const f = await fixture(t);
  const result = await publishHandheldCatalogRelease(f);
  assert.ok(f.events.indexOf("commit-with-full-readback") < f.events.indexOf("CAS"));
  assert.equal(f.requests[0].publication.files.length, 2);
  assert.equal(
    f.requests[0].publication.files[0].sha256,
    createHash("sha256").update(f.bytes).digest("hex"),
  );
  assert.equal(f.requests[1].change.expectedRevision, "0");
  assert.equal(f.requests[1].change.targetPublicationId, publicationId);
  assert.equal(result.downloadUrl, "https://releases.markiro.app/handheld/download");
});
test("empty channel still requires exact last-distributed confirmation before reserving/uploading", async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishHandheldCatalogRelease({ ...f, emptyChannelConfirmation: "" }));
  assert.equal(f.events.includes("intent"), false);
});
test("failed immutable commit cannot move channel", async (t) => {
  const f = await fixture(t);
  f.catalog.commitIntent = async () => {
    throw Error("registration conflict");
  };
  await assert.rejects(publishHandheldCatalogRelease(f), /registration conflict/);
  assert.equal(f.events.includes("CAS"), false);
});
test("stale revision is not silently retried with a newer revision", async (t) => {
  const f = await fixture(t);
  let moves = 0;
  f.catalog.changeChannel = async () => {
    moves++;
    throw Error("409");
  };
  await assert.rejects(publishHandheldCatalogRelease(f), /409/);
  assert.equal(moves, 1);
});

test("a lost PUT response stops retry without writing the same staged key again", async (t) => {
  const f = await fixture(t);
  let puts = 0;
  f.catalog.uploadFile = async () => {
    puts++;
    throw Error("response lost");
  };
  await assert.rejects(publishHandheldCatalogRelease(f), /response lost/);
  await assert.rejects(publishHandheldCatalogRelease(f), /reconcile/);
  assert.equal(puts, 1);
});
test("a lost CAS response retries exact original revision and uploaded VersionIds", async (t) => {
  const f = await fixture(t),
    moves = [],
    original = f.catalog.changeChannel;
  let first = true;
  f.catalog.changeChannel = async (scope, change) => {
    moves.push(change);
    const r = await original(scope, change);
    if (first) {
      first = false;
      throw Error("response lost");
    }
    return r;
  };
  await assert.rejects(publishHandheldCatalogRelease(f), /response lost/);
  await publishHandheldCatalogRelease({ ...f, releasedAt: "2026-10-25T00:00:00.000Z" });
  assert.deepEqual(moves[1], moves[0]);
  assert.equal(f.events.filter((e) => e.startsWith("upload:")).length, 2);
});
