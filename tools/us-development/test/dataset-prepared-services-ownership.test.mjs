import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import {
  hasExactPreparedServicesOwner,
  preparedServicesCommand,
  preparedServicesFiles,
  preparedServicesFixture,
  preparedServicesJob,
  preparedServicesJobBlock,
  preparedServicesJobId,
  withoutPreparedServicesOwner,
  withoutPreparedServicesOwnerBytes,
} from "./support/prepared-services-owner.mjs";
import {
  withoutParallelSegments,
  withoutParallelSegmentsBytes,
} from "./support/parallel-segments.mjs";

import { assertNativeFixtureGate } from "./support/native-fixture-gate.mjs";
import {
  withoutTraceReadinessOwner,
  withoutTraceReadinessOwnerBytes,
} from "./support/trace-readiness-owner.mjs";

// Independent literals keep helper/workflow changes from redefining ownership.
const expectedFiles = [
  "test/us-plan-draft-transaction.e2e.test.ts",
  "test/us-dataset-prepared-intent.e2e.test.ts",
  "test/us-dataset-plan-seed.e2e.test.ts",
  "test/us-request-create-transaction.e2e.test.ts",
];
const expectedFixture =
  "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
const expectedCommand =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts --maxWorkers=1";
const expectedJob = load(`jobs:
  dataset_prepared_services:
    runs-on: ubuntu-latest
    needs: isolation
    timeout-minutes: 30
    services:
      us-postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: markiro_us
          POSTGRES_PASSWORD: markiro-us-development-only
          POSTGRES_DB: markiro_us_dev
        ports:
          - 127.0.0.1:55432:5432
        options: >-
          --health-cmd "pg_isready -U markiro_us -d markiro_us_dev"
          --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Build shared contracts for Node tooling checks
        run: pnpm turbo build --filter '@markiro/platform-contracts...'
      - name: Reject release capabilities and merges into main
        run: node tools/us-development/check-isolation.mjs
      - run: node --test tools/us-development/test/*.test.mjs
      - name: Build isolated API dependencies and entry points
        run: pnpm turbo build --filter '@markiro/api...'
      - name: Install PDF text extraction for US plan artifact checks
        run: sudo apt-get update && sudo apt-get install -y poppler-utils && pdftotext -v
      - name: Verify prepared Plan, dataset intent, Plan seed and Request creation transactions
        env:
          US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
        run: corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts --maxWorkers=1
`).jobs.dataset_prepared_services;

const source = readFileSync(".github/workflows/us-development.yml", "utf8");
const workflow = load(source);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => digest(JSON.stringify(value));
const predecessorHash = "3d8d2826c2f6ddf636bca73af2e55d2af8225147d25bea03e16599bcae50ae74";
const predecessorBytes = "954bc1707b8f9c66e857b9fdfc4837845d77b0ff96cf43eecdbedaf48c8ee2c8";
const readWorkflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, load(readFileSync(`.github/workflows/${name}`, "utf8"))]),
  );

function assertOwnership(all) {
  const w = all["us-development.yml"];
  const job = w.jobs[preparedServicesJobId];
  assert.ok(job, "prepared services dedicated native job is present");
  const allJobs = Object.values(all).flatMap((entry) => Object.entries(entry.jobs ?? {}));
  assert.equal(
    allJobs.filter(([id]) => id === preparedServicesJobId).length,
    1,
    "globally unique native job owner",
  );
  const steps = allJobs.flatMap(([, entry]) => entry.steps ?? []);
  const ownerName = expectedJob.steps.at(-1).name;
  assert.equal(
    steps.filter((step) => step.name === ownerName).length,
    1,
    "globally unique named native selection",
  );
  for (const file of expectedFiles) {
    const filename = file.slice("test/".length).replaceAll(".", "\\.");
    const selector = new RegExp(`(?<![\\w.-])${filename}(?![\\w/.-])`, "g");
    assert.equal(
      steps.flatMap((step) => [...(step.run ?? "").matchAll(selector)]).length,
      1,
      `${file} has exactly one explicit native selection`,
    );
  }
  assert.deepEqual(job, expectedJob, "complete unconditional failure-propagating native job");
  assert.deepEqual(
    Object.keys(w.jobs),
    ["isolation", "dataset_trace_readiness", preparedServicesJobId],
    "only the reviewed additive job",
  );
  assert.equal(
    hash(withoutPreparedServicesOwner(w)),
    predecessorHash,
    "complete matrix and Trace predecessor workflow is unchanged",
  );
  assert.deepEqual(checkWorkflows(all, "codex/us-mvp"), [], "operational release locks preserved");
}

test("prepared services have an explicit native owner", () => {
  assert.deepEqual(preparedServicesFiles, expectedFiles);
  assert.equal(preparedServicesCommand, expectedCommand);
  assert.equal(preparedServicesFixture, expectedFixture);
  assert.deepEqual(preparedServicesJob, expectedJob);
  const job = workflow.jobs.dataset_prepared_services;
  assert.ok(job, "prepared services dedicated native job is present");
  assert.equal(job.needs, "isolation");
  const owner = job.steps.at(-1);
  assert.equal(
    owner.run,
    "corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts --maxWorkers=1",
  );
  assertOwnership(readWorkflows());
});

test("successful contracts build precedes every Node tool and API build precedes native execution", () => {
  const job = workflow.jobs[preparedServicesJobId];
  const steps = job.steps;
  assert.deepEqual(job, expectedJob);
  assert.equal(steps[4].run, "pnpm turbo build --filter '@markiro/platform-contracts...'");
  assert.deepEqual(
    steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.run?.startsWith("node "))
      .map(({ index }) => index),
    [5, 6],
  );
  assert.equal(steps[7].run, "pnpm turbo build --filter '@markiro/api...'");
  assert.equal(
    steps[8].run,
    "sudo apt-get update && sudo apt-get install -y poppler-utils && pdftotext -v",
  );
  assert.equal(steps[9].run, expectedCommand);
  assert.deepEqual(steps[9].env, { US_TEST_DATABASE_URL: expectedFixture });
  assert.deepEqual(job.services, workflow.jobs.isolation.services);
  assertOwnership(readWorkflows());
});

test("exact additive removal restores the matrix and Trace bytes and AST without changing pins", () => {
  assert.ok(hasExactPreparedServicesOwner(workflow));
  const original = structuredClone(workflow);
  const predecessor = withoutPreparedServicesOwner(workflow);
  const bytes = withoutPreparedServicesOwnerBytes(source);
  assert.deepEqual(workflow, original, "normalization never changes its input");
  assert.equal(Buffer.byteLength(bytes), 39780);
  assert.equal(digest(bytes), predecessorBytes, "complete predecessor bytes unchanged");
  assert.equal(hash(predecessor), predecessorHash);
  assert.deepEqual(load(bytes), predecessor);
  assert.equal(predecessor.jobs.isolation.steps.length, 82);
  assert.deepEqual(Object.keys(predecessor.jobs), ["isolation", "dataset_trace_readiness"]);
  assert.equal(
    hash(withoutParallelSegments(workflow)),
    "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5",
  );
  assert.equal(
    digest(withoutParallelSegmentsBytes(source)),
    "41011c2455d1274a65fa829dee0cd8b57f544d04436f3f481570433ab0d68d1a",
  );
});

test("native gates skip aggregate collection without the dedicated isolated fixture", () => {
  for (const file of expectedFiles) {
    const path = `apps/api/${file}`;
    assertNativeFixtureGate(readFileSync(path, "utf8"), file, expectedFixture);
  }
  assert.equal(
    JSON.parse(readFileSync("apps/api/package.json", "utf8")).scripts.test,
    "vitest run",
  );
  const ci = readWorkflows()["ci.yml"];
  const aggregate =
    "pnpm turbo test --filter=@markiro/db --filter=@markiro/api --concurrency=1 --force";
  const jobs = Object.values(ci.jobs).filter((job) =>
    job.steps?.some((step) => step.run === aggregate),
  );
  assert.equal(jobs.length, 1);
  for (const scope of [ci, jobs[0], ...jobs[0].steps])
    assert.equal(scope.env?.US_TEST_DATABASE_URL, undefined);
});

test("complete ownership rejects missing, wrong, duplicate, foreign and bypassed owners", (t) => {
  const exact = "complete unconditional failure-propagating native job";
  const prior = "complete matrix and Trace predecessor workflow is unchanged";
  const mutations = [
    [
      "missing job",
      ({ w }) => delete w.jobs[preparedServicesJobId],
      "dedicated native job is present",
    ],
    [
      "renamed job",
      ({ w, j }) => {
        delete w.jobs[preparedServicesJobId];
        w.jobs.other = j;
      },
      "dedicated native job is present",
    ],
    [
      "foreign job",
      ({ all, j }) => {
        all.other = { jobs: { [preparedServicesJobId]: j } };
      },
      "globally unique native job owner",
    ],
    [
      "duplicate renamed job",
      ({ w, j }) => {
        w.jobs.other = structuredClone(j);
      },
      "globally unique named native selection",
    ],
    [
      "foreign named step",
      ({ all, o }) => {
        all.other = { jobs: { other: { steps: [structuredClone(o)] } } };
      },
      "globally unique named native selection",
    ],
    ["missing needs", ({ j }) => delete j.needs, exact],
    [
      "wrong needs",
      ({ j }) => {
        j.needs = "other";
      },
      exact,
    ],
    [
      "always after failed isolation",
      ({ j }) => {
        j.if = "${{ always() }}";
      },
      exact,
    ],
    [
      "different budget",
      ({ j }) => {
        j["timeout-minutes"] = 31;
      },
      exact,
    ],
    [
      "different runner",
      ({ j }) => {
        j["runs-on"] = "self-hosted";
      },
      exact,
    ],
    [
      "wrong image",
      ({ j }) => {
        j.services["us-postgres"].image = "postgres:latest";
      },
      exact,
    ],
    [
      "non-loopback port",
      ({ j }) => {
        j.services["us-postgres"].ports = ["55432:5432"];
      },
      exact,
    ],
    ["service omitted", ({ j }) => delete j.services, exact],
    [
      "service credentials changed",
      ({ j }) => {
        j.services["us-postgres"].env.POSTGRES_USER = "other";
      },
      exact,
    ],
    [
      "service health changed",
      ({ j }) => {
        j.services["us-postgres"].options += " --health-retries 0";
      },
      exact,
    ],
    [
      "extra job",
      ({ w }) => {
        w.jobs.other = { steps: [] };
      },
      "only the reviewed additive job",
    ],
    [
      "prior step changed",
      ({ w }) => {
        w.jobs.isolation.steps[3].run += " || true";
      },
      prior,
    ],
    ["prior step omitted", ({ w }) => w.jobs.isolation.steps.splice(0, 1), prior],
    ["prior segment changed", ({ w }) => w.jobs.isolation.strategy.matrix.segment.pop(), prior],
    [
      "prior max parallel changed",
      ({ w }) => {
        w.jobs.isolation.strategy["max-parallel"] = 4;
      },
      prior,
    ],
    [
      "prior Trace native selection changed",
      ({ w }) => {
        w.jobs.dataset_trace_readiness.steps.at(-1).run += " || true";
      },
      prior,
    ],
    [
      "prior Trace fixture changed",
      ({ w }) => {
        w.jobs.dataset_trace_readiness.steps.at(-1).env.US_TEST_DATABASE_URL =
          "postgres://wrong/other";
      },
      prior,
    ],
    [
      "contracts build moved after Node tooling",
      ({ j }) => {
        [j.steps[4], j.steps[6]] = [j.steps[6], j.steps[4]];
      },
      exact,
    ],
    [
      "API build moved after native suites",
      ({ j }) => {
        [j.steps[7], j.steps[9]] = [j.steps[9], j.steps[7]];
      },
      exact,
    ],
    [
      "PDF extractor moved after native suites",
      ({ j }) => {
        [j.steps[8], j.steps[9]] = [j.steps[9], j.steps[8]];
      },
      exact,
    ],
    [
      "prior budget changed",
      ({ w }) => {
        w.jobs.isolation["timeout-minutes"] = 31;
      },
      prior,
    ],
    [
      "prior action changed",
      ({ w }) => {
        w.jobs.isolation.steps[0].uses += "bad";
      },
      prior,
    ],
    [
      "prior guard changed",
      ({ w }) => {
        w.jobs.isolation.steps[12].if = "false";
      },
      prior,
    ],
    ["prior guard omitted", ({ w }) => delete w.jobs.isolation.steps[12].if, prior],
    [
      "workflow write permission",
      ({ w }) => {
        w.permissions.contents = "write";
      },
      prior,
    ],
    [
      "workflow changed trigger",
      ({ w }) => {
        w.on.push.branches = ["main"];
      },
      prior,
    ],
    [
      "release unlocked",
      ({ all }) => {
        all["release-images.yml"].jobs.publish.if = "${{ true }}";
      },
      "operational release locks preserved",
    ],
  ];
  for (const [index, step] of expectedJob.steps.entries()) {
    mutations.push(
      [
        `step ${index} omitted`,
        ({ j }) => j.steps.splice(index, 1),
        index === 9 ? "globally unique named native selection" : exact,
      ],
      [
        `step ${index} duplicate`,
        ({ j }) => j.steps.push(structuredClone(step)),
        index === 9 ? "globally unique named native selection" : exact,
      ],
    );
    if (index < 9)
      mutations.push([
        `step ${index} late`,
        ({ j }) => j.steps.push(j.steps.splice(index, 1)[0]),
        exact,
      ]);
    for (const [key, value] of [
      ["if", "false"],
      ["continue-on-error", true],
      ["shell", "bash {0}"],
      ["timeout-minutes", 1],
      ["env", { DATABASE_URL: preparedServicesFixture }],
      ["env", { US_TEST_DATABASE_URL: "postgres://wrong/other" }],
    ])
      mutations.push([
        `step ${index} ${key}`,
        ({ j }) => {
          j.steps[index][key] = value;
        },
        exact,
      ]);
    if (step.uses)
      mutations.push([
        `step ${index} wrong action`,
        ({ j }) => {
          j.steps[index].uses += "bad";
        },
        exact,
      ]);
    if (step.run)
      mutations.push([
        `step ${index} ignores failure`,
        ({ j }) => {
          j.steps[index].run += " || true";
        },
        exact,
      ]);
  }
  for (const scope of ["workflow", "job"]) {
    for (const [key, value] of [
      ["env", { US_TEST_DATABASE_URL: preparedServicesFixture }],
      ["env", { DATABASE_URL: preparedServicesFixture }],
      ["if", "false"],
      ["continue-on-error", true],
      ["defaults", { run: { shell: "bash {0}" } }],
      ["permissions", { contents: "write" }],
      ["environment", "production"],
      ["secrets", "inherit"],
    ])
      mutations.push([
        `${scope} ${key}`,
        ({ w, j }) => {
          (scope === "workflow" ? w : j)[key] = value;
        },
        scope === "workflow" ? prior : exact,
      ]);
  }
  for (const file of expectedFiles) {
    const once = `${file} has exactly one explicit native selection`;
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
    const filename = file.slice("test/".length);
    for (const alias of [
      filename,
      `"${file}"`,
      `'${file}'`,
      `./${file}`,
      `apps/api/${file}`,
      `"./apps/api/${file}"`,
    ]) {
      for (const foreign of [false, true])
        mutations.push([
          `${foreign ? "foreign" : "local"} duplicate ${alias}`,
          ({ all, w }) => {
            const job = { steps: [{ run: `corepack pnpm exec vitest run ${alias}` }] };
            if (foreign) all.other = { jobs: { other: job } };
            else w.jobs.other = job;
          },
          once,
        ]);
    }
  }
  for (const run of [
    `echo '${preparedServicesCommand}'`,
    `# ${preparedServicesCommand}`,
    `if false; then ${preparedServicesCommand}; fi`,
    `${preparedServicesCommand}; exit 0`,
    `set +e\n${preparedServicesCommand}`,
    `${preparedServicesCommand} | cat`,
    `${preparedServicesCommand} &`,
    `${preparedServicesCommand} --testNamePattern=small`,
    `${preparedServicesCommand} --retry=1`,
    `${preparedServicesCommand} --testTimeout=1800000`,
    `${preparedServicesCommand} --passWithNoTests`,
    `${preparedServicesCommand} >/dev/null 2>&1`,
    preparedServicesCommand.replace("--maxWorkers=1", "--maxWorkers=2"),
    preparedServicesCommand.replace(" --maxWorkers=1", ""),
  ])
    mutations.push([
      run,
      ({ o }) => {
        o.run = run;
      },
      exact,
    ]);
  for (const [label, mutate, message] of mutations) {
    const all = readWorkflows();
    const w = all["us-development.yml"];
    const j = w.jobs[preparedServicesJobId];
    const o = j.steps.at(-1);
    mutate({ all, w, j, o });
    assert.throws(
      () => assertOwnership(all),
      (error) => error instanceof assert.AssertionError && error.message.includes(message),
      `${label}: ${message}`,
    );
  }
  t.diagnostic(
    `${mutations.length} fresh parsed ownership mutations rejected at intended assertions`,
  );
});

test("historical normalization leaves malformed jobs and AST-neutral byte tampering observable", () => {
  for (const mutate of [
    (j) => {
      j.needs = "other";
    },
    (j) => {
      j["timeout-minutes"] = 31;
    },
    (j) => {
      j.steps.at(-1).run += " || true";
    },
    (j) => {
      j.env = {};
    },
    (j) => {
      j.steps[0].uses += "bad";
    },
    (j) => {
      j.steps[4].if = "false";
    },
    (j) => {
      j.steps[4].env = {};
    },
    (j) => {
      j.steps.at(-1).env = {};
    },
    (j) => j.steps.push({ run: "echo bypass" }),
  ]) {
    const changed = structuredClone(workflow);
    mutate(changed.jobs[preparedServicesJobId]);
    assert.equal(hasExactPreparedServicesOwner(changed), false);
    assert.deepEqual(withoutPreparedServicesOwner(changed), changed);
    assert.deepEqual(
      withoutParallelSegments(changed).jobs[preparedServicesJobId],
      changed.jobs[preparedServicesJobId],
    );
    assert.notEqual(
      hash(withoutParallelSegments(changed)),
      "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5",
    );
  }
  for (const changed of [
    source.replace(
      preparedServicesJobBlock,
      preparedServicesJobBlock.replace("    needs: isolation", "    needs: other"),
    ),
    source.replace(preparedServicesCommand, `${preparedServicesCommand} || true`),
    source.replace(preparedServicesJobBlock, `${preparedServicesJobBlock}    if: false\n`),
    source.replace(preparedServicesJobBlock, preparedServicesJobBlock.replace("# v4", "# changed")),
    source + "\n",
    source + "# changed\n",
  ]) {
    assert.equal(
      withoutPreparedServicesOwnerBytes(changed),
      changed,
      "only exact complete raw block is removable",
    );
    assert.notEqual(
      digest(withoutParallelSegmentsBytes(changed)),
      "41011c2455d1274a65fa829dee0cd8b57f544d04436f3f481570433ab0d68d1a",
    );
  }
  for (const changed of [
    source.replace("# v4", "# prior action comment changed"),
    source.replace("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile || true"),
  ])
    assert.notEqual(
      digest(withoutPreparedServicesOwnerBytes(changed)),
      predecessorBytes,
      "prior byte tamper remains observable",
    );
  assert.throws(
    () => load(source + preparedServicesJobBlock),
    /duplicated mapping key/,
    "duplicate raw job keys are rejected",
  );
  assert.equal(
    withoutPreparedServicesOwnerBytes(source.replace(preparedServicesJobBlock, "")),
    source.replace(preparedServicesJobBlock, ""),
  );
  const missing = structuredClone(workflow);
  delete missing.jobs[preparedServicesJobId];
  assert.deepEqual(withoutPreparedServicesOwner(missing), missing);
});

test("malformed prepared additions survive Trace and parallel historical normalization", (t) => {
  const historicalHash = "41bf8666490eecd3a5b5d41069d77e689784f3281992869804989793ffa5d756";
  const historicalBytes = "ef3c241beaf197c5432a417315fee9dd526af275f2c8583b00ccaa0a91907079";
  const assertHistorical = (w) => {
    const historical = withoutPreparedServicesOwner(w);
    assert.deepEqual(
      Object.keys(historical.jobs),
      ["isolation", "dataset_trace_readiness"],
      "historical Trace view permits only the exact prepared addition",
    );
    assert.equal(hash(withoutTraceReadinessOwner(historical)), historicalHash);
  };
  assertHistorical(workflow);
  const malformed = source.replace(
    preparedServicesJobBlock,
    preparedServicesJobBlock.replace("    needs: isolation", "    needs: other"),
  );
  const parsed = load(malformed);
  const normalized = withoutPreparedServicesOwner(parsed);
  assert.deepEqual(normalized, parsed, "malformed parsed prepared addition is retained");
  assert.deepEqual(
    withoutTraceReadinessOwner(normalized).jobs.dataset_prepared_services,
    parsed.jobs.dataset_prepared_services,
  );
  assert.deepEqual(
    withoutParallelSegments(parsed).jobs.dataset_prepared_services,
    parsed.jobs.dataset_prepared_services,
  );
  assert.throws(
    () => assertHistorical(parsed),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("historical Trace view permits only the exact prepared addition"),
  );
  assert.throws(
    () => assertOwnership({ ...readWorkflows(), "us-development.yml": parsed }),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("complete unconditional failure-propagating native job"),
  );
  assert.equal(withoutPreparedServicesOwnerBytes(malformed), malformed);
  assert.equal(
    withoutTraceReadinessOwnerBytes(withoutPreparedServicesOwnerBytes(malformed)),
    malformed,
    "Trace EOF removal cannot conceal a retained malformed prepared block",
  );
  assert.notEqual(
    digest(withoutParallelSegmentsBytes(malformed)),
    "41011c2455d1274a65fa829dee0cd8b57f544d04436f3f481570433ab0d68d1a",
  );
  for (const changed of [
    source.replace("# v4", "# matrix comment altered"),
    source.replace("  dataset_trace_readiness:\n", "  dataset_trace_readiness: # altered\n"),
  ]) {
    assert.deepEqual(load(changed), workflow, "byte mutants preserve the parsed workflow");
    assert.notEqual(
      digest(withoutPreparedServicesOwnerBytes(changed)),
      predecessorBytes,
      "complete pre-task raw pin rejects matrix and Trace byte drift",
    );
    assert.notEqual(
      digest(withoutTraceReadinessOwnerBytes(withoutPreparedServicesOwnerBytes(changed))),
      historicalBytes,
      "unchanged historical raw pin rejects byte drift",
    );
  }
  t.diagnostic(
    "1 malformed addition rejected by both owners; 2 AST-neutral predecessor byte mutants rejected",
  );
});

test("every native fixture gate denies environment substitution, mutable and shadowed aliases", (t) => {
  let count = 0;
  for (const file of expectedFiles) {
    const text = readFileSync(`apps/api/${file}`, "utf8");
    const alias = file.includes("request-create") ? "url" : "base";
    const binding = `const ${alias} = process.env.US_TEST_DATABASE_URL;`;
    assert.ok(text.includes(binding), `${file} fixture mutation anchor exists`);
    const check = (value) => assertNativeFixtureGate(value, file, expectedFixture);
    check(text);
    check(text.replace(`!${alias})`, "!process.env.US_TEST_DATABASE_URL)"));
    const unique = "fixture binding is unique without shadows";
    const immutable = "fixture binding is a top-level const";
    const exact = "fixture is exactly US_TEST_DATABASE_URL";
    const mutations = [
      [text.replace(binding, binding.replace("US_TEST_DATABASE_URL", "DATABASE_URL")), exact],
      [text.replace(binding, binding.replace("const", "let")), immutable],
      [text.replace(binding, binding.replace("const", "var")), immutable],
      [text.replace(binding, `{ ${binding} }`), immutable],
      [text.replace(binding, ""), unique],
      [text + `\n${binding}\n`, unique],
      [text + `\nfunction shadow() { ${binding} }\n`, unique],
      [text + `\nfunction shadow(${alias}) {}\n`, unique],
      [text + `\nfunction shadow({ ${alias} }) {}\n`, unique],
      [text + `\nconst { fixture: ${alias} } = {};\n`, unique],
      [text + `\nconst [${alias}] = [];\n`, unique],
      [text + `\ntry {} catch (${alias}) {}\n`, unique],
      [text + `\nconst shadow = (${alias}) => {};\n`, unique],
      [text + `\nfunction ${alias}() {}\n`, unique],
      [text + `\nclass ${alias} {}\n`, unique],
      [text + `\nimport { fixture as ${alias} } from "fixture";\n`, unique],
      [
        text.replace(binding, `const ${alias} = process.env.US_TEST_DATABASE_URL || "fallback";`),
        exact,
      ],
      [text.replace(`!${alias})`, `!!${alias})`), exact],
      [text.replace(`!${alias})`, `${alias})`), "negates the native fixture"],
      [
        text.replace("describe.skipIf", "if (false) describe.skipIf"),
        "fixture gate owns a top-level suite",
      ],
      [text.replace(`!${alias})`, `!${alias}, true)`), "has one fixture predicate"],
      [text + `\ndescribe.skipIf(!${alias})("extra", () => {});\n`, "has one native fixture gate"],
      [text + "\nfunction shadow(process) {}\n", "process is not shadowed"],
      [text.replace(`!${alias})`, "!process.env.DATABASE_URL)"), exact],
    ];
    for (const [mutant, reason] of mutations) {
      assert.throws(
        () => check(mutant),
        (error) =>
          error instanceof assert.AssertionError && error.message.includes(`${file} ${reason}`),
        `${file}: ${reason}`,
      );
      count++;
    }
  }
  t.diagnostic(
    `${count} gate source mutations rejected at intended assertions across all four suites`,
  );
});
