import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { load } from "js-yaml";

const text = (await readFile(".github/workflows/handheld-release.yml", "utf8")).replaceAll(
  "\r\n",
  "\n",
);
const workflow = load(text);
const release = workflow.jobs.release;
const steps = release.steps;
const stepIndex = (fragment) => steps.findIndex((step) => (step.name ?? "").includes(fragment));

test("the release is dispatch-only, owner-gated, and off main it does not run", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.jobs.authorize.if, "github.ref == 'refs/heads/main'");
  assert.equal(release.if, "github.ref == 'refs/heads/main' && inputs.action != 'sync-download'");
  assert.equal(release.needs, "authorize");
  assert.match(text, /test "\$RELEASE_ACTOR" = "\$RELEASE_OWNER"/);
  assert.match(text, /test "\$OWNER_CONFIRMATION" = "BUILD-HANDHELD-RELEASE"/);
});

test("building is the default and publishing must be asked for", () => {
  // A dispatch that forgot to think about publication must change nothing that
  // a terminal is downloading.
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["stable", "beta"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.channel.default, "stable");
});

test("the signing key is restored before the build and discarded whatever happens", () => {
  assert.ok(stepIndex("Restore the signing key") < stepIndex("Build the signed release"));
  const discard = steps[stepIndex("Discard the signing key")];
  assert.equal(discard.if, "always()");
  assert.match(discard.run, /rm -f "\$RUNNER_TEMP\/handheld\.jks"/);
});

test("publication happens only after the signature is proven", () => {
  // The order is the whole point: publishing an unsigned or unproven artifact
  // puts something on a channel that terminals will refuse to install.
  const proven = stepIndex("Prove the artifact is signed");
  const published = stepIndex("Publish to the channel");
  assert.ok(proven >= 0 && published >= 0);
  assert.ok(proven < published, "the signature must be proven before anything is published");
  assert.equal(steps[published].if, "${{ inputs.publish }}");
});

test("the signing key is gone before anything else runs on the runner", () => {
  const discard = stepIndex("Discard the signing key");
  const upload = steps.findIndex((step) =>
    (step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert.ok(discard < upload, "the key must not still be on the runner during an upload");
  // Nothing below the signature check needs the key, and publication least of
  // all. The publish step re-checks at runtime, because an ordering rule that
  // only exists in a test is one refactor away from being untrue.
  assert.ok(discard < stepIndex("Publish to the channel"));
  assert.match(
    steps[stepIndex("Publish to the channel")].run,
    /test ! -f "\$RUNNER_TEMP\/handheld\.jks"/,
  );
});

test("dependencies are installed before the key or the storage credential exist", () => {
  // `pnpm install` runs whatever lifecycle scripts the dependency tree carries;
  // `.npmrc` does not disable them. None of that should run in a process that
  // can read a signing key.
  const install = stepIndex("Install publishing dependencies");
  assert.ok(install >= 0, "publishing dependencies must be installed in their own step");
  assert.ok(install < stepIndex("Restore the signing key"));
  assert.equal(steps[install].env, undefined, "the install step must carry no secrets");
  for (const step of steps) {
    if (!step.run?.includes("pnpm install")) continue;
    assert.equal(step.name, "Install publishing dependencies", "only one step may install");
  }
});

test("the object-storage credential reaches the publish step and nothing else", () => {
  const credential = "YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY";
  const carriers = steps.filter((step) => Object.keys(step.env ?? {}).includes(credential));
  assert.deepEqual(
    carriers.map((step) => step.name),
    ["Publish to the channel"],
  );
});

test("the version is computed, never typed", () => {
  // A typed `versionCode` is a repeat waiting to happen, and a repeat is an
  // update every installed terminal silently refuses.
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.version_name, undefined);
  assert.equal(inputs.version_code, undefined);
  assert.deepEqual(inputs.bump.options, ["patch", "minor", "major"]);
  assert.deepEqual(Object.keys(workflow.jobs.authorize.outputs), ["version_name", "version_code"]);
  // Resolved in `authorize`, so everything it can refuse is refused before the
  // release job puts a signing key on a runner. The channel pointer is public,
  // so this needs no credential.
  const resolve = workflow.jobs.authorize.steps.find((step) => step.id === "version");
  assert.ok(resolve, "authorize must resolve the version");
  assert.match(resolve.run, /tools\/handheld-release\/resolve\.mjs/);
  for (const step of steps) {
    assert.ok(
      !JSON.stringify(step).includes("inputs.version_name"),
      `${step.name} still reads a typed version`,
    );
  }
});

test("publishing refuses a version the changelog does not describe", () => {
  // Checked in `authorize`, which is why that job checks the repository out at
  // all: the refusal must happen before a signing key reaches a runner.
  // Enforced by `resolve.mjs`, which is why `authorize` checks the repository
  // out at all; its own tests cover the refusal and the message it carries.
  assert.match(text, /tools\/handheld-release\/resolve\.mjs/);
  assert.ok(
    workflow.jobs.authorize.steps.some((step) => (step.uses ?? "").startsWith("actions/checkout@")),
  );
  assert.equal(
    workflow.on.workflow_dispatch.inputs.notes,
    undefined,
    "notes come from the changelog",
  );
});

test("the release job runs in its own protected environment", () => {
  assert.equal(release.environment, "handheld-release");
  assert.equal(workflow.concurrency.group, "handheld-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("every third-party action is pinned to a commit", () => {
  for (const step of steps) {
    if (!step.uses) continue;
    assert.match(step.uses, /@[0-9a-f]{40}(\s|$)/, `${step.uses} is not pinned to a commit`);
  }
});

test("repairing the download URL uses the owner gate and release concurrency without a new build", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.action.default, "release");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.action.options, [
    "release",
    "sync-download",
  ]);
  const resolve = workflow.jobs.authorize.steps.find((step) => step.id === "version");
  assert.equal(resolve.if, "inputs.action != 'sync-download'");
  const sync = workflow.jobs["sync-download"];
  assert.equal(sync.if, "github.ref == 'refs/heads/main' && inputs.action == 'sync-download'");
  assert.equal(sync.needs, "authorize");
  assert.equal(sync.environment, "handheld-release");
  assert.equal(workflow.concurrency.group, "handheld-release");
  const publish = sync.steps.find((step) =>
    step.run?.includes("tools/handheld-release/download.mjs"),
  );
  assert.ok(publish);
  assert.equal(publish.env.CHANNEL, "${{ inputs.channel }}");
  assert.equal(
    publish.env.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY,
    "${{ secrets.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY }}",
  );
  for (const step of sync.steps) {
    assert.ok(
      !JSON.stringify(step).includes("MARKIRO_HANDHELD_"),
      "sync must not receive signing credentials",
    );
    assert.ok(!step.run?.includes("gradlew"), "sync must not rebuild the APK");
    if (step.run?.includes("pnpm install")) assert.equal(step.env, undefined);
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }
});
