import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import {
  hasExactParallelSegments,
  segmentForStep,
  segmentGuard,
  withoutParallelSegments,
  withoutParallelSegmentsBytes,
} from "./support/parallel-segments.mjs";

const source = readFileSync(".github/workflows/us-development.yml", "utf8");
const workflow = load(source);
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("all unchanged US checks run in exactly six isolated segments with original budgets", () => {
  assert.ok(hasExactParallelSegments(workflow));
  const job = workflow.jobs.isolation;
  assert.deepEqual(job.strategy.matrix.segment, [
    "foundation",
    "dataset",
    "office",
    "requests",
    "browser",
    "persistence",
  ]);
  assert.equal(job["timeout-minutes"], 30);
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [index, step] of job.steps.entries()) {
    const owners = job.strategy.matrix.segment.filter(
      (segment) => step.if === undefined || step.if.split(" || ").includes(segmentGuard(segment)),
    );
    assert.equal(owners.length, index === 46 ? 2 : segmentForStep(index) ? 1 : 6);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step["timeout-minutes"], undefined);
  }
  assert.equal(job.steps[6].run, "pnpm turbo build --filter '@markiro/platform-contracts...'");
  assert.equal(job.steps[10].run, "pnpm turbo build --filter '@markiro/api...'");
  assert.equal(job.steps[46].if, "matrix.segment == 'requests' || matrix.segment == 'browser'");
  assert.equal(job.steps[46].name, "Build isolated request worker entry and checked descriptor");
  assert.equal(job.steps[81].if, segmentGuard("persistence"));
  assert.equal(job.steps.filter((step) => step.if === segmentGuard("persistence")).length, 1);
  assert.deepEqual(job.services["us-postgres"].ports, ["127.0.0.1:55432:5432"]);
});

test("partition normalization preserves every predecessor command, byte and property", () => {
  assert.ok(hasExactParallelSegments(workflow));
  const original = structuredClone(workflow);
  const predecessor = withoutParallelSegments(workflow);
  assert.deepEqual(workflow, original);
  assert.equal(
    hash(JSON.stringify(predecessor)),
    "64ba03ef3513c852d107ae434bfaa67995fdcd67944471a35ca9e4a7f9fb0de5",
  );
  const bytes = withoutParallelSegmentsBytes(source);
  assert.equal(hash(bytes), "41011c2455d1274a65fa829dee0cd8b57f544d04436f3f481570433ab0d68d1a");
  assert.deepEqual(load(bytes), predecessor);
});

test("missing segments, duplicate ownership and bypass guards cannot hide behind historical pins", () => {
  for (const mutate of [
    (job) => job.strategy.matrix.segment.pop(),
    (job) => job.strategy.matrix.segment.push("browser"),
    (job) => {
      job.strategy.matrix.exclude = [{ segment: "foundation" }];
    },
    (job) => {
      job.strategy["fail-fast"] = true;
    },
    (job) => {
      job.steps[12].if = "false";
    },
    (job) => {
      job.steps[12].if = segmentGuard("browser");
    },
    (job) => {
      delete job.steps[12].if;
    },
    (job) => {
      job.steps[5].if = segmentGuard("dataset");
    },
    (job) => {
      job.steps[46].if = segmentGuard("requests");
    },
    (job) => {
      job.steps[46].if = segmentGuard("browser");
    },
    (job) => {
      job.steps[47].if = "matrix.segment == 'requests' || matrix.segment == 'browser'";
    },
    (job) => {
      job.steps[81].if = segmentGuard("browser");
    },
    (job) => job.steps.splice(12, 1),
    (job) => job.steps.push(structuredClone(job.steps[12])),
  ]) {
    const changed = structuredClone(workflow);
    mutate(changed.jobs.isolation);
    assert.equal(hasExactParallelSegments(changed), false);
    assert.deepEqual(withoutParallelSegments(changed), changed);
  }
  for (const changed of [
    source.replace(
      "segment: [foundation, dataset, office, requests, browser, persistence]",
      "segment: [dataset, office, requests, browser]",
    ),
    source.replace("if: matrix.segment == 'foundation'", "if: false"),
  ])
    assert.equal(withoutParallelSegmentsBytes(changed), changed);
  const changedCommand = structuredClone(workflow);
  changedCommand.jobs.isolation.steps[12].run += " || true";
  assert.notEqual(
    hash(JSON.stringify(withoutParallelSegments(changedCommand))),
    hash(JSON.stringify(withoutParallelSegments(workflow))),
  );
});
