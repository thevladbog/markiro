import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStationObjectStore } from "../object-storage.mjs";

const bucket = "markiro-station-releases";
const publicBaseUrl = "https://releases.markiro.app";
const version = "0.2.0-beta.7";
const immutableKey = `station/beta/releases/${version}/markiro-station-${version}-windows-x86_64-setup.exe`;
const mutableManifestKey = "station/beta/latest.json";

function missing() {
  return Object.assign(new Error("provider says missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function fakeClient(handler) {
  return {
    commands: [],
    async send(command) {
      this.commands.push(command);
      return handler(command, this.commands.length - 1);
    },
  };
}

function createStore(client, fetchImpl = async () => new Response("public bytes")) {
  return createStationObjectStore({ client, bucket, publicBaseUrl, fetchImpl });
}

test("distinguishes an absent object from present and forbidden objects", async () => {
  const absentClient = fakeClient(async () => {
    throw missing();
  });
  await createStore(absentClient).assertAbsent(immutableKey);
  assert.equal(absentClient.commands[0].constructor.name, "HeadObjectCommand");

  const presentClient = fakeClient(async () => ({ ContentLength: 10 }));
  await assert.rejects(createStore(presentClient).assertAbsent(immutableKey), /already exists/);

  const forbiddenClient = fakeClient(async () => {
    throw Object.assign(new Error(`403 for ${immutableKey}?X-Amz-Credential=secret`), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
  });
  await assert.rejects(
    createStore(forbiddenClient).assertAbsent(immutableKey),
    (error) =>
      error.message === "station object storage operation failed" &&
      !error.message.includes("secret") &&
      !error.message.includes(immutableKey),
  );
});

test("conditionally uploads only bounded regular immutable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-object-store-"));
  const file = join(directory, "installer.exe");
  await writeFile(file, "installer-bytes");
  const client = fakeClient(async () => ({}));

  await createStore(client).putImmutable(
    immutableKey,
    file,
    "application/vnd.microsoft.portable-executable",
  );

  assert.equal(client.commands.length, 1);
  assert.equal(client.commands[0].constructor.name, "PutObjectCommand");
  assert.deepEqual(client.commands[0].input, {
    Bucket: bucket,
    Key: immutableKey,
    Body: Buffer.from("installer-bytes"),
    ContentType: "application/vnd.microsoft.portable-executable",
    CacheControl: "public, max-age=31536000, immutable",
    IfNoneMatch: "*",
  });

  const link = join(directory, "installer-link.exe");
  await symlink(file, link);
  await assert.rejects(
    createStore(client).putImmutable(
      immutableKey,
      link,
      "application/vnd.microsoft.portable-executable",
    ),
    /invalid station object storage request/,
  );
  assert.equal(client.commands.length, 1);
});

test("retains mutable content types and bounds S3 response bodies", async () => {
  const getClient = fakeClient(async () => ({
    Body: (async function* () {
      yield Buffer.from('{"version":');
      yield Buffer.from('"0.2.0-beta.7"}');
    })(),
    ContentLength: 26,
    ContentType: "application/json",
  }));
  const object = await createStore(getClient).getMutable(mutableManifestKey);
  assert.deepEqual(object, {
    bytes: Buffer.from('{"version":"0.2.0-beta.7"}'),
    contentType: "application/json",
  });
  assert.equal(getClient.commands[0].constructor.name, "GetObjectCommand");

  const missingClient = fakeClient(async () => {
    throw missing();
  });
  assert.equal(await createStore(missingClient).getMutable(mutableManifestKey), null);

  let consumed = false;
  let destroyed = false;
  const oversizedClient = fakeClient(async () => ({
    Body: {
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        consumed = true;
        yield Buffer.from("unexpected");
      },
    },
    ContentLength: 256 * 1024 + 1,
    ContentType: "application/json",
  }));
  await assert.rejects(
    createStore(oversizedClient).getMutable(mutableManifestKey),
    /station object storage operation failed/,
  );
  assert.equal(consumed, false);
  assert.equal(destroyed, true);
});

test("writes mutable objects with revalidation metadata", async () => {
  const client = fakeClient(async () => ({}));
  await createStore(client).putMutable(
    mutableManifestKey,
    Buffer.from("manifest"),
    "application/json",
  );
  assert.equal(client.commands[0].constructor.name, "PutObjectCommand");
  assert.deepEqual(client.commands[0].input, {
    Bucket: bucket,
    Key: mutableManifestKey,
    Body: Buffer.from("manifest"),
    ContentType: "application/json",
    CacheControl: "public, max-age=0, must-revalidate",
  });
});

test("server-side copies the immutable installer to its matching alias", async () => {
  const client = fakeClient(async () => ({}));
  await createStore(client).copyImmutableToAlias({
    immutableKey,
    aliasKey: "station/beta/download",
    attachmentFilename: `markiro-station-${version}-windows-x86_64-setup.exe`,
  });
  assert.equal(client.commands[0].constructor.name, "CopyObjectCommand");
  assert.deepEqual(client.commands[0].input, {
    Bucket: bucket,
    Key: "station/beta/download",
    CopySource: `${bucket}/${immutableKey}`,
    MetadataDirective: "REPLACE",
    ContentType: "application/vnd.microsoft.portable-executable",
    ContentDisposition: `attachment; filename="markiro-station-${version}-windows-x86_64-setup.exe"`,
    CacheControl: "public, max-age=0, must-revalidate",
  });
});

test("rejects traversal, unexpected prefixes, and mismatched alias copies before S3", async () => {
  const client = fakeClient(async () => ({}));
  const store = createStore(client);
  await assert.rejects(store.assertAbsent("../station/beta/latest.json"), /invalid/);
  await assert.rejects(store.getMutable("private/beta/latest.json"), /invalid/);
  await assert.rejects(
    store.copyImmutableToAlias({
      immutableKey,
      aliasKey: "station/download",
      attachmentFilename: `markiro-station-${version}-windows-x86_64-setup.exe`,
    }),
    /invalid/,
  );
  assert.equal(client.commands.length, 0);
});

test("bounds public reads and rejects non-2xx responses and redirects", async () => {
  const requests = [];
  const okStore = createStore(
    fakeClient(async () => ({})),
    async (url, init) => {
      requests.push({ url, init });
      return new Response("public manifest", {
        status: 200,
        headers: { "content-length": "15" },
      });
    },
  );
  assert.deepEqual(await okStore.readPublic(mutableManifestKey), Buffer.from("public manifest"));
  assert.deepEqual(requests, [
    {
      url: `${publicBaseUrl}/${mutableManifestKey}`,
      init: { redirect: "error", cache: "no-store" },
    },
  ]);

  const errorStore = createStore(
    fakeClient(async () => ({})),
    async () => new Response("secret provider body", { status: 503 }),
  );
  await assert.rejects(
    errorStore.readPublic(mutableManifestKey),
    (error) =>
      error.message === "station public object read failed" &&
      !error.message.includes("secret provider body"),
  );

  const redirectStore = createStore(
    fakeClient(async () => ({})),
    async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: "https://attacker.example/file",
      headers: new Headers({ "content-length": "4" }),
      body: new Response("evil").body,
    }),
  );
  await assert.rejects(redirectStore.readPublic(mutableManifestKey), /public object read failed/);

  const oversizedStore = createStore(
    fakeClient(async () => ({})),
    async () =>
      new Response("small", {
        status: 200,
        headers: { "content-length": String(256 * 1024 + 1) },
      }),
  );
  await assert.rejects(oversizedStore.readPublic(mutableManifestKey), /public object read failed/);
});

test("sanitizes provider failures for puts, gets, and copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-object-errors-"));
  const file = join(directory, "installer.exe");
  await writeFile(file, "installer");
  const error = new Error(
    `${immutableKey} X-Amz-Signature=secret AWS_SECRET_ACCESS_KEY=also-secret`,
  );
  const makeFailingStore = () =>
    createStore(
      fakeClient(async () => {
        throw error;
      }),
    );
  for (const operation of [
    () =>
      makeFailingStore().putImmutable(
        immutableKey,
        file,
        "application/vnd.microsoft.portable-executable",
      ),
    () => makeFailingStore().getMutable(mutableManifestKey),
    () => makeFailingStore().putMutable(mutableManifestKey, Buffer.from("x"), "application/json"),
    () =>
      makeFailingStore().copyImmutableToAlias({
        immutableKey,
        aliasKey: "station/beta/download",
        attachmentFilename: `markiro-station-${version}-windows-x86_64-setup.exe`,
      }),
  ]) {
    await assert.rejects(operation(), (caught) => {
      assert.equal(caught.message, "station object storage operation failed");
      assert.equal(caught.message.includes("secret"), false);
      assert.equal(caught.message.includes(immutableKey), false);
      return true;
    });
  }
});
