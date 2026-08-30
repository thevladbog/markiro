import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertSignerKey,
  createSignerObjectStore,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "../object-storage.mjs";

const ENV = {
  YANDEX_STATION_RELEASE_ENDPOINT: "https://storage.yandexcloud.net",
  YANDEX_STATION_RELEASE_BUCKET: "markiro-prod-station-releases-b1gi7na10jf4j62m62df",
  YANDEX_STATION_RELEASE_ACCESS_KEY_ID: "id",
  YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: "secret",
};

test("places a release artifact under the stable channel", () => {
  assert.equal(
    signerObjectKey({ version: "0.1.0", filename: "markiro-signer-0.1.0-setup.exe" }),
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-setup.exe",
  );
  assert.equal(SIGNER_MANIFEST_KEY, "signer/stable/latest.json");
});

test("maps a key onto the public URL the agent fetches", () => {
  assert.equal(
    signerPublicUrl(SIGNER_MANIFEST_KEY),
    "https://releases.markiro.app/signer/stable/latest.json",
  );
});

test("refuses a key outside the signer prefix", () => {
  // This bucket also holds the Station's releases. Nothing in this tool may be
  // able to write to them, however it is called.
  assert.throws(() => assertSignerKey("station/stable/latest.json"), /signer\//);
  assert.throws(() => assertSignerKey("../signer/stable/latest.json"), /signer\//);
  assert.throws(() => assertSignerKey("signer/stable/../../station/x"), /signer\//);
  assert.doesNotThrow(() => assertSignerKey("signer/stable/latest.json"));
});

test("refuses to build a store from an unexpected endpoint", () => {
  assert.throws(
    () =>
      createSignerObjectStore({
        env: { ...ENV, YANDEX_STATION_RELEASE_ENDPOINT: "https://example.invalid" },
      }),
    /endpoint/,
  );
});

test("refuses to build a store when a credential is missing", () => {
  assert.throws(
    () =>
      createSignerObjectStore({
        env: { ...ENV, YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: "" },
      }),
    /credential/,
  );
});

test("accepts a published object whose bytes hash to what was uploaded", async () => {
  const body = Buffer.from("installer bytes");
  await verifyPublishedObject({
    url: signerPublicUrl(SIGNER_MANIFEST_KEY),
    expectedSha256: createHash("sha256").update(body).digest("hex"),
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
});

test("rejects a published object whose bytes differ", async () => {
  // The failure this step exists for: a truncated or half-propagated upload,
  // which otherwise reaches a customer as a broken update rather than a red
  // build.
  await assert.rejects(
    verifyPublishedObject({
      url: signerPublicUrl(SIGNER_MANIFEST_KEY),
      expectedSha256: createHash("sha256").update(Buffer.from("expected")).digest("hex"),
      fetchImpl: async () => new Response(Buffer.from("truncated"), { status: 200 }),
    }),
    /does not match/,
  );
});

test("rejects a published object that is not publicly readable", async () => {
  await assert.rejects(
    verifyPublishedObject({
      url: signerPublicUrl(SIGNER_MANIFEST_KEY),
      expectedSha256: "0".repeat(64),
      fetchImpl: async () => new Response("", { status: 403 }),
    }),
    /403/,
  );
});
