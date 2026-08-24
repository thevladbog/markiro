import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../release-summary.mjs", import.meta.url);

async function summaryModule() {
  return import(moduleUrl);
}

const digest = (character) => character.repeat(64);

test("records bounded source provenance and stable publication hashes", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const state = updateReleaseSummary(createReleaseSummaryState("publish"), {
    version: "1.2.3",
    sourceBetaTag: "station-v1.2.3-beta.4",
    baseSha: "1".repeat(40),
    releaseSha: "2".repeat(40),
    githubBetaEvidenceSha256: digest("3"),
    yandexBetaEvidenceSha256: digest("4"),
    githubManifestSha256: digest("a"),
    yandexManifestSha256: digest("b"),
    githubEvidenceSha256: digest("c"),
    yandexEvidenceSha256: digest("d"),
    installerSha256: digest("e"),
    bundleSha256: digest("f"),
    signatureSha256: digest("0"),
  });
  const output = renderReleaseSummary(state);
  assert.match(output, /Source beta: `station-v1\.2\.3-beta\.4`/);
  assert.match(output, /Base commit: `1{40}`/);
  assert.match(output, /Release commit: `2{40}`/);
  assert.match(output, /GitHub accepted-beta evidence SHA-256: `3{64}`/);
  assert.match(output, /Yandex accepted-beta evidence SHA-256: `4{64}`/);
  assert.match(output, /GitHub manifest SHA-256: `a{64}`/);
  assert.match(output, /Yandex evidence SHA-256: `d{64}`/);
  assert.match(output, /Installer SHA-256: `e{64}`/);
  assert.ok(Buffer.byteLength(output) < 8192);
});

test("tracks actual immutable boundaries from attempted publication through promotion", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, transitionReleaseSummary } =
    await summaryModule();
  let state = createReleaseSummaryState("publish");
  const expected = [
    ["github-publication-attempted", "github-publication-attempted", "partial-immutables"],
    ["github-draft-created", "github-draft-created", "partial-immutables"],
    ["github-draft-assets-validated", "github-draft-assets-validated", "partial-immutables"],
    ["github-undraft-attempted", "github-undraft-attempted", "partial-immutables"],
    ["github-public-validated", "github-public-validated", "partial-immutables"],
    ["yandex-publication-attempted", "yandex-publication-attempted", "partial-immutables"],
    ["both-origin-published", "both-origin-published", "partial-immutables"],
    ["both-public-validated", "both-public-validated", "immutable-but-not-promoted"],
    ["github-promoted", "both-public-validated", "immutable-but-not-promoted"],
    ["all-promoted", "both-public-validated", "promoted"],
  ];
  for (const [event, immutableState, outcome] of expected) {
    state = transitionReleaseSummary(state, event);
    assert.equal(state.immutableState, immutableState);
    assert.match(renderReleaseSummary(state), new RegExp(`Outcome: \\\`${outcome}\\\``));
  }
  assert.equal(state.promotionState, "all-promoted");
  assert.throws(
    () => transitionReleaseSummary(state, "github-draft-created"),
    /invalid station release summary/,
  );
});

test("distinguishes existing-tree validation, restored transactions, and restoration failure", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, transitionReleaseSummary } =
    await summaryModule();
  let existing = transitionReleaseSummary(
    createReleaseSummaryState("promote-existing"),
    "existing-public-validation-started",
  );
  assert.match(renderReleaseSummary(existing), /Outcome: `existing-immutables-not-validated`/);
  existing = transitionReleaseSummary(existing, "both-public-validated");
  assert.match(renderReleaseSummary(existing), /Outcome: `immutable-but-not-promoted`/);
  existing = transitionReleaseSummary(existing, "github-promoted");
  const restored = transitionReleaseSummary(existing, "restored");
  assert.equal(restored.rollbackState, "restored");
  assert.match(renderReleaseSummary(restored), /Outcome: `restored-after-failure`/);

  const failed = transitionReleaseSummary(existing, "restoration-failed");
  assert.equal(failed.rollbackState, "restoration-failed");
  assert.match(renderReleaseSummary(failed), /Outcome: `restoration-failed`/);
});

test("keeps early summaries safe and rejects malformed provenance or arbitrary state patches", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const state = createReleaseSummaryState("publish");
  const early = renderReleaseSummary(state);
  assert.match(early, /Source beta: `not-recorded`/);
  assert.match(early, /Base commit: `not-recorded`/);
  for (const patch of [
    { version: "github_pat_secret" },
    { sourceBetaTag: "station-v1.2.3" },
    { sourceBetaTag: `station-v1.2.3-beta.1${"x".repeat(300)}` },
    { baseSha: "a".repeat(39) },
    { releaseSha: "A".repeat(40) },
    { githubBetaEvidenceSha256: "a".repeat(65) },
    { yandexBetaEvidenceSha256: "github_pat_secret" },
    { immutableState: "both-public-validated" },
    { outcome: "provider said AWS_SECRET_ACCESS_KEY=secret" },
    { extra: "field" },
  ]) {
    assert.throws(() => updateReleaseSummary(state, patch), /invalid station release summary/);
  }
  assert.throws(
    () => renderReleaseSummary({ ...state, mode: "publish\nsecret" }),
    /invalid station release summary/,
  );
});
