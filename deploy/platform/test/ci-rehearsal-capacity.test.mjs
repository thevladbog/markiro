import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

test("CI reclaims only disposable default build cache after recovery and before VFS image staging", async (t) => {
  const workflow = load(await readFile(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["production-bundle"];
  const steps = job.steps;
  const cleanup = steps.find((step) => step.name === "Reclaim disposable CI build cache");
  assert.ok(cleanup, "VFS staging needs a build-cache reclamation boundary");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(cleanup.if, undefined);
  assert.ok(
    steps.indexOf(cleanup) >
      steps.findIndex((step) => step.run?.includes("deploy/platform/recovery-ci.mjs")),
  );
  assert.ok(
    steps.indexOf(cleanup) < steps.findIndex((step) => step.run?.includes("rehearseUpgrade")),
  );

  const root = await mkdtemp(join(tmpdir(), "markiro-ci-capacity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = join(root, "docker-calls.jsonl");
  // Process-boundary double: no Docker daemon or image/volume deletion in this test.
  await writeFile(
    join(root, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAPACITY_TEST_CALLS, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) === JSON.stringify(["system", "df"])) process.exit(0);
if (JSON.stringify(args) !== JSON.stringify(["buildx", "prune", "--builder", "default", "--all", "--force"])) process.exit(91);
process.exit(Number(process.env.CAPACITY_TEST_PRUNE_EXIT || 0));
`,
    { mode: 0o700 },
  );
  const run = (runner, pruneExit = "0") =>
    spawnSync("/bin/bash", ["-e", "-c", cleanup.run], {
      encoding: "utf8",
      env: {
        PATH: `${root}:${process.env.PATH}`,
        RUNNER_ENVIRONMENT: runner,
        RUNNER_TEMP: root,
        CAPACITY_TEST_CALLS: calls,
        CAPACITY_TEST_PRUNE_EXIT: pruneExit,
      },
    });

  assert.notEqual(run("self-hosted").status, 0);
  await assert.rejects(readFile(calls), { code: "ENOENT" });
  const success = run("github-hosted");
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse), [
    ["system", "df"],
    ["buildx", "prune", "--builder", "default", "--all", "--force"],
    ["system", "df"],
  ]);
  await rm(calls);
  assert.equal(run("github-hosted", "23").status, 23);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
});
