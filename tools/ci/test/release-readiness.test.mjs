import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const read = (name) => load(readFileSync(`.github/workflows/${name}.yml`, "utf8"));

test("platform publisher contracts can read pinned historical executors", () => {
  const job = read("release-platform-images").jobs.build;
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
});

test("the signed handheld APK is retained before fallible catalog publication", () => {
  const steps = read("handheld-release").jobs.release.steps;
  const upload = steps.findIndex((step) => step.with?.name?.startsWith("markiro-tsd-"));
  const publish = steps.findIndex((step) => step.name === "Publish to the channel");
  const discard = steps.findIndex((step) => step.name === "Discard the signing key");
  assert.ok(upload > discard && upload < publish);
  assert.equal(steps[upload].if, undefined);
  assert.equal(steps[upload].with["if-no-files-found"], "error");
});
