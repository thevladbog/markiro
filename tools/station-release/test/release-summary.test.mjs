import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../release-summary.mjs", import.meta.url);

async function summaryModule() {
  return import(moduleUrl);
}

test("renders bounded stable publication hashes and successful transaction state", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const digest = (character) => character.repeat(64);
  const state = updateReleaseSummary(createReleaseSummaryState("publish"), {
    version: "1.2.3",
    githubManifestSha256: digest("a"),
    yandexManifestSha256: digest("b"),
    githubEvidenceSha256: digest("c"),
    yandexEvidenceSha256: digest("d"),
    installerSha256: digest("e"),
    bundleSha256: digest("f"),
    signatureSha256: digest("0"),
    immutableState: "both-public-validated",
    promotionState: "all-promoted",
    rollbackState: "not-required",
    outcome: "promoted",
  });
  const output = renderReleaseSummary(state);
  assert.match(output, /GitHub manifest SHA-256: `a{64}`/);
  assert.match(output, /Yandex evidence SHA-256: `d{64}`/);
  assert.match(output, /Installer SHA-256: `e{64}`/);
  assert.match(output, /Immutable publication: `both-public-validated`/);
  assert.match(output, /Promotion: `all-promoted`/);
  assert.match(output, /Outcome: `promoted`/);
  assert.ok(Buffer.byteLength(output) < 8192);
});

test("reports explicit immutable but not promoted state after a bounded failure", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const state = updateReleaseSummary(createReleaseSummaryState("publish"), {
    version: "1.2.3",
    immutableState: "both-public-validated",
  });
  assert.match(renderReleaseSummary(state), /Outcome: `immutable-but-not-promoted`/);
});

test("rejects secret-shaped, unbounded and structurally unexpected summary state", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const state = createReleaseSummaryState("publish");
  for (const patch of [
    { version: "github_pat_secret" },
    { outcome: "provider said AWS_SECRET_ACCESS_KEY=secret" },
    { extra: "field" },
    { githubManifestSha256: "a".repeat(65) },
  ]) {
    assert.throws(() => updateReleaseSummary(state, patch), /invalid station release summary/);
  }
  assert.throws(
    () => renderReleaseSummary({ ...state, mode: "publish\nsecret" }),
    /invalid station release summary/,
  );
});
