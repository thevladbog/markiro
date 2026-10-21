import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import {
  withoutCompleteSeedOwner,
  withoutCompleteSeedOwnerBytes,
} from "./support/complete-seed-owner.mjs";
import {
  hasExactTraceReadinessOwner,
  traceReadinessCommand,
  traceReadinessFiles,
  traceReadinessFixture,
  traceReadinessJob,
  traceReadinessJobBlock,
  traceReadinessJobId,
  withoutTraceReadinessOwner,
  withoutTraceReadinessOwnerBytes,
} from "./support/trace-readiness-owner.mjs";
import {
  withoutParallelSegments,
  withoutParallelSegmentsBytes,
} from "./support/parallel-segments.mjs";

import {
  withoutPreparedServicesOwner,
  withoutPreparedServicesOwnerBytes,
} from "./support/prepared-services-owner.mjs";
import { assertNativeFixtureGate } from "./support/native-fixture-gate.mjs";

const fullSource = withoutCompleteSeedOwnerBytes(
  readFileSync(".github/workflows/us-development.yml", "utf8"),
);
const source = withoutPreparedServicesOwnerBytes(fullSource);
const workflow = load(source);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => digest(JSON.stringify(value));
const predecessorHash = "41bf8666490eecd3a5b5d41069d77e689784f3281992869804989793ffa5d756";
const predecessorBytes = "ef3c241beaf197c5432a417315fee9dd526af275f2c8583b00ccaa0a91907079";
const readWorkflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [
        name,
        withoutCompleteSeedOwner(load(readFileSync(`.github/workflows/${name}`, "utf8"))),
      ]),
  );

function assertOwnership(all) {
  const w = all["us-development.yml"];
  const job = w.jobs[traceReadinessJobId];
  assert.ok(job, "Trace/Readiness dedicated native job is present");
  const allJobs = Object.values(all).flatMap((entry) => Object.entries(entry.jobs ?? {}));
  assert.equal(
    allJobs.filter(([id]) => id === traceReadinessJobId).length,
    1,
    "globally unique native job owner",
  );
  const steps = allJobs.flatMap(([, entry]) => entry.steps ?? []);
  const ownerName = traceReadinessJob.steps.at(-1).name;
  assert.equal(
    steps.filter((step) => step.name === ownerName).length,
    1,
    "globally unique named native selection",
  );
  for (const file of traceReadinessFiles) {
    const filename = file.slice("test/".length).replaceAll(".", "\\.");
    const selector = new RegExp(`(?<![\\w.-])${filename}(?![\\w/.-])`, "g");
    assert.equal(
      steps.flatMap((step) => [...(step.run ?? "").matchAll(selector)]).length,
      1,
      `${file} has exactly one explicit native selection`,
    );
  }
  assert.deepEqual(job, traceReadinessJob, "complete unconditional failure-propagating native job");
  assert.deepEqual(
    Object.keys(withoutPreparedServicesOwner(w).jobs),
    ["isolation", traceReadinessJobId],
    "only one additive job",
  );
  assert.equal(
    hash(withoutTraceReadinessOwner(withoutPreparedServicesOwner(w))),
    predecessorHash,
    "complete 82-step predecessor workflow is unchanged",
  );
  assert.deepEqual(checkWorkflows(all, "codex/us-mvp"), [], "operational release locks preserved");
}

test("Trace global selectors remain visible inside a malformed prepared addition", () => {
  const all = readWorkflows();
  const w = all["us-development.yml"];
  const file = "test/us-dataset-trace-readiness.e2e.test.ts";
  w.jobs.dataset_prepared_services.steps.push({ run: `corepack pnpm exec vitest run ${file}` });
  assert.deepEqual(withoutPreparedServicesOwner(w), w);
  assert.throws(
    () => assertOwnership(all),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes(`${file} has exactly one explicit native selection`),
  );
});

test("terminal Shipping projection requires the exact four-suite owner and missing-suite denial", () => {
  const expectedCommand =
    "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-trace-readiness.e2e.test.ts test/us-dataset-trace-readiness-stage.e2e.test.ts test/us-dataset-trace-readiness-seed.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts --maxWorkers=1";
  const projection = "test/us-dataset-shipping-projection.e2e.test.ts";
  assert.equal(workflow.jobs[traceReadinessJobId].steps.at(-1).run, expectedCommand);
  assert.deepEqual(traceReadinessFiles, [
    "test/us-dataset-trace-readiness.e2e.test.ts",
    "test/us-dataset-trace-readiness-stage.e2e.test.ts",
    "test/us-dataset-trace-readiness-seed.e2e.test.ts",
    "test/us-dataset-shipping-projection.e2e.test.ts",
  ]);
  assert.equal(traceReadinessCommand, expectedCommand);
  const missing = readWorkflows();
  missing["us-development.yml"].jobs[traceReadinessJobId].steps.at(-1).run =
    expectedCommand.replace(` ${projection}`, "");
  assert.throws(
    () => assertOwnership(missing),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes(`${projection} has exactly one explicit native selection`),
  );
  const changed = missing["us-development.yml"];
  assert.equal(hasExactTraceReadinessOwner(changed), false);
  assert.deepEqual(withoutTraceReadinessOwner(changed), changed);
  const missingBytes = source.replace(` ${projection}`, "");
  assert.deepEqual(load(missingBytes), withoutPreparedServicesOwner(changed));
  assert.equal(withoutTraceReadinessOwnerBytes(missingBytes), missingBytes);
});

test("Trace/Readiness native suites have a dedicated serial CI job after isolation", () => {
  const job = workflow.jobs.dataset_trace_readiness;
  assert.ok(job, "Trace/Readiness dedicated native job is present");
  assert.equal(job.needs, "isolation");
  const owner = job.steps.at(-1);
  assert.equal(
    owner.run,
    "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-trace-readiness.e2e.test.ts test/us-dataset-trace-readiness-stage.e2e.test.ts test/us-dataset-trace-readiness-seed.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts --maxWorkers=1",
  );
  assertOwnership(readWorkflows());
});

for (const minutes of [30, 44, 45, 46]) {
  test(`Trace/Readiness ownership ${minutes === 45 ? "accepts" : "rejects"} a ${minutes}-minute full-suite budget`, () => {
    const all = readWorkflows();
    const changed = all["us-development.yml"];
    changed.jobs[traceReadinessJobId]["timeout-minutes"] = minutes;
    const bytes = source.replace(
      /(  dataset_trace_readiness:\n    runs-on: ubuntu-latest\n    needs: isolation\n    timeout-minutes: )\d+/,
      `$1${minutes}`,
    );
    assert.deepEqual(load(bytes), withoutPreparedServicesOwner(changed));
    if (minutes === 45) {
      assertOwnership(all);
      assert.equal(hasExactTraceReadinessOwner(changed), true);
      assert.equal(
        digest(withoutTraceReadinessOwnerBytes(bytes)),
        predecessorBytes,
        "only the reviewed 45-minute block restores the strict predecessor bytes",
      );
    } else {
      assert.throws(
        () => assertOwnership(all),
        /complete unconditional failure-propagating native job/,
      );
      assert.equal(hasExactTraceReadinessOwner(changed), false);
      assert.deepEqual(withoutTraceReadinessOwner(changed), changed);
      assert.equal(withoutTraceReadinessOwnerBytes(bytes), bytes);
    }
  });
}

test("the expanded Trace budget cannot hide other-job limits or native selection filters", () => {
  for (const id of ["isolation", "dataset_prepared_services"]) {
    const all = readWorkflows();
    const changed = all["us-development.yml"];
    changed.jobs[traceReadinessJobId]["timeout-minutes"] = 45;
    changed.jobs[id]["timeout-minutes"] = 45;
    assert.throws(
      () => assertOwnership(all),
      /predecessor workflow is unchanged|only one additive job/,
    );
    assert.equal(withoutTraceReadinessOwner(changed).jobs[id]["timeout-minutes"], 45);
    assert.notEqual(
      hash(withoutParallelSegments(changed)),
      "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5",
    );
  }
  const all = readWorkflows();
  const changed = all["us-development.yml"];
  changed.jobs[traceReadinessJobId]["timeout-minutes"] = 45;
  changed.jobs[traceReadinessJobId].steps.at(-1).run += " --testNamePattern=small";
  assert.throws(
    () => assertOwnership(all),
    /complete unconditional failure-propagating native job/,
  );
  assert.equal(hasExactTraceReadinessOwner(changed), false);
  assert.deepEqual(withoutTraceReadinessOwner(changed), changed);
});

test("successful contracts build precedes every Node tool and API build precedes native execution", () => {
  const job = workflow.jobs[traceReadinessJobId];
  const steps = job.steps;
  assert.equal(steps[4].run, "pnpm turbo build --filter '@markiro/platform-contracts...'");
  assert.deepEqual(
    steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.run?.startsWith("node "))
      .map(({ index }) => index),
    [5, 6],
  );
  assert.equal(steps[7].run, "pnpm turbo build --filter '@markiro/api...'");
  assert.equal(steps[8].run, traceReadinessCommand);
  assert.deepEqual(steps[8].env, { US_TEST_DATABASE_URL: traceReadinessFixture });
  assert.deepEqual(job.services, workflow.jobs.isolation.services);
  assertOwnership(readWorkflows());
});

test("exact additive removal restores original 82-step bytes and AST without changing historical pins", () => {
  assert.ok(hasExactTraceReadinessOwner(workflow));
  const original = structuredClone(workflow);
  const predecessor = withoutTraceReadinessOwner(workflow);
  const bytes = withoutTraceReadinessOwnerBytes(source);
  assert.deepEqual(workflow, original, "normalization never changes its input");
  assert.equal(Buffer.byteLength(bytes), 37931);
  assert.equal(digest(bytes), predecessorBytes, "complete predecessor bytes unchanged");
  assert.equal(hash(predecessor), predecessorHash);
  assert.deepEqual(load(bytes), predecessor);
  assert.equal(predecessor.jobs.isolation.steps.length, 82);
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
  for (const file of traceReadinessFiles) {
    const path = `apps/api/${file}`;
    assertNativeFixtureGate(readFileSync(path, "utf8"), file, traceReadinessFixture);
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
  const prior = "complete 82-step predecessor workflow is unchanged";
  const mutations = [
    [
      "missing job",
      ({ w }) => delete w.jobs[traceReadinessJobId],
      "dedicated native job is present",
    ],
    [
      "renamed job",
      ({ w, j }) => {
        delete w.jobs[traceReadinessJobId];
        w.jobs.other = j;
      },
      "dedicated native job is present",
    ],
    [
      "foreign job",
      ({ all, j }) => {
        all.other = { jobs: { [traceReadinessJobId]: j } };
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
      "only one additive job",
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
  for (const [index, step] of traceReadinessJob.steps.entries()) {
    mutations.push(
      [
        `step ${index} omitted`,
        ({ j }) => j.steps.splice(index, 1),
        index === 8 ? "globally unique named native selection" : exact,
      ],
      [
        `step ${index} duplicate`,
        ({ j }) => j.steps.push(structuredClone(step)),
        index === 8 ? "globally unique named native selection" : exact,
      ],
    );
    if (index < 8)
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
      ["env", { DATABASE_URL: traceReadinessFixture }],
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
      ["env", { US_TEST_DATABASE_URL: traceReadinessFixture }],
      ["env", { DATABASE_URL: traceReadinessFixture }],
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
  for (const file of traceReadinessFiles) {
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
    `echo '${traceReadinessCommand}'`,
    `# ${traceReadinessCommand}`,
    `if false; then ${traceReadinessCommand}; fi`,
    `${traceReadinessCommand}; exit 0`,
    `set +e\n${traceReadinessCommand}`,
    `${traceReadinessCommand} | cat`,
    `${traceReadinessCommand} &`,
    `${traceReadinessCommand} --testNamePattern=small`,
    `${traceReadinessCommand} --retry=1`,
    `${traceReadinessCommand} --testTimeout=1800000`,
    `${traceReadinessCommand} --passWithNoTests`,
    `${traceReadinessCommand} >/dev/null 2>&1`,
    traceReadinessCommand.replace("--maxWorkers=1", "--maxWorkers=2"),
    traceReadinessCommand.replace(" --maxWorkers=1", ""),
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
    const j = w.jobs[traceReadinessJobId];
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
    mutate(changed.jobs[traceReadinessJobId]);
    assert.equal(hasExactTraceReadinessOwner(changed), false);
    assert.deepEqual(withoutTraceReadinessOwner(changed), changed);
    assert.deepEqual(
      withoutParallelSegments(changed).jobs[traceReadinessJobId],
      changed.jobs[traceReadinessJobId],
    );
    assert.notEqual(
      hash(withoutParallelSegments(changed)),
      "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5",
    );
  }
  for (const changed of [
    source.replace("    needs: isolation", "    needs: other"),
    source.replace(traceReadinessCommand, `${traceReadinessCommand} || true`),
    source.replace(traceReadinessJobBlock, `${traceReadinessJobBlock}    if: false\n`),
    source.replace(traceReadinessJobBlock, traceReadinessJobBlock.replace("# v4", "# changed")),
    source + "\n",
    source + "# changed\n",
  ]) {
    assert.equal(
      withoutTraceReadinessOwnerBytes(changed),
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
      digest(withoutTraceReadinessOwnerBytes(changed)),
      predecessorBytes,
      "prior byte tamper remains observable",
    );
  assert.throws(
    () => load(source + traceReadinessJobBlock),
    /duplicated mapping key/,
    "duplicate raw job keys are rejected",
  );
  assert.equal(
    withoutTraceReadinessOwnerBytes(source.replace(traceReadinessJobBlock, "")),
    source.replace(traceReadinessJobBlock, ""),
  );
  const missing = structuredClone(workflow);
  delete missing.jobs[traceReadinessJobId];
  assert.deepEqual(withoutTraceReadinessOwner(missing), missing);
});
