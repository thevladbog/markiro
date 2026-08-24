import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { validateAcceptedBeta } from "../promotion.mjs";

const execFile = promisify(execFileCallback);
const promotionCli = fileURLToPath(new URL("../promotion.mjs", import.meta.url));
const allowedDiff = ["apps/station/src-tauri/Cargo.toml", "apps/station/src-tauri/tauri.conf.json"];
const version = "0.1.0-beta.19";
const sourceBetaTag = `station-v${version}`;
const baseSha = "a".repeat(40);
const releaseSha = "b".repeat(40);
const distributionSha = "c".repeat(40);
const publishedAt = "2026-08-20T10:00:00.000Z";
const names = stationAssetNames(version);

async function stageTree(origin, { installer = "installer-bytes" } = {}) {
  const input = await mkdtemp(join(tmpdir(), `markiro-promotion-${origin}-input-`));
  const output = await mkdtemp(join(tmpdir(), `markiro-promotion-${origin}-output-`));
  await rm(output, { recursive: true });
  for (const [name, bytes] of [
    [names.installer, installer],
    [names.bundle, "bundle-bytes"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), bytes);
  }
  const evidence = await stageStationRelease({
    channel: "beta",
    origin,
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: publishedAt,
    baseSha,
    releaseSha,
  });
  return { output, evidence };
}

async function validInput() {
  const [github, yandex] = await Promise.all([stageTree("github"), stageTree("yandex")]);
  return {
    sourceBetaTag,
    release: {
      tagName: sourceBetaTag,
      isDraft: false,
      isPrerelease: true,
      targetCommitish: distributionSha,
    },
    githubEvidence: github.evidence,
    yandexEvidence: yandex.evidence,
    githubTree: github.output,
    yandexTree: yandex.output,
    diffPaths: allowedDiff,
  };
}

test("accepts one strict dual-origin beta with equal common artifacts", async () => {
  assert.deepEqual(await validateAcceptedBeta(await validInput()), {
    sourceBetaTag,
    betaVersion: version,
    baseSha,
    betaReleaseSha: releaseSha,
  });
});

test("rejects draft, non-prerelease, malformed distribution target and extra beta tree changes", async () => {
  const mutations = [
    (input) => ({ ...input, release: { ...input.release, isDraft: true } }),
    (input) => ({ ...input, release: { ...input.release, isPrerelease: false } }),
    (input) => ({
      ...input,
      release: { ...input.release, targetCommitish: "main" },
    }),
    (input) => ({ ...input, diffPaths: [...input.diffPaths, "apps/station/src/App.tsx"] }),
    (input) => ({ ...input, diffPaths: [...input.diffPaths].reverse() }),
    (input) => ({ ...input, sourceBetaTag: "station-v0.1.0-beta.0" }),
    (input) => ({ ...input, githubEvidence: { ...input.githubEvidence, unexpected: true } }),
  ];
  for (const mutate of mutations) {
    await assert.rejects(
      validateAcceptedBeta(mutate(await validInput())),
      /invalid accepted station beta/,
    );
  }
});

test("rejects missing or mismatched dual-origin provenance", async () => {
  const missingYandex = await validInput();
  delete missingYandex.yandexEvidence;
  const sourceMismatch = await validInput();
  sourceMismatch.yandexEvidence = {
    ...sourceMismatch.yandexEvidence,
    baseSha: "c".repeat(40),
  };
  const channelMismatch = await validInput();
  channelMismatch.yandexEvidence = {
    ...channelMismatch.yandexEvidence,
    channel: "stable",
  };
  const versionMismatch = await validInput();
  versionMismatch.yandexEvidence = {
    ...versionMismatch.yandexEvidence,
    version: "0.1.0-beta.20",
  };
  const reversedOrigin = await validInput();
  const other = await validInput();
  reversedOrigin.githubEvidence = reversedOrigin.yandexEvidence;
  reversedOrigin.yandexEvidence = other.githubEvidence;

  for (const input of [
    missingYandex,
    sourceMismatch,
    channelMismatch,
    versionMismatch,
    reversedOrigin,
  ]) {
    await assert.rejects(validateAcceptedBeta(input), /invalid accepted station beta/);
  }
});

test("rejects a valid origin tree whose common installer differs", async () => {
  const input = await validInput();
  const yandex = await stageTree("yandex", { installer: "different-installer" });
  input.yandexTree = yandex.output;
  input.yandexEvidence = yandex.evidence;

  await assert.rejects(validateAcceptedBeta(input), /invalid accepted station beta/);
});

test("rejects legacy GitHub-only beta evidence during normal promotion", async () => {
  const input = await validInput();
  const legacyEvidence = {
    version: input.githubEvidence.version,
    baseSha: input.githubEvidence.baseSha,
    releaseSha: input.githubEvidence.releaseSha,
    publishedAt: input.githubEvidence.publishedAt,
    assets: input.githubEvidence.assets,
  };
  await writeFile(
    join(input.githubTree, names.evidence),
    `${JSON.stringify(legacyEvidence, null, 2)}\n`,
  );
  input.githubEvidence = legacyEvidence;

  await assert.rejects(validateAcceptedBeta(input), /invalid accepted station beta/);
});

test("writes only validated promotion fields and refuses existing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-stable-promotion-"));
  const releasePath = join(directory, "release.json");
  const githubEvidencePath = join(directory, "github-evidence.json");
  const yandexEvidencePath = join(directory, "yandex-evidence.json");
  const diffPath = join(directory, "diff.txt");
  const outputPath = join(directory, "output.txt");
  const input = await validInput();
  await writeFile(releasePath, JSON.stringify(input.release));
  await writeFile(githubEvidencePath, JSON.stringify(input.githubEvidence));
  await writeFile(yandexEvidencePath, JSON.stringify(input.yandexEvidence));
  await writeFile(diffPath, `${input.diffPaths.join("\n")}\n`);

  const args = [
    promotionCli,
    "validate-beta",
    releasePath,
    githubEvidencePath,
    yandexEvidencePath,
    input.githubTree,
    input.yandexTree,
    diffPath,
    outputPath,
  ];
  await execFile(process.execPath, args, { maxBuffer: 1024 * 1024 });

  assert.equal(
    await readFile(outputPath, "utf8"),
    [
      `source_beta_tag=${sourceBetaTag}`,
      `beta_version=${version}`,
      `base_sha=${baseSha}`,
      `beta_release_sha=${releaseSha}`,
      "",
    ].join("\n"),
  );
  await assert.rejects(execFile(process.execPath, args, { maxBuffer: 1024 * 1024 }));
});

test("rejects symlinked promotion evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-stable-promotion-link-"));
  const realRelease = join(directory, "release-real.json");
  const releasePath = join(directory, "release.json");
  const githubEvidencePath = join(directory, "github-evidence.json");
  const yandexEvidencePath = join(directory, "yandex-evidence.json");
  const diffPath = join(directory, "diff.txt");
  const input = await validInput();
  await writeFile(realRelease, JSON.stringify(input.release));
  await symlink(realRelease, releasePath);
  await writeFile(githubEvidencePath, JSON.stringify(input.githubEvidence));
  await writeFile(yandexEvidencePath, JSON.stringify(input.yandexEvidence));
  await writeFile(diffPath, `${allowedDiff.join("\n")}\n`);

  await assert.rejects(
    execFile(
      process.execPath,
      [
        promotionCli,
        "validate-beta",
        releasePath,
        githubEvidencePath,
        yandexEvidencePath,
        input.githubTree,
        input.yandexTree,
        diffPath,
        join(directory, "output.txt"),
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  );
});
