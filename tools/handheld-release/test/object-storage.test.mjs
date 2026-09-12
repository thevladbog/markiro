import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  assertHandheldKey,
  contentTypeFor,
  createHandheldObjectStore,
  handheldManifestKey,
  handheldObjectKey,
  handheldPublicUrl,
  verifyPublishedObject,
} from "../object-storage.mjs";

const endpoint = "https://storage.yandexcloud.net";
const env = {
  YANDEX_STATION_RELEASE_ENDPOINT: endpoint,
  YANDEX_STATION_RELEASE_BUCKET: "markiro-station-releases",
  YANDEX_STATION_RELEASE_ACCESS_KEY_ID: "id",
  YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: "secret",
};

test("the handheld shares the Station bucket, so keys outside its prefix are refused", () => {
  // The guard is the only thing standing between a mistyped key and a Station
  // release being overwritten by an Android build.
  for (const key of ["station/stable/latest.json", "latest.json", "handheld/../station/x", ""]) {
    assert.throws(() => assertHandheldKey(key), undefined, `accepted ${key}`);
  }
  assert.doesNotThrow(() => assertHandheldKey("handheld/stable/latest.json"));
});

test("keys are built per channel and per version", () => {
  assert.equal(
    handheldObjectKey({
      channel: "stable",
      versionName: "0.2.0",
      filename: "markiro-tsd-0.2.0.apk",
    }),
    "handheld/stable/releases/0.2.0/markiro-tsd-0.2.0.apk",
  );
  assert.equal(handheldManifestKey("beta"), "handheld/beta/latest.json");
  assert.throws(() => handheldManifestKey("nightly"));
  assert.equal(
    handheldPublicUrl("handheld/stable/latest.json"),
    "https://releases.markiro.app/handheld/stable/latest.json",
  );
});

test("an APK is served as an APK", () => {
  assert.equal(contentTypeFor("markiro-tsd-0.2.0.apk"), "application/vnd.android.package-archive");
  assert.equal(contentTypeFor("latest.json"), "application/json");
});

test("the store refuses to start against anything but the pinned endpoint", () => {
  assert.throws(() =>
    createHandheldObjectStore({
      env: { ...env, YANDEX_STATION_RELEASE_ENDPOINT: "https://s3.amazonaws.com" },
    }),
  );
  assert.throws(() =>
    createHandheldObjectStore({ env: { ...env, YANDEX_STATION_RELEASE_BUCKET: "../evil" } }),
  );
  assert.throws(() =>
    createHandheldObjectStore({ env: { ...env, YANDEX_STATION_RELEASE_ACCESS_KEY_ID: "" } }),
  );
  assert.doesNotThrow(() => createHandheldObjectStore({ env, Client: class {} }));
});

test("an immutable put whose bytes do not match its digest never reaches storage", async () => {
  const sent = [];
  const store = createHandheldObjectStore({
    env,
    Client: class {
      async send(command) {
        sent.push(command);
      }
    },
  });
  const body = Buffer.from("apk");
  await assert.rejects(
    () =>
      store.putImmutable(
        "handheld/stable/releases/0.2.0/x.apk",
        body,
        "application/octet-stream",
        "a".repeat(64),
      ),
    /checksum does not match/,
  );
  assert.equal(sent.length, 0);
});

test("an immutable put asks storage to refuse an overwrite", async () => {
  const sent = [];
  const store = createHandheldObjectStore({
    env,
    Client: class {
      async send(command) {
        sent.push(command.input);
      }
    },
  });
  const body = Buffer.from("apk");
  const sha256 = createHash("sha256").update(body).digest("hex");
  await store.putImmutable("handheld/stable/releases/0.2.0/x.apk", body, "application/x", sha256);
  // Read-then-write is not atomic, and that window is exactly where an
  // overwritten release would come from.
  assert.equal(sent[0].IfNoneMatch, "*");
});

test("a version already published with the same bytes is a re-run, with different bytes it stops the release", async () => {
  const precondition = Object.assign(new Error("exists"), { name: "PreconditionFailed" });
  const body = Buffer.from("apk");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const storeWith = (publishedSha256) =>
    createHandheldObjectStore({
      env,
      Client: class {
        async send(command) {
          if (command.constructor.name === "PutObjectCommand") throw precondition;
          return { Metadata: { "handheld-sha256": publishedSha256 } };
        }
      },
    });

  await assert.doesNotReject(() =>
    storeWith(sha256).putImmutable(
      "handheld/stable/releases/0.2.0/x.apk",
      body,
      "application/x",
      sha256,
    ),
  );
  await assert.rejects(
    () =>
      storeWith("c".repeat(64)).putImmutable(
        "handheld/stable/releases/0.2.0/x.apk",
        body,
        "application/x",
        sha256,
      ),
    /already exists with different bytes/,
  );
});

test("read-back is over the public URL a terminal uses, not over the S3 API", async () => {
  const bytes = Buffer.from("published");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
  await verifyPublishedObject({
    url: handheldPublicUrl(handheldManifestKey("stable")),
    expectedSha256: sha256,
    fetchImpl,
  });
  assert.deepEqual(seen, ["https://releases.markiro.app/handheld/stable/latest.json"]);

  await assert.rejects(
    () =>
      verifyPublishedObject({
        url: handheldPublicUrl(handheldManifestKey("stable")),
        expectedSha256: "b".repeat(64),
        fetchImpl,
      }),
    /does not match what was uploaded/,
  );
});
