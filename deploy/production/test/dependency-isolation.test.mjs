import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const root = new URL("../../..", import.meta.url);
const productionPackages = ["@markiro/api", "@markiro/db"];
const forbiddenProductionDependencies = ["@playwright/test", "@opentelemetry/api"];

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function productionWhy(packageName, dependencyName) {
  const output = execFileSync(
    "corepack",
    ["pnpm", "--filter", packageName, "why", "--prod", dependencyName, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      timeout: 30_000,
    },
  ).trim();
  return output ? JSON.parse(output) : [];
}

test("Playwright lives only in the isolated production-browser tooling workspace", async () => {
  const workspace = load(await readFile(new URL("pnpm-workspace.yaml", root), "utf8"));
  const rootPackage = await json("package.json");
  const browserPackage = await json("tools/production-browser/package.json");
  const browserLock = load(
    await readFile(new URL("tools/production-browser/pnpm-lock.yaml", root), "utf8"),
  );

  assert.deepEqual(workspace.packages, ["apps/*", "packages/*"]);
  assert.equal(workspace.overrides?.["@scalar/api-reference>@scalar/agent-chat"], "-");
  assert.equal(rootPackage.devDependencies?.["@playwright/test"], undefined);
  assert.equal(
    rootPackage.scripts?.["test:production-docs:browser"],
    "pnpm --dir tools/production-browser --ignore-workspace test",
  );
  assert.equal(browserPackage.name, "@markiro/production-browser");
  assert.equal(browserPackage.private, true);
  assert.equal(browserPackage.devDependencies?.["@playwright/test"], "1.61.1");
  assert.equal(
    browserLock.importers?.["."]?.devDependencies?.["@playwright/test"]?.specifier,
    "1.61.1",
  );
});

test("production API and DB dependency graphs contain neither Playwright nor OpenTelemetry", () => {
  for (const packageName of productionPackages) {
    for (const dependencyName of forbiddenProductionDependencies) {
      assert.deepEqual(
        productionWhy(packageName, dependencyName),
        [],
        `${packageName} has a production path to ${dependencyName}`,
      );
    }
  }
});
