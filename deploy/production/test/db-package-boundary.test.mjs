import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const root = new URL("../../..", import.meta.url);
const packageRoot = new URL("packages/db/", root);
const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
const expectedRuntimeExport = {
  types: "./dist/runtime-migrate.d.ts",
  default: "./dist/runtime-migrate.js",
};
let packageProbe;
let probeDirectory;
let runtimeHook;

before(async () => {
  await rm(new URL("dist", packageRoot), { recursive: true, force: true });
  const build = spawnSync("corepack", ["pnpm", "--filter", "@markiro/db", "build"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });

  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

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
    { cwd: fileURLToPath(packageRoot), encoding: "utf8" },
  );
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  packageProbe = JSON.parse(probe.stdout);

  probeDirectory = await mkdtemp(join(tmpdir(), "markiro-db-boundary-"));
  runtimeHook = join(probeDirectory, "runtime-hook.mjs");
  await writeFile(
    runtimeHook,
    `import { registerHooks } from "node:module";

const target = process.env.MARKIRO_RUNTIME_TARGET_URL;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === target
      ? { url: "markiro-test:runtime-migrate", shortCircuit: true }
      : resolved;
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
  if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true });
});

function assertRuntimeExportShape(manifest) {
  assert.deepEqual(manifest.exports["./runtime-migrate"], expectedRuntimeExport);

  const migratorAliases = Object.entries(manifest.exports)
    .filter(([key, mapping]) => /migrat/i.test(`${key} ${JSON.stringify(mapping)}`))
    .map(([key]) => key);
  assert.deepEqual(migratorAliases, ["./runtime-migrate"]);
}

test("the built package root cannot expose the server-only runtime migrator", () => {
  assert.deepEqual(packageProbe.rootMigrationExports, []);
});

test("the explicit runtime-migrate subpath exports the built migration function", () => {
  assert.equal(packageProbe.runtimeExportType, "function");
});

test("the runtime-migrate package mapping points to built JavaScript and declarations", async () => {
  assertRuntimeExportShape(packageJson);

  for (const target of Object.values(expectedRuntimeExport)) {
    const metadata = await stat(new URL(target, packageRoot));
    assert.equal(metadata.isFile(), true, `${target} must be a built file`);
  }
});

test("the package contract rejects alternate migrator filenames and aliases", () => {
  const alternateFilename = structuredClone(packageJson);
  alternateFilename.exports["./runtime-migrate"].default = "./dist/runtime-migrate-alias.js";
  assert.throws(() => assertRuntimeExportShape(alternateFilename));

  const additionalAlias = structuredClone(packageJson);
  additionalAlias.exports["./migrate"] = expectedRuntimeExport;
  assert.throws(() => assertRuntimeExportShape(additionalAlias));
});

test("the built migration CLI loads and calls the server implementation without DB access", () => {
  const execution = spawnSync(
    process.execPath,
    ["--import", runtimeHook, fileURLToPath(new URL("dist/migrate-cli.js", packageRoot))],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "",
        MARKIRO_RUNTIME_TARGET_URL: new URL("dist/runtime-migrate.js", packageRoot).href,
      },
    },
  );

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, "");
  assert.deepEqual(JSON.parse(execution.stdout), {
    databaseUrl: "",
    migrationsFolder: fileURLToPath(new URL("migrations", packageRoot)),
  });
});
