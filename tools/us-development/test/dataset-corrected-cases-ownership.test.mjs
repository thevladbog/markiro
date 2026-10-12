import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { load } from "js-yaml";
import ts from "typescript";
import { checkWorkflows } from "../check-isolation.mjs";
import {
  withoutNativeAssemblyOwner,
  withoutNativeAssemblyOwnerBytes,
} from "./support/native-assembly-owner.mjs";

const ownerName = "Verify corrected dataset Cases on disposable databases";
const files = [
  "test/us-dataset-corrected-cases-contract.test.ts",
  "test/us-dataset-corrected-cases-seed.e2e.test.ts",
];
const command = `corepack pnpm --filter @markiro/api exec vitest run ${files.join(" ")} --maxWorkers=1`;
const fixture = "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
const buildCommands = [
  [
    "Verify shared domain foundation",
    "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
  ],
  [
    "Build isolated API dependencies and entry points",
    "pnpm turbo build --filter '@markiro/api...'",
  ],
];
const workflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [
        name,
        withoutNativeAssemblyOwner(load(readFileSync(`.github/workflows/${name}`, "utf8"))),
      ]),
  );
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Deleting this step or making its run a printed/conditional command must fail.
const assertOwnership = (all) => {
  const workflow = all["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === ownerName);
  assert.equal(owners.length, 1, "Corrected Cases has exactly one named owner");
  const owner = owners[0];
  const allSteps = Object.values(all).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((entry) => entry.steps ?? []),
  );
  assert.equal(
    allSteps.filter((step) => step.name === ownerName).length,
    1,
    "Corrected Cases has exactly one named owner across workflows",
  );
  const mentions = allSteps.flatMap((step) =>
    Array.from(
      (step.run ?? "").matchAll(/(?<![\w/.-])(?:\.\/)?test\/[\w.-]+\.tsx?(?![\w/.-])/g),
      ([file]) => file.replace(/^\.\//, ""),
    ),
  );
  for (const file of files) {
    assert.equal(
      mentions.filter((token) => token === file).length,
      1,
      `${file} has exactly one explicit suite path selection across workflows`,
    );
  }
  assert.equal(owner.run, command, "Corrected Cases uses the exact executable serial command");
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Corrected Cases ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Corrected Cases ${label} cannot ignore failure`,
    );
    assert.equal(entry.shell, undefined, `Corrected Cases ${label} rejects shell override`);
    assert.equal(
      entry.defaults?.run?.shell,
      undefined,
      `Corrected Cases ${label} rejects inherited shell override`,
    );
  }
  const usScopes = [
    workflow,
    ...Object.values(workflow.jobs).flatMap((entry) => [entry, ...(entry.steps ?? [])]),
  ];
  for (const entry of usScopes) {
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      "Corrected Cases rejects primary database fallback at every scope",
    );
    if (entry.env?.US_TEST_DATABASE_URL !== undefined) {
      assert.equal(
        entry.env.US_TEST_DATABASE_URL,
        fixture,
        "Corrected Cases rejects wrong synthetic fixture at every scope",
      );
    }
  }
  assert.equal(
    workflow.env?.US_TEST_DATABASE_URL,
    undefined,
    "Corrected Cases workflow cannot inherit fixture environment",
  );
  assert.equal(
    job.env?.US_TEST_DATABASE_URL,
    undefined,
    "Corrected Cases job cannot inherit fixture environment",
  );
  assert.deepEqual(
    owner.env,
    { US_TEST_DATABASE_URL: fixture },
    "Corrected Cases uses only its exact fixture environment",
  );
  assert.deepEqual(
    Object.keys(owner).sort(),
    ["env", "name", "run"],
    "Corrected Cases owner has only check-only settings",
  );
  let previous = -1;
  for (const [name, run] of buildCommands) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has exactly one corrected Cases predecessor`);
    const build = builds[0];
    assert.equal(build.run, run, `${name} propagates every corrected Cases build failure`);
    assert.equal(build.if, undefined, `${name} is unconditional for Corrected Cases`);
    assert.equal(
      build["continue-on-error"],
      undefined,
      `${name} cannot ignore corrected Cases build failure`,
    );
    assert.equal(build.shell, undefined, `${name} rejects corrected Cases build shell override`);
    assert.equal(
      build.defaults?.run?.shell,
      undefined,
      `${name} rejects inherited corrected Cases build shell override`,
    );
    const index = job.steps.indexOf(build);
    assert.ok(
      index > previous && index < job.steps.indexOf(owner),
      "Corrected Cases follows ordered successful shared/domain/API builds",
    );
    previous = index;
  }
  assert.equal(job["timeout-minutes"], 30, "Corrected Cases retains the 30-minute budget");
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Corrected Cases retains read-only permissions",
  );
  const priorSteps = job.steps.filter((step) => step !== owner);
  assert.equal(
    hash(priorSteps),
    "58e7a3614c0e7478c6aab319488636cedc7b3eb67331a2941fcd66a0af15b1a5",
    "Corrected Cases preserves every predecessor step, command, order and setting",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    hash(priorWorkflow),
    "524ccc84f796d75127407eabd8ac51abd8fe921f4398d043e57b0b1ca6e7606d",
    "Corrected Cases preserves the complete predecessor workflow",
  );
  assert.deepEqual(
    checkWorkflows(all, "codex/us-mvp"),
    [],
    "Corrected Cases retains operational release locks",
  );
};

test("Corrected Cases has one unconditional dedicated owner with globally unique explicit selections", () => {
  assertOwnership(workflows());
});

test("dedicated explicit selections coexist with aggregate API collection and native fixture gating", () => {
  const all = workflows();
  const aggregateCommand =
    "pnpm turbo test --filter=@markiro/db --filter=@markiro/api --concurrency=1 --force";
  const ci = all["ci.yml"];
  const aggregateJobs = Object.values(ci.jobs).filter((job) =>
    (job.steps ?? []).some((step) => step.run === aggregateCommand),
  );
  assert.equal(aggregateJobs.length, 1, "Actual generic CI retains one aggregate API test command");
  const aggregateJob = aggregateJobs[0];
  for (const entry of [ci, aggregateJob, ...aggregateJob.steps]) {
    assert.equal(
      entry.env?.US_TEST_DATABASE_URL,
      undefined,
      "Aggregate CI does not supply the native US fixture",
    );
  }
  const manifest = JSON.parse(readFileSync("apps/api/package.json", "utf8"));
  assert.equal(
    manifest.scripts.test,
    "vitest run",
    "Aggregate API test uses unfiltered Vitest collection",
  );
  const parse = (path) =>
    ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const descendants = (source, predicate) => {
    const found = [];
    const visit = (node) => {
      if (predicate(node)) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const config = parse("apps/api/vitest.config.ts");
  const include = descendants(
    config,
    (node) => ts.isPropertyAssignment(node) && node.name.getText(config) === "include",
  );
  assert.equal(include.length, 1, "Actual API config declares one test include");
  const patterns = include[0].initializer;
  assert.ok(ts.isArrayLiteralExpression(patterns));
  assert.ok(patterns.elements.every(ts.isStringLiteral));
  const globs = patterns.elements.map((node) => node.text);
  assert.deepEqual(globs, ["test/**/*.test.ts"]);
  assert.deepEqual(
    files.filter((file) => globs.some((glob) => matchesGlob(file, glob))),
    files,
    "The native suite is collected by the aggregate API glob",
  );
  const pure = parse(`apps/api/${files[0]}`);
  assert.equal(
    descendants(
      pure,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.getText(pure) === "describe.skipIf",
    ).length,
    0,
    "Pure corrected Cases contract has no native fixture gate",
  );
  assert.equal(
    descendants(
      pure,
      (node) =>
        ts.isPropertyAccessExpression(node) &&
        node.getText(pure) === "process.env.US_TEST_DATABASE_URL",
    ).length,
    0,
    "Pure corrected Cases contract does not need the native fixture",
  );
  for (const file of [files[1]]) {
    const native = parse(`apps/api/${file}`);
    const skipCalls = (source) =>
      descendants(
        source,
        (node) =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.getText(source) === "describe.skipIf",
      );
    const nativeCalls = skipCalls(native);
    assert.equal(nativeCalls.length, 1, "Native suite has one fixture gate");
    assert.ok(
      ts.isCallExpression(nativeCalls[0].parent) &&
        ts.isExpressionStatement(nativeCalls[0].parent.parent) &&
        nativeCalls[0].parent.parent.parent === native,
      "Native fixture gate directly uses the module-level base binding",
    );
    const bases = descendants(
      native,
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(native) === "base" &&
        node.parent.parent.parent === native,
    );
    assert.equal(bases.length, 1);
    assert.ok(bases[0].parent.flags & ts.NodeFlags.Const, "Native fixture base is const");
    assert.equal(bases[0].initializer.getText(native), "process.env.US_TEST_DATABASE_URL");
    const predicate = nativeCalls[0].arguments[0];
    assert.ok(
      ts.isPrefixUnaryExpression(predicate) &&
        predicate.operator === ts.SyntaxKind.ExclamationToken,
    );
    assert.equal(predicate.operand.getText(native), "base");
    // Execute only the actual fixture predicate, without importing native services or tests.
    const gate = new Script(`((base) => (${predicate.getText(native)}))`);
    const shouldSkip = gate.runInNewContext();
    assert.equal(shouldSkip(undefined), true, "Collected native suite skips without US fixture");
    assert.equal(
      shouldSkip(fixture),
      false,
      "Dedicated owner enables native assertions with its fixture",
    );
  }
  assertOwnership(all); // Actual aggregate command is allowed alongside the dedicated owner.
  all["foreign.yml"] = { jobs: { other: { steps: [{ run: `vitest run ${files[0]}` }] } } };
  assert.throws(
    () => assertOwnership(all),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes(
        `${files[0]} has exactly one explicit suite path selection across workflows`,
      ),
    "Duplicate explicit selection must be diagnosed without claiming exclusive total execution",
  );
});

test("Corrected Cases ownership rejects fresh parsed workflow mutations at intended assertions", (t) => {
  const exactCommand = "Corrected Cases uses the exact executable serial command";
  const priorSteps = "Corrected Cases preserves every predecessor step, command, order and setting";
  const priorWorkflow = "Corrected Cases preserves the complete predecessor workflow";
  const mutations = [
    [
      "missing owner",
      ({ j, o }) => {
        j.steps = j.steps.filter((s) => s !== o);
      },
      "Corrected Cases has exactly one named owner",
    ],
    [
      "duplicate owner",
      ({ j, o }) => {
        j.steps.push(structuredClone(o));
      },
      "Corrected Cases has exactly one named owner",
    ],
    [
      "foreign named owner",
      ({ all, o }) => {
        all["foreign.yml"] = { jobs: { other: { steps: [structuredClone(o)] } } };
      },
      "Corrected Cases has exactly one named owner across workflows",
    ],
    [
      "split command",
      ({ o }) => {
        o.run = o.run.replace("exec vitest run", "exec vitest\nrun");
      },
      exactCommand,
    ],
    [
      "split owner selection",
      ({ j, o }) => {
        o.run = "corepack pnpm --filter @markiro/api exec vitest run --maxWorkers=1";
        j.steps.push({ run: command });
      },
      exactCommand,
    ],
    [
      "unused uses",
      ({ o }) => {
        o.uses = "actions/checkout@bad";
      },
      "Corrected Cases owner has only check-only settings",
    ],
    [
      "empty fixture",
      ({ o }) => {
        delete o.env;
      },
      "Corrected Cases uses only its exact fixture environment",
    ],
    [
      "extra owner environment",
      ({ o }) => {
        o.env.CI = "true";
      },
      "Corrected Cases uses only its exact fixture environment",
    ],
    [
      "timeout budget",
      ({ j }) => {
        j["timeout-minutes"] = 31;
      },
      "Corrected Cases retains the 30-minute budget",
    ],
    [
      "write permissions",
      ({ w }) => {
        w.permissions.contents = "write";
      },
      "Corrected Cases retains read-only permissions",
    ],
    [
      "prior command",
      ({ j }) => {
        j.steps.find((s) => s.run === "pnpm install --frozen-lockfile").run += " || true";
      },
      priorSteps,
    ],
    [
      "prior step omitted",
      ({ j }) => {
        j.steps.splice(0, 1);
      },
      priorSteps,
    ],
    [
      "prior step reordered",
      ({ j }) => {
        [j.steps[0], j.steps[1]] = [j.steps[1], j.steps[0]];
      },
      priorSteps,
    ],
    [
      "prior action settings",
      ({ j }) => {
        j.steps[0].with["persist-credentials"] = true;
      },
      priorSteps,
    ],
    [
      "prior owner condition",
      ({ j }) => {
        j.steps.find((s) => s.name?.includes("dataset Shipping")).if = "false";
      },
      priorSteps,
    ],
    [
      "postgres service port",
      ({ j }) => {
        j.services["us-postgres"].ports = ["55432:5432"];
      },
      priorWorkflow,
    ],
    [
      "postgres service image",
      ({ j }) => {
        j.services["us-postgres"].image = "postgres:latest";
      },
      priorWorkflow,
    ],
    [
      "job runner",
      ({ j }) => {
        j["runs-on"] = "self-hosted";
      },
      priorWorkflow,
    ],
    [
      "workflow trigger",
      ({ w }) => {
        w.on.push.branches = ["main"];
      },
      priorWorkflow,
    ],
    [
      "workflow concurrency",
      ({ w }) => {
        w.concurrency["cancel-in-progress"] = false;
      },
      priorWorkflow,
    ],
    [
      "extra workflow job",
      ({ w }) => {
        w.jobs.other = { steps: [] };
      },
      priorWorkflow,
    ],
    [
      "operational release unlocked",
      ({ all }) => {
        all["release-images.yml"].jobs.publish.if = "${{ true }}";
      },
      "Corrected Cases retains operational release locks",
    ],
  ];
  for (const file of files) {
    const once = `${file} has exactly one explicit suite path selection across workflows`;
    mutations.push(
      [
        `missing ${file}`,
        ({ o }) => {
          o.run = o.run.replace(file, "");
        },
        once,
      ],
      [
        `duplicate ${file}`,
        ({ o }) => {
          o.run += ` ${file}`;
        },
        once,
      ],
    );
    for (const alias of [
      file,
      `"${file}"`,
      `'${file}'`,
      `./${file}`,
      `"./${file}"`,
      `'./${file}'`,
    ]) {
      if (alias !== file) {
        mutations.push([
          `owner alias ${alias}`,
          ({ o }) => {
            o.run = o.run.replace(file, alias);
          },
          exactCommand,
        ]);
      }
      for (const foreign of [false, true]) {
        mutations.push([
          `${foreign ? "foreign" : "local"} duplicate ${alias}`,
          ({ all, j }) => {
            const step = {
              run: `corepack pnpm --filter @markiro/api exec vitest run ${alias} --maxWorkers=1`,
            };
            if (foreign) all["foreign.yml"] = { jobs: { other: { steps: [step] } } };
            else j.steps.push(step);
          },
          once,
        ]);
      }
    }
  }
  for (const [label, wrap] of [
    ["echo", (run) => `echo '${run}'`],
    ["comment", (run) => `# ${run}`],
    ["heredoc", (run) => `cat <<'EOF'\n${run}\nEOF`],
    ["false guard", (run) => `if false; then ${run}; fi`],
    ["successful false guard", (run) => `false && ${run} || true`],
    ["suppressed exit", (run) => `${run} || true`],
    ["ignored exit", (run) => `${run}; exit 0`],
    ["disabled errexit", (run) => `set +e\n${run}`],
    ["redirect", (run) => `${run} >/dev/null 2>&1`],
    ["background", (run) => `${run} &`],
    ["pipe", (run) => `${run} | cat`],
    ["shell executable", (run) => `sh -c '${run}'`],
    ["parallel workers", (run) => run.replace("--maxWorkers=1", "--maxWorkers=2")],
    ["missing serial worker", (run) => run.replace(" --maxWorkers=1", "")],
    ["extra suite selector", (run) => `${run} --passWithNoTests`],
    ["pnpm alias", (run) => run.replace("corepack pnpm", "pnpm")],
  ]) {
    mutations.push([
      label,
      ({ o }) => {
        o.run = wrap(o.run);
      },
      exactCommand,
    ]);
  }
  for (const scope of ["workflow", "job", "owner"]) {
    const get = ({ w, j, o }) => ({ workflow: w, job: j, owner: o })[scope];
    for (const value of ["false", "${{ always() }}", "${{ success() }}"]) {
      mutations.push([
        `${scope} conditional ${value}`,
        (state) => {
          get(state).if = value;
        },
        `Corrected Cases ${scope} is unconditional`,
      ]);
    }
    mutations.push(
      [
        `${scope} ignored failure`,
        (state) => {
          get(state)["continue-on-error"] = true;
        },
        `Corrected Cases ${scope} cannot ignore failure`,
      ],
      [
        `${scope} shell override`,
        (state) => {
          get(state).shell = "bash {0}";
        },
        `Corrected Cases ${scope} rejects shell override`,
      ],
      [
        `${scope} inherited shell`,
        (state) => {
          get(state).defaults = { run: { shell: "bash {0}" } };
        },
        `Corrected Cases ${scope} rejects inherited shell override`,
      ],
    );
  }
  for (const scope of ["workflow", "job", "owner", "predecessor"]) {
    const get = ({ w, j, o }) =>
      ({ workflow: w, job: j, owner: o, predecessor: j.steps[0] })[scope];
    mutations.push(
      [
        `${scope} primary database fallback`,
        (state) => {
          const entry = get(state);
          entry.env = { ...entry.env, DATABASE_URL: fixture };
        },
        "Corrected Cases rejects primary database fallback at every scope",
      ],
      [
        `${scope} wrong fixture`,
        (state) => {
          const entry = get(state);
          entry.env = { ...entry.env, US_TEST_DATABASE_URL: "postgres://wrong/other" };
        },
        "Corrected Cases rejects wrong synthetic fixture at every scope",
      ],
    );
  }
  for (const scope of ["workflow", "job"]) {
    mutations.push([
      `${scope} inherited fixture`,
      ({ w, j }) => {
        (scope === "workflow" ? w : j).env = { US_TEST_DATABASE_URL: fixture };
      },
      `Corrected Cases ${scope} cannot inherit fixture environment`,
    ]);
  }
  for (const scope of ["extra job", "extra job step"]) {
    for (const [key, value, message] of [
      ["DATABASE_URL", fixture, "Corrected Cases rejects primary database fallback at every scope"],
      [
        "US_TEST_DATABASE_URL",
        "postgres://wrong/other",
        "Corrected Cases rejects wrong synthetic fixture at every scope",
      ],
    ]) {
      mutations.push([
        `${scope} ${key}`,
        ({ w }) => {
          w.jobs.other =
            scope === "extra job"
              ? { env: { [key]: value }, steps: [] }
              : { steps: [{ env: { [key]: value }, run: "echo check" }] };
        },
        message,
      ]);
    }
  }
  for (const [name] of buildCommands) {
    const get = ({ j }) => j.steps.find((s) => s.name === name);
    mutations.push(
      [
        `${name} missing`,
        (state) => {
          state.j.steps = state.j.steps.filter((s) => s !== get(state));
        },
        `${name} has exactly one corrected Cases predecessor`,
      ],
      [
        `${name} duplicate`,
        (state) => {
          state.j.steps.push(structuredClone(get(state)));
        },
        `${name} has exactly one corrected Cases predecessor`,
      ],
      [
        `${name} conditional`,
        (state) => {
          get(state).if = "false";
        },
        `${name} is unconditional for Corrected Cases`,
      ],
      [
        `${name} ignores failure`,
        (state) => {
          get(state)["continue-on-error"] = true;
        },
        `${name} cannot ignore corrected Cases build failure`,
      ],
      [
        `${name} shell override`,
        (state) => {
          get(state).shell = "bash {0}";
        },
        `${name} rejects corrected Cases build shell override`,
      ],
      [
        `${name} inherited shell override`,
        (state) => {
          get(state).defaults = { run: { shell: "bash {0}" } };
        },
        `${name} rejects inherited corrected Cases build shell override`,
      ],
      [
        `${name} suppressed command`,
        (state) => {
          get(state).run += " || true";
        },
        `${name} propagates every corrected Cases build failure`,
      ],
      [
        `${name} replaced command`,
        (state) => {
          get(state).run = `echo '${get(state).run}'`;
        },
        `${name} propagates every corrected Cases build failure`,
      ],
      [
        `${name} late build`,
        (state) => {
          const build = get(state);
          state.j.steps = [...state.j.steps.filter((s) => s !== build), build];
        },
        "Corrected Cases follows ordered successful shared/domain/API builds",
      ],
    );
  }
  mutations.push([
    "build order reversed",
    ({ j }) => {
      const a = j.steps.findIndex((s) => s.name === buildCommands[0][0]);
      const b = j.steps.findIndex((s) => s.name === buildCommands[1][0]);
      [j.steps[a], j.steps[b]] = [j.steps[b], j.steps[a]];
    },
    "Corrected Cases follows ordered successful shared/domain/API builds",
  ]);
  mutations.push(
    [
      "checkout token",
      ({ j }) => {
        j.steps[0].with.token = "${{ github.token }}";
      },
      priorSteps,
    ],
    [
      "job write token permissions",
      ({ j }) => {
        j.permissions = { contents: "read", "id-token": "write" };
      },
      priorWorkflow,
    ],
    [
      "workflow write token permissions",
      ({ w }) => {
        w.permissions["id-token"] = "write";
      },
      "Corrected Cases retains read-only permissions",
    ],
    [
      "foreign check-only secret token",
      ({ all }) => {
        all["ci.yml"].env = { GH_TOKEN: "${{ secrets.PUBLISH_TOKEN }}" };
      },
      "Corrected Cases retains operational release locks",
    ],
    [
      "isolation checker skipped",
      ({ j }) => {
        j.steps.find((s) => s.run === "node tools/us-development/check-isolation.mjs").if = "false";
      },
      priorSteps,
    ],
  );
  for (const [label, mutate, message] of mutations) {
    const all = workflows();
    const w = all["us-development.yml"];
    const j = w.jobs.isolation;
    const o = j.steps.find((step) => step.name === ownerName);
    mutate({ all, w, j, o });
    assert.throws(
      () => assertOwnership(all),
      (error) => error instanceof assert.AssertionError && error.message.includes(message),
      `${label} must fail its intended ownership assertion: ${message}`,
    );
  }
  t.diagnostic(
    `${mutations.length} fresh parsed-YAML mutations rejected at intended AssertionError/messages`,
  );
});

test("removing only the corrected Cases owner restores the complete 79-step predecessor bytes and AST", () => {
  const source = withoutNativeAssemblyOwnerBytes(
    readFileSync(".github/workflows/us-development.yml", "utf8"),
  );
  const ownerBlock =
    "      - name: Verify corrected dataset Cases on disposable databases\n        env:\n          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev\n        run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-corrected-cases-contract.test.ts test/us-dataset-corrected-cases-seed.e2e.test.ts --maxWorkers=1\n";
  assert.equal(
    source.split(ownerBlock).length,
    2,
    "The exact corrected Cases raw owner block occurs once",
  );
  const predecessor = source.replace(ownerBlock, "");
  assert.equal(
    Buffer.byteLength(predecessor),
    34241,
    "Complete corrected Cases predecessor byte count",
  );
  const assertPredecessorBytes = (bytes) => {
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      "eb9a0e5451dbb01638a9e11926989e819ad8cab824f2bd86a621625e20be7a88",
      "Removing only corrected Cases restores complete predecessor bytes",
    );
  };
  assertPredecessorBytes(predecessor);
  for (const changed of [
    predecessor + "\n",
    predecessor + "# changed comment\n",
    predecessor.replace("# v4", "# changed action comment"),
  ]) {
    assert.deepEqual(
      load(changed),
      load(predecessor),
      "Byte mutations retain the complete predecessor AST",
    );
    assert.throws(
      () => assertPredecessorBytes(changed),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes("Removing only corrected Cases restores complete predecessor bytes"),
      "AST-neutral drift must fail the predecessor byte assertion",
    );
  }
  const workflow = load(source);
  workflow.jobs.isolation.steps = workflow.jobs.isolation.steps.filter(
    (step) => step.name !== ownerName,
  );
  assert.equal(workflow.jobs.isolation.steps.length, 79);
  assert.deepEqual(
    load(predecessor),
    workflow,
    "Raw and parsed owner removal restore identical complete AST",
  );
  assert.equal(
    hash(workflow.jobs.isolation.steps),
    "58e7a3614c0e7478c6aab319488636cedc7b3eb67331a2941fcd66a0af15b1a5",
  );
  assert.equal(hash(workflow), "524ccc84f796d75127407eabd8ac51abd8fe921f4398d043e57b0b1ca6e7606d");
});
