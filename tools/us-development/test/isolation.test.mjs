import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";

const workflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, load(readFileSync(`.github/workflows/${name}`, "utf8"))]),
  );

test("every inherited operational job is unconditionally locked before it can obtain credentials", () => {
  const safe = new Set(["ci.yml", "dependency-review.yml", "us-development.yml"]);
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

test("US check-only job has enough time for its serial disposable-database suites", () => {
  const job = workflows()["us-development.yml"].jobs.isolation;
  assert.ok(
    job["timeout-minutes"] >= 30,
    "the full serial US suite exceeded the former 15-minute job limit",
  );
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
