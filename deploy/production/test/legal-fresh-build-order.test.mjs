import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

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

async function freshVerifierFixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "markiro-fresh-legal-verifier-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const domain = path.join(directory, "packages/domain");
  const legal = path.join(directory, "packages/legal-documents");
  await Promise.all([
    cp(path.join(root, "package.json"), path.join(directory, "package.json")),
    cp(path.join(root, "pnpm-workspace.yaml"), path.join(directory, "pnpm-workspace.yaml")),
    cp(path.join(root, "tsconfig.base.json"), path.join(directory, "tsconfig.base.json")),
    cp(path.join(root, "packages/domain"), domain, {
      recursive: true,
      filter: sourceFilter,
    }),
    cp(path.join(root, "packages/legal-documents"), legal, {
      recursive: true,
      filter: sourceFilter,
    }),
    copyProductionVerifier(directory),
  ]);
  await linkDependencies(
    path.join(root, "packages/domain/node_modules"),
    path.join(domain, "node_modules"),
  );
  await linkDependencies(
    path.join(root, "packages/legal-documents/node_modules"),
    path.join(legal, "node_modules"),
    { "@markiro": path.join(directory, "packages") },
  );
  return directory;
}

function sourceFilter(source) {
  return (
    !source.includes(`${path.sep}dist${path.sep}`) &&
    !source.endsWith(`${path.sep}dist`) &&
    !source.includes(`${path.sep}node_modules${path.sep}`) &&
    !source.endsWith(`${path.sep}node_modules`)
  );
}

async function copyProductionVerifier(directory) {
  const production = path.join(directory, "deploy/production");
  const landing = path.join(directory, "apps/landing/public");
  await Promise.all([mkdir(production, { recursive: true }), mkdir(landing, { recursive: true })]);
  await Promise.all([
    cp(path.join(root, "deploy/production/cli-main.mjs"), path.join(production, "cli-main.mjs")),
    cp(
      path.join(root, "deploy/production/verify-legal-artifacts.mjs"),
      path.join(production, "verify-legal-artifacts.mjs"),
    ),
    cp(
      path.join(root, "deploy/production/legal-artifacts-attestation.json"),
      path.join(production, "legal-artifacts-attestation.json"),
    ),
    cp(path.join(root, "apps/landing/public/legal"), path.join(landing, "legal"), {
      recursive: true,
    }),
  ]);
}

function runProductionVerifier(directory) {
  const source = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const verifier = await import(pathToFileURL(path.join(process.cwd(), "deploy/production/verify-legal-artifacts.mjs")));
    await verifier.verifyPublishedLegalArtifacts(
      path.join(process.cwd(), "apps/landing/public/legal"),
      path.join(process.cwd(), "deploy/production/legal-artifacts-attestation.json"),
      undefined,
      async () => undefined,
    );
    process.stdout.write("verified dist-less fixture\\n");
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: directory,
    encoding: "utf8",
  });
}

function runWorkflowBuild(directory, command) {
  const expected = {
    "pnpm --filter @markiro/domain build": "packages/domain/tsconfig.json",
    "pnpm --filter @markiro/legal-documents build": "packages/legal-documents/tsconfig.json",
  }[command];
  assert.ok(expected, `unsupported legal verifier build command: ${command}`);
  return tsc(path.join(directory, expected));
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

for (const [label, workflowPath] of [
  ["CI", ".github/workflows/ci.yml"],
  ["release", ".github/workflows/release-images.yml"],
]) {
  test(`${label} production contracts build and load the verifier from a dist-less checkout`, async (context) => {
    const directory = await freshVerifierFixture(context);
    const beforeBuild = runProductionVerifier(directory);
    assert.notEqual(beforeBuild.status, 0);
    assert.match(beforeBuild.stderr, /ERR_MODULE_NOT_FOUND/);

    const workflow = load(await readFile(path.join(root, workflowPath), "utf8"));
    const steps = workflow.jobs["production-bundle"].steps;
    const contractIndex = steps.findIndex(
      (step) => step.name === "Verify production bundle contracts",
    );
    assert.notEqual(contractIndex, -1);
    const buildStep = steps[contractIndex - 1];
    assert.equal(buildStep.name, "Build legal verifier dependencies");
    assert.equal(
      buildStep.run,
      "pnpm --filter @markiro/domain build\npnpm --filter @markiro/legal-documents build\n",
    );
    for (const command of buildStep.run.trim().split("\n")) {
      const build = runWorkflowBuild(directory, command);
      assert.equal(build.status, 0, build.stderr || build.stdout);
    }

    const afterBuild = runProductionVerifier(directory);
    assert.equal(afterBuild.status, 0, afterBuild.stderr || afterBuild.stdout);
    assert.equal(afterBuild.stdout, "verified dist-less fixture\n");
  });
}
