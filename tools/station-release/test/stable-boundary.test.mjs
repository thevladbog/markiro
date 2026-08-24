import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { stageStationRelease, stationAssetNames } from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";

const execFile = promisify(execFileCallback);
const moduleUrl = new URL("../stable-boundary.mjs", import.meta.url);

async function boundaryModule() {
  return import(moduleUrl);
}

async function git(repository, ...args) {
  return (
    await execFile("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}

async function commitFile(repository, path, content, message) {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), content);
  await git(repository, "add", path);
  await git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

async function releaseGraph() {
  const repository = await mkdtemp(join(tmpdir(), "markiro-stable-boundary-git-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Markiro Test");
  await git(repository, "config", "user.email", "test@markiro.local");
  await mkdir(join(repository, "apps/station/src-tauri"), { recursive: true });
  await writeFile(
    join(repository, "apps/station/src-tauri/Cargo.toml"),
    '[package]\nname = "station"\nversion = "1.0.0"\n',
  );
  await writeFile(
    join(repository, "apps/station/src-tauri/tauri.conf.json"),
    '{"version":"1.0.0"}\n',
  );
  await writeFile(join(repository, "README.md"), "root\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "chore: root");
  const rootSha = await git(repository, "rev-parse", "HEAD");
  const baseSha = await commitFile(
    repository,
    "apps/station/src/source.ts",
    "export const source = true;\n",
    "feat(station): release source",
  );

  await git(repository, "checkout", "-b", "release-candidate");
  await writeFile(
    join(repository, "apps/station/src-tauri/Cargo.toml"),
    '[package]\nname = "station"\nversion = "1.1.0"\n',
  );
  await writeFile(
    join(repository, "apps/station/src-tauri/tauri.conf.json"),
    '{"version":"1.1.0"}\n',
  );
  await git(
    repository,
    "add",
    "apps/station/src-tauri/Cargo.toml",
    "apps/station/src-tauri/tauri.conf.json",
  );
  await git(repository, "commit", "-m", "chore(station): release overlay");
  const releaseSha = await git(repository, "rev-parse", "HEAD");

  await git(repository, "checkout", "main");
  const currentBaseSha = await commitFile(
    repository,
    "apps/station/src/current.ts",
    "export const current = true;\n",
    "fix(station): current source",
  );
  await git(repository, "checkout", "-b", "divergent", rootSha);
  const divergentBaseSha = await commitFile(
    repository,
    "apps/station/src/divergent.ts",
    "export const divergent = true;\n",
    "feat(station): divergent source",
  );
  await git(repository, "checkout", "main");
  return { repository, rootSha, baseSha, releaseSha, currentBaseSha, divergentBaseSha };
}

function releaseMetadata({ tagName, targetCommitish, isDraft = false, isPrerelease = false }) {
  return { tagName, isDraft, isPrerelease, targetCommitish };
}

function listedRelease({ tagName, isDraft = false, isPrerelease = false }) {
  return {
    tagName,
    isDraft,
    isPrerelease,
    publishedAt: isDraft ? null : "2026-08-24T10:00:00Z",
  };
}

async function stagedTree({ channel, version, baseSha, releaseSha, legacy = false }) {
  const input = await mkdtemp(join(tmpdir(), "markiro-stable-boundary-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-stable-boundary-tree-"));
  await rm(output, { recursive: true });
  const names = stationAssetNames(version);
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  const options = {
    channel,
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-24T10:00:00.000Z",
    baseSha,
    releaseSha,
  };
  if (channel === "stable") {
    const notesPath = join(input, "notes.md");
    await writeFile(notesPath, "Stable notes\n");
    Object.assign(options, {
      notesPath,
      stableProvenance: {
        sourceBetaTag: `station-v${version}-beta.1`,
        betaVersion: `${version}-beta.1`,
        betaReleaseSha: "b".repeat(40),
        betaEvidenceSha256: "d".repeat(64),
        acceptanceConfirmed: true,
        previousStableTag: null,
        previousStableBaseSha: null,
        changelogFromSha: baseSha,
        changelogToSha: baseSha,
      },
    });
  }
  await stageStationRelease(options);
  if (legacy) {
    const evidencePath = join(output, names.evidence);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    delete evidence.distribution;
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        ...evidence,
        schemaVersion: 2,
        channelUrl: stationReleaseLocation({ channel, origin: "github", version }).channelUrl,
      })}\n`,
    );
  }
  return output;
}

test("derives stable monotonicity only from published releases and ignores tag-only boundaries", async () => {
  const { resolveStableReleaseState } = await boundaryModule();
  const sourceBetaTag = "station-v1.2.0-beta.2";
  const state = resolveStableReleaseState({
    mode: "publish",
    sourceBetaTag,
    repositoryTags: ["station-v1.1.5"],
    releases: [
      listedRelease({
        tagName: "station-v1.0.0",
      }),
      listedRelease({
        tagName: sourceBetaTag,
        isPrerelease: true,
      }),
    ],
  });
  assert.deepEqual(state, {
    version: "1.2.0",
    tag: "station-v1.2.0",
    previousStableTag: "station-v1.0.0",
    firstBetaTag: sourceBetaTag,
  });
  assert.notEqual(state.previousStableTag, "station-v1.1.5");

  assert.throws(
    () =>
      resolveStableReleaseState({
        mode: "publish",
        sourceBetaTag,
        repositoryTags: ["station-v1.2.0"],
        releases: [
          listedRelease({
            tagName: sourceBetaTag,
            isPrerelease: true,
          }),
        ],
      }),
    /invalid station stable boundary/,
  );
});

test("finds the latest published stable from one complete bounded release inventory", async () => {
  const { resolveLatestPublishedStableRelease, resolveStableReleaseState } = await boundaryModule();
  const releases = [
    listedRelease({ tagName: "station-v1.0.0" }),
    listedRelease({ tagName: "station-v1.4.0", isDraft: true }),
    listedRelease({ tagName: "station-v1.3.0-beta.2", isPrerelease: true }),
    listedRelease({ tagName: "station-v1.2.0" }),
  ];
  assert.equal(resolveLatestPublishedStableRelease({ releases }), "station-v1.2.0");

  const truncated = Array.from({ length: 10_001 }, (_, index) =>
    listedRelease({ tagName: `unrelated-${index}` }),
  );
  assert.throws(
    () => resolveLatestPublishedStableRelease({ releases: truncated }),
    /invalid station stable boundary/,
  );
  assert.throws(
    () =>
      resolveStableReleaseState({
        mode: "publish",
        sourceBetaTag: "station-v2.0.0-beta.1",
        releases: truncated,
        repositoryTags: [],
      }),
    /invalid station stable boundary/,
  );
});

test("ignores draft stable candidates but never accepts draft boundary metadata", async () => {
  const { resolveStableChangelogBoundary, resolveStableReleaseState } = await boundaryModule();
  const graph = await releaseGraph();
  const tree = await stagedTree({
    channel: "stable",
    version: "1.1.0",
    baseSha: graph.baseSha,
    releaseSha: graph.releaseSha,
  });
  const sourceBetaTag = "station-v1.2.0-beta.1";
  const state = resolveStableReleaseState({
    mode: "publish",
    sourceBetaTag,
    repositoryTags: [],
    releases: [
      listedRelease({
        tagName: "station-v1.1.0",
        isDraft: true,
      }),
      listedRelease({
        tagName: sourceBetaTag,
        isPrerelease: true,
      }),
    ],
  });
  assert.equal(state.previousStableTag, null);
  await assert.rejects(
    resolveStableChangelogBoundary({
      repository: graph.repository,
      currentBaseSha: graph.currentBaseSha,
      sourceBetaTag,
      previous: {
        metadata: releaseMetadata({
          tagName: "station-v1.1.0",
          targetCommitish: graph.releaseSha,
          isDraft: true,
        }),
        tree,
        allowLegacy: false,
      },
      firstBeta: null,
    }),
    /invalid station stable boundary/,
  );
});

test("resolves a published validated previous stable boundary and its legacy-only migration form", async () => {
  const { resolveStableChangelogBoundary } = await boundaryModule();
  const graph = await releaseGraph();
  for (const legacy of [false, true]) {
    const tree = await stagedTree({
      channel: "stable",
      version: "1.1.0",
      baseSha: graph.baseSha,
      releaseSha: graph.releaseSha,
      legacy,
    });
    const input = {
      repository: graph.repository,
      currentBaseSha: graph.currentBaseSha,
      sourceBetaTag: "station-v1.2.0-beta.1",
      previous: {
        metadata: releaseMetadata({
          tagName: "station-v1.1.0",
          targetCommitish: graph.releaseSha,
        }),
        tree,
        allowLegacy: legacy,
      },
      firstBeta: null,
    };
    assert.deepEqual(await resolveStableChangelogBoundary(input), {
      fromSha: graph.baseSha,
      previousStableBaseSha: graph.baseSha,
    });
    if (legacy) {
      await assert.rejects(
        resolveStableChangelogBoundary({
          ...input,
          previous: { ...input.previous, allowLegacy: false },
        }),
        /invalid station stable boundary/,
      );
    }
  }
});

test("resolves first stable from the earliest published strict beta evidence", async () => {
  const { resolveStableChangelogBoundary } = await boundaryModule();
  const graph = await releaseGraph();
  const tree = await stagedTree({
    channel: "beta",
    version: "1.2.0-beta.1",
    baseSha: graph.baseSha,
    releaseSha: graph.releaseSha,
  });
  assert.deepEqual(
    await resolveStableChangelogBoundary({
      repository: graph.repository,
      currentBaseSha: graph.currentBaseSha,
      sourceBetaTag: "station-v1.2.0-beta.2",
      previous: null,
      firstBeta: {
        metadata: releaseMetadata({
          tagName: "station-v1.2.0-beta.1",
          targetCommitish: graph.releaseSha,
          isPrerelease: true,
        }),
        tree,
      },
    }),
    { fromSha: graph.rootSha, previousStableBaseSha: null },
  );
});

test("rejects wrong targets, invalid evidence and boundaries outside current beta ancestry", async () => {
  const { resolveStableChangelogBoundary } = await boundaryModule();
  const graph = await releaseGraph();
  const tree = await stagedTree({
    channel: "stable",
    version: "1.1.0",
    baseSha: graph.baseSha,
    releaseSha: graph.releaseSha,
  });
  const baseInput = {
    repository: graph.repository,
    currentBaseSha: graph.currentBaseSha,
    sourceBetaTag: "station-v1.2.0-beta.1",
    previous: {
      metadata: releaseMetadata({
        tagName: "station-v1.1.0",
        targetCommitish: graph.releaseSha,
      }),
      tree,
      allowLegacy: false,
    },
    firstBeta: null,
  };

  await assert.rejects(
    resolveStableChangelogBoundary({
      ...baseInput,
      previous: {
        ...baseInput.previous,
        metadata: releaseMetadata({
          tagName: "station-v1.1.0",
          targetCommitish: "f".repeat(40),
        }),
      },
    }),
    /invalid station stable boundary/,
  );

  const evidencePath = join(tree, stationAssetNames("1.1.0").evidence);
  const validEvidence = await readFile(evidencePath);
  await writeFile(evidencePath, "{}\n");
  await assert.rejects(
    resolveStableChangelogBoundary(baseInput),
    /invalid station stable boundary/,
  );
  await writeFile(evidencePath, validEvidence);

  await assert.rejects(
    resolveStableChangelogBoundary({ ...baseInput, currentBaseSha: graph.divergentBaseSha }),
    /invalid station stable boundary/,
  );
});
