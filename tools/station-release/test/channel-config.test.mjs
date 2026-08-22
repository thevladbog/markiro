import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const betaUrl =
  "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json";
const stableUrl =
  "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json";

test("stable builds replace only the updater endpoint and inherit the beta public key", async () => {
  const base = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.conf.json", root), "utf8"),
  );
  const overlay = JSON.parse(
    await readFile(new URL("apps/station/src-tauri/tauri.stable.conf.json", root), "utf8"),
  );
  const mergedUpdater = { ...base.plugins.updater, ...overlay.plugins.updater };

  assert.deepEqual(base.plugins.updater.endpoints, [betaUrl]);
  assert.deepEqual(overlay.plugins.updater.endpoints, [stableUrl]);
  assert.equal(overlay.plugins.updater.pubkey, undefined);
  assert.equal(mergedUpdater.pubkey, base.plugins.updater.pubkey);
  assert.equal(JSON.stringify(base).includes(stableUrl), false);
  assert.equal(JSON.stringify(overlay).includes(betaUrl), false);
});
