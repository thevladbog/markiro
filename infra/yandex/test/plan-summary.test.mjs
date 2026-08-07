import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const scriptPath = path.join(repositoryRoot, "infra/yandex/scripts/validate-plan-summary.mjs");

function summarize(records) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  });
}

test("plan summary emits only action classes and aggregate resource counts", () => {
  const result = summarize([
    { type: "planned_change", action: "create" },
    { type: "planned_change", action: "update" },
    { type: "planned_change", action: "replace" },
    { type: "planned_change", action: "delete" },
    {
      type: "change_summary",
      changes: { add: 2, change: 1, remove: 2, operation: "plan" },
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action_classes: { create: 1, delete: 1, replace: 1, update: 1 },
    resource_counts: { add: 2, change: 1, remove: 2 },
  });
});

test("plan summary accepts a state-only remove without reporting resource destruction", () => {
  const result = summarize([
    { type: "planned_change", action: "remove" },
    {
      type: "change_summary",
      changes: { add: 0, change: 0, remove: 0, operation: "plan" },
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action_classes: { remove: 1 },
    resource_counts: { add: 0, change: 0, remove: 0 },
  });
});

test("plan summary rejects full changes, outputs, sensitive fields, and malformed summaries", () => {
  const unsafeInputs = [
    [
      {
        type: "planned_change",
        action: "create",
        change: { before: null, after: { name: "private" } },
      },
      {
        type: "change_summary",
        changes: { add: 1, change: 0, remove: 0, operation: "plan" },
      },
    ],
    [
      { type: "outputs", outputs: { endpoint: { value: "https://private.example" } } },
      {
        type: "change_summary",
        changes: { add: 0, change: 0, remove: 0, operation: "plan" },
      },
    ],
    [
      { type: "planned_change", action: "create", password: "not-allowed" },
      {
        type: "change_summary",
        changes: { add: 1, change: 0, remove: 0, operation: "plan" },
      },
    ],
    [
      {
        type: "change_summary",
        changes: { add: -1, change: 0, remove: 0, operation: "plan" },
      },
    ],
    [{ type: "planned_change", action: "create" }],
  ];

  for (const records of unsafeInputs) {
    const result = summarize(records);
    assert.notEqual(result.status, 0, `unsafe input unexpectedly passed: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private|not-allowed|password|endpoint/);
  }
});

test("plan summary rejects unsupported action classes and duplicate summaries", () => {
  for (const records of [
    [
      { type: "planned_change", action: "execute" },
      {
        type: "change_summary",
        changes: { add: 0, change: 0, remove: 0, operation: "plan" },
      },
    ],
    [
      {
        type: "change_summary",
        changes: { add: 0, change: 0, remove: 0, operation: "plan" },
      },
      {
        type: "change_summary",
        changes: { add: 0, change: 0, remove: 0, operation: "plan" },
      },
    ],
  ]) {
    const result = summarize(records);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});
