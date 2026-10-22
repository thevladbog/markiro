import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as support from "./support/dataset-command-positive-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureUrl = new URL("./support/dataset-command-positive-fixture.mjs", import.meta.url).href;
const valid = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_JOB: "demo_viewer_acceptance",
  RUNNER_ENVIRONMENT: "github-hosted",
  US_TEST_DATABASE_URL:
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
};

test("viewer and positive guards are distinct, resource-free, strict predicates", () => {
  assert.equal(typeof support.assertDemoViewerRunner, "function");
  assert.doesNotThrow(() => support.assertDemoViewerRunner(valid, "linux"));
  assert.throws(() => support.assertDatasetPositiveRunner(valid, "linux"));
  assert.throws(() =>
    support.assertDemoViewerRunner({ ...valid, GITHUB_JOB: "dataset_command_positive" }, "linux"),
  );
  for (const key of Object.keys(valid))
    for (const value of [undefined, "", "wrong"])
      assert.throws(
        () => support.assertDemoViewerRunner({ ...valid, [key]: value }, "linux"),
        /us_demo_viewer_ci_only/,
      );
  for (const extra of [{ NODE_OPTIONS: "--require=sentinel" }, { NODE_PATH: "sentinel" }])
    assert.throws(() => support.assertDemoViewerRunner({ ...valid, ...extra }, "linux"));
  assert.throws(() => support.assertDemoViewerRunner(valid, "darwin"));
});

test("viewer real entry has no successful environment override and refuses before any I/O", () => {
  assert.equal(typeof support.createDemoViewerInstallationFixture, "function");
  const source = `import net from 'node:net'; import cp from 'node:child_process'; import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import * as f from ${JSON.stringify(fixtureUrl)}; const fail=()=>{throw Error('forbidden_io_opened')}; net.Socket.prototype.connect=fail; net.Server.prototype.listen=fail; cp.spawn=fail; fs.readFile=fail; syncBuiltinESMExports(); try {await f.createDemoViewerInstallationFixture(${JSON.stringify(valid)}); process.exitCode=2} catch(e) {if(e.message!=='us_demo_viewer_ci_only')throw e; console.log(e.message)}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 4000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "us_demo_viewer_ci_only\n");
  assert.doesNotMatch(result.stdout + result.stderr, /forbidden_io_opened/);
});

test("module-fixed checkout root is identical from repository and API cwd without acquisition", () => {
  assert.equal(typeof support.datasetFixtureRoot, "string");
  for (const cwd of [root, `${root}apps/api`]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {datasetFixtureRoot} from ${JSON.stringify(fixtureUrl)};console.log(datasetFixtureRoot)`,
      ],
      { cwd, encoding: "utf8", timeout: 4000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), root.replace(/\/$/, ""));
  }
});

test("only approved root and guard substitutions reconstruct the whole frozen acquisition and command AST", () => {
  const path = "tools/us-development/test/support/dataset-command-positive-fixture.mjs";
  const base = "e5a00d71bf51aedd711269ca1a289749a8d172d8";
  const original = execFileSync("git", ["-C", root, "show", `${base}:${path}`], {
    encoding: "utf8",
  });
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "5a5bc9d873b673218e09e355c7b7640c0c73016603f781eb69cc5fc6710af5e7",
  );
  const current = readFileSync(
    new URL("./support/dataset-command-positive-fixture.mjs", import.meta.url),
    "utf8",
  );
  const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
  const ts = require("typescript");
  const parse = (source) =>
    ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statementName = (node) =>
    node.name?.text ??
    (ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name?.text : undefined);
  const additions = new Set([
    "datasetFixtureRoot",
    "assertDemoViewerRunner",
    "createDemoViewerInstallationFixture",
    "createDatasetPositiveFixture",
  ]);
  const ast = parse(current);
  let restored = current;
  for (const statement of [...ast.statements].reverse()) {
    if (
      additions.has(statementName(statement)) ||
      (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "node:url")
    )
      restored = restored.slice(0, statement.getFullStart()) + restored.slice(statement.end);
  }
  const change = (pattern, replacement) => {
    assert.equal([...restored.matchAll(new RegExp(pattern.source, "g"))].length, 1, pattern.source);
    restored = restored.replace(pattern, replacement);
  };
  change(
    /async function acquireDatasetInstallation\(\) \{/,
    "export async function createDatasetPositiveFixture(env = process.env) {\n  assertDatasetPositiveRunner(env);",
  );
  change(/const root = datasetFixtureRoot;/, "const root = process.cwd();");
  change(
    /\["-C", root, "status", "--porcelain=v1", "--untracked-files=all"\]/,
    '["status", "--porcelain=v1", "--untracked-files=all"]',
  );
  change(/\["-C", root, "rev-parse", "HEAD"\]/, '["rev-parse", "HEAD"]');
  change(/resolve\(root, "apps\/api\/package.json"\)/, 'resolve("apps/api/package.json")');
  change(
    /resolve\(root, "deploy\/us-development\/local.env.example"\)/,
    '"deploy/us-development/local.env.example"',
  );
  change(
    /resolve\(root, `apps\/api\/dist\/\$\{path\}\.js`\)/,
    "resolve(`apps/api/dist/${path}.js`)",
  );
  change(/resolve\(root, "packages\/db\/migrations"\)/, 'resolve("packages/db/migrations")');
  change(
    /resolve\(root, "apps\/api\/test\/support\/us-dataset-snapshot.ts"\)/,
    '"apps/api/test/support/us-dataset-snapshot.ts"',
  );
  change(/projectVerificationFailure,\s*cwd,/, "projectVerificationFailure,");
  change(/\.\.\.\(cwd \? \{ cwd \} : \{\}\),\s*/, "");
  change(/env: environment,\s*cwd: root,/, "env: environment,");
  const shape = (node) => {
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(shape(child));
    });
    return [node.kind, node.flags, ts.isSourceFile(node) ? null : (node.text ?? null), children];
  };
  assert.equal(parse(restored).parseDiagnostics.length, 0);
  assert.deepEqual(shape(parse(restored)), shape(parse(original)));
  // Byte-level checks of the excluded SDK/container/acquisition/normal-disposal bodies.
  for (const [start, end] of [
    ["  const owner = randomUUID();", "  try {\n    connection = createDb"],
    ["    storeContract = datasetObjectStoreContainer(", "    const invoked = new Set();"],
  ]) {
    assert.ok(original.includes(start) && original.includes(end));
    assert.equal(
      current.slice(current.indexOf(start), current.indexOf(end)),
      original.slice(original.indexOf(start), original.indexOf(end)),
    );
  }
  for (const excluded of ["dataset-command-provider.mjs", "dataset-command-object-store.mjs"])
    assert.equal(
      readFileSync(new URL(`./support/${excluded}`, import.meta.url), "utf8"),
      execFileSync(
        "git",
        ["-C", root, "show", `${base}:tools/us-development/test/support/${excluded}`],
        { encoding: "utf8" },
      ),
    );
  const acquire = ast.statements
    .find((statement) => statementName(statement) === "acquireDatasetInstallation")
    .getText(ast);
  assert.ok(
    acquire.indexOf('assert.equal(git.stdout, ""') < acquire.indexOf("createDb(DATABASE_URL"),
  );
  assert.ok(
    acquire.indexOf("checked.document.build.gitSha") < acquire.indexOf("createDb(DATABASE_URL"),
  );
  assert.ok(acquire.indexOf("checked.document.build.gitSha") < acquire.indexOf("ownContainer()"));
  assert.doesNotMatch(acquire, /process\.chdir|process\.env\.[A-Z_]+\s*=/);
});
