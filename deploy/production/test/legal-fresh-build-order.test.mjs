import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function linkDependencies(sourceDir, targetDir, overrides = {}) {
  await mkdir(targetDir, { recursive: true });
  for (const name of await readdir(sourceDir)) {
    if (name === ".bin" || Object.hasOwn(overrides, name)) continue;
    await symlink(path.join(sourceDir, name), path.join(targetDir, name));
  }
  for (const [name, target] of Object.entries(overrides)) {
    await symlink(target, path.join(targetDir, name));
  }
}

function tsc(project) {
  return spawnSync(path.join(root, "node_modules/.bin/tsc"), ["-p", project], {
    cwd: root,
    encoding: "utf8",
  });
}

test("fresh dist-less legal build fails before domain and passes after domain", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "markiro-fresh-legal-build-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const domain = path.join(directory, "packages/domain");
  const legal = path.join(directory, "packages/legal-documents");
  await cp(path.join(root, "tsconfig.base.json"), path.join(directory, "tsconfig.base.json"));
  await cp(path.join(root, "packages/domain"), domain, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${path.sep}dist${path.sep}`) &&
      !source.endsWith(`${path.sep}dist`) &&
      !source.includes(`${path.sep}node_modules${path.sep}`) &&
      !source.endsWith(`${path.sep}node_modules`),
  });
  await cp(path.join(root, "packages/legal-documents"), legal, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${path.sep}dist${path.sep}`) &&
      !source.endsWith(`${path.sep}dist`) &&
      !source.includes(`${path.sep}node_modules${path.sep}`) &&
      !source.endsWith(`${path.sep}node_modules`),
  });
  await linkDependencies(
    path.join(root, "packages/domain/node_modules"),
    path.join(domain, "node_modules"),
  );
  await linkDependencies(
    path.join(root, "packages/legal-documents/node_modules"),
    path.join(legal, "node_modules"),
    {
      "@markiro": path.join(directory, "packages"),
    },
  );
  assert.equal((await lstat(domain)).isDirectory(), true);
  assert.notEqual(tsc(path.join(legal, "tsconfig.json")).status, 0);
  assert.equal(tsc(path.join(domain, "tsconfig.json")).status, 0);
  const legalBuild = tsc(path.join(legal, "tsconfig.json"));
  assert.equal(legalBuild.status, 0, legalBuild.stderr || legalBuild.stdout);
});
