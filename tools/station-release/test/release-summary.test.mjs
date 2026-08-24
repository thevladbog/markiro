import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { load } from "js-yaml";

const moduleUrl = new URL("../release-summary.mjs", import.meta.url);
const workflowUrl = new URL(
  "../../../.github/workflows/station-stable-release.yml",
  import.meta.url,
);
const execFile = promisify(execFileCallback);

async function summaryModule() {
  return import(moduleUrl);
}

const digest = (character) => character.repeat(64);

const completeProvenance = () => ({
  version: "1.2.3",
  sourceBetaTag: "station-v1.2.3-beta.4",
  baseSha: "1".repeat(40),
  releaseSha: "2".repeat(40),
  githubBetaEvidenceSha256: digest("3"),
  yandexBetaEvidenceSha256: digest("4"),
});

async function runSummaryCli(args) {
  return execFile(process.execPath, [fileURLToPath(moduleUrl), ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

test("records bounded source provenance and stable publication hashes", async () => {
  const { createReleaseSummaryState, renderReleaseSummary, updateReleaseSummary } =
    await summaryModule();
  const state = updateReleaseSummary(createReleaseSummaryState("publish"), {
    ...completeProvenance(),
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
  const {
    createReleaseSummaryState,
    renderReleaseSummary,
    transitionReleaseSummary,
    updateReleaseSummary,
  } = await summaryModule();
  let state = updateReleaseSummary(createReleaseSummaryState("publish"), completeProvenance());
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
  const {
    createReleaseSummaryState,
    renderReleaseSummary,
    transitionReleaseSummary,
    updateReleaseSummary,
  } = await summaryModule();
  let existing = transitionReleaseSummary(
    updateReleaseSummary(createReleaseSummaryState("promote-existing"), completeProvenance()),
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

test("seed workflow passes explicit null provenance through the real summary CLI", async () => {
  const workflow = load(await readFile(workflowUrl, "utf8"));
  const run = workflow.jobs.release.steps.find(
    (step) => step.name === "Resolve stable publication candidate",
  )?.run;
  assert.equal(typeof run, "string");
  const seedStart = run.indexOf('else\n  beta_version=""');
  const seedEnd = run.indexOf("\nfi", seedStart);
  assert.ok(seedStart >= 0 && seedEnd > seedStart);
  const seedBranch = run.slice(seedStart, seedEnd);
  const sentinelNames = [
    "summary_source_beta_tag",
    "summary_base_sha",
    "summary_github_beta_evidence_sha256",
    "summary_yandex_beta_evidence_sha256",
  ];
  const sentinels = sentinelNames.map((name) => {
    const match = new RegExp(`^  ${name}="([^"]*)"$`, "m").exec(seedBranch);
    assert.ok(match, `missing seed summary sentinel: ${name}`);
    return match[1];
  });
  assert.deepEqual(sentinels, ["null", "null", "null", "null"]);
  for (const name of sentinelNames) assert.match(run, new RegExp(`"\\$${name}"`));

  const directory = await mkdtemp(join(tmpdir(), "markiro-seed-summary-cli-"));
  const statePath = join(directory, "state.json");
  await runSummaryCli(["init", "seed-baseline", statePath]);
  await runSummaryCli([
    "update",
    statePath,
    "version",
    "1.2.3",
    "sourceBetaTag",
    sentinels[0],
    "baseSha",
    sentinels[1],
    "releaseSha",
    "a".repeat(40),
    "githubBetaEvidenceSha256",
    sentinels[2],
    "yandexBetaEvidenceSha256",
    sentinels[3],
  ]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.version, "1.2.3");
  assert.equal(state.releaseSha, "a".repeat(40));
  assert.equal(state.sourceBetaTag, null);
  assert.equal(state.baseSha, null);
  assert.equal(state.githubBetaEvidenceSha256, null);
  assert.equal(state.yandexBetaEvidenceSha256, null);
  await runSummaryCli(["transition", statePath, "seed-publication-attempted"]);
  const transitioned = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(transitioned.immutableState, "seed-publication-attempted");
});

test("normal summary CLI rejects null accepted-beta provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-normal-summary-cli-"));
  const statePath = join(directory, "state.json");
  await runSummaryCli(["init", "publish", statePath]);
  await assert.rejects(
    runSummaryCli([
      "update",
      statePath,
      "version",
      "1.2.3",
      "sourceBetaTag",
      "null",
      "baseSha",
      "null",
      "releaseSha",
      "a".repeat(40),
      "githubBetaEvidenceSha256",
      "null",
      "yandexBetaEvidenceSha256",
      "null",
    ]),
    /invalid station release summary/,
  );
});

test("normal summary CLI rejects explicit all-null provenance before the first transition", async () => {
  for (const [mode, firstTransition] of [
    ["publish", "github-publication-attempted"],
    ["promote-existing", "existing-public-validation-started"],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `markiro-${mode}-summary-cli-`));
    const statePath = join(directory, "state.json");
    await runSummaryCli(["init", mode, statePath]);
    await assert.rejects(
      runSummaryCli([
        "update",
        statePath,
        "version",
        "null",
        "sourceBetaTag",
        "null",
        "baseSha",
        "null",
        "releaseSha",
        "null",
        "githubBetaEvidenceSha256",
        "null",
        "yandexBetaEvidenceSha256",
        "null",
      ]),
      /invalid station release summary/,
    );
    await assert.rejects(
      runSummaryCli(["transition", statePath, firstTransition]),
      /invalid station release summary/,
    );
  }
});
