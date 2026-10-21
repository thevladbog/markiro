import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import { assertNativeFixtureGate } from "./support/native-fixture-gate.mjs";
import {
  withoutCompleteSeedOwner,
  withoutCompleteSeedOwnerBytes,
} from "./support/complete-seed-owner.mjs";
import {
  withoutParallelSegments,
  withoutParallelSegmentsBytes,
} from "./support/parallel-segments.mjs";
import {
  withoutPreparedServicesOwner,
  withoutPreparedServicesOwnerBytes,
} from "./support/prepared-services-owner.mjs";
import {
  withoutTraceReadinessOwner,
  withoutTraceReadinessOwnerBytes,
} from "./support/trace-readiness-owner.mjs";
import {
  withoutCanonicalTestsOwner,
  withoutCanonicalTestsOwnerBytes,
} from "./support/canonical-tests-owner.mjs";
import {
  withoutSharedContractsBootstrap,
  withoutSharedContractsBootstrapBytes,
} from "./support/shared-contracts-bootstrap.mjs";
import {
  withoutNativeAssemblyOwner,
  withoutNativeAssemblyOwnerBytes,
} from "./support/native-assembly-owner.mjs";

const id = "dataset_complete_seed";
const name = "Verify complete six-month dataset owner on disposable database";
const selector = "test/us-dataset-complete-seed.e2e.test.ts";
const command =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-complete-seed.e2e.test.ts --maxWorkers=1 --reporter=verbose";
const fixture = "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
const predecessorBytes = "040dea3c96382541fab4a90d4f6b94df5c524e09adeec554f4af3f89a53ca3b9";
const predecessorHash = "db55b3c81504fccc8d1d03ad83fd3c3c1f09cf6b749205e923473f87096b7b99";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => digest(JSON.stringify(value));
const source = () => readFileSync(".github/workflows/us-development.yml", "utf8");
const workflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [file, load(readFileSync(`.github/workflows/${file}`, "utf8"))]),
  );
// This complete expectation is independent of the normalization helper.
const expected = {
  "runs-on": "ubuntu-latest",
  needs: "isolation",
  "timeout-minutes": 45,
  services: {
    "us-postgres": {
      image: "postgres:17-alpine",
      env: {
        POSTGRES_USER: "markiro_us",
        POSTGRES_PASSWORD: "markiro-us-development-only",
        POSTGRES_DB: "markiro_us_dev",
      },
      ports: ["127.0.0.1:55432:5432"],
      options:
        '--health-cmd "pg_isready -U markiro_us -d markiro_us_dev" --health-interval 5s --health-timeout 5s --health-retries 10',
    },
  },
  steps: [
    {
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: { "persist-credentials": false },
    },
    { uses: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1" },
    {
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": 24, cache: "pnpm" },
    },
    { run: "pnpm install --frozen-lockfile" },
    {
      name: "Build shared contracts for Node tooling checks",
      run: "pnpm turbo build --filter '@markiro/platform-contracts...'",
    },
    {
      name: "Reject release capabilities and merges into main",
      run: "node tools/us-development/check-isolation.mjs",
    },
    { run: "node --test tools/us-development/test/*.test.mjs" },
    {
      name: "Build isolated API dependencies and entry points",
      run: "pnpm turbo build --filter '@markiro/api...'",
    },
    {
      name: "Install PDF text extraction for US plan artifact checks",
      run: "sudo apt-get update && sudo apt-get install -y poppler-utils && pdftotext -v",
    },
    { name, env: { US_TEST_DATABASE_URL: fixture }, run: command },
  ],
};
const normalizers = [
  [withoutCompleteSeedOwner, withoutCompleteSeedOwnerBytes],
  [withoutParallelSegments, withoutParallelSegmentsBytes],
  [withoutPreparedServicesOwner, withoutPreparedServicesOwnerBytes],
  [withoutTraceReadinessOwner, withoutTraceReadinessOwnerBytes],
  [withoutCanonicalTestsOwner, withoutCanonicalTestsOwnerBytes],
  [withoutSharedContractsBootstrap, withoutSharedContractsBootstrapBytes],
  [withoutNativeAssemblyOwner, withoutNativeAssemblyOwnerBytes],
];
function assertOwner(all) {
  const workflow = all["us-development.yml"],
    job = workflow.jobs[id];
  assert.ok(job, "complete seed owner is present");
  const jobs = Object.values(all).flatMap((w) => Object.entries(w.jobs ?? {}));
  assert.equal(jobs.filter(([key]) => key === id).length, 1, "globally unique complete owner");
  const steps = jobs.flatMap(([, j]) => j.steps ?? []);
  assert.equal(
    steps.filter((s) => s.name === name).length,
    1,
    "globally unique complete owner name",
  );
  const pattern = /(?<![\w.-])us-dataset-complete-seed\.e2e\.test\.ts(?![\w/.-])/g;
  assert.equal(
    steps.flatMap((s) => [...(s.run ?? "").matchAll(pattern)]).length,
    1,
    "globally unique literal whole-file selector",
  );
  assert.deepEqual(job, expected, "exact unconditional check-only complete owner");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const key of ["if", "continue-on-error", "env", "defaults"])
    assert.equal(workflow[key], undefined, `workflow rejects ${key}`);
  assert.equal(
    hash(withoutCompleteSeedOwner(workflow)),
    predecessorHash,
    "complete predecessor unchanged",
  );
  assert.deepEqual(checkWorkflows(all, "codex/us-mvp"), []);
}
test("complete dataset has one exact check-only whole-file owner and unchanged predecessor", () => {
  assertOwner(workflows());
  assert.equal(digest(withoutCompleteSeedOwnerBytes(source())), predecessorBytes);
});
test("native complete collection uses only the isolated US fixture gate", () => {
  const text = readFileSync(`apps/api/${selector}`, "utf8");
  assertNativeFixtureGate(text, selector, fixture);
  assert.doesNotMatch(text, /\b(?:it|test|describe)\.(?:only|skip\(|todo|skipIf\(true)/);
});
test("all historical normalizers remove only the exact reviewed complete addition", () => {
  const workflow = workflows()["us-development.yml"],
    original = structuredClone(workflow);
  assert.notDeepEqual(withoutCompleteSeedOwner(workflow), workflow);
  assert.deepEqual(workflow, original);
  for (const [parsed, bytes] of normalizers) {
    const normalized = parsed(workflow),
      raw = bytes(source());
    assert.equal(normalized.jobs[id], undefined);
    assert.equal(load(raw).jobs[id], undefined);
    const changed = structuredClone(workflow);
    changed.jobs.isolation.steps[0].name = "Changed predecessor";
    assert.equal(parsed(changed).jobs.isolation.steps[0].name, "Changed predecessor");
  }
});
test("independent complete-owner mutants cannot weaken checks or hide through history", () => {
  const mutations = [
    (w) => {
      delete w.jobs[id];
    },
    (w) => {
      w.jobs[id]["timeout-minutes"] = 60;
    },
    (w) => {
      w.jobs[id].needs = [];
    },
    (w) => {
      w.jobs[id].if = "true";
    },
    (w) => {
      w.jobs[id]["continue-on-error"] = false;
    },
    (w) => {
      w.jobs[id].env = {};
    },
    (w) => {
      w.jobs[id].permissions = { contents: "write" };
    },
    (w) => {
      w.jobs[id].services["us-postgres"].image = "postgres:latest";
    },
    (w) => {
      w.jobs[id].steps[0].with["persist-credentials"] = true;
    },
    (w) => {
      w.jobs[id].steps[7].run += " || true";
    },
    (w) => {
      w.jobs[id].steps.reverse();
    },
    (w) => {
      w.jobs[id].steps.at(-1).env.US_TEST_DATABASE_URL = fixture.replace("55432", "5432");
    },
    ...[
      " || true",
      " --passWithNoTests",
      " --testNamePattern=only",
      " --exclude=**",
      " --testTimeout=1800000",
    ].map((suffix) => (w) => {
      w.jobs[id].steps.at(-1).run += suffix;
    }),
    ...["if", "continue-on-error", "shell", "defaults"].map((key) => (w) => {
      w.jobs[id].steps.at(-1)[key] = {};
    }),
  ];
  for (const mutate of mutations) {
    const all = workflows();
    mutate(all["us-development.yml"]);
    assert.throws(() => assertOwner(all));
    if (all["us-development.yml"].jobs[id])
      for (const [parsed] of normalizers)
        assert.deepEqual(
          parsed(all["us-development.yml"]).jobs[id],
          all["us-development.yml"].jobs[id],
          "malformed complete addition stays visible",
        );
  }
  for (const changed of [
    source().replace(command, command + " || true"),
    source().replace(`  ${id}:\n`, `  ${id}: # altered\n`),
    source() + "    if: true\n",
  ])
    for (const [, bytes] of normalizers)
      assert.ok(load(bytes(changed)).jobs[id], "malformed complete bytes stay visible");
});
test("global literal selector ownership rejects duplication and permits unrelated aggregate tests", () => {
  for (const run of [command, `vitest run ./${selector}`]) {
    const all = workflows();
    all.other = { jobs: { check: { steps: [{ run }] } } };
    assert.throws(() => assertOwner(all), /globally unique literal/);
  }
  for (const run of [
    "pnpm turbo test --filter=@markiro/api",
    "vitest run prefix-us-dataset-complete-seed.e2e.test.ts",
    "vitest run us-dataset-complete-seed.e2e.test.tsx",
  ]) {
    const all = workflows();
    all.other = {
      permissions: { contents: "read" },
      jobs: { check: { if: "${{ false }}", steps: [{ run }] } },
    };
    assertOwner(all);
  }
  const duplicate = workflows();
  duplicate.other = { jobs: { [id]: structuredClone(expected) } };
  assert.throws(() => assertOwner(duplicate), /globally unique complete owner/);
});
