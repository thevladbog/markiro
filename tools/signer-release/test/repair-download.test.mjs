import assert from "node:assert/strict";
import test from "node:test";

import { repairSignerDownload } from "../repair-download.mjs";

const VERSION = "0.1.0";
const INSTALLER_KEY = "signer/stable/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe";
const INSTALLER_URL = `https://releases.markiro.app/${INSTALLER_KEY}`;
const MANIFEST = {
  version: VERSION,
  pub_date: "2026-08-30T12:00:00.000Z",
  platforms: {
    "windows-x86_64": {
      url: INSTALLER_URL,
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
    },
  },
};

function mirrorWith(manifest = MANIFEST) {
  const objects = new Map([
    ["signer/stable/latest.json", Buffer.from(`${JSON.stringify(manifest)}\n`)],
    [INSTALLER_KEY, Buffer.from("current stable installer")],
  ]);
  const copies = [];
  return {
    copies,
    store: {
      copyInstallerToDownload: async (input) => {
        copies.push(input);
        objects.set("signer/download", objects.get(input.immutableKey));
      },
    },
    fetchImpl: async (url) => {
      const body = objects.get(new URL(url).pathname.slice(1));
      return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
    },
  };
}

test("repairs the versionless download from the exact installer in the current stable manifest", async () => {
  const mirror = mirrorWith();
  const result = await repairSignerDownload({ store: mirror.store, fetchImpl: mirror.fetchImpl });

  assert.deepEqual(mirror.copies, [
    {
      immutableKey: INSTALLER_KEY,
      attachmentFilename: "markiro-signer-0.1.0-windows-x86_64-setup.exe",
    },
  ]);
  assert.deepEqual(result, {
    version: VERSION,
    installerUrl: INSTALLER_URL,
    downloadUrl: "https://releases.markiro.app/signer/download",
  });
});

test("refuses a manifest URL that does not exactly match its stable version", async () => {
  const mirror = mirrorWith({
    ...MANIFEST,
    platforms: {
      "windows-x86_64": {
        ...MANIFEST.platforms["windows-x86_64"],
        url: "https://releases.markiro.app/signer/stable/releases/9.9.9/attacker.exe",
      },
    },
  });

  await assert.rejects(
    repairSignerDownload({ store: mirror.store, fetchImpl: mirror.fetchImpl }),
    /does not match version 0\.1\.0/,
  );
  assert.equal(mirror.copies.length, 0);
});

test("refuses to replace the alias when the current immutable installer is unreadable", async () => {
  const mirror = mirrorWith();
  const fetchImpl = async (url) =>
    url === INSTALLER_URL ? new Response("", { status: 404 }) : mirror.fetchImpl(url);

  await assert.rejects(
    repairSignerDownload({ store: mirror.store, fetchImpl }),
    /current stable installer is not readable/,
  );
  assert.equal(mirror.copies.length, 0);
});
