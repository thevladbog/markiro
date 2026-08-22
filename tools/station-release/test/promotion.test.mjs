import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { validateAcceptedBeta } from "../promotion.mjs";

const execFile = promisify(execFileCallback);
const allowedDiff = ["apps/station/src-tauri/Cargo.toml", "apps/station/src-tauri/tauri.conf.json"];

function validInput() {
  return {
    sourceBetaTag: "station-v0.1.0-beta.19",
    release: {
      tagName: "station-v0.1.0-beta.19",
      isDraft: false,
      isPrerelease: true,
      targetCommitish: "b".repeat(40),
    },
    evidence: {
      version: "0.1.0-beta.19",
      baseSha: "a".repeat(40),
      releaseSha: "b".repeat(40),
      publishedAt: "2026-08-20T10:00:00.000Z",
      assets: {},
    },
    diffPaths: allowedDiff,
  };
}

test("accepts one published canonical beta with a version-only release tree", () => {
  assert.deepEqual(validateAcceptedBeta(validInput()), {
    sourceBetaTag: "station-v0.1.0-beta.19",
    betaVersion: "0.1.0-beta.19",
    baseSha: "a".repeat(40),
    betaReleaseSha: "b".repeat(40),
  });
});

test("rejects draft, non-prerelease, SHA mismatch and extra beta tree changes", () => {
  const mutations = [
    (input) => ({ ...input, release: { ...input.release, isDraft: true } }),
    (input) => ({ ...input, release: { ...input.release, isPrerelease: false } }),
    (input) => ({
      ...input,
      evidence: { ...input.evidence, releaseSha: "c".repeat(40) },
    }),
    (input) => ({ ...input, diffPaths: [...input.diffPaths, "apps/station/src/App.tsx"] }),
    (input) => ({ ...input, diffPaths: [...input.diffPaths].reverse() }),
    (input) => ({ ...input, sourceBetaTag: "station-v0.1.0-beta.0" }),
    (input) => ({ ...input, evidence: { ...input.evidence, unexpected: true } }),
  ];
  for (const mutate of mutations) {
    assert.throws(
      () => validateAcceptedBeta(mutate(validInput())),
      /invalid accepted station beta/,
    );
  }
});

test("writes only validated promotion fields and refuses existing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-stable-promotion-"));
  const releasePath = join(directory, "release.json");
  const evidencePath = join(directory, "evidence.json");
  const diffPath = join(directory, "diff.txt");
  const outputPath = join(directory, "output.txt");
  const input = validInput();
  await writeFile(releasePath, JSON.stringify(input.release));
  await writeFile(evidencePath, JSON.stringify(input.evidence));
  await writeFile(diffPath, `${input.diffPaths.join("\n")}\n`);

  await execFile(
    process.execPath,
    [
      new URL("../promotion.mjs", import.meta.url).pathname,
      "validate-beta",
      releasePath,
      evidencePath,
      diffPath,
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );

  assert.equal(
    await readFile(outputPath, "utf8"),
    [
      "source_beta_tag=station-v0.1.0-beta.19",
      "beta_version=0.1.0-beta.19",
      `base_sha=${"a".repeat(40)}`,
      `beta_release_sha=${"b".repeat(40)}`,
      "",
    ].join("\n"),
  );
  await assert.rejects(
    execFile(
      process.execPath,
      [
        new URL("../promotion.mjs", import.meta.url).pathname,
        "validate-beta",
        releasePath,
        evidencePath,
        diffPath,
        outputPath,
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  );
});

test("rejects symlinked promotion inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-stable-promotion-link-"));
  const realRelease = join(directory, "release-real.json");
  const releasePath = join(directory, "release.json");
  const evidencePath = join(directory, "evidence.json");
  const diffPath = join(directory, "diff.txt");
  await writeFile(realRelease, JSON.stringify(validInput().release));
  await symlink(realRelease, releasePath);
  await writeFile(evidencePath, JSON.stringify(validInput().evidence));
  await writeFile(diffPath, `${allowedDiff.join("\n")}\n`);

  await assert.rejects(
    execFile(
      process.execPath,
      [
        new URL("../promotion.mjs", import.meta.url).pathname,
        "validate-beta",
        releasePath,
        evidencePath,
        diffPath,
        join(directory, "output.txt"),
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  );
});
