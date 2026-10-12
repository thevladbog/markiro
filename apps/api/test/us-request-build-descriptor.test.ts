import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as descriptor from "../src/deployment/us-request-build-descriptor";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";

type Fixture = Awaited<ReturnType<typeof createUsRequestBuildFixture>>;
const fixtures: Fixture[] = [];
async function ready() {
  const fixture = await createUsRequestBuildFixture();
  fixtures.push(fixture);
  const document = await descriptor.captureUsRequestBuildDescriptor(
    fixture.cleanBuild,
    fixture.roots,
  );
  await fixture.writeDocument(document);
  return { fixture, document, source: await localBuildEnv() };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("checked US request build descriptor", () => {
  it.each(["db", "domain", "platform-contracts"])(
    "rejects correct inventories with a misdirected API workspace link to %s",
    async (name) => {
      const { fixture, source } = await ready();
      const outside = join(fixture.root, "stale-checkout", name);
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "package.json"), JSON.stringify({ main: "index.js" }));
      await writeFile(join(outside, "index.js"), "module.exports = {};\n");
      await mkdir(join(fixture.api, "node_modules/@markiro"), { recursive: true });
      await symlink(outside, join(fixture.api, "node_modules/@markiro", name), "dir");
      await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
        "us_request_build_invalid",
      );
    },
  );
  it("rejects a shared ESM consumer's misdirected domain dependency", async () => {
    const { fixture, source } = await ready();
    const outside = join(fixture.root, "stale-domain");
    await mkdir(outside);
    await writeFile(join(outside, "package.json"), JSON.stringify({ main: "index.js" }));
    await writeFile(join(outside, "index.js"), "export const stale = true;\n");
    const modules = join(fixture.roots.trees.contracts, "../node_modules/@markiro");
    await mkdir(modules, { recursive: true });
    await symlink(outside, join(modules, "domain"), "dir");
    await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
      "us_request_build_invalid",
    );
  });
  it("rejects a foreign package manifest even when its require entry aliases checked bytes", async () => {
    const { fixture, source } = await ready();
    const outside = join(fixture.root, "stale-conditional-domain");
    await mkdir(outside);
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({
        name: "@markiro/domain",
        exports: { ".": { import: "./stale.js", require: "./index.js", default: "./index.js" } },
      }),
    );
    await writeFile(join(outside, "stale.js"), "export const stale = true;\n");
    await symlink(join(fixture.roots.trees.domain, "index.js"), join(outside, "index.js"));
    const modules = join(fixture.roots.trees.contracts, "../node_modules/@markiro");
    await mkdir(modules, { recursive: true });
    await symlink(outside, join(modules, "domain"), "dir");
    await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
      "us_request_build_invalid",
    );
  });
  it.each(["api", "contracts"] as const)(
    "rejects a nested %s importer dependency shadow",
    async (tree) => {
      const fixture = await createUsRequestBuildFixture();
      fixtures.push(fixture);
      const directory = join(fixture.roots.trees[tree], "nested");
      await mkdir(directory);
      await writeFile(
        join(directory, "consumer.js"),
        tree === "api" ? 'require("@markiro/domain");\n' : 'import "@markiro/domain";\n',
      );
      await fixture.writeDocument(
        await descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
      );
      const shadow = join(directory, "node_modules/@markiro/domain");
      await mkdir(shadow, { recursive: true });
      await writeFile(join(shadow, "package.json"), JSON.stringify({ main: "index.js" }));
      await writeFile(join(shadow, "index.js"), "module.exports = {};\n");
      // Keep the checked output inventory correct, including the shadow's bytes.
      await fixture.writeDocument(
        await descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
      );
      await expect(
        descriptor.loadUsRequestBuildDescriptor(await localBuildEnv(), fixture.roots),
      ).rejects.toThrow("us_request_build_invalid");
    },
  );
  it.each(["default", "import", "require"])(
    "rejects a changed workspace root %s export outside checked output",
    async (condition) => {
      const { fixture, source } = await ready();
      await writeFile(join(fixture.roots.trees.domain, "../stale.js"), "export {};\n");
      await writeFile(
        join(fixture.roots.trees.domain, "../package.json"),
        JSON.stringify({
          name: "@markiro/domain",
          exports: {
            ".":
              condition === "default"
                ? { default: "./stale.js" }
                : { [condition]: "./stale.js", default: "./dist/index.js" },
          },
        }),
      );
      await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
        "us_request_build_invalid",
      );
    },
  );
  it("permits normal pnpm workspace links from API and shared importers", async () => {
    const { fixture, source } = await ready();
    await expect(
      descriptor.loadUsRequestBuildDescriptor(source, fixture.roots),
    ).resolves.toMatchObject({
      document: { build: fixture.cleanBuild },
    });
  });
  it.each(["api", "db", "domain", "contracts"] as const)(
    "rejects identical output reached through a %s parent-directory symlink",
    async (tree) => {
      const { fixture, source } = await ready();
      const parent = dirname(fixture.roots.trees[tree]);
      const outside = join(fixture.root, `outside-${tree}`);
      await rename(parent, outside);
      await symlink(outside, parent);
      await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
        "us_request_build_invalid",
      );
      await expect(
        descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
      ).rejects.toThrow("us_request_build_invalid");
      const program = `require(${JSON.stringify(resolve("dist/deployment/us-request-build-descriptor.js"))}).loadUsRequestBuildDescriptor(JSON.parse(process.env.US_BUILD_FIXTURE_ENV), JSON.parse(process.env.US_BUILD_FIXTURE_ROOTS)).then(() => process.exit(2), () => process.exit(0));`;
      const compiled = spawnSync(process.execPath, ["-e", program], {
        env: {
          ...process.env,
          US_BUILD_FIXTURE_ENV: JSON.stringify(source),
          US_BUILD_FIXTURE_ROOTS: JSON.stringify(fixture.roots),
        },
        timeout: 1000,
        encoding: "utf8",
      });
      expect(compiled.status).toBe(0);
    },
  );
  it("permits a filesystem alias above the workspace boundary", async () => {
    const { fixture, source } = await ready();
    const alias = join(fixture.root, "outer-alias");
    await symlink(dirname(fixture.root), alias);
    const workspace = join(alias, basename(fixture.root));
    const rebase = (path: string) => join(workspace, relative(fixture.root, path));
    const roots = {
      trees: {
        api: rebase(fixture.roots.trees.api),
        db: rebase(fixture.roots.trees.db),
        domain: rebase(fixture.roots.trees.domain),
        contracts: rebase(fixture.roots.trees.contracts),
      },
      lockfile: rebase(fixture.roots.lockfile),
    };
    await expect(descriptor.loadUsRequestBuildDescriptor(source, roots)).resolves.toMatchObject({
      document: { build: fixture.cleanBuild },
    });
  });
  it("rejects an identical lockfile reached through a workspace-relative parent symlink", async () => {
    const { fixture, source } = await ready();
    const outside = join(fixture.root, "outside-lock");
    const parent = join(fixture.root, "locks");
    await mkdir(outside);
    await writeFile(join(outside, "pnpm-lock.yaml"), "fixture lock\n");
    await symlink(outside, parent);
    const roots = { ...fixture.roots, lockfile: join(parent, "pnpm-lock.yaml") };
    await expect(descriptor.loadUsRequestBuildDescriptor(source, roots)).rejects.toThrow(
      "us_request_build_invalid",
    );
    await expect(
      descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, roots),
    ).rejects.toThrow("us_request_build_invalid");
  });
  it("bounds cumulative captured bytes including the lockfile without competing invalid inventory", async () => {
    const { fixture, document } = await ready();
    expect(document.files.reduce((total, file) => total + file.byteSize, 0)).toBe(98);
    // Existing valid inventory totals 98 bytes; the lockfile is 13 bytes.
    // Seven full files plus the last file bring compiled output to 256 MiB - 13.
    for (let index = 0; index < 8; index++) {
      const path = join(fixture.roots.trees.api, `large-${index}.js`);
      await writeFile(path, "");
      await truncate(path, index === 7 ? 32 * 1024 * 1024 - 98 - 13 : 32 * 1024 * 1024);
    }
    await expect(
      descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    ).resolves.toMatchObject({ build: fixture.cleanBuild });
    // Only the lock grows: compiled inventory remains valid and unchanged.
    await writeFile(fixture.roots.lockfile, "fixture lock\n!");
    await expect(
      descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    ).rejects.toThrow("us_request_build_invalid");
  });
  it("checks an installed XLSX renderer that exports only its Node subpath", async () => {
    const { fixture, source } = await ready();
    await writeFile(
      join(fixture.api, "node_modules/write-excel-file/package.json"),
      JSON.stringify({
        name: "write-excel-file",
        version: "4.1.1",
        exports: { "./node": "./index.js" },
      }),
    );
    await expect(
      descriptor.loadUsRequestBuildDescriptor(source, fixture.roots),
    ).resolves.toMatchObject({ document: { build: fixture.cleanBuild } });
  });
  it("refuses a FIFO descriptor without waiting for a writer", async () => {
    const { fixture, source } = await ready();
    await rm(fixture.descriptorPath);
    execFileSync("mkfifo", [fixture.descriptorPath]);
    const program = `require(${JSON.stringify(resolve("dist/deployment/us-request-build-descriptor.js"))}).loadUsRequestBuildDescriptor(JSON.parse(process.env.US_BUILD_FIXTURE_ENV), JSON.parse(process.env.US_BUILD_FIXTURE_ROOTS)).then(() => process.exit(2), () => process.exit(0));`;
    const result = spawnSync(process.execPath, ["-e", program], {
      env: {
        ...process.env,
        US_BUILD_FIXTURE_ENV: JSON.stringify(source),
        US_BUILD_FIXTURE_ROOTS: JSON.stringify(fixture.roots),
      },
      timeout: 1000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
  it("captures exact byte hashes, sorted complete inventories and immutable loaded authority", async () => {
    const { fixture, document, source } = await ready();
    expect(document.files).toHaveLength(7);
    expect(document.files.find((file) => file.path === "main.us-request-worker.js")).toEqual({
      tree: "api",
      path: "main.us-request-worker.js",
      byteSize: 15,
      sha256: createHash("sha256").update("fixture worker\n").digest("hex"),
    });
    expect(document.lockfileSha256).toBe(
      createHash("sha256").update("fixture lock\n").digest("hex"),
    );
    const keys = document.files.map((file) => `${file.tree}/${file.path}`);
    expect(keys).toEqual([...keys].sort());
    const loaded = await descriptor.loadUsRequestBuildDescriptor(source, fixture.roots);
    expect(loaded.document.build).toEqual(fixture.cleanBuild);
    expect(Object.isFrozen(loaded.document.files[0])).toBe(true);
    expect(() => descriptor.assertLoadedUsRequestBuildDescriptor(loaded)).not.toThrow();
    expect(() => descriptor.assertLoadedUsRequestBuildDescriptor({ ...loaded })).toThrow();
  });
  it.each(["changed", "added", "removed", "font", "library", "lockfile", "truncated", "missing"])(
    "rejects %s build evidence",
    async (kind) => {
      const { fixture, source } = await ready();
      if (kind === "changed")
        await fixture.replaceApiBytes("main.us-request-worker.js", Buffer.from("changed"));
      if (kind === "added") await fixture.replaceApiBytes("new.js", Buffer.from("new"));
      if (kind === "removed") await rm(join(fixture.roots.trees.db, "index.js"));
      if (kind === "font")
        await fixture.replaceApiBytes(
          "modules/traceability/plans/assets/IBMPlexSans-Regular.ttf",
          Buffer.from("other font"),
        );
      if (kind === "library") await fixture.setLibraryVersion("fflate", "0.8.2");
      if (kind === "lockfile") await writeFile(fixture.roots.lockfile, "different lock");
      if (kind === "truncated") await writeFile(fixture.descriptorPath, '{"schemaVersion":');
      if (kind === "missing") await rm(fixture.descriptorPath);
      await expect(
        descriptor.loadUsRequestBuildDescriptor(source, fixture.roots),
      ).rejects.toThrow();
    },
  );
  it.each([
    "unknown-tree",
    "absolute",
    "traversal",
    "duplicate",
    "unsorted",
    "bad-lock-hash",
    "dirty",
    "extra-field",
    "oversized-file",
    "too-many",
  ])("rejects %s document", async (kind) => {
    const { fixture, document, source } = await ready();
    const files = document.files.map((file) => ({ ...file }));
    const first = files[0];
    if (!first) throw new Error("fixture empty");
    let changed: unknown = document;
    if (kind === "unknown-tree") changed = { ...document, files: [{ ...first, tree: "other" }] };
    if (kind === "absolute") first.path = "/etc/passwd";
    if (kind === "traversal") first.path = "../outside";
    if (kind === "duplicate") files.push({ ...first });
    if (kind === "unsorted") files.reverse();
    if (kind === "bad-lock-hash") changed = { ...document, lockfileSha256: "x".repeat(64) };
    if (kind === "dirty") changed = { ...document, build: { ...document.build, dirty: true } };
    if (kind === "extra-field") changed = { ...document, secret: "must not be accepted" };
    if (kind === "oversized-file") first.byteSize = 32 * 1024 * 1024 + 1;
    if (kind === "too-many")
      changed = {
        ...document,
        files: Array.from({ length: 10001 }, (_, index) => ({
          ...first,
          path: `file-${index}.js`,
        })),
      };
    if (changed === document) changed = { ...document, files };
    await fixture.writeDocument(changed);
    await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow();
  });
  it.each(["file", "directory", "root", "descriptor", "lockfile"])(
    "rejects a symlink at %s",
    async (kind) => {
      const { fixture, source } = await ready();
      const target = join(fixture.root, "target");
      await mkdir(target);
      await writeFile(join(target, "bytes"), "external");
      const path =
        kind === "root"
          ? fixture.roots.trees.db
          : kind === "descriptor"
            ? fixture.descriptorPath
            : kind === "lockfile"
              ? fixture.roots.lockfile
              : join(fixture.roots.trees.api, kind === "directory" ? "linked" : "index.js");
      if (kind !== "directory") await rm(path, { recursive: true });
      await symlink(kind === "directory" || kind === "root" ? target : join(target, "bytes"), path);
      await expect(
        descriptor.loadUsRequestBuildDescriptor(source, fixture.roots),
      ).rejects.toThrow();
    },
  );
  it("bounds descriptor and capture byte size", async () => {
    const { fixture, source } = await ready();
    await writeFile(fixture.descriptorPath, " ".repeat(1024 * 1024 + 1));
    await expect(descriptor.loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow();
    const path = join(fixture.roots.trees.api, "huge.js");
    await writeFile(path, "");
    await truncate(path, 32 * 1024 * 1024 + 1);
    await expect(
      descriptor.captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    ).rejects.toThrow();
  });
  it.each([
    { NODE_ENV: "production" },
    { MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { VITE_DEPLOYMENT_EDITION: "RU" },
    { DATABASE_URL: "postgres://remote/db" },
    { DADATA_TOKEN: "forbidden" },
  ])("rejects operational configuration before evidence loading %j", async (overrides) => {
    const { fixture, source } = await ready();
    await expect(
      descriptor.loadUsRequestBuildDescriptor({ ...source, ...overrides }, fixture.roots),
    ).rejects.toThrow();
  });
});
