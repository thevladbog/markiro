import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
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
  assert.equal(isMainModule(moduleUrl, ["node", "deploy/production/does-not-exist.mjs"]), false);
  assert.equal(isMainModule("data:text/javascript,export default 1", ["node", entry]), false);

  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  let canonicalizeCalls = 0;
  assert.throws(
    () =>
      isMainModule(moduleUrl, ["node", entry], () => {
        canonicalizeCalls += 1;
        if (canonicalizeCalls === 1) return entry;
        throw denied;
      }),
    denied,
  );
  assert.equal(canonicalizeCalls, 2);
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

test("a production CLI invoked through a symlink still executes its entrypoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "markiro cli main "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linkedCli = join(directory, "verify dns.mjs");
  await symlink(resolve("deploy/production/verify-dns.mjs"), linkedCli);

  const result = spawnSync(process.execPath, [linkedCli], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "MARKIRO_DOMAIN is invalid");
});

test("a directory-symlinked CLI executes when Node preserves the main symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "markiro preserved main "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linkedProduction = join(directory, "production link");
  await symlink(resolve("deploy/production"), linkedProduction, "dir");
  const linkedCli = join(linkedProduction, "verify-dns.mjs");

  for (const invocation of [
    { args: ["--preserve-symlinks-main", linkedCli], env: {} },
    { args: [linkedCli], env: { NODE_OPTIONS: "--preserve-symlinks-main" } },
  ]) {
    const result = spawnSync(process.execPath, invocation.args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: invocation.env,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "MARKIRO_DOMAIN is invalid");
  }
});
