import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { RUNTIME_DEPENDENCY_PROBE_SOURCE } from "../runtime-dependency-probe.mjs";

async function packageManifest(root, relativePath, name, contents) {
  const directory = join(root, relativePath);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    contents ?? `${JSON.stringify({ name, version: "1.0.0" })}\n`,
  );
  return directory;
}

function runProbe(root) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", RUNTIME_DEPENDENCY_PROBE_SOURCE, root],
    { encoding: "utf8", timeout: 5_000 },
  );
}

test("runtime dependency probe scans nested pnpm manifests and fails closed", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "markiro-runtime-dependency-probe-"));
  const modules = join(fixture, "node_modules");
  await mkdir(modules, { recursive: true });
  t.after(() => rm(fixture, { recursive: true, force: true }));

  await t.test("accepts a clean pnpm tree and terminates through a symlink loop", async () => {
    const packageDirectory = await packageManifest(
      modules,
      ".pnpm/allowed@1.0.0/node_modules/allowed",
      "allowed",
    );
    const nestedModules = join(packageDirectory, "node_modules");
    await mkdir(nestedModules, { recursive: true });
    await symlink(modules, join(nestedModules, "loop"), "dir");
    const virtualStoreHoist = join(modules, ".pnpm/node_modules/@markiro");
    await mkdir(virtualStoreHoist, { recursive: true });
    await symlink(join(fixture, "missing-workspace-api"), join(virtualStoreHoist, "api"), "dir");

    const result = runProbe(modules);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  for (const dependency of ["@playwright/test", "@opentelemetry/api"]) {
    await t.test(`rejects nested ${dependency}`, async () => {
      const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-injection-"));
      const isolatedModules = join(isolatedFixture, "node_modules");
      t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
      await packageManifest(
        isolatedModules,
        `.pnpm/injected@1.0.0/node_modules/${dependency}`,
        dependency,
      );

      const result = runProbe(isolatedModules);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });

    await t.test(`rejects virtual-store-hoisted ${dependency}`, async () => {
      const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-hoist-"));
      const isolatedModules = join(isolatedFixture, "node_modules");
      t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
      await packageManifest(isolatedModules, `.pnpm/node_modules/${dependency}`, dependency);

      const result = runProbe(isolatedModules);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });

    await t.test(`scans an in-root @markiro/api self-link containing ${dependency}`, async () => {
      const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-self-link-"));
      const isolatedModules = join(isolatedFixture, "node_modules");
      const selfTarget = await packageManifest(isolatedModules, ".self-target", "@markiro/api");
      const centralScope = join(isolatedModules, ".pnpm/node_modules/@markiro");
      t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
      await packageManifest(selfTarget, `node_modules/${dependency}`, dependency);
      await mkdir(centralScope, { recursive: true });
      await symlink(selfTarget, join(centralScope, "api"), "dir");

      const result = runProbe(isolatedModules);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  }

  await t.test("rejects a resolved external @markiro/api self-link", async () => {
    const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-external-self-"));
    const isolatedModules = join(isolatedFixture, "node_modules");
    const externalSelf = await packageManifest(isolatedFixture, "workspace-api", "@markiro/api");
    const centralScope = join(isolatedModules, ".pnpm/node_modules/@markiro");
    t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
    await mkdir(centralScope, { recursive: true });
    await symlink(externalSelf, join(centralScope, "api"), "dir");

    const result = runProbe(isolatedModules);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  await t.test("rejects a package manifest symlink that escapes the scan root", async () => {
    const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-manifest-link-"));
    const isolatedModules = join(isolatedFixture, "node_modules");
    const packageDirectory = join(isolatedModules, ".pnpm/linked@1.0.0/node_modules/linked");
    const externalManifest = join(isolatedFixture, "outside-package.json");
    t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(externalManifest, '{"name":"linked","version":"1.0.0"}\n');
    await symlink(externalManifest, join(packageDirectory, "package.json"));

    const result = runProbe(isolatedModules);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  await t.test("rejects a package directory symlink that escapes the scan root", async () => {
    const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-package-link-"));
    const isolatedModules = join(isolatedFixture, "node_modules");
    const externalPackage = await packageManifest(isolatedFixture, "outside-package", "linked");
    const storeModules = join(isolatedModules, ".pnpm/linked@1.0.0/node_modules");
    t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
    await mkdir(storeModules, { recursive: true });
    await symlink(externalPackage, join(storeModules, "linked"), "dir");

    const result = runProbe(isolatedModules);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  await t.test("rejects broken and looping package manifest symlinks", async () => {
    for (const target of ["missing-package.json", "package.json"]) {
      const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-broken-link-"));
      const isolatedModules = join(isolatedFixture, "node_modules");
      const packageDirectory = join(isolatedModules, ".pnpm/linked@1.0.0/node_modules/linked");
      t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
      await mkdir(packageDirectory, { recursive: true });
      await symlink(target, join(packageDirectory, "package.json"));

      const result = runProbe(isolatedModules);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  });

  await t.test(
    "rejects an invalid encountered package manifest without disclosing it",
    async () => {
      const isolatedFixture = await mkdtemp(join(tmpdir(), "markiro-runtime-invalid-"));
      const isolatedModules = join(isolatedFixture, "node_modules");
      t.after(() => rm(isolatedFixture, { recursive: true, force: true }));
      await packageManifest(
        isolatedModules,
        ".pnpm/broken@1.0.0/node_modules/broken",
        "broken",
        '{"token":"do-not-log",',
      );

      const result = runProbe(isolatedModules);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    },
  );
});
