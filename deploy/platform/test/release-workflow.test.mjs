import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
const path = ".github/workflows/release-platform-images.yml";
const workflow = () => load(readFileSync(path, "utf8"));
test("manual main-only publisher uses immutable dispatch identity and protected dependent write job", () => {
  const w = workflow();
  assert.equal(w.name, "Publish platform images");
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs), ["ci_run_id"]);
  assert.equal(w.on.workflow_dispatch.inputs.ci_run_id.required, true);
  assert.deepEqual(w.permissions, { contents: "read" });
  assert.match(w.jobs.build.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(w.jobs.build.if, /github.event_name == 'workflow_dispatch'/);
  assert.deepEqual(w.jobs.build.permissions, { contents: "read", actions: "read" });
  assert.equal(w.jobs.publish.environment, "production-deploy");
  assert.equal(w.jobs.publish.needs, "build");
  assert.deepEqual(w.jobs.publish.permissions, { contents: "read", packages: "write" });
  assert.equal(w.env.RELEASE_SHA, "${{ github.sha }}");
  for (const job of Object.values(w.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    for (const step of job.steps.filter((step) => step.uses))
      assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});
test("build verifies CI, contracts and exact local images before immutable artifact upload", () => {
  const w = workflow();
  const steps = w.jobs.build.steps;
  const commands = steps.map((s) => s.run ?? "").join("\n");
  for (const verb of ["fetch-ci", "capture", "export"])
    assert.ok(commands.includes(`release-images.mjs ${verb}`));
  for (const gate of [
    "node --test deploy/platform/test/*.test.mjs",
    "test:production-bundle:contract",
    "test:ci-policy",
    "ci-stack.mjs --local-ci",
  ])
    assert.ok(commands.includes(gate));
  assert.ok(commands.indexOf("fetch-ci") < commands.indexOf("docker build"));
  assert.ok(commands.indexOf(" capture ") < commands.indexOf("ci-stack.mjs --local-ci"));
  assert.ok(commands.indexOf("ci-stack.mjs --local-ci") < commands.indexOf(" export "));
  assert.equal((commands.match(/docker build --platform linux\/amd64/g) ?? []).length, 2);
  assert.ok(!commands.includes("docker push"));
  const archive = steps.find((s) => s.id === "images");
  assert.equal(archive.with["retention-days"], 1);
  assert.equal(archive.with.overwrite, undefined);
  assert.equal(
    archive.with.path,
    "${{ runner.temp }}/platform-images/images.tar\n${{ runner.temp }}/platform-images/verified-images.json\n",
  );
  assert.match(w.jobs.build.outputs["artifact-id"], /steps.images.outputs.artifact-id/);
  const evidence = steps.find((s) => s.name === "Upload sanitized harness evidence");
  assert.equal(evidence.if, "always()");
  assert.equal(
    evidence.with.path,
    "${{ runner.temp }}/platform-harness/verification.json\n${{ runner.temp }}/platform-harness/platform-login.png\n${{ runner.temp }}/platform-harness/platform-landing.png\n",
  );
});
test("protected job loads artifact ID, checks before login/push and retains partial evidence", () => {
  const steps = workflow().jobs.publish.steps;
  const download = steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ needs.build.outputs.artifact-id }}");
  assert.equal(download.with.name, undefined);
  const index = (predicate) => steps.findIndex(predicate);
  assert.ok(
    index((s) => s.run?.includes(" load ")) <
      index((s) => s.uses?.startsWith("docker/login-action@")),
  );
  assert.ok(
    index((s) => s.uses?.startsWith("docker/login-action@")) <
      index((s) => s.run?.includes(" publish ")),
  );
  const upload = steps.find((s) => s.name === "Upload complete release");
  assert.equal(upload.with["retention-days"], 90);
  assert.match(upload.with.name, /github.run_id.*github.run_attempt/);
  const partial = steps.find((s) => s.name === "Upload incomplete publication evidence");
  assert.equal(partial.if, "failure()");
  assert.equal(partial.with.path, "${{ runner.temp }}/platform-published/release-evidence.json");
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(
    text,
    /\bssh\b|\bterraform\b|remote-deploy|yc |twc |NODE_TLS_REJECT_UNAUTHORIZED|:latest|overwrite: true/,
  );
  assert.doesNotMatch(steps.map((s) => s.run ?? "").join("\n"), /docker build|ci-stack/);
});

test("both publisher jobs select and verify the same classic store before images are built or loaded", () => {
  const w = workflow();
  const scripts = [];
  for (const [name, job] of Object.entries(w.jobs)) {
    const index = job.steps.findIndex(
      (s) => s.name === "Select classic store for portable platform images",
    );
    assert.ok(index >= 0, name);
    const setup = job.steps[index];
    scripts.push(setup.run);
    assert.match(setup.run, /RUNNER_ENVIRONMENT.*github-hosted/);
    assert.match(setup.run, /RUNNER_OS.*Linux/);
    assert.match(setup.run, /docker ps -aq/);
    assert.match(setup.run, /"containerd-snapshotter": false/);
    assert.match(setup.run, /"storage-driver": "overlay2"/);
    assert.match(setup.run, /sudo systemctl restart docker/);
    assert.match(setup.run, /docker info.*Driver.*overlay2/);
    const imageStep = job.steps.findIndex((s) =>
      /docker build|release-images.mjs load/.test(s.run ?? ""),
    );
    assert.ok(imageStep > index, name);
  }
  assert.equal(scripts[0], scripts[1]);
});
