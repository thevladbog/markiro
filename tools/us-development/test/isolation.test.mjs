import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import { isNativeAssemblyOwner } from "./support/native-assembly-owner.mjs";
import { withoutSharedContractsBootstrap } from "./support/shared-contracts-bootstrap.mjs";
import {
  assertSupplementalOwnership,
  withoutCasesRegressionWorkflow,
} from "./support/cases-regression-owner.mjs";

const rawSources = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(`.github/workflows/${name}`, "utf8")]),
  );

const historicalInventory = (allWorkflows, sources = rawSources()) => {
  if (allWorkflows["us-cases-native.yml"]) assertSupplementalOwnership(allWorkflows, sources);
  return withoutCasesRegressionWorkflow(allWorkflows, sources);
};

const workflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [
        name,
        withoutSharedContractsBootstrap(load(readFileSync(`.github/workflows/${name}`, "utf8"))),
      ]),
  );

const transformationTransactionOwner = "Check US Transformation native transaction foundation";
const caseTransactionOwner = "Check US Case native transaction foundation";
const datasetTransformationOwner =
  "Verify regular US dataset Transformation on disposable databases";
const datasetCasesOwner = "Verify regular US dataset Cases on disposable databases";
const datasetShippingOwner = "Verify regular dataset Shipping on disposable databases";

const datasetShippingFiles = [
  "test/us-dataset-shipping-contract.test.ts",
  "test/us-dataset-shipping-result.test.ts",
  "test/us-dataset-shipping-origin-status.e2e.test.ts",
  "test/us-dataset-shipping-seed.e2e.test.ts",
  "test/us-dataset-shipping-verify.e2e.test.ts",
  "test/us-dataset-shipping-locks.e2e.test.ts",
];

test("primary Cases and Shipping owners reject a changed supplement and third selector", () => {
  for (const assertOwner of [assertDatasetShippingOwnership, assertDatasetCasesOwnership]) {
    const changed = workflows();
    changed["us-cases-native.yml"].jobs.cases_native.steps.find(
      (step) => step.name === "Verify complete Cases native regression on disposable databases",
    ).if = "false";
    assert.throws(() => assertOwner(changed), /parsed workflow differs/);
    const bytes = rawSources();
    bytes["us-cases-native.yml"] += "\n";
    assert.throws(() => assertOwner(workflows(), bytes), /bytes differ/);
  }
  const thirdCases = workflows();
  thirdCases["third.yml"] = {
    jobs: { third: { steps: [{ run: "vitest run test/us-dataset-cases-seed.e2e.test.ts" }] } },
  };
  assert.throws(
    () => assertDatasetCasesOwnership(thirdCases),
    /runs exactly once across workflows/,
  );
  const thirdShipping = workflows();
  thirdShipping["third.yml"] = {
    jobs: { third: { steps: [{ run: "vitest run test/us-dataset-shipping-seed.e2e.test.ts" }] } },
  };
  assert.throws(
    () => assertDatasetShippingOwnership(thirdShipping),
    /runs exactly once across workflows/,
  );
});

const assertDatasetShippingOwnership = (allWorkflows, sources = rawSources()) => {
  allWorkflows = historicalInventory(allWorkflows, sources);
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === datasetShippingOwner);
  assert.equal(owners.length, 1, "Dataset Shipping has exactly one named owner");
  const owner = owners[0];
  const allSteps = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((entry) => entry.steps ?? []),
  );
  assert.equal(
    allSteps.filter((step) => step.name === datasetShippingOwner).length,
    1,
    "Dataset Shipping has exactly one named owner across workflows",
  );
  const executions = allSteps.flatMap((step) =>
    Array.from(
      (step.run ?? "").matchAll(/(?<![\w/.-])(?:\.\/)?test\/[\w.-]+\.tsx?(?![\w/.-])/g),
      ([file]) => file.replace(/^\.\//, ""),
    ),
  );
  for (const file of datasetShippingFiles) {
    assert.equal(
      executions.filter((token) => token === file).length,
      1,
      `${file} runs exactly once across workflows`,
    );
  }
  assert.equal(
    owner.shell,
    undefined,
    "Dataset Shipping owner cannot suppress failures through a shell override",
  );
  assert.equal(
    owner.run,
    `corepack pnpm --filter @markiro/api exec vitest run ${datasetShippingFiles.join(" ")} --maxWorkers=1`,
    "Dataset Shipping uses the exact command and serial worker limit",
  );
  let previous = -1;
  for (const [name, command] of [
    [
      "Verify shared domain foundation",
      "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    ],
    [
      "Build isolated API dependencies and entry points",
      "pnpm turbo build --filter '@markiro/api...'",
    ],
  ]) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has one Dataset Shipping predecessor`);
    const build = builds[0];
    assert.equal(
      build.run,
      command,
      `${name} propagates every Dataset Shipping prerequisite failure`,
    );
    const index = job.steps.indexOf(build);
    assert.ok(
      index > previous && index < job.steps.indexOf(owner),
      "Dataset Shipping follows ordered successful shared/domain/API builds",
    );
    assert.equal(build.if, undefined, `${name} is unconditional for Dataset Shipping`);
    assert.equal(
      build["continue-on-error"],
      undefined,
      `${name} cannot ignore Dataset Shipping prerequisite failure`,
    );
    previous = index;
  }
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Dataset Shipping ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Dataset Shipping ${label} cannot ignore failure`,
    );
  }
  const fixture =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  for (const entry of [workflow, job, ...job.steps]) {
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      "Dataset Shipping rejects primary database fallback at every scope",
    );
    if (entry.env?.US_TEST_DATABASE_URL !== undefined) {
      assert.equal(
        entry.env.US_TEST_DATABASE_URL,
        fixture,
        "Dataset Shipping rejects wrong synthetic fixture URL at every scope",
      );
    }
  }
  assert.deepEqual(
    owner.env,
    { US_TEST_DATABASE_URL: fixture },
    "Dataset Shipping uses only the exact synthetic fixture URL",
  );
  assert.deepEqual(
    Object.keys(owner).sort(),
    ["env", "name", "run"],
    "Dataset Shipping owner has only exact check-only settings",
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Dataset Shipping retains read-only permissions",
  );
  assert.equal(job["timeout-minutes"], 30, "Dataset Shipping retains the 30-minute budget");
  const priorSteps = job.steps.filter(
    (step) =>
      step !== owner &&
      step.name !== "Verify regular dataset range orchestration on disposable databases" &&
      step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
      step.name !== "Verify special dataset Receiving examples on disposable databases" &&
      step.name !== "Verify special dataset event examples on disposable databases" &&
      step.name !== "Verify corrected dataset Cases on disposable databases" &&
      !isNativeAssemblyOwner(step),
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "a36a03e4a4cd5026aeb24f6b6ab8152d5071c76c5dd56caa9fd34f900751b3fc",
    "Dataset Shipping preserves every preincrement step, command, order and setting",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorWorkflow)).digest("hex"),
    "5f20d278eb331aeddad69b12b467a022a860ed6241430cdcaa7e97988f82fe1d",
    "Dataset Shipping preserves every preincrement workflow setting",
  );
  assert.deepEqual(checkWorkflows(allWorkflows, "codex/us-mvp"), []);
};

test("regular dataset Shipping has one unconditional serial fixture-only owner after successful builds", () => {
  assertDatasetShippingOwnership(workflows());
});

test("dataset Shipping ownership rejects fresh executable mutations at their intended assertions", (t) => {
  assertDatasetShippingOwnership(workflows());
  const mutations = [
    [
      "missing owner",
      (w, j, o) => {
        j.steps = j.steps.filter((s) => s !== o);
      },
      /exactly one named owner/,
    ],
    [
      "duplicate owner",
      (w, j, o) => {
        j.steps.push(structuredClone(o));
      },
      /exactly one named owner/,
    ],
    [
      "split commands",
      (w, j, o) => {
        o.run = o.run.replace(
          ` ${datasetShippingFiles[1]}`,
          `\ncorepack pnpm --filter @markiro/api exec vitest run ${datasetShippingFiles[1]}`,
        );
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing serial limit",
      (w, j, o) => {
        o.run = o.run.replace(" --maxWorkers=1", "");
      },
      /exact command and serial worker limit/,
    ],
    [
      "parallel workers",
      (w, j, o) => {
        o.run = o.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing fixture",
      (w, j, o) => {
        delete o.env.US_TEST_DATABASE_URL;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "missing fixture environment",
      (w, j, o) => {
        delete o.env;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "owner shell suppression",
      (w, j, o) => {
        o.shell = "bash -c '{0} || true'";
      },
      /cannot suppress failures through a shell override/,
    ],
    [
      "owner working directory",
      (w, j, o) => {
        o["working-directory"] = "apps/admin";
      },
      /only exact check-only settings/,
    ],
    [
      "job shell suppression",
      (w, j) => {
        j.defaults = { run: { shell: "bash -c '{0} || true'" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "workflow shell suppression",
      (w) => {
        w.defaults = { run: { shell: "bash -c '{0} || true'" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "job directory redirect",
      (w, j) => {
        j.defaults = { run: { "working-directory": "apps/admin" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "workflow directory redirect",
      (w) => {
        w.defaults = { run: { "working-directory": "apps/admin" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "service drift",
      (w, j) => {
        j.services["us-postgres"].image = "postgres:18-alpine";
      },
      /preserves every preincrement workflow/,
    ],
    [
      "job permissions",
      (w, j) => {
        j.permissions = { contents: "write" };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "workflow permissions",
      (w) => {
        w.permissions.contents = "write";
      },
      /read-only permissions/,
    ],
    [
      "changed budget",
      (w, j) => {
        j["timeout-minutes"] = 31;
      },
      /30-minute budget/,
    ],
    [
      "old command drift",
      (w, j) => {
        j.steps.find((s) => s.name === shippingTransactionOwner).run += " || true";
      },
      /preserves every preincrement step/,
    ],
    [
      "old owner drift",
      (w, j) => {
        j.steps.find((s) => s.name === datasetCasesOwner).name = "renamed";
      },
      /preserves every preincrement step/,
    ],
    [
      "old setting drift",
      (w, j) => {
        j.steps[0].timeout = 1;
      },
      /preserves every preincrement step/,
    ],
    [
      "old step reordering",
      (w, j) => {
        [j.steps[0], j.steps[1]] = [j.steps[1], j.steps[0]];
      },
      /preserves every preincrement step/,
    ],
    [
      "workflow setting drift",
      (w) => {
        w.concurrency = "changed";
      },
      /preserves every preincrement workflow/,
    ],
    [
      "reversed prerequisite builds",
      (w, j) => {
        const a = j.steps.findIndex((s) => s.name === "Verify shared domain foundation");
        const b = j.steps.findIndex(
          (s) => s.name === "Build isolated API dependencies and entry points",
        );
        [j.steps[a], j.steps[b]] = [j.steps[b], j.steps[a]];
      },
      /ordered successful shared\/domain\/API builds/,
    ],
  ];
  for (const file of datasetShippingFiles) {
    mutations.push(
      [
        `omitted ${file}`,
        (w, j, o) => {
          o.run = o.run.replace(` ${file}`, "");
        },
        /runs exactly once across workflows/,
      ],
      [
        `duplicate ${file}`,
        (w, j) => {
          j.steps.push({ run: `corepack pnpm --filter @markiro/api exec vitest run ${file}` });
        },
        /runs exactly once across workflows/,
      ],
      [
        `quoted duplicate ${file}`,
        (w, j) => {
          j.steps.push({ run: `corepack pnpm --filter @markiro/api exec vitest run '${file}'` });
        },
        /runs exactly once across workflows/,
      ],
      [
        `path duplicate ${file}`,
        (w, j) => {
          j.steps.push({ run: `corepack pnpm --filter @markiro/api exec vitest run "./${file}"` });
        },
        /runs exactly once across workflows/,
      ],
      [
        `quoted owner ${file}`,
        (w, j, o) => {
          o.run = o.run.replace(file, `'${file}'`);
        },
        /exact command and serial worker limit/,
      ],
      [
        `path owner ${file}`,
        (w, j, o) => {
          o.run = o.run.replace(file, `./${file}`);
        },
        /exact command and serial worker limit/,
      ],
    );
  }
  for (const suffix of [" || true", " ; exit 0", " > /dev/null", " 2>&1", " &"]) {
    mutations.push([
      `owner suppression ${suffix}`,
      (w, j, o) => {
        o.run += suffix;
      },
      /exact command and serial worker limit/,
    ]);
  }
  for (const target of ["workflow", "job", "owner"]) {
    for (const [key, value, expected] of [
      ["if", "${{ false }}", /is unconditional/],
      ["continue-on-error", true, /cannot ignore failure/],
      [
        "env",
        { DATABASE_URL: "postgres://wrong/other" },
        /primary database fallback at every scope/,
      ],
      [
        "env",
        { US_TEST_DATABASE_URL: "postgres://wrong/other" },
        /wrong synthetic fixture URL at every scope/,
      ],
    ]) {
      mutations.push([
        `${target} ${key} ${JSON.stringify(value)}`,
        (w, j, o) => {
          ({ workflow: w, job: j, owner: o })[target][key] = value;
        },
        expected,
      ]);
    }
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    const build = (j) => j.steps.find((s) => s.name === name);
    for (const [label, mutate, expected] of [
      [
        "missing",
        (w, j) => {
          j.steps = j.steps.filter((s) => s !== build(j));
        },
        /has one Dataset Shipping predecessor/,
      ],
      [
        "duplicated",
        (w, j) => {
          j.steps.push(structuredClone(build(j)));
        },
        /has one Dataset Shipping predecessor/,
      ],
      [
        "after owner",
        (w, j, o) => {
          const b = build(j);
          j.steps = j.steps.filter((s) => s !== b);
          j.steps.splice(j.steps.indexOf(o) + 1, 0, b);
        },
        /ordered successful shared\/domain\/API builds/,
      ],
      [
        "conditional",
        (w, j) => {
          build(j).if = "${{ false }}";
        },
        /is unconditional for Dataset Shipping/,
      ],
      [
        "ignored",
        (w, j) => {
          build(j)["continue-on-error"] = true;
        },
        /cannot ignore Dataset Shipping prerequisite failure/,
      ],
      [
        "suppressed",
        (w, j) => {
          build(j).run += " || true";
        },
        /propagates every Dataset Shipping prerequisite failure/,
      ],
      [
        "redirected",
        (w, j) => {
          build(j).run += " > /dev/null";
        },
        /propagates every Dataset Shipping prerequisite failure/,
      ],
      [
        "shell suppression",
        (w, j) => {
          build(j).shell = "bash -c '{0} || true'";
        },
        /preserves every preincrement step/,
      ],
      [
        "primary fallback",
        (w, j) => {
          build(j).env = { DATABASE_URL: "postgres://wrong/other" };
        },
        /primary database fallback at every scope/,
      ],
      [
        "wrong fixture",
        (w, j) => {
          build(j).env = { US_TEST_DATABASE_URL: "postgres://wrong/other" };
        },
        /wrong synthetic fixture URL at every scope/,
      ],
    ])
      mutations.push([`${name} ${label}`, mutate, expected]);
  }
  for (const [label, mutate, expected] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    mutate(
      workflow,
      job,
      job.steps.find((step) => step.name === datasetShippingOwner),
    );
    assert.throws(
      () => assertDatasetShippingOwnership(changed),
      { name: "AssertionError", message: expected },
      label,
    );
  }
  const externalMutations = [
    [
      "duplicate named owner across workflows",
      [{ name: datasetShippingOwner, run: "echo duplicate" }],
      /exactly one named owner across workflows/,
    ],
    ...datasetShippingFiles.flatMap((file) => [
      [
        `quoted suite across workflows ${file}`,
        [{ run: `corepack pnpm --filter @markiro/api exec vitest run '${file}'` }],
        /runs exactly once across workflows/,
      ],
      [
        `path suite across workflows ${file}`,
        [{ run: `corepack pnpm --filter @markiro/api exec vitest run "./${file}"` }],
        /runs exactly once across workflows/,
      ],
    ]),
  ];
  for (const [label, steps, expected] of externalMutations) {
    const changed = workflows();
    changed["ci.yml"].jobs.datasetShippingDuplicate = { steps };
    assert.throws(
      () => assertDatasetShippingOwnership(changed),
      { name: "AssertionError", message: expected },
      label,
    );
  }
  const split = workflows();
  const splitOwner = split["us-development.yml"].jobs.isolation.steps.find(
    (step) => step.name === datasetShippingOwner,
  );
  splitOwner.run = splitOwner.run.replace(` ${datasetShippingFiles[1]}`, "");
  split["ci.yml"].jobs.datasetShippingSplit = {
    steps: [
      {
        run: `corepack pnpm --filter @markiro/api exec vitest run '${datasetShippingFiles[1]}' --maxWorkers=1`,
      },
    ],
  };
  assert.throws(
    () => assertDatasetShippingOwnership(split),
    { name: "AssertionError", message: /exact command and serial worker limit/ },
    "splitting one suite into another workflow cannot satisfy one executable owner",
  );
  t.diagnostic(
    `Rejected ${mutations.length + externalMutations.length + 1} fresh dataset Shipping workflow mutations`,
  );
});

const datasetCasesFiles = [
  "test/us-dataset-cases-contract.test.ts",
  "test/us-case-demo-command.e2e.test.ts",
  "test/us-dataset-cases-prepare.e2e.test.ts",
  "test/us-dataset-cases-verify.e2e.test.ts",
  "test/us-dataset-cases-locks.e2e.test.ts",
  "test/us-dataset-cases-seed.e2e.test.ts",
];
const assertDatasetCasesOwnership = (allWorkflows, sources = rawSources()) => {
  allWorkflows = historicalInventory(allWorkflows, sources);
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === datasetCasesOwner);
  assert.equal(owners.length, 1, "Dataset Cases has exactly one named owner");
  const owner = owners[0];
  const allSteps = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((entry) => entry.steps ?? []),
  );
  assert.equal(
    allSteps.filter((step) => step.name === datasetCasesOwner).length,
    1,
    "Dataset Cases has exactly one named owner across workflows",
  );
  const executions = allSteps.flatMap((step) =>
    Array.from(
      (step.run ?? "").matchAll(/(?<![\w/.-])(?:\.\/)?test\/[\w.-]+\.tsx?(?![\w/.-])/g),
      ([file]) => file.replace(/^\.\//, ""),
    ),
  );
  for (const file of datasetCasesFiles) {
    assert.equal(
      executions.filter((token) => token === file).length,
      1,
      `${file} runs exactly once across workflows`,
    );
  }
  assert.equal(
    owner.run,
    `corepack pnpm --filter @markiro/api exec vitest run ${datasetCasesFiles.join(" ")} --maxWorkers=1`,
    "Dataset Cases uses the exact command and serial worker limit",
  );
  let previous = -1;
  for (const [name, command] of [
    [
      "Verify shared domain foundation",
      "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    ],
    [
      "Build isolated API dependencies and entry points",
      "pnpm turbo build --filter '@markiro/api...'",
    ],
  ]) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has one Cases predecessor`);
    const build = builds[0];
    assert.equal(build.run, command, `${name} propagates every Cases prerequisite failure`);
    const index = job.steps.indexOf(build);
    assert.ok(
      index > previous && index < job.steps.indexOf(owner),
      "Dataset Cases follows ordered successful shared/domain/API builds",
    );
    assert.equal(build.if, undefined, `${name} is unconditional for Cases`);
    assert.equal(
      build["continue-on-error"],
      undefined,
      `${name} cannot ignore Cases prerequisite failure`,
    );
    previous = index;
  }
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Dataset Cases ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Dataset Cases ${label} cannot ignore failure`,
    );
  }
  const fixture =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  for (const entry of [workflow, job, ...job.steps]) {
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      "Dataset Cases rejects primary database fallback at every scope",
    );
    if (entry.env?.US_TEST_DATABASE_URL !== undefined) {
      assert.equal(
        entry.env.US_TEST_DATABASE_URL,
        fixture,
        "Dataset Cases rejects wrong synthetic fixture URL at every scope",
      );
    }
  }
  assert.deepEqual(
    owner.env,
    { US_TEST_DATABASE_URL: fixture },
    "Dataset Cases uses only the exact synthetic fixture URL",
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Dataset Cases retains read-only permissions",
  );
  assert.equal(job["timeout-minutes"], 30, "Dataset Cases retains the 30-minute budget");
  const priorSteps = job.steps.filter(
    (step) =>
      step !== owner &&
      step.name !== shippingTransactionOwner &&
      step.name !== datasetShippingOwner &&
      step.name !== "Verify regular dataset range orchestration on disposable databases" &&
      step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
      step.name !== "Verify special dataset Receiving examples on disposable databases" &&
      step.name !== "Verify special dataset event examples on disposable databases" &&
      step.name !== "Verify corrected dataset Cases on disposable databases" &&
      !isNativeAssemblyOwner(step),
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "f3b34bfe35b442908b8696fce4b424f96d5ce02859124094ce3ac7f8cd579f1b",
    "Dataset Cases preserves every preincrement step, command, order and setting",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorWorkflow)).digest("hex"),
    "c221c71b470554b13d1d5010affb6ed33a74664c843ab3bba969dbb44b40787c",
    "Dataset Cases preserves every preincrement workflow setting",
  );
  assert.deepEqual(
    checkWorkflows(allWorkflows, "codex/us-mvp"),
    [],
    "Dataset Cases retains operational release locks",
  );
};

test("regular dataset Cases has one unconditional serial fixture-only owner after successful builds", () => {
  assertDatasetCasesOwnership(workflows());
});

test("dataset Cases ownership rejects fresh executable mutations at their intended assertions", () => {
  assertDatasetCasesOwnership(workflows());
  const mutations = [
    [
      "missing owner",
      (w, j, o) => {
        j.steps = j.steps.filter((s) => s !== o);
      },
      /exactly one named owner/,
    ],
    [
      "duplicate owner",
      (w, j, o) => {
        j.steps.push(structuredClone(o));
      },
      /exactly one named owner/,
    ],
    [
      "split commands",
      (w, j, o) => {
        o.run = o.run.replace(
          ` ${datasetCasesFiles[1]}`,
          `\ncorepack pnpm --filter @markiro/api exec vitest run ${datasetCasesFiles[1]}`,
        );
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing serial limit",
      (w, j, o) => {
        o.run = o.run.replace(" --maxWorkers=1", "");
      },
      /exact command and serial worker limit/,
    ],
    [
      "wrong serial limit",
      (w, j, o) => {
        o.run = o.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /exact command and serial worker limit/,
    ],
    [
      "shell suppression",
      (w, j, o) => {
        o.run += " || true";
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing fixture",
      (w, j, o) => {
        delete o.env.US_TEST_DATABASE_URL;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "missing fixture environment",
      (w, j, o) => {
        delete o.env;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "quoted owner command",
      (w, j, o) => {
        o.run = o.run.replace(datasetCasesFiles[0], `'${datasetCasesFiles[0]}'`);
      },
      /exact command and serial worker limit/,
    ],
    [
      "aliased owner command",
      (w, j, o) => {
        o.run = o.run.replace(datasetCasesFiles[0], `./${datasetCasesFiles[0]}`);
      },
      /exact command and serial worker limit/,
    ],
    [
      "old command drift",
      (w, j) => {
        j.steps.find((s) => s.name === caseTransactionOwner).run += " || true";
      },
      /preserves every preincrement step/,
    ],
    [
      "old setting drift",
      (w, j) => {
        j.steps[0].timeout = 1;
      },
      /preserves every preincrement step/,
    ],
    [
      "old order drift",
      (w, j) => {
        [j.steps[0], j.steps[1]] = [j.steps[1], j.steps[0]];
      },
      /preserves every preincrement step/,
    ],
    [
      "workflow setting drift",
      (w) => {
        w.concurrency = "changed";
      },
      /preserves every preincrement workflow/,
    ],
    [
      "write permissions",
      (w) => {
        w.permissions.contents = "write";
      },
      /read-only permissions/,
    ],
    [
      "budget drift",
      (w, j) => {
        j["timeout-minutes"] = 31;
      },
      /30-minute budget/,
    ],
  ];
  for (const file of datasetCasesFiles) {
    mutations.push([
      `omit ${file}`,
      (w, j, o) => {
        o.run = o.run.replace(` ${file}`, "");
      },
      /runs exactly once across workflows/,
    ]);
    for (const alias of [file, `"${file}"`, `'./${file}'`]) {
      mutations.push([
        `duplicate ${alias}`,
        (w, j) => {
          j.steps.push({
            run: `corepack pnpm --filter @markiro/api exec vitest run ${alias} --maxWorkers=1`,
          });
        },
        /runs exactly once across workflows/,
      ]);
    }
  }
  for (const scope of ["workflow", "job", "owner", "other step"]) {
    const target = (w, j, o) =>
      ({ workflow: w, job: j, owner: o, "other step": j.steps[0] })[scope];
    for (const [label, apply, expected] of [
      [
        "primary fallback",
        (s) => {
          s.env = { ...s.env, DATABASE_URL: "forbidden" };
        },
        /primary database fallback/,
      ],
      [
        "wrong fixture",
        (s) => {
          s.env = { ...s.env, US_TEST_DATABASE_URL: "postgres://wrong/other" };
        },
        /wrong synthetic fixture URL/,
      ],
    ])
      mutations.push([
        `${scope} ${label}`,
        (w, j, o) => {
          apply(target(w, j, o));
        },
        expected,
      ]);
    if (scope !== "other step") {
      for (const [key, value, expected] of [
        ["if", "${{ false }}", /is unconditional/],
        ["continue-on-error", true, /cannot ignore failure/],
      ])
        mutations.push([
          `${scope} ${key}`,
          (w, j, o) => {
            target(w, j, o)[key] = value;
          },
          expected,
        ]);
    }
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    const build = (j) => j.steps.find((s) => s.name === name);
    for (const [label, apply, expected] of [
      [
        "missing",
        (j) => {
          j.steps = j.steps.filter((s) => s !== build(j));
        },
        /has one Cases predecessor/,
      ],
      [
        "after owner",
        (j, o) => {
          const b = build(j);
          j.steps = j.steps.filter((s) => s !== b);
          j.steps.splice(j.steps.indexOf(o) + 1, 0, b);
        },
        /ordered successful shared\/domain\/API builds/,
      ],
      [
        "conditional",
        (j) => {
          build(j).if = "${{ false }}";
        },
        /is unconditional for Cases/,
      ],
      [
        "ignored failure",
        (j) => {
          build(j)["continue-on-error"] = true;
        },
        /cannot ignore Cases prerequisite failure/,
      ],
      [
        "shell suppression",
        (j) => {
          build(j).run += " || true";
        },
        /propagates every Cases prerequisite failure/,
      ],
    ])
      mutations.push([
        `${name} ${label}`,
        (w, j, o) => {
          apply(j, o);
        },
        expected,
      ]);
  }
  mutations.push([
    "reversed prerequisite builds",
    (w, j) => {
      const a = j.steps.findIndex((s) => s.name === "Verify shared domain foundation");
      const b = j.steps.findIndex(
        (s) => s.name === "Build isolated API dependencies and entry points",
      );
      [j.steps[a], j.steps[b]] = [j.steps[b], j.steps[a]];
    },
    /ordered successful shared\/domain\/API builds/,
  ]);
  for (const [label, mutate, message] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    mutate(
      workflow,
      job,
      job.steps.find((step) => step.name === datasetCasesOwner),
    );
    assert.throws(
      () => assertDatasetCasesOwnership(changed),
      { name: "AssertionError", message },
      label,
    );
  }
  for (const [label, steps, message] of [
    [
      "named owner in another workflow",
      [{ name: datasetCasesOwner, run: "node unrelated.mjs" }],
      /exactly one named owner across workflows/,
    ],
    [
      "suite in another workflow",
      [
        {
          run: `corepack pnpm --filter @markiro/api exec vitest run '${datasetCasesFiles[0]}' --maxWorkers=1`,
        },
      ],
      /runs exactly once across workflows/,
    ],
    [
      "aliased suite in another workflow",
      [
        {
          run: `corepack pnpm --filter @markiro/api exec vitest run "./${datasetCasesFiles[5]}" --maxWorkers=1`,
        },
      ],
      /runs exactly once across workflows/,
    ],
  ]) {
    const changed = workflows();
    changed["ci.yml"].jobs.datasetCasesDuplicate = { steps };
    assert.throws(
      () => assertDatasetCasesOwnership(changed),
      { name: "AssertionError", message },
      label,
    );
  }
});

const shippingTransactionOwner =
  "Verify Shipping native transaction foundation on disposable databases";

const shippingTransactionFiles = [
  "test/us-shipping-transaction-seams.e2e.test.ts",
  "test/us-shipping-transaction-locks.e2e.test.ts",
];
const assertShippingTransactionOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === shippingTransactionOwner);
  assert.equal(owners.length, 1, "Shipping foundation has exactly one named owner");
  const owner = owners[0];
  const allSteps = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((entry) => entry.steps ?? []),
  );
  assert.equal(
    allSteps.filter((step) => step.name === shippingTransactionOwner).length,
    1,
    "Shipping foundation has exactly one named owner across workflows",
  );
  const executions = allSteps.flatMap((step) =>
    Array.from(
      (step.run ?? "").matchAll(/(?<![\w/.-])(?:\.\/)?test\/[\w.-]+\.tsx?(?![\w/.-])/g),
      ([file]) => file.replace(/^\.\//, ""),
    ),
  );
  for (const file of shippingTransactionFiles) {
    assert.equal(
      executions.filter((token) => token === file).length,
      1,
      `${file} runs exactly once across workflows`,
    );
  }
  assert.equal(
    owner.shell,
    undefined,
    "Shipping foundation owner cannot suppress failures through a shell override",
  );
  assert.equal(
    owner.run,
    `corepack pnpm --filter @markiro/api exec vitest run ${shippingTransactionFiles.join(" ")} --maxWorkers=1`,
    "Shipping foundation uses the exact command and serial worker limit",
  );
  let previous = -1;
  for (const [name, command] of [
    [
      "Verify shared domain foundation",
      "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    ],
    [
      "Build isolated API dependencies and entry points",
      "pnpm turbo build --filter '@markiro/api...'",
    ],
  ]) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has one Shipping predecessor`);
    const build = builds[0];
    assert.equal(build.run, command, `${name} propagates every Shipping prerequisite failure`);
    const index = job.steps.indexOf(build);
    assert.ok(
      index > previous && index < job.steps.indexOf(owner),
      "Shipping foundation follows ordered successful shared/domain/API builds",
    );
    assert.equal(build.if, undefined, `${name} is unconditional for Shipping`);
    assert.equal(
      build["continue-on-error"],
      undefined,
      `${name} cannot ignore Shipping prerequisite failure`,
    );
    previous = index;
  }
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Shipping foundation ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Shipping foundation ${label} cannot ignore failure`,
    );
  }
  const fixture =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  for (const entry of [workflow, job, ...job.steps]) {
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      "Shipping foundation rejects primary database fallback at every scope",
    );
    if (entry.env?.US_TEST_DATABASE_URL !== undefined) {
      assert.equal(
        entry.env.US_TEST_DATABASE_URL,
        fixture,
        "Shipping foundation rejects wrong synthetic fixture URL at every scope",
      );
    }
  }
  assert.deepEqual(
    owner.env,
    { US_TEST_DATABASE_URL: fixture },
    "Shipping foundation uses only the exact synthetic fixture URL",
  );
  assert.deepEqual(
    Object.keys(owner).sort(),
    ["env", "name", "run"],
    "Shipping foundation owner has only exact check-only settings",
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Shipping foundation retains read-only permissions",
  );
  assert.equal(job["timeout-minutes"], 30, "Shipping foundation retains the 30-minute budget");
  const priorSteps = job.steps.filter(
    (step) =>
      step !== owner &&
      step.name !== datasetShippingOwner &&
      step.name !== "Verify regular dataset range orchestration on disposable databases" &&
      step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
      step.name !== "Verify special dataset Receiving examples on disposable databases" &&
      step.name !== "Verify special dataset event examples on disposable databases" &&
      step.name !== "Verify corrected dataset Cases on disposable databases" &&
      !isNativeAssemblyOwner(step),
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "d3144c04106e7bd4e176ec210aee5351c30aab869b625c8969c0f29251a3e8b3",
    "Shipping foundation preserves every preincrement step, command, order and setting",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorWorkflow)).digest("hex"),
    "849380f0b1b156fa2c7294ab8b7eadaabac2fc36582b2b1329f22836e56feebe",
    "Shipping foundation preserves every preincrement workflow setting",
  );
  assert.deepEqual(
    checkWorkflows(allWorkflows, "codex/us-mvp"),
    [],
    "Shipping foundation retains operational release locks",
  );
};

test("Shipping native transaction foundation has one unconditional serial fixture-only owner after successful builds", () => {
  assertShippingTransactionOwnership(workflows());
});

test("Shipping foundation ownership rejects fresh executable mutations at their intended assertions", (t) => {
  assertShippingTransactionOwnership(workflows());
  const mutations = [
    [
      "missing owner",
      (w, j, o) => {
        j.steps = j.steps.filter((s) => s !== o);
      },
      /exactly one named owner/,
    ],
    [
      "duplicate owner",
      (w, j, o) => {
        j.steps.push(structuredClone(o));
      },
      /exactly one named owner/,
    ],
    [
      "split commands",
      (w, j, o) => {
        o.run = o.run.replace(
          ` ${shippingTransactionFiles[1]}`,
          `\ncorepack pnpm --filter @markiro/api exec vitest run ${shippingTransactionFiles[1]}`,
        );
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing serial limit",
      (w, j, o) => {
        o.run = o.run.replace(" --maxWorkers=1", "");
      },
      /exact command and serial worker limit/,
    ],
    [
      "wrong serial limit",
      (w, j, o) => {
        o.run = o.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /exact command and serial worker limit/,
    ],
    [
      "shell suppression",
      (w, j, o) => {
        o.run += " || true";
      },
      /exact command and serial worker limit/,
    ],
    [
      "missing fixture",
      (w, j, o) => {
        delete o.env.US_TEST_DATABASE_URL;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "missing fixture environment",
      (w, j, o) => {
        delete o.env;
      },
      /only the exact synthetic fixture URL/,
    ],
    [
      "quoted owner command",
      (w, j, o) => {
        o.run = o.run.replace(shippingTransactionFiles[0], `'${shippingTransactionFiles[0]}'`);
      },
      /exact command and serial worker limit/,
    ],
    [
      "aliased owner command",
      (w, j, o) => {
        o.run = o.run.replace(shippingTransactionFiles[0], `./${shippingTransactionFiles[0]}`);
      },
      /exact command and serial worker limit/,
    ],
    [
      "owner shell suppression",
      (w, j, o) => {
        o.shell = "bash -c '{0} || true'";
      },
      /cannot suppress failures through a shell override/,
    ],
    [
      "owner working-directory redirect",
      (w, j, o) => {
        o["working-directory"] = "apps/admin";
      },
      /only exact check-only settings/,
    ],
    [
      "job shell suppression",
      (w, j) => {
        j.defaults = { run: { shell: "bash -c '{0} || true'" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "workflow shell suppression",
      (w) => {
        w.defaults = { run: { shell: "bash -c '{0} || true'" } };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "service drift",
      (w, j) => {
        j.services["us-postgres"].image = "postgres:18-alpine";
      },
      /preserves every preincrement workflow/,
    ],
    [
      "job permission drift",
      (w, j) => {
        j.permissions = { contents: "write" };
      },
      /preserves every preincrement workflow/,
    ],
    [
      "old command drift",
      (w, j) => {
        j.steps.find((s) => s.name === caseTransactionOwner).run += " || true";
      },
      /preserves every preincrement step/,
    ],
    [
      "old setting drift",
      (w, j) => {
        j.steps[0].timeout = 1;
      },
      /preserves every preincrement step/,
    ],
    [
      "old order drift",
      (w, j) => {
        [j.steps[0], j.steps[1]] = [j.steps[1], j.steps[0]];
      },
      /preserves every preincrement step/,
    ],
    [
      "workflow setting drift",
      (w) => {
        w.concurrency = "changed";
      },
      /preserves every preincrement workflow/,
    ],
    [
      "write permissions",
      (w) => {
        w.permissions.contents = "write";
      },
      /read-only permissions/,
    ],
    [
      "budget drift",
      (w, j) => {
        j["timeout-minutes"] = 31;
      },
      /30-minute budget/,
    ],
  ];
  for (const file of shippingTransactionFiles) {
    mutations.push([
      `omit ${file}`,
      (w, j, o) => {
        o.run = o.run.replace(` ${file}`, "");
      },
      /runs exactly once across workflows/,
    ]);
    for (const alias of [
      file,
      `"${file}"`,
      `'${file}'`,
      `./${file}`,
      `"./${file}"`,
      `'./${file}'`,
    ]) {
      mutations.push([
        `duplicate ${alias}`,
        (w, j) => {
          j.steps.push({
            run: `corepack pnpm --filter @markiro/api exec vitest run ${alias} --maxWorkers=1`,
          });
        },
        /runs exactly once across workflows/,
      ]);
      if (alias !== file) {
        mutations.push([
          `owner alias ${alias}`,
          (w, j, o) => {
            o.run = o.run.replace(file, alias);
          },
          /exact command and serial worker limit/,
        ]);
      }
    }
  }
  for (const scope of ["workflow", "job", "owner", "other step"]) {
    const target = (w, j, o) =>
      ({ workflow: w, job: j, owner: o, "other step": j.steps[0] })[scope];
    for (const [label, apply, expected] of [
      [
        "primary fallback",
        (s) => {
          s.env = { ...s.env, DATABASE_URL: "forbidden" };
        },
        /primary database fallback/,
      ],
      [
        "wrong fixture",
        (s) => {
          s.env = { ...s.env, US_TEST_DATABASE_URL: "postgres://wrong/other" };
        },
        /wrong synthetic fixture URL/,
      ],
    ])
      mutations.push([
        `${scope} ${label}`,
        (w, j, o) => {
          apply(target(w, j, o));
        },
        expected,
      ]);
    if (scope !== "other step") {
      for (const [key, value, expected] of [
        ["if", "${{ false }}", /is unconditional/],
        ["continue-on-error", true, /cannot ignore failure/],
      ])
        mutations.push([
          `${scope} ${key}`,
          (w, j, o) => {
            target(w, j, o)[key] = value;
          },
          expected,
        ]);
    }
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    const build = (j) => j.steps.find((s) => s.name === name);
    for (const [label, apply, expected] of [
      [
        "missing",
        (j) => {
          j.steps = j.steps.filter((s) => s !== build(j));
        },
        /has one Shipping predecessor/,
      ],
      [
        "duplicate",
        (j) => {
          j.steps.push(structuredClone(build(j)));
        },
        /has one Shipping predecessor/,
      ],
      [
        "shell override",
        (j) => {
          build(j).shell = "bash -c '{0} || true'";
        },
        /preserves every preincrement step/,
      ],
      [
        "after owner",
        (j, o) => {
          const b = build(j);
          j.steps = j.steps.filter((s) => s !== b);
          j.steps.splice(j.steps.indexOf(o) + 1, 0, b);
        },
        /ordered successful shared\/domain\/API builds/,
      ],
      [
        "conditional",
        (j) => {
          build(j).if = "${{ false }}";
        },
        /is unconditional for Shipping/,
      ],
      [
        "ignored failure",
        (j) => {
          build(j)["continue-on-error"] = true;
        },
        /cannot ignore Shipping prerequisite failure/,
      ],
      [
        "shell suppression",
        (j) => {
          build(j).run += " || true";
        },
        /propagates every Shipping prerequisite failure/,
      ],
    ])
      mutations.push([
        `${name} ${label}`,
        (w, j, o) => {
          apply(j, o);
        },
        expected,
      ]);
  }
  mutations.push([
    "reversed prerequisite builds",
    (w, j) => {
      const a = j.steps.findIndex((s) => s.name === "Verify shared domain foundation");
      const b = j.steps.findIndex(
        (s) => s.name === "Build isolated API dependencies and entry points",
      );
      [j.steps[a], j.steps[b]] = [j.steps[b], j.steps[a]];
    },
    /ordered successful shared\/domain\/API builds/,
  ]);
  for (const [label, mutate, message] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    mutate(
      workflow,
      job,
      job.steps.find((step) => step.name === shippingTransactionOwner),
    );
    assert.throws(
      () => assertShippingTransactionOwnership(changed),
      { name: "AssertionError", message },
      label,
    );
  }
  const externalMutations = [
    [
      "named owner in another workflow",
      [{ name: shippingTransactionOwner, run: "node unrelated.mjs" }],
      /exactly one named owner across workflows/,
    ],
    ...shippingTransactionFiles.flatMap((file) =>
      [file, `"${file}"`, `'${file}'`, `./${file}`, `"./${file}"`, `'./${file}'`].map((alias) => [
        `suite alias in another workflow: ${alias}`,
        [{ run: `corepack pnpm --filter @markiro/api exec vitest run ${alias} --maxWorkers=1` }],
        /runs exactly once across workflows/,
      ]),
    ),
  ];
  for (const [label, steps, message] of externalMutations) {
    const changed = workflows();
    changed["ci.yml"].jobs.shippingTransactionDuplicate = { steps };
    assert.throws(
      () => assertShippingTransactionOwnership(changed),
      { name: "AssertionError", message },
      label,
    );
  }
  t.diagnostic(
    `Rejected ${mutations.length + externalMutations.length} fresh Shipping workflow mutations`,
  );
});

const caseTransactionFiles = [
  "test/us-case-transaction-seams.e2e.test.ts",
  "test/us-case-transaction-locks.e2e.test.ts",
];
const assertCaseTransactionOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === caseTransactionOwner);
  assert.equal(owners.length, 1, "Case foundation has exactly one named owner");
  const namedOwners = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((entry) =>
      (entry.steps ?? []).filter((step) => step.name === caseTransactionOwner),
    ),
  );
  assert.equal(
    namedOwners.length,
    1,
    "Case foundation has exactly one named owner across workflows",
  );
  const owner = owners[0];
  assert.deepEqual(
    owner.run.trim().split(/\s+/),
    [
      "corepack",
      "pnpm",
      "--filter",
      "@markiro/api",
      "exec",
      "vitest",
      "run",
      ...caseTransactionFiles,
      "--maxWorkers=1",
    ],
    "Case foundation has the exact serial command",
  );
  for (const file of caseTransactionFiles) {
    const executions = Object.values(allWorkflows).flatMap((candidate) =>
      Object.values(candidate.jobs ?? {}).flatMap((entry) =>
        (entry.steps ?? []).flatMap((step) => step.run?.trim().split(/\s+/) ?? []),
      ),
    );
    assert.equal(
      executions.filter((token) => token === file).length,
      1,
      `${file} runs exactly once across workflows`,
    );
  }
  for (const entry of [workflow, job, owner]) {
    assert.equal(entry.if, undefined, "Case workflow, job and owner are unconditional");
    assert.equal(
      entry["continue-on-error"],
      undefined,
      "Case workflow, job and owner preserve failures",
    );
  }
  const buildCommands = [
    "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    "pnpm turbo build --filter '@markiro/api...'",
  ];
  let previous = -1;
  for (const command of buildCommands) {
    const index = job.steps.findIndex((step) => step.run === command);
    assert.ok(
      index > previous && index < job.steps.indexOf(owner),
      "Case foundation follows ordered successful shared/domain/API builds",
    );
    const build = job.steps[index];
    assert.equal(build.if, undefined, "Case prerequisite builds are unconditional");
    assert.equal(
      build["continue-on-error"],
      undefined,
      "Case prerequisite builds preserve failures",
    );
    previous = index;
  }
  assert.deepEqual(
    owner.env,
    {
      US_TEST_DATABASE_URL:
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    },
    "Case foundation uses only the exact synthetic fixture URL",
  );
  for (const entry of [workflow, job, ...job.steps]) {
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      "Case foundation rejects primary database fallback at every scope",
    );
  }
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Case foundation retains read-only permissions",
  );
  assert.equal(job["timeout-minutes"], 30, "Case foundation retains the 30-minute budget");
  const priorSteps = job.steps.filter(
    (step) =>
      step !== owner &&
      step.name !== datasetCasesOwner &&
      step.name !== shippingTransactionOwner &&
      step.name !== datasetShippingOwner &&
      step.name !== "Verify regular dataset range orchestration on disposable databases" &&
      step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
      step.name !== "Verify special dataset Receiving examples on disposable databases" &&
      step.name !== "Verify special dataset event examples on disposable databases" &&
      step.name !== "Verify corrected dataset Cases on disposable databases" &&
      !isNativeAssemblyOwner(step),
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "4294d7b8f1d349dfdddfb3d1ec6411a281914cec6740cabd3c251162d85b551f",
    "Case foundation preserves every prior step, command, order and setting",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorWorkflow)).digest("hex"),
    "0bd97357ce9a271ff37dc3f088803e8b6e73d21e4b08f22d12d24ad507e06892",
    "Case foundation preserves every prior workflow setting",
  );
  assert.deepEqual(
    checkWorkflows(allWorkflows, "codex/us-mvp"),
    [],
    "Case foundation retains operational release locks",
  );
};

test("Case native transaction foundation has one unconditional serial fixture-only owner after successful builds", () => {
  assertCaseTransactionOwnership(workflows());
});

test("Case ownership rejects fresh executable workflow mutations with the intended invariant", () => {
  assertCaseTransactionOwnership(workflows());
  const mutations = [
    [
      "remove owner",
      (w, j, o) => {
        j.steps = j.steps.filter((s) => s !== o);
      },
      /exactly one named owner/,
    ],
    [
      "duplicate owner",
      (w, j, o) => {
        j.steps.push(structuredClone(o));
      },
      /exactly one named owner/,
    ],
    [
      "omit seams",
      (w, j, o) => {
        o.run = o.run.replace(` ${caseTransactionFiles[0]}`, "");
      },
      /exact serial command/,
    ],
    [
      "omit locks",
      (w, j, o) => {
        o.run = o.run.replace(` ${caseTransactionFiles[1]}`, "");
      },
      /exact serial command/,
    ],
    [
      "duplicate suite",
      (w, j) => {
        j.steps.push({ run: `node ${caseTransactionFiles[0]}` });
      },
      /runs exactly once across workflows/,
    ],
    [
      "split suites",
      (w, j, o) => {
        o.run = o.run.replace(` ${caseTransactionFiles[1]}`, "");
        j.steps.push({ run: `node ${caseTransactionFiles[1]}` });
      },
      /exact serial command/,
    ],
    [
      "remove serial flag",
      (w, j, o) => {
        o.run = o.run.replace(" --maxWorkers=1", "");
      },
      /exact serial command/,
    ],
    [
      "change serial flag",
      (w, j, o) => {
        o.run = o.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /exact serial command/,
    ],
    [
      "suppress shell failure",
      (w, j, o) => {
        o.run += " || true";
      },
      /exact serial command/,
    ],
    [
      "remove fixture",
      (w, j, o) => {
        delete o.env.US_TEST_DATABASE_URL;
      },
      /exact synthetic fixture URL/,
    ],
    [
      "change fixture",
      (w, j, o) => {
        o.env.US_TEST_DATABASE_URL += "-other";
      },
      /exact synthetic fixture URL/,
    ],
    [
      "permissions",
      (w) => {
        w.permissions.contents = "write";
      },
      /read-only permissions/,
    ],
    [
      "budget",
      (w, j) => {
        j["timeout-minutes"] = 31;
      },
      /30-minute budget/,
    ],
    [
      "prior step",
      (w, j) => {
        j.steps[0].timeout = 1;
      },
      /preserves every prior step/,
    ],
  ];
  for (const scope of ["workflow", "job", "step"]) {
    const target = (w, j, o) => ({ workflow: w, job: j, step: o })[scope];
    mutations.push(
      [
        `skip ${scope}`,
        (w, j, o) => {
          target(w, j, o).if = "${{ false }}";
        },
        /unconditional/,
      ],
      [
        `ignore ${scope} failure`,
        (w, j, o) => {
          target(w, j, o)["continue-on-error"] = true;
        },
        /preserve failures/,
      ],
      [
        `primary database ${scope}`,
        (w, j, o) => {
          target(w, j, o).env = { ...target(w, j, o).env, DATABASE_URL: "forbidden" };
        },
        scope === "step" ? /exact synthetic fixture URL/ : /primary database fallback/,
      ],
    );
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    const build = (j) => j.steps.find((s) => s.name === name);
    mutations.push(
      [
        `remove ${name}`,
        (w, j) => {
          j.steps = j.steps.filter((s) => s !== build(j));
        },
        /ordered successful shared\/domain\/API builds/,
      ],
      [
        `reorder ${name}`,
        (w, j) => {
          const b = build(j);
          j.steps = [...j.steps.filter((s) => s !== b), b];
        },
        /ordered successful shared\/domain\/API builds/,
      ],
      [
        `skip ${name}`,
        (w, j) => {
          build(j).if = "${{ false }}";
        },
        /prerequisite builds are unconditional/,
      ],
      [
        `ignore ${name}`,
        (w, j) => {
          build(j)["continue-on-error"] = true;
        },
        /prerequisite builds preserve failures/,
      ],
      [
        `change ${name}`,
        (w, j) => {
          build(j).run += " || true";
        },
        /ordered successful shared\/domain\/API builds/,
      ],
    );
  }
  for (const [label, mutate, message] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    mutate(
      workflow,
      job,
      job.steps.find((step) => step.name === caseTransactionOwner),
    );
    assert.throws(
      () => assertCaseTransactionOwnership(changed),
      { name: "AssertionError", message },
      label,
    );
  }
  const changed = workflows();
  changed["ci.yml"].jobs.caseDuplicate = { steps: [{ run: `node ${caseTransactionFiles[1]}` }] };
  assert.throws(
    () => assertCaseTransactionOwnership(changed),
    { name: "AssertionError", message: /runs exactly once across workflows/ },
    "duplicate in another workflow",
  );
  const duplicateOwner = workflows();
  duplicateOwner["ci.yml"].jobs.caseDuplicate = {
    steps: [{ name: caseTransactionOwner, run: "node unrelated.mjs" }],
  };
  assert.throws(
    () => assertCaseTransactionOwnership(duplicateOwner),
    { name: "AssertionError", message: /exactly one named owner across workflows/ },
    "duplicate named owner in another workflow without duplicating a suite",
  );
});

const assertDatasetStageOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter(
    (step) => step.name === "Verify bounded US dataset progress on disposable databases",
  );
  assert.equal(owners.length, 1, "Dataset progress has exactly one named owner");
  const step = owners[0];
  const files = ["test/us-dataset-journal.e2e.test.ts", "test/us-dataset-atomic-stage.e2e.test.ts"];
  assert.deepEqual(step.run.trim().split(/\s+/), [
    "corepack",
    "pnpm",
    "--filter",
    "@markiro/api",
    "exec",
    "vitest",
    "run",
    ...files,
    "--maxWorkers=1",
  ]);
  for (const file of files) {
    const executions = Object.values(workflow.jobs).flatMap((candidate) =>
      candidate.steps.flatMap((entry) => entry.run?.trim().split(/\s+/) ?? []),
    );
    assert.equal(executions.filter((token) => token === file).length, 1, `${file} runs once`);
  }
  const build = job.steps.findIndex(
    (candidate) => candidate.run === "pnpm turbo build --filter '@markiro/api...'",
  );
  assert.ok(
    build >= 0 && build < job.steps.indexOf(step),
    "Dataset checks follow shared/API builds",
  );
  for (const owner of [job, step, job.steps[build]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
  assert.deepEqual(step.env, {
    US_TEST_DATABASE_URL:
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
  });
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["isolation"]);
  assert.deepEqual(checkWorkflows(allWorkflows, "codex/us-mvp"), []);
};

test("dataset atomic stage and journal have one unconditional serial isolated owner after shared/API builds", () => {
  assertDatasetStageOwnership(workflows());
});

test("dataset execution ownership rejects omission, duplication, skipped builds and ignored failures", () => {
  assertDatasetStageOwnership(workflows());
  for (const [label, mutate] of [
    [
      "omitted atomic suite",
      (job, step) => {
        step.run = step.run.replace(" test/us-dataset-atomic-stage.e2e.test.ts", "");
      },
    ],
    [
      "omitted journal suite",
      (job, step) => {
        step.run = step.run.replace(" test/us-dataset-journal.e2e.test.ts", "");
      },
    ],
    [
      "duplicate execution",
      (job, step) => {
        job.steps.push({ run: step.run });
      },
    ],
    [
      "nonserial execution",
      (job, step) => {
        step.run = step.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
    ],
    [
      "ignored shell failure",
      (job, step) => {
        step.run += " || true";
      },
    ],
    [
      "before builds",
      (job, step) => {
        job.steps = [step, ...job.steps.filter((entry) => entry !== step)];
      },
    ],
    [
      "conditional stage",
      (job, step) => {
        step.if = "${{ false }}";
      },
    ],
    [
      "ignored stage failure",
      (job, step) => {
        step["continue-on-error"] = true;
      },
    ],
    [
      "conditional build",
      (job) => {
        job.steps.find((step) => step.run === "pnpm turbo build --filter '@markiro/api...'").if =
          "${{ false }}";
      },
    ],
    [
      "missing isolated URL",
      (job, step) => {
        delete step.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "primary database URL",
      (job, step) => {
        step.env.DATABASE_URL = step.env.US_TEST_DATABASE_URL;
      },
    ],
  ]) {
    const changed = workflows();
    const job = changed["us-development.yml"].jobs.isolation;
    const step = job.steps.find(
      (entry) => entry.name === "Verify bounded US dataset progress on disposable databases",
    );
    mutate(job, step);
    assert.throws(() => assertDatasetStageOwnership(changed), { name: "AssertionError" }, label);
  }
});

const assertDatasetReferenceOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const build = job.steps.findIndex(
    (step) => step.run === "pnpm turbo build --filter '@markiro/api...'",
  );
  assert.ok(build >= 0, "Reference checks require shared/API builds");
  for (const [name, prefix, files, configured] of [
    [
      "Verify US demo descriptor and strict journal codecs",
      ["pnpm"],
      [
        "test/us-demo-definition.test.ts",
        "test/us-demo-journal-contract.test.ts",
        "test/us-dataset-contract.test.ts",
        "test/us-dataset-reference-contract.test.ts",
        "test/us-dataset-receiving-contract.test.ts",
      ],
      false,
    ],
    [
      "Verify exact US demo references and canonical replay on disposable databases",
      ["corepack", "pnpm"],
      [
        "test/us-reference-transaction-seams.e2e.test.ts",
        "test/us-demo-atomic-stage.e2e.test.ts",
        "test/us-demo-reference-seed.e2e.test.ts",
        "test/us-dataset-reference-seed.e2e.test.ts",
        "test/us-demo-journal.e2e.test.ts",
        "test/us-master-data.e2e.test.ts",
        "test/us-catalog.e2e.test.ts",
        "test/us-catalog-operational-boundaries.e2e.test.ts",
        "test/us-product-profile.e2e.test.ts",
        "test/us-reference-document.e2e.test.ts",
      ],
      true,
    ],
  ]) {
    const owners = job.steps.filter((step) => step.name === name);
    assert.equal(owners.length, 1, `${name} has one owner`);
    const step = owners[0];
    assert.deepEqual(step.run.trim().split(/\s+/), [
      ...prefix,
      "--filter",
      "@markiro/api",
      "exec",
      "vitest",
      "run",
      ...files,
      "--maxWorkers=1",
    ]);
    const newFile = configured
      ? "test/us-dataset-reference-seed.e2e.test.ts"
      : "test/us-dataset-reference-contract.test.ts";
    const executions = Object.values(workflow.jobs).flatMap((candidate) =>
      candidate.steps.flatMap((entry) => entry.run?.trim().split(/\s+/) ?? []),
    );
    assert.equal(executions.filter((token) => token === newFile).length, 1);
    assert.ok(job.steps.indexOf(step) > build, "Reference checks follow shared/API builds");
    for (const owner of [job, step, job.steps[build]]) {
      assert.equal(owner.if, undefined);
      assert.equal(owner["continue-on-error"], undefined);
    }
    assert.deepEqual(
      step.env,
      configured
        ? {
            US_TEST_DATABASE_URL:
              "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
          }
        : undefined,
    );
  }
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["isolation"]);
  assertDatasetStageOwnership(allWorkflows);
};

test("dataset reference contract and native reference stage retain separate exact check-only owners", () => {
  assertDatasetReferenceOwnership(workflows());
});

test("dataset reference ownership rejects missing/duplicate suites and unsafe configured execution", () => {
  assertDatasetReferenceOwnership(workflows());
  for (const [label, mutate] of [
    [
      "omitted configured suite",
      (job, step) => {
        step.run = step.run.replace(" test/us-dataset-reference-seed.e2e.test.ts", "");
      },
    ],
    [
      "duplicated configured suite",
      (job, _step) => {
        job.steps.push({
          run: "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-reference-seed.e2e.test.ts --maxWorkers=1",
        });
      },
    ],
    [
      "omitted pure suite",
      (job) => {
        const pure = job.steps.find(
          (step) => step.name === "Verify US demo descriptor and strict journal codecs",
        );
        pure.run = pure.run.replace(" test/us-dataset-reference-contract.test.ts", "");
      },
    ],
    [
      "duplicated pure suite",
      (job) => {
        job.steps.push({
          run: "pnpm --filter @markiro/api exec vitest run test/us-dataset-reference-contract.test.ts --maxWorkers=1",
        });
      },
    ],
    [
      "guarded pure owner",
      (job) => {
        job.steps.find(
          (step) => step.name === "Verify US demo descriptor and strict journal codecs",
        ).if = "${{ false }}";
      },
    ],
    [
      "ignored pure failure",
      (job) => {
        job.steps.find(
          (step) => step.name === "Verify US demo descriptor and strict journal codecs",
        )["continue-on-error"] = true;
      },
    ],
    [
      "pure execution before builds",
      (job) => {
        const pure = job.steps.find(
          (step) => step.name === "Verify US demo descriptor and strict journal codecs",
        );
        job.steps = [pure, ...job.steps.filter((entry) => entry !== pure)];
      },
    ],
    [
      "job database fallback",
      (job) => {
        job.env = { DATABASE_URL: "postgres://wrong/other" };
      },
    ],
    [
      "guarded reference owner",
      (job, step) => {
        step.if = "${{ false }}";
      },
    ],
    [
      "ignored reference failure",
      (job, step) => {
        step["continue-on-error"] = true;
      },
    ],
    [
      "ignored shell failure",
      (job, step) => {
        step.run += " || true";
      },
    ],
    [
      "wrong isolated URL",
      (job, step) => {
        step.env.US_TEST_DATABASE_URL = "postgres://wrong/other";
      },
    ],
    [
      "primary database fallback",
      (job, step) => {
        step.env.DATABASE_URL = step.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "absent isolated URL",
      (job, step) => {
        delete step.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "parallel fixture execution",
      (job, step) => {
        step.run = step.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
    ],
    [
      "reference execution before builds",
      (job, step) => {
        job.steps = [step, ...job.steps.filter((entry) => entry !== step)];
      },
    ],
    [
      "conditional dependency build",
      (job) => {
        job.steps.find((step) => step.run === "pnpm turbo build --filter '@markiro/api...'").if =
          "${{ false }}";
      },
    ],
    [
      "ignored dependency build",
      (job) => {
        job.steps.find((step) => step.run === "pnpm turbo build --filter '@markiro/api...'")[
          "continue-on-error"
        ] = true;
      },
    ],
  ]) {
    const changed = workflows();
    const job = changed["us-development.yml"].jobs.isolation;
    const step = job.steps.find(
      (entry) =>
        entry.name ===
        "Verify exact US demo references and canonical replay on disposable databases",
    );
    mutate(job, step);
    assert.throws(
      () => assertDatasetReferenceOwnership(changed),
      { name: "AssertionError" },
      label,
    );
  }
});

const datasetReceivingOwner = "Verify regular US dataset Receiving on disposable databases";
const datasetReceivingPure = "test/us-dataset-receiving-contract.test.ts";
const datasetReceivingConfigured = [
  "test/us-dataset-stage-read.e2e.test.ts",
  "test/us-dataset-receiving-verify.e2e.test.ts",
  "test/us-dataset-receiving-locks.e2e.test.ts",
  "test/us-dataset-receiving-seed.e2e.test.ts",
];

const assertDatasetReceivingOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === datasetReceivingOwner);
  assert.equal(owners.length, 1, "Regular dataset Receiving has exactly one configured owner");
  const configured = owners[0];
  const pure = job.steps.find(
    (step) => step.name === "Verify US demo descriptor and strict journal codecs",
  );
  const tokens = (step) => step.run?.trim().split(/\s+/) ?? [];
  const executions = Object.values(workflow.jobs).flatMap((candidate) =>
    candidate.steps.flatMap(tokens),
  );
  for (const file of [datasetReceivingPure, ...datasetReceivingConfigured]) {
    assert.equal(executions.filter((token) => token === file).length, 1, `${file} runs once`);
  }
  assert.ok(tokens(pure).includes(datasetReceivingPure));
  assert.deepEqual(tokens(configured), [
    "corepack",
    "pnpm",
    "--filter",
    "@markiro/api",
    "exec",
    "vitest",
    "run",
    ...datasetReceivingConfigured,
    "--maxWorkers=1",
  ]);
  const build = job.steps.findIndex(
    (step) =>
      JSON.stringify(tokens(step)) ===
      JSON.stringify(["pnpm", "turbo", "build", "--filter", "'@markiro/api...'"]),
  );
  assert.ok(build >= 0, "Receiving requires the existing shared/API build");
  for (const step of [pure, configured]) {
    assert.ok(job.steps.indexOf(step) > build, "Receiving checks follow shared/API builds");
  }
  for (const owner of [workflow, job, pure, configured, job.steps[build]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
    assert.equal(owner.env?.DATABASE_URL, undefined);
  }
  assert.equal(pure.env, undefined);
  assert.deepEqual(configured.env, {
    US_TEST_DATABASE_URL:
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
  });
  const priorSteps = job.steps
    .filter(
      (step) =>
        step !== configured &&
        step.name !== transformationTransactionOwner &&
        step.name !== caseTransactionOwner &&
        step.name !== datasetCasesOwner &&
        step.name !== shippingTransactionOwner &&
        step.name !== datasetShippingOwner &&
        step.name !== datasetTransformationOwner &&
        step.name !== "Verify regular dataset range orchestration on disposable databases" &&
        step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
        step.name !== "Verify special dataset Receiving examples on disposable databases" &&
        step.name !== "Verify special dataset event examples on disposable databases" &&
        step.name !== "Verify corrected dataset Cases on disposable databases" &&
        !isNativeAssemblyOwner(step),
    )
    .map((step) =>
      step === pure ? { ...step, run: step.run.replace(` ${datasetReceivingPure}`, "") } : step,
    );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "9fc8ecea70d0a363458b845a1556c0d1e6cb477a0c5e2ee85a6937e92f515643",
    "Every pre-existing step, command matrix, order and setting is preserved",
  );
  assertDatasetReferenceOwnership(allWorkflows);
};

test("regular dataset Receiving has exact separate pure/configured unconditional serial owners after builds", () => {
  assertDatasetReceivingOwnership(workflows());
});

test("regular dataset Receiving ownership rejects fresh executable workflow mutations", () => {
  assertDatasetReceivingOwnership(workflows());
  const mutations = [];
  for (const file of [datasetReceivingPure, ...datasetReceivingConfigured]) {
    mutations.push(
      [
        `omit ${file}`,
        (workflow, job) => {
          const owner = job.steps.find((step) => step.run?.trim().split(/\s+/).includes(file));
          owner.run = owner.run.replace(` ${file}`, "");
        },
      ],
      [
        `duplicate ${file}`,
        (workflow, job) => {
          job.steps.push({
            run: `corepack pnpm --filter @markiro/api exec vitest run ${file} --maxWorkers=1`,
          });
        },
      ],
    );
  }
  for (const target of ["workflow", "job", "pure", "configured", "build"]) {
    for (const [label, change] of [
      [
        "conditional",
        (owner) => {
          owner.if = "${{ false }}";
        },
      ],
      [
        "ignored failure",
        (owner) => {
          owner["continue-on-error"] = true;
        },
      ],
      [
        "DATABASE_URL fallback",
        (owner) => {
          owner.env = { ...owner.env, DATABASE_URL: "postgres://wrong/other" };
        },
      ],
    ]) {
      mutations.push([
        `${target} ${label}`,
        (workflow, job, pure, configured, build) => {
          change({ workflow, job, pure, configured, build }[target]);
        },
      ]);
    }
  }
  for (const target of ["pure", "configured", "build"]) {
    mutations.push([
      `${target} shell suppression`,
      (workflow, job, pure, configured, build) => {
        ({ pure, configured, build })[target].run += " || true";
      },
    ]);
  }
  mutations.push(
    [
      "wrong fixture URL",
      (workflow, job, pure, configured) => {
        configured.env.US_TEST_DATABASE_URL = "postgres://wrong/other";
      },
    ],
    [
      "missing fixture URL",
      (workflow, job, pure, configured) => {
        delete configured.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "missing builds",
      (workflow, job, pure, configured, build) => {
        job.steps = job.steps.filter((step) => step !== build);
      },
    ],
    [
      "configured before builds",
      (workflow, job, pure, configured) => {
        job.steps = [configured, ...job.steps.filter((step) => step !== configured)];
      },
    ],
    [
      "pure before builds",
      (workflow, job, pure) => {
        job.steps = [pure, ...job.steps.filter((step) => step !== pure)];
      },
    ],
    [
      "parallel fixtures",
      (workflow, job, pure, configured) => {
        configured.run = configured.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
    ],
    [
      "missing serial workers",
      (workflow, job, pure, configured) => {
        configured.run = configured.run.replace(" --maxWorkers=1", "");
      },
    ],
  );
  for (const [label, mutate] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    const pure = job.steps.find(
      (step) => step.name === "Verify US demo descriptor and strict journal codecs",
    );
    const configured = job.steps.find((step) => step.name === datasetReceivingOwner);
    const build = job.steps.find(
      (step) => step.run === "pnpm turbo build --filter '@markiro/api...'",
    );
    mutate(workflow, job, pure, configured, build);
    assert.throws(
      () => assertDatasetReceivingOwnership(changed),
      { name: "AssertionError" },
      label,
    );
  }
});

const assertReceivingTransactionOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter(
    (step) =>
      step.name ===
      "Verify US profile, session and master-data persistence on disposable databases",
  );
  assert.equal(owners.length, 1, "Receiving regressions have one existing owner");
  const owner = owners[0];
  const file = "test/us-receiving-transaction-seams.e2e.test.ts";
  const executions = Object.values(workflow.jobs).flatMap((candidate) =>
    candidate.steps.flatMap((step) => step.run?.trim().split(/\s+/) ?? []),
  );
  assert.equal(executions.filter((token) => token === file).length, 1, `${file} runs once`);
  const commands = owner.run
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const commandsWithSeam = commands.filter((tokens) => tokens.includes(file));
  assert.equal(commandsWithSeam.length, 1);
  assert.deepEqual(commandsWithSeam[0], [
    "pnpm",
    "--filter",
    "@markiro/api",
    "exec",
    "vitest",
    "run",
    "test/us-receiving-revision-finalization.e2e.test.ts",
    "test/us-receiving-revision-finalization-concurrency.e2e.test.ts",
    file,
    "--maxWorkers=1",
  ]);
  // Pin the executable pre-increment matrix, including all existing paths and command order.
  const priorCommands = commands.map((tokens) =>
    tokens.includes(file)
      ? tokens.filter((token) => token !== file && token !== "--maxWorkers=1")
      : tokens,
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorCommands)).digest("hex"),
    "f52c0a2d90368d40890c93ea69c24fc928c6dfb2149c3fa9a70ec5e6e7ebb13b",
    "All pre-existing persistence commands retain their files and order",
  );
  const build = job.steps.findIndex(
    (step) => step.run === "pnpm turbo build --filter '@markiro/api...'",
  );
  assert.ok(
    build >= 0 && build < job.steps.indexOf(owner),
    "Receiving checks follow shared/API builds",
  );
  for (const step of [job, owner, job.steps[build]]) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  assert.deepEqual(owner.env, {
    US_TEST_DATABASE_URL:
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
  });
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.equal(job["timeout-minutes"], 30);
  assertDatasetReferenceOwnership(allWorkflows);
};

test("Receiving native transaction suite has one unconditional serial owner among existing regressions after builds", () => {
  assertReceivingTransactionOwnership(workflows());
});

test("Receiving transaction ownership rejects omission, duplication and unsafe execution", () => {
  assertReceivingTransactionOwnership(workflows());
  for (const [label, mutate] of [
    [
      "omitted seam",
      (job, owner) => {
        owner.run = owner.run.replace(" test/us-receiving-transaction-seams.e2e.test.ts", "");
      },
    ],
    [
      "duplicate seam",
      (job, owner) => {
        job.steps.push({ run: owner.run });
      },
    ],
    [
      "conditional owner",
      (job, owner) => {
        owner.if = "${{ false }}";
      },
    ],
    [
      "conditional job",
      (job) => {
        job.if = "${{ false }}";
      },
    ],
    [
      "ignored owner failure",
      (job, owner) => {
        owner["continue-on-error"] = true;
      },
    ],
    [
      "ignored job failure",
      (job) => {
        job["continue-on-error"] = true;
      },
    ],
    [
      "shell failure suppression",
      (job, owner) => {
        owner.run += " || true";
      },
    ],
    [
      "conditional build",
      (job, owner, build) => {
        build.if = "${{ false }}";
      },
    ],
    [
      "ignored build failure",
      (job, owner, build) => {
        build["continue-on-error"] = true;
      },
    ],
    [
      "build shell failure suppression",
      (job, owner, build) => {
        build.run += " || true";
      },
    ],
    [
      "missing build",
      (job, owner, build) => {
        job.steps = job.steps.filter((step) => step !== build);
      },
    ],
    [
      "before builds",
      (job, owner) => {
        job.steps = [owner, ...job.steps.filter((step) => step !== owner)];
      },
    ],
    [
      "nonserial seam",
      (job, owner) => {
        owner.run = owner.run.replace(
          "test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=1",
          "test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=2",
        );
      },
    ],
    [
      "missing serial flag",
      (job, owner) => {
        owner.run = owner.run.replace(
          "test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=1",
          "test/us-receiving-transaction-seams.e2e.test.ts",
        );
      },
    ],
    [
      "missing fixture URL",
      (job, owner) => {
        delete owner.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "wrong fixture URL",
      (job, owner) => {
        owner.env.US_TEST_DATABASE_URL = "postgres://wrong/other";
      },
    ],
    [
      "owner database fallback",
      (job, owner) => {
        owner.env.DATABASE_URL = owner.env.US_TEST_DATABASE_URL;
      },
    ],
    [
      "job database fallback",
      (job) => {
        job.env = { DATABASE_URL: "postgres://wrong/other" };
      },
    ],
    [
      "workflow database fallback",
      (job, owner, build, workflow) => {
        workflow.env = { DATABASE_URL: "postgres://wrong/other" };
      },
    ],
    [
      "omitted prior Receiving regression",
      (job, owner) => {
        owner.run = owner.run.replace(" test/us-receiving-history.e2e.test.ts", "");
      },
    ],
    [
      "reordered prior Receiving regressions",
      (job, owner) => {
        owner.run = owner.run.replace(
          "test/us-receiving-history.e2e.test.ts test/us-receiving-read-concurrency.e2e.test.ts",
          "test/us-receiving-read-concurrency.e2e.test.ts test/us-receiving-history.e2e.test.ts",
        );
      },
    ],
  ]) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    const owner = job.steps.find(
      (step) =>
        step.name ===
        "Verify US profile, session and master-data persistence on disposable databases",
    );
    const build = job.steps.find(
      (step) => step.run === "pnpm turbo build --filter '@markiro/api...'",
    );
    mutate(job, owner, build, workflow);
    assert.throws(
      () => assertReceivingTransactionOwnership(changed),
      { name: "AssertionError" },
      label,
    );
  }
});

const transformationTransactionFiles = [
  "test/us-transformation-transaction-seams.e2e.test.ts",
  "test/us-transformation-transaction-locks.e2e.test.ts",
];

const assertTransformationTransactionOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === transformationTransactionOwner);
  assert.equal(owners.length, 1, "Transformation has exactly one named owner");
  const owner = owners[0];
  const executions = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((candidateJob) =>
      (candidateJob.steps ?? []).flatMap((step) => step.run?.trim().split(/\s+/) ?? []),
    ),
  );
  for (const file of transformationTransactionFiles) {
    assert.equal(executions.filter((token) => token === file).length, 1, `${file} runs once`);
  }
  assert.deepEqual(
    owner.run.trim().split(/\s+/),
    [
      "pnpm",
      "--filter",
      "@markiro/api",
      "exec",
      "vitest",
      "run",
      ...transformationTransactionFiles,
      "--maxWorkers=1",
    ],
    "Transformation uses the exact native command and serial worker limit",
  );
  for (const [name, command] of [
    [
      "Verify shared domain foundation",
      "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    ],
    [
      "Build isolated API dependencies and entry points",
      "pnpm turbo build --filter '@markiro/api...'",
    ],
  ]) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has one predecessor`);
    const build = builds[0];
    assert.equal(build.run, command, `${name} propagates every build failure`);
    assert.ok(
      job.steps.indexOf(build) < job.steps.indexOf(owner),
      `${name} precedes Transformation`,
    );
    assert.equal(build.if, undefined, `${name} is unconditional`);
    assert.equal(build["continue-on-error"], undefined, `${name} cannot ignore failure`);
    assert.equal(build.env?.DATABASE_URL, undefined, `${name} has no database fallback`);
  }
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Transformation ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Transformation ${label} cannot ignore failure`,
    );
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      `Transformation ${label} has no database fallback`,
    );
  }
  assert.deepEqual(
    owner.env,
    {
      US_TEST_DATABASE_URL:
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    },
    "Transformation uses only the exact synthetic fixture URL",
  );
  assert.equal(job["timeout-minutes"], 30);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify(
          job.steps.filter(
            (step) =>
              step !== owner &&
              step.name !== datasetTransformationOwner &&
              step.name !== datasetCasesOwner &&
              step.name !== shippingTransactionOwner &&
              step.name !== datasetShippingOwner &&
              step.name !== caseTransactionOwner &&
              step.name !== "Verify regular dataset range orchestration on disposable databases" &&
              step.name !==
                "Verify Receiving lifecycle transaction foundation on disposable databases" &&
              step.name !== "Verify special dataset Receiving examples on disposable databases" &&
              step.name !== "Verify special dataset event examples on disposable databases" &&
              step.name !== "Verify corrected dataset Cases on disposable databases" &&
              !isNativeAssemblyOwner(step),
          ),
        ),
      )
      .digest("hex"),
    "57fd76da4e01120596edd608b2f56fcf7e2db66262d2e31264d976b838180c5b",
    "Every prior Transformation foundation step, command, order and setting is preserved",
  );
  assertReceivingTransactionOwnership(allWorkflows);
  assertDatasetReceivingOwnership(allWorkflows);
  assert.deepEqual(checkWorkflows(allWorkflows, "codex/us-mvp"), []);
};

test("Transformation native suites have one unconditional serial fixture owner after successful builds", () => {
  assertTransformationTransactionOwnership(workflows());
});

test("Transformation native ownership rejects fresh executable mutations at their invariants", () => {
  assertTransformationTransactionOwnership(workflows());
  const mutations = [];
  for (const file of transformationTransactionFiles) {
    mutations.push(
      [
        `omitted ${file}`,
        (job, owner) => {
          owner.run = owner.run.replace(` ${file}`, "");
        },
        /runs once/,
      ],
      [
        `duplicate ${file}`,
        (job) => {
          job.steps.push({ run: `pnpm --filter @markiro/api exec vitest run ${file}` });
        },
        /runs once/,
      ],
    );
  }
  mutations.push(
    [
      "duplicate named owner",
      (job, owner) => {
        job.steps.push({ ...owner });
      },
      /exactly one named owner/,
    ],
    [
      "split suites into two commands",
      (job, owner) => {
        owner.run = owner.run.replace(
          ` ${transformationTransactionFiles[1]}`,
          ` --maxWorkers=1\npnpm --filter @markiro/api exec vitest run ${transformationTransactionFiles[1]}`,
        );
      },
      /exact native command/,
    ],
    [
      "parallel workers",
      (job, owner) => {
        owner.run = owner.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /serial worker limit/,
    ],
    [
      "missing serial limit",
      (job, owner) => {
        owner.run = owner.run.replace(" --maxWorkers=1", "");
      },
      /serial worker limit/,
    ],
    [
      "owner shell suppression",
      (job, owner) => {
        owner.run += " || true";
      },
      /exact native command/,
    ],
    [
      "missing fixture URL",
      (job, owner) => {
        delete owner.env.US_TEST_DATABASE_URL;
      },
      /exact synthetic fixture URL/,
    ],
    [
      "wrong fixture URL",
      (job, owner) => {
        owner.env.US_TEST_DATABASE_URL = "postgres://wrong/other";
      },
      /exact synthetic fixture URL/,
    ],
    [
      "changed prior command",
      (job) => {
        job.steps.find(
          (step) => step.name === "Verify pure six-month recipe and compiled timezone identity",
        ).run += " || true";
      },
      /Every prior Transformation foundation step/,
    ],
    [
      "reordered prior steps",
      (job) => {
        const index = job.steps.findIndex(
          (step) => step.name === "Verify pure six-month recipe and compiled timezone identity",
        );
        [job.steps[index], job.steps[index + 1]] = [job.steps[index + 1], job.steps[index]];
      },
      /Every prior Transformation foundation step/,
    ],
  );
  for (const label of ["workflow", "job", "owner"]) {
    for (const [key, value, expected] of [
      ["if", "${{ false }}", /is unconditional/],
      ["continue-on-error", true, /cannot ignore failure/],
      ["env", { DATABASE_URL: "postgres://wrong/other" }, /has no database fallback/],
    ]) {
      mutations.push([
        `${label} ${key}`,
        (job, owner, workflow) => {
          ({ workflow, job, owner })[label][key] = value;
        },
        expected,
      ]);
    }
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    for (const [label, mutate, expected] of [
      [
        "conditional",
        (job, owner, build) => {
          build.if = "${{ false }}";
        },
        /is unconditional/,
      ],
      [
        "ignored failure",
        (job, owner, build) => {
          build["continue-on-error"] = true;
        },
        /cannot ignore failure/,
      ],
      [
        "shell suppression",
        (job, owner, build) => {
          build.run += " || true";
        },
        /propagates every build failure/,
      ],
      [
        "missing",
        (job, owner, build) => {
          job.steps = job.steps.filter((step) => step !== build);
        },
        /has one predecessor/,
      ],
      [
        "reordered after owner",
        (job, owner, build) => {
          job.steps = job.steps.filter((step) => step !== build);
          job.steps.splice(job.steps.indexOf(owner) + 1, 0, build);
        },
        /precedes Transformation/,
      ],
      [
        "database fallback",
        (job, owner, build) => {
          build.env = { DATABASE_URL: "postgres://wrong/other" };
        },
        /has no database fallback/,
      ],
    ]) {
      mutations.push([
        `${name} ${label}`,
        (job, owner) => {
          mutate(
            job,
            owner,
            job.steps.find((step) => step.name === name),
          );
        },
        expected,
      ]);
    }
  }
  for (const [label, mutate, expected] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    const owner = job.steps.find((step) => step.name === transformationTransactionOwner);
    mutate(job, owner, workflow);
    assert.throws(
      () => assertTransformationTransactionOwnership(changed),
      { name: "AssertionError", message: expected },
      label,
    );
  }
});

const datasetTransformationFiles = [
  "test/us-dataset-transformation-contract.test.ts",
  "test/us-dataset-transformation-verify.e2e.test.ts",
  "test/us-dataset-transformation-locks.e2e.test.ts",
  "test/us-dataset-transformation-seed.e2e.test.ts",
];

const assertDatasetTransformationOwnership = (allWorkflows) => {
  const workflow = allWorkflows["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === datasetTransformationOwner);
  assert.equal(owners.length, 1, "Dataset Transformation has exactly one named owner");
  const owner = owners[0];
  const executions = Object.values(allWorkflows).flatMap((candidate) =>
    Object.values(candidate.jobs ?? {}).flatMap((candidateJob) =>
      (candidateJob.steps ?? []).flatMap((step) => step.run?.trim().split(/\s+/) ?? []),
    ),
  );
  for (const file of datasetTransformationFiles) {
    assert.equal(executions.filter((token) => token === file).length, 1, `${file} runs once`);
  }
  assert.deepEqual(
    owner.run.trim().split(/\s+/),
    [
      "corepack",
      "pnpm",
      "--filter",
      "@markiro/api",
      "exec",
      "vitest",
      "run",
      ...datasetTransformationFiles,
      "--maxWorkers=1",
    ],
    "Dataset Transformation uses the exact command and serial worker limit",
  );
  for (const [name, command] of [
    [
      "Verify shared domain foundation",
      "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
    ],
    [
      "Build isolated API dependencies and entry points",
      "pnpm turbo build --filter '@markiro/api...'",
    ],
  ]) {
    const builds = job.steps.filter((step) => step.name === name);
    assert.equal(builds.length, 1, `${name} has one predecessor`);
    const build = builds[0];
    assert.equal(build.run, command, `${name} propagates every build failure`);
    assert.ok(
      job.steps.indexOf(build) < job.steps.indexOf(owner),
      `${name} precedes dataset Transformation`,
    );
    assert.equal(build.if, undefined, `${name} is unconditional`);
    assert.equal(build["continue-on-error"], undefined, `${name} cannot ignore failure`);
    assert.equal(build.env?.DATABASE_URL, undefined, `${name} has no database fallback`);
  }
  for (const [label, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    assert.equal(entry.if, undefined, `Dataset Transformation ${label} is unconditional`);
    assert.equal(
      entry["continue-on-error"],
      undefined,
      `Dataset Transformation ${label} cannot ignore failure`,
    );
    assert.equal(
      entry.env?.DATABASE_URL,
      undefined,
      `Dataset Transformation ${label} has no database fallback`,
    );
  }
  assert.deepEqual(
    owner.env,
    {
      US_TEST_DATABASE_URL:
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    },
    "Dataset Transformation uses only the exact synthetic fixture URL",
  );
  assert.equal(job["timeout-minutes"], 30, "Dataset Transformation retains the 30-minute budget");
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "Dataset Transformation retains read-only permissions",
  );
  const priorSteps = job.steps.filter(
    (step) =>
      step !== owner &&
      step.name !== caseTransactionOwner &&
      step.name !== datasetCasesOwner &&
      step.name !== shippingTransactionOwner &&
      step.name !== datasetShippingOwner &&
      step.name !== "Verify regular dataset range orchestration on disposable databases" &&
      step.name !== "Verify Receiving lifecycle transaction foundation on disposable databases" &&
      step.name !== "Verify special dataset Receiving examples on disposable databases" &&
      step.name !== "Verify special dataset event examples on disposable databases" &&
      step.name !== "Verify corrected dataset Cases on disposable databases" &&
      !isNativeAssemblyOwner(step),
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorSteps)).digest("hex"),
    "f681c812d89c713e55fab3c91eb841b6ff5d3081ffca4994ad72fa5fbb89707c",
    "Every preincrement step, command matrix, order and setting is preserved",
  );
  const priorWorkflow = structuredClone(workflow);
  priorWorkflow.jobs.isolation.steps = priorSteps;
  assert.equal(
    createHash("sha256").update(JSON.stringify(priorWorkflow)).digest("hex"),
    "25f9816ced605ebbf3721504bb96e3a49615c22c5c82d43bd723b1ab57407be7",
    "Every preincrement workflow setting is preserved",
  );
  assertTransformationTransactionOwnership(allWorkflows);
  assert.deepEqual(checkWorkflows(allWorkflows, "codex/us-mvp"), []);
};

test("regular dataset Transformation has one unconditional serial fixture owner after successful builds", () => {
  assertDatasetTransformationOwnership(workflows());
});

test("dataset Transformation ownership rejects fresh executable mutations at their invariants", () => {
  assertDatasetTransformationOwnership(workflows());
  const mutations = [];
  for (const file of datasetTransformationFiles) {
    mutations.push(
      [
        `omitted ${file}`,
        (job, owner) => {
          owner.run = owner.run.replace(` ${file}`, "");
        },
        /runs once/,
      ],
      [
        `duplicate ${file}`,
        (job) => {
          job.steps.push({ run: `corepack pnpm --filter @markiro/api exec vitest run ${file}` });
        },
        /runs once/,
      ],
    );
  }
  mutations.push(
    [
      "duplicate owner",
      (job, owner) => {
        job.steps.push({ ...owner });
      },
      /exactly one named owner/,
    ],
    [
      "missing owner",
      (job, owner) => {
        job.steps = job.steps.filter((step) => step !== owner);
      },
      /exactly one named owner/,
    ],
    [
      "split commands",
      (job, owner) => {
        owner.run = owner.run.replace(
          ` ${datasetTransformationFiles[1]}`,
          ` --maxWorkers=1\ncorepack pnpm --filter @markiro/api exec vitest run ${datasetTransformationFiles[1]}`,
        );
      },
      /exact command/,
    ],
    [
      "parallel workers",
      (job, owner) => {
        owner.run = owner.run.replace("--maxWorkers=1", "--maxWorkers=2");
      },
      /serial worker limit/,
    ],
    [
      "missing serial limit",
      (job, owner) => {
        owner.run = owner.run.replace(" --maxWorkers=1", "");
      },
      /serial worker limit/,
    ],
    [
      "shell suppression",
      (job, owner) => {
        owner.run += " || true";
      },
      /exact command/,
    ],
    [
      "wrong fixture URL",
      (job, owner) => {
        owner.env.US_TEST_DATABASE_URL = "postgres://wrong/other";
      },
      /exact synthetic fixture URL/,
    ],
    [
      "missing fixture URL",
      (job, owner) => {
        delete owner.env.US_TEST_DATABASE_URL;
      },
      /exact synthetic fixture URL/,
    ],
    [
      "changed old command",
      (job) => {
        job.steps.find((step) => step.name === transformationTransactionOwner).run += " || true";
      },
      /Every preincrement step/,
    ],
    [
      "changed old setting",
      (job) => {
        job.steps[0].timeout = 1;
      },
      /Every preincrement step/,
    ],
    [
      "reordered old steps",
      (job) => {
        [job.steps[0], job.steps[1]] = [job.steps[1], job.steps[0]];
      },
      /Every preincrement step/,
    ],
    [
      "changed workflow setting",
      (job, owner, workflow) => {
        workflow.concurrency = "changed";
      },
      /Every preincrement workflow/,
    ],
    [
      "increased budget",
      (job) => {
        job["timeout-minutes"] = 31;
      },
      /30-minute budget/,
    ],
    [
      "write permission",
      (job, owner, workflow) => {
        workflow.permissions.contents = "write";
      },
      /read-only permissions/,
    ],
  );
  for (const label of ["workflow", "job", "owner"]) {
    for (const [key, value, expected] of [
      ["if", "${{ false }}", /is unconditional/],
      ["continue-on-error", true, /cannot ignore failure/],
      ["env", { DATABASE_URL: "postgres://wrong/other" }, /has no database fallback/],
    ])
      mutations.push([
        `${label} ${key}`,
        (job, owner, workflow) => {
          ({ workflow, job, owner })[label][key] = value;
        },
        expected,
      ]);
  }
  for (const name of [
    "Verify shared domain foundation",
    "Build isolated API dependencies and entry points",
  ]) {
    for (const [label, mutate, expected] of [
      [
        "guarded",
        (job, owner, build) => {
          build.if = "${{ false }}";
        },
        /is unconditional/,
      ],
      [
        "ignored",
        (job, owner, build) => {
          build["continue-on-error"] = true;
        },
        /cannot ignore failure/,
      ],
      [
        "suppressed",
        (job, owner, build) => {
          build.run += " || true";
        },
        /propagates every build failure/,
      ],
      [
        "missing",
        (job, owner, build) => {
          job.steps = job.steps.filter((step) => step !== build);
        },
        /has one predecessor/,
      ],
      [
        "after owner",
        (job, owner, build) => {
          job.steps = job.steps.filter((step) => step !== build);
          job.steps.splice(job.steps.indexOf(owner) + 1, 0, build);
        },
        /precedes dataset Transformation/,
      ],
      [
        "fallback",
        (job, owner, build) => {
          build.env = { DATABASE_URL: "postgres://wrong/other" };
        },
        /has no database fallback/,
      ],
    ])
      mutations.push([
        `${name} ${label}`,
        (job, owner) => {
          mutate(
            job,
            owner,
            job.steps.find((step) => step.name === name),
          );
        },
        expected,
      ]);
  }
  for (const [label, mutate, expected] of mutations) {
    const changed = workflows();
    const workflow = changed["us-development.yml"];
    const job = workflow.jobs.isolation;
    mutate(
      job,
      job.steps.find((step) => step.name === datasetTransformationOwner),
      workflow,
    );
    assert.throws(
      () => assertDatasetTransformationOwnership(changed),
      { name: "AssertionError", message: expected },
      label,
    );
  }
});

test("Requests frozen runs, bounded polling, retry and downloads have one serial owner after preparation", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-runs.test.tsx test/us-requests-polling.test.ts test/us-requests-retry.test.tsx test/us-requests-download.test.tsx --maxWorkers=1";
  const owners = job.steps.filter((step) => step.run === command);
  assert.equal(owners.length, 1);
  const preparation = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-validation.test.tsx test/us-requests-prepare.test.tsx test/us-requests-source.test.ts --maxWorkers=1",
  );
  assert.ok(preparation >= 0 && job.steps.indexOf(owners[0]) > preparation);
  for (const owner of [job, owners[0]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
});

test("Requests fresh validation, frozen preparation and source navigation have one serial CI owner after CRUD", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-validation.test.tsx test/us-requests-prepare.test.tsx test/us-requests-source.test.ts --maxWorkers=1";
  const owners = job.steps.filter((step) => step.run === command);
  assert.equal(owners.length, 1);
  const crud = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-editor.test.tsx test/us-requests-scope.test.tsx test/us-requests-crud.test.tsx --maxWorkers=1",
  );
  assert.ok(crud >= 0 && job.steps.indexOf(owners[0]) > crud);
  for (const owner of [job, owners[0]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
});

test("Requests controlled editors and recoverable CRUD have exact serial CI ownership after reads", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-editor.test.tsx test/us-requests-scope.test.tsx test/us-requests-crud.test.tsx --maxWorkers=1";
  const owners = job.steps.filter((step) => step.run === command);
  assert.equal(owners.length, 1, "Exactly one serial CRUD owner");
  const reads = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-navigation.test.tsx test/us-requests-view.test.tsx --maxWorkers=1",
  );
  assert.ok(
    reads >= 0 && job.steps.indexOf(owners[0]) > reads,
    "CRUD suites follow read-only suites",
  );
  for (const owner of [job, owners[0]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
});

test("Requests list, card and navigation have exact serial CI ownership after policy", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-navigation.test.tsx test/us-requests-view.test.tsx --maxWorkers=1";
  const owners = job.steps.filter((step) => step.run === command);
  assert.equal(owners.length, 1, "Exactly one serial read-only view owner");
  const index = job.steps.indexOf(owners[0]);
  const policy = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-time.test.ts test/us-requests-form.test.ts test/us-requests-copy.test.ts --maxWorkers=1",
  );
  assert.ok(policy >= 0 && index > policy, "View suites follow policy and dependency builds");
  for (const owner of [job, owners[0]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
});

test("Requests time, scope and form policy has exact serial CI ownership after dependencies", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-time.test.ts test/us-requests-form.test.ts test/us-requests-copy.test.ts --maxWorkers=1";
  const owners = job.steps.filter((step) => step.run === command);
  assert.equal(owners.length, 1, "Exactly one unconditional serial policy owner");
  const index = job.steps.indexOf(owners[0]);
  for (const pkg of ["domain", "platform-contracts", "ui"]) {
    const build = job.steps.findIndex((step) =>
      step.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
    );
    assert.ok(build >= 0 && build < index, `Policy suite follows ${pkg} build`);
  }
  for (const owner of [job, owners[0]]) {
    assert.equal(owner.if, undefined);
    assert.equal(owner["continue-on-error"], undefined);
  }
});

test("Requests verified binary suite has unconditional serial CI ownership after JSON", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const json = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-client.test.ts --maxWorkers=1",
  );
  const binary = job.steps.findIndex(
    (step) =>
      step.run ===
      "pnpm --filter @markiro/admin exec vitest run test/us-requests-download-client.test.ts --maxWorkers=1",
  );
  assert.ok(json > 0 && binary > json, "Exact serial binary suite follows JSON suite");
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.steps[binary].if, undefined);
  assert.equal(job.steps[binary]["continue-on-error"], undefined);
});

test("Requests cabinet JSON and proxy suites have unconditional CI ownership", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const command =
    "pnpm --filter @markiro/admin exec vitest run test/us-requests-client.test.ts --maxWorkers=1";
  const index = job.steps.findIndex((step) => step.run === command);
  assert.ok(index > 0, "Exact serial Requests JSON suite is owned");
  for (const pkg of ["domain", "platform-contracts", "ui"]) {
    const build = job.steps.findIndex((step) =>
      step.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
    );
    assert.ok(build >= 0 && build < index, `Requests JSON suite follows ${pkg} build`);
  }
  const nodeStep = job.steps.find(
    (step) => step.run === "node --test tools/us-development/test/*.test.mjs",
  );
  assert.ok(nodeStep, "Proxy suite retains existing wildcard owner");
  for (const step of [job.steps[index], nodeStep]) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
});

test("every inherited operational job is unconditionally locked before it can obtain credentials", () => {
  const safe = new Set([
    "ci.yml",
    "dependency-review.yml",
    "us-development.yml",
    "us-cases-native.yml",
  ]);
  for (const [name, workflow] of Object.entries(workflows())) {
    if (safe.has(name)) continue;
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.if, "${{ false }}", `${name}/${jobId} is executable`);
    }
    if (workflow.concurrency) assert.match(workflow.concurrency.group, /^us-development-locked-/);
  }
});

test("US checks run on the development branch and cannot write repository or package state", () => {
  const workflow = workflows()["us-development.yml"];
  assert.ok(workflow, "US development workflow must exist");
  assert.deepEqual(workflow.on.push.branches, ["codex/us-mvp"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions, undefined);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\./);
});

test("US check-only job retains its approved 30-minute budget", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  assert.equal(job["timeout-minutes"], 30);
});

test("release checker fails on a pull request to main, even with all workflows locked", () => {
  const result = spawnSync(process.execPath, ["tools/us-development/check-isolation.mjs"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_BASE_REF: "main" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /US development must not merge into main/);
});

test("US event storage and contract regressions run unconditionally in the isolated job", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  assert.equal(job.if, undefined);
  for (const [pkg, file] of [
    ["admin", "us-receiving-command-acknowledgement.test.ts"],
    ["admin", "us-receiving-live-client.test.ts"],
    ["admin", "us-receiving-lifecycle-client.test.ts"],
    ["admin", "us-receiving-lifecycle.test.tsx"],
    ["admin", "us-receiving-amendment-editor.test.tsx"],
    ["admin", "us-receiving-amendment-finalization.test.tsx"],
    ["admin", "us-receiving-history.test.tsx"],
    ["admin", "us-receiving-tlc-input.test.tsx"],
    ["admin", "us-receiving-revision-acknowledgement.test.ts"],
    ["db", "us-receiving-basis-version-migration.e2e.test.ts"],
    ["api", "us-receiving-basis-version.e2e.test.ts"],
    ["db", "us-receiving-roots-migration.e2e.test.ts"],
    ["db", "us-receiving-lifecycle-migration.e2e.test.ts"],
    ["db", "us-shared-event-foundation-schema.test.ts"],
    ["db", "us-shared-event-foundation-migration.e2e.test.ts"],
    ["domain", "us-transformation-readiness.test.ts"],
    ["domain", "us-transformation-genealogy.test.ts"],
    ["platform-contracts", "us-transformation-draft.test.ts"],
    ["platform-contracts", "us-transformation-readiness.test.ts"],
    ["platform-contracts", "us-transformation-records.test.ts"],
    ["platform-contracts", "us-transformation-genealogy.test.ts"],
    ["db", "us-transformation-schema.test.ts"],
    ["db", "us-transformation-original-migration.e2e.test.ts"],
    ["db", "us-transformation-revisions-migration.e2e.test.ts"],
    ["api", "us-transformation-draft.e2e.test.ts"],
    ["api", "us-transformation-readiness.e2e.test.ts"],
    ["api", "us-transformation-finalization.e2e.test.ts"],
    ["api", "us-transformation-finalization-concurrency.e2e.test.ts"],
    ["api", "us-transformation-genealogy-fixture.e2e.test.ts"],
    ["api", "us-transformation-genealogy.e2e.test.ts"],
    ["api", "us-receiving-date-compatibility.e2e.test.ts"],
    ["api", "us-receiving-shared-event-compatibility.e2e.test.ts"],
    ["api", "us-receiving-roots.e2e.test.ts"],
    ["api", "us-receiving-basis.e2e.test.ts"],
    ["api", "us-receiving-history.e2e.test.ts"],
    ["api", "us-receiving-registry.e2e.test.ts"],
    ["api", "us-receiving-read-concurrency.e2e.test.ts"],
    ["api", "us-receiving-lifecycle.e2e.test.ts"],
    ["api", "us-receiving-lifecycle-concurrency.e2e.test.ts"],
    ["api", "us-receiving-lifecycle-compatibility.e2e.test.ts"],
    ["api", "us-receiving-original-command.e2e.test.ts"],
    ["api", "us-receiving-command-contracts.e2e.test.ts"],
    ["api", "us-receiving-draft-command-bridge.e2e.test.ts"],
    ["api", "us-receiving-finalization-command-bridge.e2e.test.ts"],
    ["api", "us-receiving-amendment-save.e2e.test.ts"],
    ["api", "us-receiving-amendment-save-concurrency.e2e.test.ts"],
    ["api", "us-receiving-revision-readiness.e2e.test.ts"],
    ["api", "us-receiving-revision-readiness-concurrency.e2e.test.ts"],
    ["api", "us-receiving-revision-finalization.e2e.test.ts"],
    ["api", "us-receiving-revision-finalization-concurrency.e2e.test.ts"],
    ["platform-contracts", "us-receiving-lifecycle.test.ts"],
    ["platform-contracts", "us-receiving-lifecycle-errors.test.ts"],
    ["platform-contracts", "us-receiving-command-contracts.test.ts"],
    ["platform-contracts", "us-receiving-finalization-v3.test.ts"],
    ["platform-contracts", "us-receiving-live-records.test.ts"],
    ["platform-contracts", "us-receiving-registry.test.ts"],
    ["platform-contracts", "us-receiving-revision-readiness.test.ts"],
  ]) {
    const step = job.steps.find((candidate) =>
      candidate.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(step, `Missing ${pkg} event storage regression: ${file}`);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(
      step.env?.US_TEST_DATABASE_URL,
      pkg === "admin"
        ? undefined
        : "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    );
  }
});

test("US case bridge contract, migration, commands, concurrency, reads and HTTP suites run on disposable PostgreSQL", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  for (const [pkg, file] of [
    ["platform-contracts", "us-case-bridge.test.ts"],
    ["db", "us-case-bridge-schema.test.ts"],
    ["db", "us-case-bridge-migration.e2e.test.ts"],
    ["api", "us-case-commands.e2e.test.ts"],
    ["api", "us-case-concurrency.e2e.test.ts"],
    ["api", "us-case-reads.e2e.test.ts"],
    ["api", "us-case-http.e2e.test.ts"],
  ]) {
    const step = job.steps.find((candidate) =>
      candidate.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(step, `Missing disposable-DB case regression: ${pkg}/${file}`);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(
      step.env?.US_TEST_DATABASE_URL,
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    );
  }
});

test("US API allowlist mounts the case bridge without RU box, Station or release entrypoints", () => {
  const module = readFileSync("apps/api/src/deployment/us-development.module.ts", "utf8");
  assert.match(module, /controllers:\s*\[[^\]]*\bUsCaseController\b/s);
  assert.doesNotMatch(module, /\bBoxesController\b|\bStation\w*Controller\b/);
  const workflow = workflows()["us-development.yml"];
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /release-images\.yml|deploy-production\.yml|station-(?:beta|stable)-release\.yml/,
  );
});

test("US Transformation and Events API suites are owned by the isolated check-only workflow", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const databaseUrl =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  for (const [pkg, file] of [
    ["platform-contracts", "us-transformation-http.test.ts"],
    ["platform-contracts", "us-events.test.ts"],
    ["api", "us-transformation-original-draft-void.e2e.test.ts"],
    ["api", "us-transformation-revisions.e2e.test.ts"],
    ["api", "us-transformation-http.e2e.test.ts"],
    ["api", "us-events-registry.e2e.test.ts"],
    ["api", "us-events-http.e2e.test.ts"],
  ]) {
    const step = job.steps.find((candidate) =>
      candidate.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(step, `Missing isolated US API gate: ${pkg}/${file}`);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.env?.US_TEST_DATABASE_URL, pkg === "api" ? databaseUrl : undefined);
  }
  assert.equal(job["continue-on-error"], undefined);
  const module = readFileSync("apps/api/src/deployment/us-development.module.ts", "utf8");
  assert.match(module, /controllers:\s*\[[^\]]*\bUsTransformationController\b/s);
  assert.match(module, /controllers:\s*\[[^\]]*\bUsEventsController\b/s);
  const workflow = workflows()["us-development.yml"];
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /release-images\.yml|deploy-production\.yml|station-(?:beta|stable)-release\.yml/,
  );
});

test("US Shipping storage, finalization and HTTP suites stay in isolated check-only CI", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  const databaseUrl =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  for (const [pkg, file] of [
    ["domain", "us-shipping-balance.test.ts"],
    ["domain", "us-shipping-readiness.test.ts"],
    ["platform-contracts", "us-shipping-contracts.test.ts"],
    ["platform-contracts", "us-shipping-finalization.test.ts"],
    ["db", "us-shipping-schema.test.ts"],
    ["db", "us-shipping-migration.e2e.test.ts"],
    ["api", "us-shipping-balance.e2e.test.ts"],
    ["api", "us-shipping-balance-read.e2e.test.ts"],
    ["api", "us-shipping-draft.e2e.test.ts"],
    ["api", "us-shipping-readiness.e2e.test.ts"],
    ["api", "us-shipping-status-effects.e2e.test.ts"],
    ["api", "us-shipping-finalization.e2e.test.ts"],
    ["api", "us-shipping-finalization-concurrency.e2e.test.ts"],
    ["api", "us-shipping-http.e2e.test.ts"],
    ["admin", "us-shipping-editor.test.tsx"],
    ["admin", "us-shipping-readiness.test.tsx"],
    ["admin", "us-shipping-detail.test.tsx"],
    ["admin", "us-shipping-history.test.tsx"],
    ["admin", "us-events-ui.test.tsx"],
  ]) {
    const step = job.steps.find((candidate) =>
      candidate.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(step, `Missing isolated US Shipping gate: ${pkg}/${file}`);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(
      step.env?.US_TEST_DATABASE_URL,
      pkg === "api" || pkg === "db" ? databaseUrl : undefined,
    );
  }
  const module = readFileSync("apps/api/src/deployment/us-development.module.ts", "utf8");
  assert.match(module, /controllers:\s*\[[^\]]*\bUsShippingController\b/s);
  assert.doesNotMatch(readFileSync("apps/api/src/app.module.ts", "utf8"), /UsShippingController/);
});

test("US-09 request rules, contracts, storage and freeze suites run unconditionally in isolated CI", () => {
  const workflow = workflows()["us-development.yml"];
  const job = workflow.jobs.isolation;
  const databaseUrl =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  const buildIndex = job.steps.findIndex(
    (step) => step.run === "pnpm turbo build --filter '@markiro/api...'",
  );
  assert.ok(buildIndex >= 0, "US request gates require built API dependencies");
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  for (const [pkg, file] of [
    ["domain", "us-request-deadline.test.ts"],
    ["platform-contracts", "us-requests.test.ts"],
    ["db", "us-request-schema.test.ts"],
    ["db", "us-request-migration.e2e.test.ts"],
    ["api", "us-request-selection.e2e.test.ts"],
    ["api", "us-request-store.e2e.test.ts"],
    ["api", "us-request-validation.e2e.test.ts"],
    ["api", "us-request-prepare.e2e.test.ts"],
    ["api", "us-request-run-evidence.e2e.test.ts"],
    ["api", "us-request-payloads.e2e.test.ts"],
    ["api", "us-request-tenant-origin.e2e.test.ts"],
    ["api", "us-request-versions.e2e.test.ts"],
    ["api", "us-request-plan-reader.e2e.test.ts"],
    ["api", "us-request-package-inputs.e2e.test.ts"],
    ["api", "us-request-report-pdf.e2e.test.ts"],
    ["api", "us-request-package-manifest.e2e.test.ts"],
    ["api", "us-request-package-zip.test.ts"],
    ["api", "us-request-package.e2e.test.ts"],
  ]) {
    const stepIndex = job.steps.findIndex((candidate) =>
      candidate.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(stepIndex >= 0, `Missing isolated US-09 request gate: ${pkg}/${file}`);
    assert.ok(stepIndex > buildIndex, `${pkg}/${file} must run after dependency builds`);
    const step = job.steps[stepIndex];
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.env?.DATABASE_URL, undefined);
    const usesDatabase = pkg === "db" || pkg === "api";
    assert.equal(step.env?.US_TEST_DATABASE_URL, usesDatabase ? databaseUrl : undefined);
    for (const line of step.run.trim().split("\n")) {
      assert.match(
        line,
        /^pnpm --filter @markiro\/(?:domain|platform-contracts|db|api) exec vitest run (?:test\/[\w.-]+(?:\s+|$))+(?:--maxWorkers=1)?$/,
        "US request checks must be direct commands without conditional skips or ignored failures",
      );
      if (usesDatabase) assert.ok(line.split(/\s+/).includes("--maxWorkers=1"));
    }
  }
});

test("US durable request worker and package regressions have serial isolated check-only ownership", () => {
  const workflow = workflows()["us-development.yml"];
  const job = workflow.jobs.isolation;
  const databaseUrl =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  const builds = ["db", "domain", "platform-contracts"].map((pkg) =>
    job.steps.findIndex((step) =>
      step.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
    ),
  );
  for (const [pkg, file] of [
    ["db", "us-request-worker-schema.test.ts"],
    ["db", "us-request-worker-migration.e2e.test.ts"],
    ["api", "us-request-worker-types.test.ts"],
    ["api", "us-request-worker-failures.test.ts"],
    ["api", "us-request-worker-execution.test.ts"],
    ["api", "us-request-package-artifact-config.test.ts"],
    ["api", "us-request-package-artifacts.test.ts"],
    ["api", "us-request-worker-lifecycle.e2e.test.ts"],
    ["api", "us-request-worker-checkpoint.e2e.test.ts"],
    ["api", "us-request-worker-publication.e2e.test.ts"],
    ["api", "us-request-worker-cleanup.e2e.test.ts"],
    ["api", "us-request-worker.e2e.test.ts"],
    ["api", "us-request-worker-recovery.e2e.test.ts"],
  ]) {
    const index = job.steps.findIndex((step) =>
      step.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith(`pnpm --filter @markiro/${pkg} exec vitest run `) &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(index >= 0, `Missing durable worker gate: ${pkg}/${file}`);
    assert.ok(
      builds.every((build) => build >= 0),
      "Missing explicit shared dependency build",
    );
    assert.ok(
      builds.every((build) => build < index),
      `${file} precedes a shared build`,
    );
  }
  for (const index of builds) {
    assert.equal(job.steps[index].if, undefined);
    assert.equal(job.steps[index]["continue-on-error"], undefined);
    for (const line of job.steps[index].run.trim().split("\n")) {
      assert.match(line, /^pnpm --filter @markiro\/(?:db|domain|platform-contracts) build$/);
    }
  }
  for (const step of job.steps) {
    const lines = step.run?.trim().split("\n") ?? [];
    if (
      !lines.some(
        (line) =>
          /--filter @markiro\/(?:domain|platform-contracts|db|api) /.test(line) &&
          /test\/us-(?:request|export|plan)[\w.-]+/.test(line),
      )
    )
      continue;
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.env?.DATABASE_URL, undefined);
    for (const line of lines) {
      assert.match(
        line,
        /^(?:corepack )?pnpm --filter @markiro\/(?:domain|platform-contracts|db|api) exec vitest run (?:test\/[\w.-]+(?:\s+|$))+(?:--maxWorkers=1)?$/,
        "request/export/Plan commands must not skip or ignore failures",
      );
      if (
        /--filter @markiro\/(?:api|db) /.test(line) &&
        /test\/us-(?:request|export|plan)[\w.-]+/.test(line)
      ) {
        assert.equal(step.env?.US_TEST_DATABASE_URL, databaseUrl);
        assert.ok(line.split(/\s+/).includes("--maxWorkers=1"), `${line} is not serial`);
      }
    }
  }
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.doesNotMatch(JSON.stringify(workflow), /upload-artifact|secrets\./);
});

test("US worker build, loop, runtime and process checks require serial isolated CI and compiled entry", () => {
  const workflow = workflows()["us-development.yml"];
  const job = workflow.jobs.isolation;
  const builds = ["db", "domain", "platform-contracts"].map((pkg) =>
    job.steps.findIndex((step) =>
      step.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
    ),
  );
  const entryBuild = job.steps.findIndex(
    (step) => step.run === "pnpm --filter @markiro/api build:us-request-worker",
  );
  for (const file of [
    "us-request-build-descriptor.test.ts",
    "us-request-build-command.test.ts",
    "us-request-worker-loop.test.ts",
    "us-request-worker-runtime.test.ts",
    "us-request-worker-runtime.e2e.test.ts",
    "us-request-worker-process.e2e.test.ts",
  ]) {
    const index = job.steps.findIndex((step) =>
      step.run
        ?.split("\n")
        .some(
          (line) =>
            line.startsWith("pnpm --filter @markiro/api exec vitest run ") &&
            line.split(/\s+/).includes(`test/${file}`),
        ),
    );
    assert.ok(index >= 0, `Missing worker runtime gate: ${file}`);
    assert.ok(builds.every((build) => build >= 0 && build < index));
    assert.ok(
      entryBuild >= 0 && entryBuild < index,
      "Compiled descriptor build precedes consumers",
    );
    const step = job.steps[index];
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.env?.DATABASE_URL, undefined);
    assert.equal(
      step.env?.US_TEST_DATABASE_URL,
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    );
    assert.match(
      step.run,
      /^pnpm --filter @markiro\/api exec vitest run (?:test\/[\w.-]+\s+)+--maxWorkers=1$/,
    );
  }
  assert.ok(builds.every((build) => build >= 0 && build < entryBuild));
  const smokeIndex = job.steps.findIndex((step) =>
    step.run?.split(/\s+/).includes("tools/us-development/test/request-worker-entry.smoke.mjs"),
  );
  assert.ok(smokeIndex > entryBuild, "Direct executable smoke follows descriptor build");
  assert.match(
    job.steps[smokeIndex].run,
    /^node --test (?:tools\/us-development\/test\/[\w.-]+\s*)+$/,
  );
  for (const index of [entryBuild, smokeIndex]) {
    assert.equal(job.steps[index].if, undefined);
    assert.equal(job.steps[index]["continue-on-error"], undefined);
    assert.equal(job.steps[index].env?.DATABASE_URL, undefined);
  }
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job["timeout-minutes"], 30);
  assert.doesNotMatch(JSON.stringify(workflow), /upload-artifact|secrets\./);
});

test("US Requests HTTP has exact unconditional serial ownership after dependency and descriptor builds", () => {
  const workflow = workflows()["us-development.yml"];
  const job = workflow.jobs.isolation;
  const databaseUrl =
    "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
  const apiSuites = [
    "us-request-read.e2e.test.ts",
    "us-request-publication-read.e2e.test.ts",
    "us-request-http-commands.e2e.test.ts",
    "us-request-http-resources.test.ts",
    "us-request-http-resources.e2e.test.ts",
    "us-request-download.e2e.test.ts",
    "us-request-http.e2e.test.ts",
    "openapi-coverage.test.ts",
  ];
  const commands = [
    "pnpm --filter @markiro/platform-contracts exec vitest run test/us-requests-http.test.ts --maxWorkers=1",
    `pnpm --filter @markiro/api exec vitest run ${apiSuites.map((suite) => `test/${suite}`).join(" ")} --maxWorkers=1`,
  ];
  const builds = ["db", "domain", "platform-contracts"].map((pkg) =>
    job.steps.findIndex((step) =>
      step.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
    ),
  );
  const descriptor = job.steps.findIndex(
    (step) => step.run === "pnpm --filter @markiro/api build:us-request-worker",
  );
  assert.ok(builds.every((index) => index >= 0 && index < descriptor));
  for (const command of commands) {
    const index = job.steps.findIndex((step) => step.run === command);
    assert.ok(index > descriptor, `Missing exact Requests HTTP gate after builds: ${command}`);
    const step = job.steps[index];
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.env?.DATABASE_URL, undefined);
    assert.equal(
      step.env?.US_TEST_DATABASE_URL,
      command.includes("@markiro/api ") ? databaseUrl : undefined,
    );
  }
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.equal(job["timeout-minutes"], 30);
  assert.deepEqual(Object.keys(job.services), ["us-postgres"]);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /upload-artifact|secrets\.|release-images|deploy-production/,
  );
  assert.ok(
    job.steps.some((step) =>
      step.run?.includes(
        "test/us-plan-read.e2e.test.ts test/us-plan-inspection.e2e.test.ts test/us-plan-http.e2e.test.ts test/openapi-coverage.test.ts --maxWorkers=1",
      ),
    ),
    "The existing Plan/OpenAPI selection remains owned",
  );
});

for (const [label, command] of [
  [
    "owned HTTP lifecycle",
    "pnpm --filter @markiro/api exec vitest run test/deployment-entry.test.ts --maxWorkers=1",
  ],
  [
    "build fixture acquisition",
    "pnpm --filter @markiro/api exec vitest run test/us-request-build-fixture.test.ts --maxWorkers=1",
  ],
]) {
  test(`US Requests ${label} has exact unconditional serial isolated CI ownership`, () => {
    const workflow = workflows()["us-development.yml"];
    const job = workflow.jobs.isolation;
    const owners = job.steps.filter((step) => step.run === command);
    assert.equal(owners.length, 1, `Missing unique configured gate: ${command}`);
    const step = owners[0];
    const index = job.steps.indexOf(step);
    for (const pkg of ["db", "domain", "platform-contracts"]) {
      const build = job.steps.findIndex((candidate) =>
        candidate.run?.split("\n").includes(`pnpm --filter @markiro/${pkg} build`),
      );
      assert.ok(build >= 0 && build < index, `${command} must follow ${pkg} build`);
    }
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.deepEqual(step.env, {
      US_TEST_DATABASE_URL:
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    });
    assert.equal(workflow.env?.DATABASE_URL, undefined);
    assert.equal(job.env?.DATABASE_URL, undefined);
    assert.equal(job.if, undefined);
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job["timeout-minutes"], 30);
    assert.ok(
      job.steps.some(
        (candidate) =>
          candidate.run ===
          "pnpm --filter @markiro/api exec vitest run test/deployment-entry.test.ts test/us-development.e2e.test.ts test/env.test.ts test/health.e2e.test.ts",
      ),
      "The original entry gate remains owned",
    );
    assert.deepEqual(checkWorkflows(workflows(), "codex/us-mvp"), []);
    assert.doesNotMatch(
      JSON.stringify(workflow),
      /upload-artifact|secrets\.|release-images|deploy-production/,
    );
  });
}

test("Requests real cabinet lifecycle and browser have exact serial check-only owners after all builds and UI checks", () => {
  const workflow = workflows()["us-development.yml"];
  const job = workflow.jobs.isolation;
  const commands = [
    "pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile",
    "pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium",
    "pnpm --filter @markiro/api exec vitest run test/us-request-cabinet-browser-fixture.test.ts --maxWorkers=1",
    "pnpm --filter @markiro/api exec vitest run test/us-request-cabinet-browser.e2e.test.ts --maxWorkers=1",
  ];
  const positions = commands.map((command) => {
    const owners = job.steps.filter((step) => step.run === command);
    assert.equal(owners.length, 1, `Missing unique configured Requests browser owner: ${command}`);
    const step = owners[0];
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.deepEqual(
      step.env,
      command.includes("exec vitest")
        ? {
            US_TEST_DATABASE_URL:
              "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
          }
        : undefined,
    );
    return job.steps.indexOf(step);
  });
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  const requiredBuilds = [
    "pnpm turbo build --filter '@markiro/api...'",
    "pnpm --filter @markiro/api build:us-request-worker",
    "pnpm --filter @markiro/ui build",
  ];
  for (const command of requiredBuilds) {
    const position = job.steps.findIndex((step) => step.run === command);
    assert.ok(position >= 0 && position < positions[2]);
  }
  for (const file of [
    "us-app.test.tsx",
    "us-requests-download.test.tsx",
    "us-requests-validation.test.tsx",
    "us-requests-prepare.test.tsx",
  ]) {
    const position = job.steps.findIndex((step) => step.run?.split(/\s+/).includes(`test/${file}`));
    assert.ok(position >= 0 && position < positions[2]);
  }
  for (const file of [
    "deployment-entry.test.ts",
    "us-request-build-fixture.test.ts",
    "us-request-http.e2e.test.ts",
    "us-request-worker-process.e2e.test.ts",
  ]) {
    assert.ok(
      job.steps.some((step) => step.run?.split(/\s+/).includes(`test/${file}`)),
      `${file} remains owned`,
    );
  }
  assert.equal(job["timeout-minutes"], 30);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(job.services), ["us-postgres"]);
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(workflow.env?.DATABASE_URL, undefined);
  assert.equal(job.env?.DATABASE_URL, undefined);
  assert.deepEqual(checkWorkflows(workflows(), "codex/us-mvp"), []);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /upload-artifact|secrets\.|release-images|deploy-production/,
  );
});

test("US dependency stack has private ports and independently named persistent data", () => {
  const stack = load(readFileSync("deploy/us-development/compose.yml", "utf8"));
  assert.equal(stack.name, "markiro-us-development");
  assert.equal(stack.services.postgres.environment.POSTGRES_DB, "markiro_us_dev");
  assert.deepEqual(stack.services.postgres.ports, ["127.0.0.1:55432:5432"]);
  assert.deepEqual(stack.services.mailpit.ports, ["127.0.0.1:11025:1025", "127.0.0.1:18025:8025"]);
  assert.deepEqual(stack.services.minio.ports, ["127.0.0.1:19000:9000", "127.0.0.1:19001:9001"]);
  for (const volume of Object.values(stack.volumes)) {
    assert.equal(volume?.external, undefined);
    assert.equal(volume?.name, undefined);
  }
});

test("checker accepts the locked repository but rejects re-enabled and newly added release jobs", () => {
  const valid = workflows();
  assert.deepEqual(checkWorkflows(valid, "codex/us-mvp"), []);
  const unlocked = structuredClone(valid);
  unlocked["release-images.yml"].jobs.publish.if = "${{ true }}";
  assert.ok(checkWorkflows(unlocked).some((error) => error.includes("release-images.yml/publish")));
  const added = structuredClone(valid);
  added["unexpected.yml"] = { jobs: { publish: { "runs-on": "ubuntu-latest" } } };
  assert.ok(checkWorkflows(added).some((error) => error.includes("unexpected.yml/publish")));
});

for (const [label, mutate] of [
  [
    "write token",
    (workflow) => {
      workflow.permissions.contents = "write";
    },
  ],
  [
    "environment",
    (workflow) => {
      workflow.jobs.isolation.environment = "production-deploy";
    },
  ],
  [
    "secret",
    (workflow) => {
      workflow.jobs.isolation.env = { KEY: "${{ secrets.DEPLOY_KEY }}" };
    },
  ],
  [
    "delegated job",
    (workflow) => {
      workflow.jobs.isolation.uses = "./.github/workflows/deploy-production.yml";
    },
  ],
  [
    "removed checker",
    (workflow) => {
      workflow.jobs.isolation.steps = workflow.jobs.isolation.steps.filter(
        (step) => step.run !== "node tools/us-development/check-isolation.mjs",
      );
    },
  ],
  [
    "ignored checker failure",
    (workflow) => {
      workflow.jobs.isolation.steps.find(
        (step) => step.run === "node tools/us-development/check-isolation.mjs",
      )["continue-on-error"] = true;
    },
  ],
]) {
  test(`checker rejects ${label} in the development workflow`, () => {
    const changed = workflows();
    mutate(changed["us-development.yml"]);
    assert.notDeepEqual(checkWorkflows(changed), []);
  });
}
