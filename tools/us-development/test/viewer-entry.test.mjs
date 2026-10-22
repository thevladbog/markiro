import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("preservation executes with historical Git reads unavailable", () => {
  const name =
    "only approved root and guard substitutions reconstruct the whole frozen acquisition and command AST";
  const source = `
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const { run } = require('node:test');
    const original = cp.execFileSync;
    cp.execFileSync = (file, args, ...rest) => {
      if (file === 'git' && args.includes('show')) throw Error('historical_git_unavailable');
      return original(file, args, ...rest);
    };
    syncBuiltinESMExports();
    const stream = run({ files: [${JSON.stringify(fileURLToPath(import.meta.url))}], isolation: 'none', testNamePatterns: [${JSON.stringify(`^${name}$`)}], timeout: 4000 });
    stream.on('test:pass', (event) => {
      if (event.name !== ${JSON.stringify(name)}) return;
      if (event.skip || event.todo) process.exitCode = 1;
      else console.log('preservation_executed');
    });
    stream.on('test:fail', (event) => { process.exitCode = 1; console.error(event.details.error.message); });
    stream.resume();
  `;
  const result = spawnSync(process.execPath, [`--test-name-pattern=^${name}$`, "-e", source], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "preservation_executed\n");
});

// Independently derived from the actual original Git blobs, never the mutable current source.
// Provenance: e5a00d71bf51aedd711269ca1a289749a8d172d8, TypeScript 6.0.3,
// tools/us-development/test/support/dataset-command-positive-fixture.mjs raw SHA-256:
// 5a5bc9d873b673218e09e355c7b7640c0c73016603f781eb69cc5fc6710af5e7.
// CI deliberately requires no historical Git objects (checkout remains depth 1).
const originalAstDigest = "d048145e4a4bd773ec5e436fe563a6e3acaa6d668336da749c127d4b5c4bf25f";
const excludedSegments = [
  {
    start: "  const owner = randomUUID();",
    end: "  try {\n    connection = createDb",
    digest: "6b2af5794707e5b34a85ef7e61d643f8d4fc72a86591a8bbadc21eebe70a14b8",
  },
  {
    start: "    storeContract = datasetObjectStoreContainer(",
    end: "    const invoked = new Set();",
    digest: "9a085dd0092f2e57b85bfe5dca96b98682d414a873f89eb0ab9e81481390fedd",
  },
];
const excludedModules = {
  "dataset-command-provider.mjs":
    "57b3c8434bd81231e9d44a5a0f43309767d766f730be6236fa2fa46650573f86",
  "dataset-command-object-store.mjs":
    "80a4f30d29a8dd998dd9acc35c492847f8904d4524fc4a951e25334794605880",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function preservationSources() {
  return {
    current: readFileSync(
      new URL("./support/dataset-command-positive-fixture.mjs", import.meta.url),
      "utf8",
    ),
    modules: Object.fromEntries(
      Object.keys(excludedModules).map((name) => [
        name,
        readFileSync(new URL(`./support/${name}`, import.meta.url)),
      ]),
    ),
  };
}
// Independently pinned complete Task8 fragments; verify each exactly once BEFORE
// erasing only this extension. Historical restoration and all digests stay below.
function withoutTransportWitness(current) {
  const ts = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
    "typescript",
  );
  const ast = ts.createSourceFile(
    "fixture.mjs",
    current,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let placed = 0;
  function placement(node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) =>
          ts.isObjectBindingPattern(decl.name) &&
          decl.name.getText(ast) === "{ projectUsRequestPackageTransportWitness }",
      )
    ) {
      const statements = node.parent.statements;
      const previous = statements?.[statements.indexOf(node) - 1];
      assert.equal(
        previous?.getText(ast),
        `const { projectUsRequestPackageStorageReadFailureCode } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );`,
        "transport witness exact inverse placement",
      );
      placed++;
    }
    ts.forEachChild(node, placement);
  }
  placement(ast);
  assert.equal(placed, 1, "transport witness exact inverse placement");
  const inverse = [
    [
      `  projectStorageReadFailureCode,
  projectTransportWitness,
)`,
      `  projectStorageReadFailureCode,
)`,
    ],
    [
      `    projectStorageReadFailureCode,
    projectTransportWitness,
    cwd,`,
      `    projectStorageReadFailureCode,
    cwd,`,
    ],
    [
      `                    projectStorageReadFailureCode,
                    projectTransportWitness,
                  )`,
      `                    projectStorageReadFailureCode,
                  )`,
    ],
    [
      `    const { projectUsRequestPackageTransportWitness } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
`,
      "",
    ],
    ["              projectTransportWitness: projectUsRequestPackageTransportWitness,\n", ""],
    [
      `![
            "code",
            "unitKey",
            "stage",
            "verificationFailure",
            "verificationStorageCode",
            "verificationTransportWitness",
          ].includes(key)`,
      `!["code", "unitKey", "stage", "verificationFailure", "verificationStorageCode"].includes(
            key,
          )`,
    ],
    [
      `    let verificationTransportWitness;
    if (keys.includes("verificationTransportWitness")) {
      if (
        typeof projectTransportWitness !== "function" ||
        verificationStorageCode !== "us_request_package_storage_transport_failed"
      )
        return { status: "unavailable" };
      verificationTransportWitness = projectTransportWitness(parsed.verificationTransportWitness);
      if (
        !verificationTransportWitness ||
        verificationTransportWitness !== parsed.verificationTransportWitness
      )
        return { status: "unavailable" };
    }
`,
      "",
    ],
    ["      ...(verificationTransportWitness ? { verificationTransportWitness } : {}),\n", ""],
  ];
  for (const [before, after] of inverse) {
    assert.equal(current.split(before).length, 2, "transport witness exact inverse match");
    current = current.replace(before, after);
  }
  return current;
}
function withoutStorageEvidence(current) {
  const ts = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
    "typescript",
  );
  const ast = ts.createSourceFile(
    "fixture.mjs",
    current,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const printer = ts.createPrinter({ removeComments: true });
  let placed = 0;
  function checkPlacement(node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) =>
          ts.isObjectBindingPattern(decl.name) &&
          decl.name.getText(ast) === "{ projectUsRequestPackageStorageReadFailureCode }",
      )
    ) {
      const statements = node.parent.statements;
      const previous = statements?.[statements.indexOf(node) - 1];
      assert.ok(previous, "storage evidence exact inverse placement");
      assert.equal(
        printer.printNode(ts.EmitHint.Unspecified, previous, ast),
        "const invoked = new Set();",
        "storage evidence exact inverse placement",
      );
      placed++;
    }
    ts.forEachChild(node, checkPlacement);
  }
  checkPlacement(ast);
  assert.equal(placed, 1, "storage evidence exact inverse placement");
  const inverse = [
    [
      `function commandDiagnostic(
  text,
  diagnose,
  projectVerificationFailure,
  projectStorageReadFailureCode,
)`,
      "function commandDiagnostic(text, diagnose, projectVerificationFailure)",
    ],
    [
      `    projectVerificationFailure,
    projectStorageReadFailureCode,
    cwd,`,
      `    projectVerificationFailure,
    cwd,`,
    ],
    [
      `commandDiagnostic(
                    stderr.toString("utf8"),
                    diagnose,
                    projectVerificationFailure,
                    projectStorageReadFailureCode,
                  )`,
      'commandDiagnostic(stderr.toString("utf8"), diagnose, projectVerificationFailure)',
    ],
    [
      `    const { projectUsRequestPackageStorageReadFailureCode } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
`,
      "",
    ],
    [
      "              projectStorageReadFailureCode: projectUsRequestPackageStorageReadFailureCode,\n",
      "",
    ],
    [
      `keys.some(
        (key) =>
          !["code", "unitKey", "stage", "verificationFailure", "verificationStorageCode"].includes(
            key,
          ),
      )`,
      'keys.some((key) => !["code", "unitKey", "stage", "verificationFailure"].includes(key))',
    ],
    [
      `keys.some(
        (key) =>
          key !== "verificationFailure" &&
          key !== "verificationStorageCode" &&
          typeof parsed[key] !== "string",
      )`,
      'keys.some((key) => key !== "verificationFailure" && typeof parsed[key] !== "string")',
    ],
    [
      `    let verificationStorageCode;
    if (keys.includes("verificationStorageCode")) {
      if (
        typeof projectStorageReadFailureCode !== "function" ||
        verificationFailure?.operation !== "read_private_object"
      )
        return { status: "unavailable" };
      verificationStorageCode = projectStorageReadFailureCode(parsed.verificationStorageCode);
      if (!verificationStorageCode || verificationStorageCode !== parsed.verificationStorageCode)
        return { status: "unavailable" };
    }
`,
      "",
    ],
    ["      ...(verificationStorageCode ? { verificationStorageCode } : {}),\n", ""],
  ];
  for (const [before, after] of inverse) {
    assert.equal(current.split(before).length, 2, "storage evidence exact inverse match");
    current = current.replace(before, after);
  }
  return current;
}
function assertFrozenFixture({ current, modules }) {
  current = withoutTransportWitness(current);
  current = withoutStorageEvidence(current);
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
  assert.equal(ast.parseDiagnostics.length, 0);
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
  assert.equal(
    digest(JSON.stringify(shape(parse(restored)))),
    originalAstDigest,
    "complete original AST digest",
  );
  // Byte-level checks of the excluded SDK/container/acquisition/normal-disposal bodies.
  for (const { start, end, digest: expected } of excludedSegments) {
    assert.equal(current.split(start).length, 2, "unique excluded start boundary");
    assert.equal(current.split(end).length, 2, "unique excluded end boundary");
    assert.ok(current.indexOf(start) < current.indexOf(end), "ordered excluded boundaries");
    assert.equal(
      digest(current.slice(current.indexOf(start), current.indexOf(end))),
      expected,
      "excluded segment byte digest",
    );
  }
  for (const [excluded, expected] of Object.entries(excludedModules))
    assert.equal(digest(modules[excluded]), expected, "excluded module byte digest");
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
}

test("only approved root and guard substitutions reconstruct the whole frozen acquisition and command AST", () => {
  assert.equal(
    digest(withoutTransportWitness(preservationSources().current)),
    "194325caca93ec18d68996d342ba98004cc416726c77aa6cc707e44aab851ac2",
    "whole immutable922 predecessor bytes",
  );
  assertFrozenFixture(preservationSources());
});

test("transport witness inverse rejects its bypasses and misplaced load before erasure", () => {
  const source = preservationSources();
  for (const [before, after] of [
    ['typeof projectTransportWitness !== "function" ||', "false ||"],
    [
      'verificationStorageCode !== "us_request_package_storage_transport_failed"',
      'verificationStorageCode !== "us_request_package_storage_timeout"',
    ],
    [
      "verificationTransportWitness = projectTransportWitness(parsed.verificationTransportWitness);",
      "verificationTransportWitness = parsed.verificationTransportWitness;",
    ],
    ["verificationTransportWitness !== parsed.verificationTransportWitness", "false"],
    ['"verificationTransportWitness",', '"transportWitness",'],
  ]) {
    assert.equal(source.current.split(before).length, 2);
    assert.throws(
      () => assertFrozenFixture({ ...source, current: source.current.replace(before, after) }),
      /transport witness exact inverse match/,
    );
  }
  const load = `    const { projectUsRequestPackageTransportWitness } = compiled(
      "modules/traceability/requests/us-request-package-artifacts",
    );
`;
  assert.equal(source.current.split(load).length, 2);
  const misplaced = source.current
    .replace(load, "")
    .replace("    const invoked = new Set();", load + "    const invoked = new Set();");
  assert.throws(
    () => assertFrozenFixture({ ...source, current: misplaced }),
    /transport witness exact inverse placement/,
  );
});

test("preservation rejects semantic cap, query, action and literal mutants", () => {
  const source = preservationSources();
  for (const [before, after] of [
    ["cap: 900_000,", "cap: 900_001,"],
    ["SELECT tablename FROM pg_tables", "SELECT tablename FROM pg_views"],
    ["invoked.add(mode);", "invoked.delete(mode);"],
    ["positive disposal exceeded 60000ms", "positive disposal exceeded 60001ms"],
  ]) {
    assert.equal(source.current.split(before).length, 2, "one semantic mutant target");
    assert.throws(
      () => assertFrozenFixture({ ...source, current: source.current.replace(before, after) }),
      /complete original AST digest/,
    );
  }
});

test("storage evidence inverse refuses semantic bypasses before erasing the extension", () => {
  const source = preservationSources();
  for (const [before, after] of [
    ['typeof projectStorageReadFailureCode !== "function" ||', "false ||"],
    [
      'verificationFailure?.operation !== "read_private_object"',
      'verificationFailure?.operation !== "compare_private_object"',
    ],
    [
      'verificationFailure?.operation !== "read_private_object"',
      'verificationFailure?.artifact !== "private/key"',
    ],
    [
      "verificationStorageCode = projectStorageReadFailureCode(parsed.verificationStorageCode);",
      "verificationStorageCode = parsed.verificationStorageCode;",
    ],
    [
      "if (!verificationStorageCode || verificationStorageCode !== parsed.verificationStorageCode)",
      "if (false)",
    ],
    ['key !== "verificationFailure" &&', 'key !== "code" &&'],
  ]) {
    assert.equal(source.current.split(before).length, 2, "one new semantic mutant target");
    assert.throws(
      () => assertFrozenFixture({ ...source, current: source.current.replace(before, after) }),
      /storage evidence exact inverse match/,
    );
  }
});

test("old guard and resource mutants still fail with storage evidence present", () => {
  const source = preservationSources();
  for (const [before, after] of [
    ['env.GITHUB_JOB !== "dataset_command_positive"', 'env.GITHUB_JOB !== "other_job"'],
    [
      "connection = createDb(DATABASE_URL, {\n      max: 2,",
      "connection = createDb(DATABASE_URL, {\n      max: 3,",
    ],
  ]) {
    assert.equal(source.current.split(before).length, 2);
    assert.throws(
      () => assertFrozenFixture({ ...source, current: source.current.replace(before, after) }),
      /complete original AST digest/,
    );
  }
});

test("preservation rejects excluded byte changes and missing or duplicated exact boundaries", () => {
  const source = preservationSources();
  for (const { start, end } of excludedSegments) {
    // Comments preserve the AST projection: these failures must reach the exact-byte proof.
    assert.throws(
      () =>
        assertFrozenFixture({
          ...source,
          current: source.current.replace(start, `${start}\n/* byte-only mutant */`),
        }),
      /excluded segment byte digest/,
    );
    for (const [boundary, side] of [
      [start, "start"],
      [end, "end"],
    ]) {
      assert.throws(
        () =>
          assertFrozenFixture({
            ...source,
            current: source.current.replace(boundary, `${boundary} /*${boundary}*/`),
          }),
        new RegExp(`unique excluded ${side} boundary`),
      );
      // Break the exact boundary using a harmless comment between the first two tokens.
      const missing = boundary.replace(/(\S+) /, "$1 /* boundary mutant */ ");
      assert.notEqual(missing, boundary);
      assert.throws(
        () =>
          assertFrozenFixture({ ...source, current: source.current.replace(boundary, missing) }),
        new RegExp(`unique excluded ${side} boundary`),
      );
    }
  }
});

test("preservation rejects changed provider and object-store module bytes", () => {
  const source = preservationSources();
  for (const name of Object.keys(excludedModules)) {
    assert.throws(
      () =>
        assertFrozenFixture({
          ...source,
          modules: {
            ...source.modules,
            [name]: Buffer.concat([source.modules[name], Buffer.from("\n// byte-only mutant\n")]),
          },
        }),
      /excluded module byte digest/,
    );
  }
});
