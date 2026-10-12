import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { withoutParallelSegmentsBytes } from "./support/parallel-segments.mjs";

const source = withoutParallelSegmentsBytes(
  readFileSync(".github/workflows/us-development.yml", "utf8"),
);
const workflow = load(source);
const owner = {
  name: "Build shared contracts for Node tooling checks",
  run: "pnpm turbo build --filter '@markiro/platform-contracts...'",
};
const checker = {
  name: "Reject release capabilities and merges into main",
  run: "node tools/us-development/check-isolation.mjs",
};
const nodeChecks = { run: "node --test tools/us-development/test/*.test.mjs" };
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Removing/moving the prerequisite, making it conditional, or swallowing build
// failure must fail before fresh-checkout imports can be incorrectly called green.
function assertBootstrap(candidate) {
  const job = candidate.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === owner.name);
  assert.equal(owners.length, 1, "exactly one contracts bootstrap");
  const step = owners[0];
  assert.deepEqual(step, owner, "unconditional failure-propagating dependency build");
  const index = job.steps.indexOf(step);
  assert.deepEqual(job.steps[index - 1], checker, "release checker precedes bootstrap");
  assert.deepEqual(job.steps[index + 1], nodeChecks, "bootstrap precedes Node imports");
  for (const scope of [candidate, job]) {
    for (const key of ["if", "continue-on-error", "env", "shell", "defaults"])
      assert.equal(scope[key], undefined, `bootstrap scope rejects ${key}`);
  }
  assert.deepEqual(candidate.permissions, { contents: "read" });
  assert.equal(job["timeout-minutes"], 30);
}

test("US Node imports require successful transitive contracts build before execution", () => {
  assertBootstrap(workflow);
});

test("bootstrap ownership rejects omission, reordering, duplicate and failure bypasses", () => {
  const valid = structuredClone(workflow);
  valid.jobs.isolation.steps = valid.jobs.isolation.steps.filter(
    (step) => step.name !== owner.name,
  );
  const index = valid.jobs.isolation.steps.findIndex((step) => step.run === nodeChecks.run);
  valid.jobs.isolation.steps.splice(index, 0, owner);
  assertBootstrap(valid);
  for (const mutate of [
    (steps, i) => steps.splice(i, 1),
    (steps, i) => steps.push(steps.splice(i, 1)[0]),
    (steps, i) => steps.splice(i, 0, structuredClone(owner)),
    ...["if", "continue-on-error", "env", "shell", "defaults"].map((key) => (steps, i) => {
      steps[i][key] = key === "env" ? {} : "true";
    }),
    ...[
      "echo pnpm turbo build",
      `${owner.run} || true`,
      "pnpm --filter @markiro/platform-contracts build",
    ].map((run) => (steps, i) => {
      steps[i].run = run;
    }),
  ]) {
    const changed = structuredClone(valid);
    mutate(changed.jobs.isolation.steps, index);
    assert.throws(() => assertBootstrap(changed), assert.AssertionError);
  }
});

test("only the exact ordered additive bootstrap is removed from historical pins", async () => {
  const guard = await import("./support/shared-contracts-bootstrap.mjs").catch(() => ({}));
  assert.equal(typeof guard.withoutSharedContractsBootstrap, "function");
  assert.equal(typeof guard.withoutSharedContractsBootstrapBytes, "function");
  assertBootstrap(workflow);
  const original = structuredClone(workflow);
  const predecessor = guard.withoutSharedContractsBootstrap(workflow);
  assert.deepEqual(workflow, original, "normalization never mutates workflow");
  assert.equal(
    hash(JSON.stringify(predecessor)),
    "11012e9b37c9aa0b5501ce1745657df154a30ed7cdbcfe47db8dcd39389e285f",
  );
  const bytes = guard.withoutSharedContractsBootstrapBytes(source);
  assert.equal(hash(bytes), "af671fe078c1a2b8d1ea07361d353856b2ab6776bc6282cc64afb75f2f75f344");
  assert.deepEqual(load(bytes), predecessor);
  const index = workflow.jobs.isolation.steps.findIndex((step) => step.name === owner.name);
  for (const change of [
    { run: `${owner.run} || true` },
    { if: "true" },
    { env: {} },
    { name: "changed" },
  ]) {
    const changed = structuredClone(workflow);
    Object.assign(changed.jobs.isolation.steps[index], change);
    assert.deepEqual(
      guard.withoutSharedContractsBootstrap(changed),
      changed,
      "malformed bootstrap remains visible",
    );
  }
  const duplicate = structuredClone(workflow);
  duplicate.jobs.isolation.steps.push(structuredClone(owner));
  assert.deepEqual(guard.withoutSharedContractsBootstrap(duplicate), duplicate);
  const moved = structuredClone(workflow);
  moved.jobs.isolation.steps.push(moved.jobs.isolation.steps.splice(index, 1)[0]);
  assert.deepEqual(guard.withoutSharedContractsBootstrap(moved), moved);
  for (const changed of [
    source.replace(owner.run, `${owner.run} || true`),
    source.replace(`        run: ${owner.run}\n`, `        run: ${owner.run}\n        env: {}\n`),
  ])
    assert.equal(guard.withoutSharedContractsBootstrapBytes(changed), changed);
});
