import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../cli-main.mjs";

const cliFiles = ["preflight.mjs", "deploy.mjs", "smoke.mjs", "verify-dns.mjs"];

test("portable main-module detection matches the resolved CLI path and handles a missing entry", () => {
  const entry = resolve("deploy/production/preflight.mjs");
  const moduleUrl = pathToFileURL(entry).href;

  assert.equal(isMainModule(moduleUrl, ["node", entry]), true);
  assert.equal(isMainModule(moduleUrl, ["node", "deploy/production/preflight.mjs"]), true);
  assert.equal(isMainModule(moduleUrl, ["node"]), false);
  assert.equal(isMainModule(moduleUrl, null), false);
});

test("every production CLI uses the portable detector instead of import.meta.main", async () => {
  for (const file of cliFiles) {
    const source = await readFile(`deploy/production/${file}`, "utf8");
    assert.match(source, /import \{ isMainModule \} from "\.\/cli-main\.mjs";/, file);
    assert.match(source, /if \(isMainModule\(import\.meta\.url\)\)/, file);
    assert.doesNotMatch(source, /import\.meta\.main/, file);
  }
});

test("a production CLI invoked by path executes its entrypoint instead of silently skipping", () => {
  const result = spawnSync(process.execPath, ["deploy/production/verify-dns.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /MARKIRO_DOMAIN is invalid/);
});
