import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const sourcePackageRoot = join(root, "packages/db");
const sourceDist = join(sourcePackageRoot, "dist");
const sourceNodeModules = join(sourcePackageRoot, "node_modules");
const compiler = join(root, "node_modules/typescript/bin/tsc");
const packageJson = JSON.parse(await readFile(join(sourcePackageRoot, "package.json"), "utf8"));
const expectedExportKeys = [".", "./organization-access", "./runtime-migrate"];
const expectedRuntimeExport = {
  types: "./dist/runtime-migrate.d.ts",
  default: "./dist/runtime-migrate.js",
};
const sharedDistBefore = await snapshotDirectory(sourceDist);

let fixtureRoot;
let isolatedPackageRoot;
let consumerRoot;
let packageProbe;
let runtimeHook;
let compiledCliUrl;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "markiro-db-boundary-"));
  isolatedPackageRoot = join(fixtureRoot, "package");
  await mkdir(isolatedPackageRoot, { recursive: true });
  await writeFile(
    join(isolatedPackageRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await symlink(sourceNodeModules, join(isolatedPackageRoot, "node_modules"), "dir");

  const build = spawnSync(
    process.execPath,
    [
      compiler,
      "--project",
      join(sourcePackageRoot, "tsconfig.json"),
      "--outDir",
      join(isolatedPackageRoot, "dist"),
      "--rootDir",
      join(sourcePackageRoot, "src"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  compiledCliUrl = pathToFileURL(
    await realpath(join(isolatedPackageRoot, "dist/migrate-cli.js")),
  ).href;

  consumerRoot = await createConsumer("actual", isolatedPackageRoot);
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const root = await import("@markiro/db");
       const runtime = await import("@markiro/db/runtime-migrate");
       console.log(JSON.stringify({
         rootMigrationExports: Object.keys(root).filter((name) => /runtime.*migrat/i.test(name)),
         runtimeExportType: typeof runtime.runRuntimeMigrations,
       }));`,
    ],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  packageProbe = JSON.parse(probe.stdout);

  runtimeHook = join(fixtureRoot, "runtime-hook.mjs");
  await writeFile(
    runtimeHook,
    `import { registerHooks } from "node:module";

const cli = process.env.MARKIRO_CLI_URL;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "./runtime-migrate.js" && context.parentURL === cli
      ? { url: "markiro-test:runtime-migrate", shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== "markiro-test:runtime-migrate") return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: \`export async function runRuntimeMigrations(options) {
        console.log(JSON.stringify(options));
      }\`,
    };
  },
});
`,
  );
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

function assertRuntimeExportContract(manifest) {
  assert.deepEqual(Object.keys(manifest.exports).sort(), [...expectedExportKeys].sort());
  assert.deepEqual(manifest.exports["./runtime-migrate"], expectedRuntimeExport);
}

async function assertMappedArtifactsExist(packageRoot, mapping = expectedRuntimeExport) {
  for (const target of Object.values(mapping)) {
    const metadata = await stat(join(packageRoot, target));
    assert.equal(metadata.isFile(), true, `${target} must be a built file`);
  }
}

async function createConsumer(name, packageRoot) {
  const currentConsumer = join(fixtureRoot, "consumers", name);
  const scope = join(currentConsumer, "node_modules/@markiro");
  await mkdir(scope, { recursive: true });
  await symlink(packageRoot, join(scope, "db"), "dir");
  return currentConsumer;
}

async function copyIsolatedPackage(name) {
  const target = join(fixtureRoot, "packages", name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await cp(join(isolatedPackageRoot, "dist"), join(target, "dist"), { recursive: true });
  await symlink(sourceNodeModules, join(target, "node_modules"), "dir");
  return target;
}

async function compileFixture(currentConsumer, filename, source) {
  const fixture = join(currentConsumer, filename);
  await writeFile(fixture, source);
  return spawnSync(
    process.execPath,
    [
      compiler,
      "--noEmit",
      "--pretty",
      "false",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      fixture,
    ],
    { cwd: currentConsumer, encoding: "utf8" },
  );
}

function assertMissingRootExport(result, exportName) {
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `${exportName} unexpectedly compiled from package root`);
  assert.ok(
    output.includes(`error TS2305: Module '"@markiro/db"' has no exported member '${exportName}'.`),
    output,
  );
}

async function snapshotDirectory(directory) {
  try {
    const files = [];

    async function visit(current) {
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isSymbolicLink()) {
          files.push([relative(directory, path), "symlink", await readlink(path)]);
        } else {
          const metadata = await stat(path, { bigint: true });
          const digest = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
          files.push([
            relative(directory, path),
            metadata.ino.toString(),
            metadata.mtimeNs.toString(),
            digest,
          ]);
        }
      }
    }

    await visit(directory);
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

test("the isolated package root cannot expose the server-only runtime migrator", () => {
  assert.deepEqual(packageProbe.rootMigrationExports, []);
});

test("the isolated runtime-migrate subpath exports the built migration function", () => {
  assert.equal(packageProbe.runtimeExportType, "function");
});

test("the package export allowlist is exact and every runtime mapping artifact exists", async () => {
  assertRuntimeExportContract(packageJson);
  await assertMappedArtifactsExist(isolatedPackageRoot);
});

test("the export contract rejects alternate files, missing declarations, and neutral aliases", async () => {
  const alternateFilename = structuredClone(packageJson);
  alternateFilename.exports["./runtime-migrate"].default = "./dist/runtime-migrate-alias.js";
  assert.throws(() => assertRuntimeExportContract(alternateFilename));

  const wrongDeclaration = structuredClone(packageJson);
  wrongDeclaration.exports["./runtime-migrate"].types = "./dist/runtime-migrate-wrong.d.ts";
  assert.throws(() => assertRuntimeExportContract(wrongDeclaration));

  const neutralAlias = structuredClone(packageJson);
  neutralAlias.exports["./server"] = expectedRuntimeExport;
  assert.throws(() => assertRuntimeExportContract(neutralAlias));

  const missingDeclarationPackage = join(fixtureRoot, "packages/missing-declaration");
  await mkdir(join(missingDeclarationPackage, "dist"), { recursive: true });
  await writeFile(join(missingDeclarationPackage, "dist/runtime-migrate.js"), "export {};\n");
  await assert.rejects(assertMappedArtifactsExist(missingDeclarationPackage), { code: "ENOENT" });
});

test("the isolated package exposes runtime migration values and types only from the subpath", async () => {
  const subpath = await compileFixture(
    consumerRoot,
    "subpath.ts",
    `import { runRuntimeMigrations, type RuntimeMigrationOptions } from "@markiro/db/runtime-migrate";
const options: RuntimeMigrationOptions = { databaseUrl: "", migrationsFolder: "" };
void runRuntimeMigrations(options);
`,
  );
  assert.equal(subpath.status, 0, `${subpath.stdout}\n${subpath.stderr}`);

  const rootImport = await compileFixture(
    consumerRoot,
    "root.ts",
    `import { runRuntimeMigrations, type RuntimeMigrationOptions } from "@markiro/db";
const options: RuntimeMigrationOptions = { databaseUrl: "", migrationsFolder: "" };
void runRuntimeMigrations(options);
`,
  );
  assertMissingRootExport(rootImport, "runRuntimeMigrations");
  assertMissingRootExport(rootImport, "RuntimeMigrationOptions");
});

test("the root type probe detects an adversarial type-only runtime export", async () => {
  const mutatedPackage = await copyIsolatedPackage("type-only-root-export");
  await appendFile(
    join(mutatedPackage, "dist/index.d.ts"),
    'export type { RuntimeMigrationOptions } from "./runtime-migrate.js";\n',
  );
  const mutatedConsumer = await createConsumer("type-only-root-export", mutatedPackage);
  const result = await compileFixture(
    mutatedConsumer,
    "root-type.ts",
    `import type { RuntimeMigrationOptions } from "@markiro/db";
const options = {} as RuntimeMigrationOptions;
void options;
`,
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.throws(() => assertMissingRootExport(result, "RuntimeMigrationOptions"));
});

test("the isolated migration CLI loads and calls the exact server implementation without DB access", () => {
  const execution = spawnSync(
    process.execPath,
    ["--import", runtimeHook, join(isolatedPackageRoot, "dist/migrate-cli.js")],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "",
        MARKIRO_CLI_URL: compiledCliUrl,
      },
    },
  );

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, "");
  assert.deepEqual(JSON.parse(execution.stdout), {
    databaseUrl: "",
    migrationsFolder: fileURLToPath(new URL("../migrations", compiledCliUrl)),
  });
});

test("the isolated package build never mutates shared database output", async () => {
  assert.deepEqual(await snapshotDirectory(sourceDist), sharedDistBefore);
});
