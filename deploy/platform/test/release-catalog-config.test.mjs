import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCatalogConfig,
  assertCatalogMounts,
  catalogMountBindings,
  assertExclusiveCatalogMounts,
} from "../catalog-config.mjs";
const env = () => ({
  MARKIRO_RELEASES_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
  RELEASE_CATALOG_S3_REGION: "ru-1",
  RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture",
  RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "private-fixture",
  RELEASE_CATALOG_CACHE_DIR: "/opt/markiro-platform/release-catalog/cache",
  RELEASE_CATALOG_JOURNAL_DIR: "/opt/markiro-platform/release-catalog/journal",
  RELEASE_CATALOG_CACHE_BYTES: "1048576",
  RELEASE_CATALOG_OBJECT_BYTES: "524288",
  RELEASE_CATALOG_DISK_RESERVE_BYTES: "1048576",
  RELEASE_CATALOG_DOWNLOADS: "2",
  RELEASE_CATALOG_TIMEOUT_MS: "30000",
  RELEASE_CATALOG_WRITERS_ENABLED: "false",
});
test("catalog absent closes resolver; partial/unsafe config never silently disables", () => {
  assert.equal(validateCatalogConfig({}), false);
  assert.equal(validateCatalogConfig(env()), true);
  for (const key of Object.keys(env()).filter((k) => k.startsWith("RELEASE_CATALOG_"))) {
    const e = env();
    delete e[key];
    assert.throws(() => validateCatalogConfig(e), key);
  }
  for (const patch of [
    { RELEASE_CATALOG_S3_ENDPOINT: "https://evil.test" },
    { RELEASE_CATALOG_S3_BUCKET: "backups" },
    { RELEASE_CATALOG_CACHE_DIR: "/tmp/cache" },
    { RELEASE_CATALOG_OBJECT_BYTES: "536870913" },
    { RELEASE_CATALOG_DOWNLOADS: "3" },
    { RELEASE_CATALOG_CACHE_BYTES: "1" },
    { RELEASE_CATALOG_DISK_RESERVE_BYTES: "0" },
    { RELEASE_CATALOG_TIMEOUT_MS: "3600001" },
    { RELEASE_CATALOG_WRITERS_ENABLED: "true" },
    { RELEASE_CATALOG_PUBLISHERS_JSON: "private-fixture" },
  ])
    assert.throws(
      () => validateCatalogConfig({ ...env(), ...patch }),
      (e) => !e.message.includes("private-fixture"),
    );
});
test("writer activation needs immutable publisher identity pins, not moving refs alone", () => {
  const p = {
    repository: "thevladbog/markiro",
    repositoryId: "1",
    ownerId: "2",
    workflows: [
      {
        product: "station",
        environment: "station-release",
        workflowRef:
          "thevladbog/markiro/.github/workflows/station-beta-release.yml@refs/heads/main",
        workflowSha: "a".repeat(40),
        subject: "repo:thevladbog/markiro:environment:station-release",
      },
    ],
  };
  assert.equal(
    validateCatalogConfig({
      ...env(),
      RELEASE_CATALOG_WRITERS_ENABLED: "true",
      RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify(p),
    }),
    true,
  );
  delete p.workflows[0].workflowSha;
  assert.throws(() =>
    validateCatalogConfig({ ...env(), RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify(p) }),
  );
});
test("host mount proof requires exact canonical private directories owned by API uid", () => {
  const stat = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 1000,
    gid: 1000,
    mode: 0o40700,
  };
  const fs = { lstatSync: () => stat, realpathSync: (p) => p };
  assert.doesNotThrow(() => assertCatalogMounts(env(), fs));
  for (const change of [
    { uid: 0 },
    { gid: 0 },
    { mode: 0o40755 },
    { isSymbolicLink: () => true },
    { isDirectory: () => false },
  ])
    assert.throws(() =>
      assertCatalogMounts(env(), { ...fs, lstatSync: () => ({ ...stat, ...change }) }),
    );
  assert.throws(() => assertCatalogMounts(env(), { ...fs, realpathSync: () => "/elsewhere" }));
});

test("only the API may mount the exact private catalog directories read-write", () => {
  assert.deepEqual(catalogMountBindings({}, "api"), {});
  for (const service of ["edge", "migrate", "postgres"])
    assert.deepEqual(catalogMountBindings(env(), service), {});
  const binds = catalogMountBindings(env(), "api");
  assert.deepEqual(Object.keys(binds), [
    env().RELEASE_CATALOG_CACHE_DIR,
    env().RELEASE_CATALOG_JOURNAL_DIR,
  ]);
  for (const [key, value] of Object.entries(binds)) assert.equal(key, value);
  assert.throws(() => catalogMountBindings({ ...env(), RELEASE_CATALOG_CACHE_DIR: "/etc" }, "api"));
});

test("foreign containers cannot share catalog binds even when stopped or mounting an ancestor", () => {
  const mount = {
    Source: "/opt/markiro-platform/release-catalog/cache",
    Destination: "/elsewhere",
  };
  assert.doesNotThrow(() =>
    assertExclusiveCatalogMounts([{ Id: "owned", Mounts: [mount] }], "owned"),
  );
  for (const source of [
    mount.Source,
    "/opt/markiro-platform/release-catalog",
    "/opt/markiro-platform",
    "/",
    "/opt/markiro-platform/release-catalog/journal",
  ])
    assert.throws(() =>
      assertExclusiveCatalogMounts(
        [
          { Id: "owned", Mounts: [mount] },
          { Id: "foreign", State: { Running: false }, Mounts: [{ ...mount, Source: source }] },
        ],
        "owned",
      ),
    );
  assert.doesNotThrow(() =>
    assertExclusiveCatalogMounts(
      [{ Id: "foreign", Mounts: [{ Source: "/unrelated", Destination: "/elsewhere" }] }],
      "owned",
    ),
  );
});
