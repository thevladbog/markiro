import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import {
  withoutParallelSegments,
  withoutParallelSegmentsBytes,
} from "./support/parallel-segments.mjs";

// Independent literals: neither helper exports nor workflow content define acceptance.
const name = "Verify pure six-month recipe and compiled timezone identity";
const files = [
  "test/us-six-month-references.test.ts",
  "test/us-six-month-chains.test.ts",
  "test/us-six-month-definition.test.ts",
  "test/us-dataset-native-digest-routing.test.ts",
  "test/us-demo-canonical.test.ts",
  "test/us-demo-canonical-ascii.test.ts",
];
const command =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-references.test.ts test/us-six-month-chains.test.ts test/us-six-month-definition.test.ts test/us-dataset-native-digest-routing.test.ts test/us-demo-canonical.test.ts test/us-demo-canonical-ascii.test.ts --maxWorkers=1";
const previousCommand =
  "corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-references.test.ts test/us-six-month-chains.test.ts test/us-six-month-definition.test.ts --maxWorkers=1";
const owner = { name, if: "matrix.segment == 'office'", run: command };
const source = readFileSync(".github/workflows/us-development.yml", "utf8");
const candidateSource = source.replace(previousCommand, command);
const candidate = load(candidateSource);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const predecessorHash = "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5";
const predecessorBytes = "41011c2455d1274a65fa829dee0cd8b57f544d04436f3f481570433ab0d68d1a";
const readWorkflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((entry) => /\.ya?ml$/.test(entry))
      .map((entry) => [entry, load(readFileSync(`.github/workflows/${entry}`, "utf8"))]),
  );

function assertOwnership(all) {
  const workflow = all["us-development.yml"];
  assert.deepEqual(workflow.jobs.isolation.steps[22], owner);
  const steps = Object.values(all).flatMap((w) =>
    Object.values(w.jobs ?? {}).flatMap((job) => job.steps ?? []),
  );
  assert.equal(steps.filter((step) => step.name === name).length, 1);
  for (const file of files) {
    const basename = file.slice(5).replaceAll(".", "\\.");
    const selector = new RegExp(`(?<![\\w.-])${basename}(?![\\w/.-])`, "g");
    assert.equal(
      steps.flatMap((step) => [...(step.run ?? "").matchAll(selector)]).length,
      1,
      `${file} has exactly one explicit selection`,
    );
  }
  assert.equal(digest(JSON.stringify(withoutParallelSegments(workflow))), predecessorHash);
}

test("office owns all original recipe tests plus native digest routing and canonical parity once", () => {
  assertOwnership(readWorkflows());
});

test("only the exact canonical selection restores every historical command and byte pin", () => {
  const before = structuredClone(candidate);
  const normalized = withoutParallelSegments(candidate);
  assert.equal(digest(JSON.stringify(normalized)), predecessorHash);
  const bytes = withoutParallelSegmentsBytes(candidateSource);
  assert.equal(digest(bytes), predecessorBytes);
  assert.deepEqual(load(bytes), normalized);
  assert.deepEqual(candidate, before);
});

test("malformed selection, ownership or failure handling cannot normalize the canonical addition", () => {
  const mutations = [
    ...files.map((file) => (w) => {
      w.jobs.isolation.steps[22].run = command.replace(`${file} `, "");
    }),
    ...[
      command + " || true",
      command + " --passWithNoTests",
      command + " --testNamePattern=only",
      command.replace(files[3], `${files[3]} ${files[3]}`),
      command.replace(files[3], "test/us-*.test.ts"),
      command.replace(`${files[3]} ${files[4]}`, `${files[4]} ${files[3]}`),
    ].map((run) => (w) => Object.assign(w.jobs.isolation.steps[22], { run })),
    ...[
      { if: "false" },
      { if: "matrix.segment == 'browser'" },
      { "continue-on-error": true },
      { "timeout-minutes": 60 },
    ].map((properties) => (w) => Object.assign(w.jobs.isolation.steps[22], properties)),
    (w) => {
      delete w.jobs.isolation.steps[22].if;
    },
    ...[{ if: "false" }, { "continue-on-error": true }, { "timeout-minutes": 60 }].map(
      (properties) => (w) => Object.assign(w.jobs.isolation, properties),
    ),
    (w) => {
      w.jobs.isolation.strategy.matrix.exclude = [{ segment: "office" }];
    },
    (w) => {
      w.jobs.isolation.steps[23].run += ` ${files[3]}`;
    },
    (w) => {
      w.jobs.dataset_prepared_services.steps[9].run += ` ${files[4]}`;
    },
    (w) => w.jobs.isolation.steps.push(structuredClone(owner)),
    (w) =>
      w.jobs.isolation.steps.splice(22, 2, w.jobs.isolation.steps[23], w.jobs.isolation.steps[22]),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() => assertOwnership({ "us-development.yml": changed }));
    const normalized = withoutParallelSegments(changed);
    assert.equal(normalized.jobs.isolation.steps[22].run, changed.jobs.isolation.steps[22].run);
    assert.notEqual(digest(JSON.stringify(normalized)), predecessorHash);
  }
});

test("duplicate canonical selection in a different workflow cannot satisfy ownership", () => {
  for (const file of files) {
    const all = {
      "us-development.yml": candidate,
      extra: { jobs: { duplicate: { steps: [{ run: `pnpm exec vitest run ${file}` }] } } },
    };
    assert.throws(() => assertOwnership(all), /exactly one explicit selection/);
  }
});

test("byte normalization retains malformed commands, guards and failure properties", () => {
  const block = `      - name: ${name}\n        if: matrix.segment == 'office'\n        run: ${command}\n`;
  for (const replacement of [
    block.replace(files[3] + " ", ""),
    block.replace("--maxWorkers=1", "--maxWorkers=1 || true"),
    block.replace("matrix.segment == 'office'", "false"),
    block.replace("        run:", "        continue-on-error: true\n        run:"),
    block.replace("        run:", "        timeout-minutes: 60\n        run:"),
    block + block,
  ]) {
    const changed = candidateSource.replace(block, replacement);
    assert.notEqual(changed, candidateSource);
    const normalized = withoutParallelSegmentsBytes(changed);
    assert.ok(
      normalized.includes(command.replace(files[3] + " ", "")) || normalized.includes(files[3]),
    );
    assert.notEqual(digest(normalized), predecessorBytes);
  }
});
