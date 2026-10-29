import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { readBootstrapSshArguments } from "../catalog-bootstrap-transport.mjs";
const dispatch = { toolingSha: "a".repeat(40), runId: "123", runAttempt: "1" };
const target = {
  host: "201.34.136.19",
  port: "22",
  user: "root",
  identityFile: "/tmp/test-key",
  knownHostsFile: "/tmp/test-hosts",
};
test("bootstrap SSH uses strict pinned transport and a fixed new operator path, never an old activation", () => {
  const args = readBootstrapSshArguments(
    target,
    "de7a478d-e712-45bb-b36f-40067a62ab1d",
    "b".repeat(64),
    dispatch,
  );
  assert.ok(args.includes("StrictHostKeyChecking=yes") && args.includes("IdentityAgent=none"));
  assert.match(
    args.at(-1),
    /catalog-bootstrap-executors\/[a-f0-9]{40}\/deploy\/platform\/catalog-bootstrap-transport.mjs execute /,
  );
  assert.ok(!args.at(-1).includes("upgrade-bootstrap"));
  for (const bad of ["../bad", "x; echo forbidden", "$(echo forbidden)"])
    assert.throws(() => readBootstrapSshArguments(target, bad, "b".repeat(64), dispatch));
  assert.throws(() =>
    readBootstrapSshArguments(target, "de7a478d-e712-45bb-b36f-40067a62ab1d", "bad", dispatch),
  );
  assert.throws(() =>
    readBootstrapSshArguments(
      { ...target, host: "evil;echo" },
      "de7a478d-e712-45bb-b36f-40067a62ab1d",
      "b".repeat(64),
      dispatch,
    ),
  );
});

test("catalog workflow permits only main or its exact SHA tag, retaining independent protection", async () => {
  const workflow = load(
    await readFile(
      new URL("../../../.github/workflows/bootstrap-release-catalog.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = workflow.jobs.bootstrap;
  assert.equal(job.environment, "production-deploy");
  assert.equal(
    job.if,
    "${{ github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || github.ref == format('refs/tags/catalog-bootstrap-{0}', github.sha)) && github.run_attempt == 1 }}",
  );
  assert.deepEqual(workflow.concurrency, {
    group: "timeweb-platform-production",
    "cancel-in-progress": false,
  });
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  const run = job.steps.find((step) => step.env?.DISPATCH_SHA);
  assert.equal(run.env.DISPATCH_SHA, "${{ github.sha }}");
  assert.equal(run.env.EXECUTOR_SHA, "${{ inputs.executor_sha }}");
  assert.equal(run.env.EXECUTOR_CI_RUN_ID, "${{ inputs.executor_ci_run_id }}");
  assert.equal(run.env.OPERATION_SHA256, "${{ inputs.operation_sha256 }}");
});
