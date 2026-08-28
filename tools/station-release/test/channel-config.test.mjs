import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const betaUrls = [
  "https://releases.markiro.app/station/beta/latest.json",
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json",
];
const legacyBetaUrls = [
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json",
];
const stableUrls = [
  "https://releases.markiro.app/station/stable/latest.json",
  "https://github.com/thevladbog/markiro-station-releases/releases/download/station-stable-channel/latest.json",
];

test("stable builds replace only the ordered channel endpoints and inherit the public key", async () => {
  const base = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.conf.json", root), "utf8"),
  );
  const overlay = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.stable.conf.json", root), "utf8"),
  );
  const mergedUpdater = { ...base.plugins.updater, ...overlay.plugins.updater };

  assert.deepEqual(base.plugins.updater.endpoints, betaUrls);
  assert.deepEqual(overlay.plugins.updater.endpoints, stableUrls);
  assert.equal(overlay.plugins.updater.pubkey, undefined);
  assert.equal(mergedUpdater.pubkey, base.plugins.updater.pubkey);
  for (const stableUrl of stableUrls) assert.equal(JSON.stringify(base).includes(stableUrl), false);
  for (const betaUrl of betaUrls) assert.equal(JSON.stringify(overlay).includes(betaUrl), false);
});

test("baseline seed builds retain the legacy GitHub-only updater channel", async () => {
  const base = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.conf.json", root), "utf8"),
  );
  const overlay = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.beta-seed.conf.json", root), "utf8"),
  );
  const mergedUpdater = { ...base.plugins.updater, ...overlay.plugins.updater };

  assert.deepEqual(base.plugins.updater.endpoints, betaUrls);
  assert.deepEqual(mergedUpdater.endpoints, legacyBetaUrls);
  assert.equal(overlay.plugins.updater.pubkey, undefined);
  assert.equal(mergedUpdater.pubkey, base.plugins.updater.pubkey);
  assert.equal(JSON.stringify(overlay).includes("releases.markiro.app"), false);
});
