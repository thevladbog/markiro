import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readStandaloneVersion } from "../prepare.mjs";

// One version per build (plan ОБН-2): the shell compares an update with
// `tauri.conf.json`'s version (`app.package_info()`), while the station's
// version header, the name of its copy before migrations (plan ОБН-1) and
// the host's `hello` carry `CARGO_PKG_VERSION`. A release that bumps one of
// them bumps them all, or a PC would report one version and update by
// another. Plan ОБН-3 (task 14) keeps this rule with its compatibility window.

const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
const CRATES = {
  "markiro-standalone": "apps/standalone/src-tauri/Cargo.toml",
  "markiro-host": "apps/standalone/host/Cargo.toml",
  "markiro-proto": "apps/standalone/proto/Cargo.toml",
};

test("the build's version is one across its manifests and the lock", async () => {
  const version = await readStandaloneVersion();
  for (const path of Object.values(CRATES)) {
    assert.equal(/^version = "([^"]+)"$/mu.exec(await text(path))?.[1], version, path);
  }
  const app = JSON.parse(await text("apps/standalone/package.json"));
  assert.equal(app.version, version, "apps/standalone/package.json");
  const lock = await text("apps/standalone/Cargo.lock");
  for (const name of Object.keys(CRATES)) {
    const entry = new RegExp(`^name = "${name}"\\nversion = "([^"]+)"$`, "mu").exec(lock);
    assert.equal(entry?.[1], version, `Cargo.lock ${name}`);
  }
});
