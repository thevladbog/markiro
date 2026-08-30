import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishSignerRelease } from "../publish.mjs";

const VERSION = "0.1.0";
const INSTALLER_BYTES = Buffer.from("nsis installer");
const SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=";

async function bundleDirWith({ installer = true, signature = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "signer-publish-"));
  if (installer) {
    await writeFile(join(dir, "Markiro Signer_0.1.0_x64-setup.exe"), INSTALLER_BYTES);
  }
  if (signature) {
    await writeFile(join(dir, "Markiro Signer_0.1.0_x64-setup.exe.sig"), `${SIGNATURE}\n`);
  }
  return dir;
}

/** A store that records puts and serves them back, standing in for the mirror. */
function fakeMirror() {
  const objects = new Map();
  return {
    objects,
    store: {
      bucket: "bucket",
      put: async (key, body) => {
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
      },
    },
    fetchImpl: async (url) => {
      const key = new URL(url).pathname.slice(1);
      const body = objects.get(key);
      return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
    },
  };
}

test("uploads the installer, its signature and a manifest that points at them", async () => {
  const mirror = fakeMirror();
  const result = await publishSignerRelease({
    version: VERSION,
    bundleDir: await bundleDirWith(),
    pubDate: "2026-08-30T12:00:00.000Z",
    store: mirror.store,
    fetchImpl: mirror.fetchImpl,
  });

  assert.deepEqual([...mirror.objects.keys()].sort(), [
    "signer/stable/latest.json",
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe",
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe.sig",
  ]);

  const manifest = JSON.parse(mirror.objects.get("signer/stable/latest.json").toString("utf8"));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.platforms["windows-x86_64"].url, result.installerUrl);
  // The .sig file's trailing newline must not reach the manifest: Tauri
  // compares the signature verbatim.
  assert.equal(manifest.platforms["windows-x86_64"].signature, SIGNATURE);
});

test("verifies the published bytes over the public URL", async () => {
  const mirror = fakeMirror();
  // A mirror that serves back something other than what was put is exactly the
  // half-propagated upload this step exists to catch.
  const corrupting = async (url) => {
    const key = new URL(url).pathname.slice(1);
    if (key.endsWith("-setup.exe")) return new Response(Buffer.from("truncated"), { status: 200 });
    return mirror.fetchImpl(url);
  };
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith(),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: corrupting,
    }),
    /does not match/,
  );
});

test("refuses a bundle directory with no signature", async () => {
  const mirror = fakeMirror();
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith({ signature: false }),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: mirror.fetchImpl,
    }),
    /signature/,
  );
});

test("refuses a bundle directory with no installer", async () => {
  const mirror = fakeMirror();
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith({ installer: false }),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: mirror.fetchImpl,
    }),
    /installer/,
  );
});

test("uploads the manifest only after the artifacts it names", async () => {
  // latest.json is what the agent reads. Publishing it first would advertise a
  // download that is not there yet.
  const mirror = fakeMirror();
  const order = [];
  const store = {
    bucket: "bucket",
    put: async (key, body) => {
      order.push(key);
      await mirror.store.put(key, body);
    },
  };
  await publishSignerRelease({
    version: VERSION,
    bundleDir: await bundleDirWith(),
    pubDate: "2026-08-30T12:00:00.000Z",
    store,
    fetchImpl: mirror.fetchImpl,
  });
  assert.equal(order.at(-1), "signer/stable/latest.json");
});
