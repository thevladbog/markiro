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
  assert.equal(release.if, "github.ref == 'refs/heads/main'");
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

test("the signing key is gone before the artifact is uploaded anywhere", () => {
  const discard = stepIndex("Discard the signing key");
  const upload = steps.findIndex((step) =>
    (step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert.ok(discard < upload, "the key must not still be on the runner during an upload");
});

test("publishing refuses an empty set of release notes", () => {
  assert.match(text, /if \[ "\$PUBLISH" = "true" \]; then\n\s+test -n/);
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
