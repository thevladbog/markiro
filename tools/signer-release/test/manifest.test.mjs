import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidSignerManifest,
  buildSignerManifest,
  SIGNER_CHANNEL_BASE_URL,
} from "../manifest.mjs";

const VALID = {
  version: "0.1.0",
  pubDate: "2026-08-30T12:00:00.000Z",
  bundleUrl: `${SIGNER_CHANNEL_BASE_URL}/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe`,
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
};

test("builds exactly the Tauri v2 updater shape", () => {
  const manifest = buildSignerManifest(VALID);
  assert.deepEqual(Object.keys(manifest).sort(), ["platforms", "pub_date", "version"]);
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  assert.deepEqual(Object.keys(manifest.platforms["windows-x86_64"]).sort(), ["signature", "url"]);
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.pub_date, VALID.pubDate);
  assert.equal(manifest.platforms["windows-x86_64"].url, VALID.bundleUrl);
  assert.equal(manifest.platforms["windows-x86_64"].signature, VALID.signature);
});

test("refuses a bundle URL outside the channel the agent polls", () => {
  // A manifest pointing somewhere the agent does not look is the defect most
  // likely to ship unnoticed: the release goes green and no client updates.
  assert.throws(
    () =>
      buildSignerManifest({
        ...VALID,
        bundleUrl:
          "https://releases.markiro.app/signer/beta/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe",
      }),
    /signer\/stable/,
  );
});

test("rejects an empty signature", () => {
  assert.throws(() => buildSignerManifest({ ...VALID, signature: "" }), /signature/);
});

test("rejects an unparseable publication date", () => {
  assert.throws(() => buildSignerManifest({ ...VALID, pubDate: "yesterday" }), /invalid/);
});

test("rejects a manifest carrying an extra key", () => {
  const manifest = { ...buildSignerManifest(VALID), notes: "hello" };
  assert.throws(() => assertValidSignerManifest(manifest), /invalid signer manifest/);
});
