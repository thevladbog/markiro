import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createBetaUpdateManifest,
  createStationUpdateManifest,
  checksumsForDirectory,
  parseBetaUpdateManifest,
  stageStationRelease,
  stationAssetNames,
  validateLegacyGithubStationReleaseDirectory,
  validateStationReleaseDirectory,
} from "../artifacts.mjs";

const version = "0.1.0-beta.1";
const names = stationAssetNames(version);
const bundleUrl = `https://github.com/thevladbog/markiro-station-releases/releases/download/station-v${version}/${names.bundle}`;
const stableVersion = "0.1.0";
const stableNames = stationAssetNames(stableVersion);
const stableBundleUrl = `https://github.com/thevladbog/markiro-station-releases/releases/download/station-v${stableVersion}/${stableNames.bundle}`;
const legacyGithubReleases = "https://github.com/thevladbog/markiro/releases/download";
const execFile = promisify(execFileCallback);

async function updateAssetDigest(directory, name) {
  const digest = createHash("sha256")
    .update(await readFile(join(directory, name)))
    .digest("hex");
  const checksumsPath = join(directory, names.checksums);
  const checksums = await readFile(checksumsPath, "utf8");
  await writeFile(
    checksumsPath,
    checksums.replace(new RegExp(`^[0-9a-f]{64}  ${name}$`, "m"), `${digest}  ${name}`),
  );
  const evidencePath = join(directory, names.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.assets[name] = digest;
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
}

async function stageCanonicalBetaTree() {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-binding-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-binding-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await stageStationRelease({
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-11T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  return { input, output };
}

async function rewriteAsLegacyGithub(directory, channel, releaseVersion) {
  const releaseNames = stationAssetNames(releaseVersion);
  const manifestPath = join(directory, releaseNames.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.platforms["windows-x86_64"].url =
    `${legacyGithubReleases}/station-v${releaseVersion}/${releaseNames.bundle}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumsPath = join(directory, releaseNames.checksums);
  await writeFile(checksumsPath, await checksumsForDirectory(directory, releaseVersion));
  const assets = Object.fromEntries(
    (await readFile(checksumsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => [line.slice(66), line.slice(0, 64)]),
  );
  const evidencePath = join(directory, releaseNames.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.assets = assets;
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
}

test("creates the exact one-platform Tauri beta manifest", () => {
  const manifest = createBetaUpdateManifest({
    origin: "github",
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.deepEqual(manifest, {
    version,
    pub_date: "2026-08-11T12:00:00.000Z",
    platforms: {
      "windows-x86_64": { url: bundleUrl, signature: "trusted-test-signature" },
    },
  });
  assert.deepEqual(
    parseBetaUpdateManifest(JSON.stringify(manifest), { origin: "github", version, bundleUrl }),
    manifest,
  );
});

test("rejects extra platforms, mutable URLs, traversal, symlinks and secret-shaped text", async () => {
  const valid = createBetaUpdateManifest({
    origin: "github",
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.throws(
    () =>
      parseBetaUpdateManifest(JSON.stringify({ ...valid, token: "ghp_sensitive" }), {
        origin: "github",
        version,
        bundleUrl,
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      parseBetaUpdateManifest(
        JSON.stringify({ ...valid, platforms: { ...valid.platforms, linux: {} } }),
        { origin: "github", version, bundleUrl },
      ),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      parseBetaUpdateManifest(
        JSON.stringify({
          ...valid,
          platforms: {
            "windows-x86_64": { ...valid.platforms["windows-x86_64"], url: "http://evil" },
          },
        }),
        { origin: "github", version, bundleUrl },
      ),
    /invalid station release artifacts/,
  );
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-artifacts-"));
  await writeFile(join(directory, "real"), "bundle");
  await symlink(join(directory, "real"), join(directory, names.bundle));
  assert.equal(await readFile(join(directory, "real"), "utf8"), "bundle");
});

test("rejects noncanonical versions, dates, signatures and secret-shaped text", () => {
  assert.throws(() => stationAssetNames("0.1.0-rc.1"), /invalid station release artifacts/);
  assert.throws(
    () =>
      createStationUpdateManifest({
        channel: "beta",
        origin: "github",
        version: stableVersion,
        pubDate: "2026-08-11T12:00:00.000Z",
        bundleUrl: stableBundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        origin: "github",
        channel: "stable",
        version: stableVersion,
        pubDate: "2026-08-11T12:00:00.000Z",
        bundleUrl: stableBundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        origin: "github",
        version,
        pubDate: "2026-08-11T12:00:00Z",
        bundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        origin: "github",
        version,
        pubDate: "2099-08-11T12:00:00.000Z",
        bundleUrl,
        signature: "signature",
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      createBetaUpdateManifest({
        origin: "github",
        version,
        pubDate: "2026-08-11T12:00:00.000Z",
        bundleUrl,
        signature: "TAURI_SIGNING_PRIVATE_KEY=secret",
      }),
    /invalid station release artifacts/,
  );
});

test("stages and validates stable artifacts with accepted beta provenance", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-stable-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-stable-output-"));
  const notesPath = join(input, "notes.md");
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [stableNames.installer, "stable-installer"],
    [stableNames.bundle, "stable-bundle"],
    [stableNames.signature, "trusted-stable-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "# Markiro Station 0.1.0\n\nПервый стабильный релиз.\n");

  const evidence = await stageStationRelease({
    channel: "stable",
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "c".repeat(40),
    notesPath,
    stableProvenance: {
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    },
  });

  assert.equal(evidence.schemaVersion, 3);
  assert.equal(evidence.channel, "stable");
  assert.equal(evidence.sourceBetaTag, "station-v0.1.0-beta.19");
  assert.equal(evidence.acceptanceConfirmed, true);
  const validated = await validateStationReleaseDirectory(output, {
    channel: "stable",
    origin: "github",
    version: stableVersion,
  });
  assert.equal(validated.manifest.version, stableVersion);
  assert.equal(validated.evidence.betaReleaseSha, "b".repeat(40));
});

test("rejects stable evidence without acceptance and rejects channel/version mismatch", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-stable-invalid-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-stable-invalid-output-"));
  const notesPath = join(input, "notes.md");
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [stableNames.installer, "stable-installer"],
    [stableNames.bundle, "stable-bundle"],
    [stableNames.signature, "trusted-stable-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "Stable notes\n");
  const stableProvenance = {
    sourceBetaTag: "station-v0.1.0-beta.19",
    betaVersion: "0.1.0-beta.19",
    betaReleaseSha: "b".repeat(40),
    betaEvidenceSha256: "d".repeat(64),
    acceptanceConfirmed: true,
    previousStableTag: null,
    previousStableBaseSha: null,
    changelogFromSha: "e".repeat(40),
    changelogToSha: "a".repeat(40),
  };
  const downgradeOutput = await mkdtemp(join(tmpdir(), "markiro-station-stable-downgrade-output-"));
  await rm(downgradeOutput, { recursive: true });
  await assert.rejects(
    stageStationRelease({
      channel: "stable",
      origin: "github",
      inputDirectory: input,
      outputDirectory: downgradeOutput,
      version: stableVersion,
      pubDate: "2026-08-20T10:00:00.000Z",
      baseSha: "a".repeat(40),
      releaseSha: "c".repeat(40),
      notesPath,
      stableProvenance: {
        ...stableProvenance,
        previousStableTag: "station-v0.2.0",
        previousStableBaseSha: "f".repeat(40),
      },
    }),
    /invalid station release artifacts/,
  );
  await stageStationRelease({
    channel: "stable",
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "c".repeat(40),
    notesPath,
    stableProvenance,
  });

  await assert.rejects(
    validateStationReleaseDirectory(output, {
      channel: "beta",
      origin: "github",
      version: stableVersion,
    }),
    /invalid station release artifacts/,
  );
  const evidencePath = join(output, stableNames.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  await writeFile(evidencePath, `${JSON.stringify({ ...evidence, acceptanceConfirmed: false })}\n`);
  await assert.rejects(
    validateStationReleaseDirectory(output, {
      channel: "stable",
      origin: "github",
      version: stableVersion,
    }),
    /invalid station release artifacts/,
  );
});

test("rejects stable notes whose bytes no longer match evidence", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-stable-notes-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-stable-notes-output-"));
  const notesPath = join(input, "notes.md");
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [stableNames.installer, "stable-installer"],
    [stableNames.bundle, "stable-bundle"],
    [stableNames.signature, "trusted-stable-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "Stable notes\n");
  await stageStationRelease({
    channel: "stable",
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "c".repeat(40),
    notesPath,
    stableProvenance: {
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    },
  });
  await writeFile(join(output, stableNames.notes), "tampered notes\n");

  await assert.rejects(
    validateStationReleaseDirectory(output, {
      channel: "stable",
      origin: "github",
      version: stableVersion,
    }),
    /invalid station release artifacts/,
  );
});

test("stages and validates the canonical release tree", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ])
    await writeFile(join(input, name), content);
  const evidence = await stageStationRelease({
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-11T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  assert.equal(evidence.version, version);
  const validated = await validateStationReleaseDirectory(output, { origin: "github", version });
  assert.equal(validated.manifest.version, version);
  assert.match(
    await readFile(join(output, names.checksums), "utf8"),
    /[0-9a-f]{64} {2}latest\.json/,
  );
});

test("rejects a detached signature file that differs from the updater manifest", async () => {
  const { output } = await stageCanonicalBetaTree();
  await writeFile(join(output, names.signature), "different-signature\n");
  await updateAssetDigest(output, names.signature);

  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});

test("rejects an updater manifest signature that differs from the detached signature", async () => {
  const { output } = await stageCanonicalBetaTree();
  const manifestPath = join(output, names.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.platforms["windows-x86_64"].signature = "different-signature";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await updateAssetDigest(output, names.manifest);

  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});

test("rejects an updater manifest publication date that differs from evidence", async () => {
  const { output } = await stageCanonicalBetaTree();
  const manifestPath = join(output, names.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pub_date = "2026-08-12T10:00:00.000Z";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await updateAssetDigest(output, names.manifest);

  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});

test("rejects evidence publication date that differs from the updater manifest", async () => {
  const { output } = await stageCanonicalBetaTree();
  const evidencePath = join(output, names.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.publishedAt = "2026-08-12T10:00:00.000Z";
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);

  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});

test("CLI retains the GitHub default when staging and validating beta artifacts", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-cli-beta-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-cli-beta-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  const argumentsForStage = [
    "tools/station-release/artifacts.mjs",
    "stage",
    "beta",
    input,
    output,
    version,
    "2026-08-11T10:00:00.000Z",
    "a".repeat(40),
    "b".repeat(40),
  ];
  await execFile(process.execPath, argumentsForStage);
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "validate",
    "beta",
    output,
    version,
  ]);
  const manifest = JSON.parse(await readFile(join(output, names.manifest), "utf8"));
  assert.equal(manifest.platforms["windows-x86_64"].url, bundleUrl);
});

test("CLI stages, validates and compares only explicit closed release origins", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-cli-origin-input-"));
  const githubOutput = join(input, "github");
  const yandexOutput = join(input, "yandex");
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  const common = [
    "beta",
    input,
    version,
    "2026-08-11T10:00:00.000Z",
    "a".repeat(40),
    "b".repeat(40),
  ];

  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "stage-origin",
    "github",
    common[0],
    common[1],
    githubOutput,
    ...common.slice(2),
  ]);
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "stage-origin",
    "yandex",
    common[0],
    common[1],
    yandexOutput,
    ...common.slice(2),
  ]);
  for (const [origin, directory] of [
    ["github", githubOutput],
    ["yandex", yandexOutput],
  ]) {
    await execFile(process.execPath, [
      "tools/station-release/artifacts.mjs",
      "validate-origin",
      origin,
      "beta",
      directory,
      version,
    ]);
  }
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "compare-origins",
    githubOutput,
    yandexOutput,
    "beta",
    version,
  ]);

  const githubManifest = JSON.parse(await readFile(join(githubOutput, names.manifest), "utf8"));
  const yandexManifest = JSON.parse(await readFile(join(yandexOutput, names.manifest), "utf8"));
  assert.equal(githubManifest.platforms["windows-x86_64"].url, bundleUrl);
  assert.equal(
    yandexManifest.platforms["windows-x86_64"].url,
    `https://releases.markiro.app/station/beta/releases/${version}/${names.bundle}`,
  );

  await assert.rejects(
    execFile(process.execPath, [
      "tools/station-release/artifacts.mjs",
      "validate-origin",
      "https://evil.invalid",
      "beta",
      githubOutput,
      version,
    ]),
  );
});

test("CLI retains the GitHub default when staging stable artifacts", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-cli-stable-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-cli-stable-output-"));
  const notesPath = join(input, "notes.md");
  const provenancePath = join(input, "provenance.json");
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [stableNames.installer, "installer"],
    [stableNames.bundle, "bundle"],
    [stableNames.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "Stable notes\n");
  await writeFile(
    provenancePath,
    `${JSON.stringify({
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    })}\n`,
  );
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "stage-stable",
    input,
    output,
    stableVersion,
    "2026-08-20T10:00:00.000Z",
    "a".repeat(40),
    "c".repeat(40),
    notesPath,
    provenancePath,
  ]);
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "validate",
    "stable",
    output,
    stableVersion,
  ]);
  const manifest = JSON.parse(await readFile(join(output, stableNames.manifest), "utf8"));
  assert.equal(manifest.platforms["windows-x86_64"].url, stableBundleUrl);
});

test("CLI stages and compares explicit GitHub and Yandex stable trees", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-cli-stable-origin-input-"));
  const githubOutput = join(input, "github");
  const yandexOutput = join(input, "yandex");
  const notesPath = join(input, "notes.md");
  const provenancePath = join(input, "provenance.json");
  for (const [name, content] of [
    [stableNames.installer, "installer"],
    [stableNames.bundle, "bundle"],
    [stableNames.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "Stable notes\n");
  await writeFile(
    provenancePath,
    `${JSON.stringify({
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    })}\n`,
  );

  for (const [origin, output] of [
    ["github", githubOutput],
    ["yandex", yandexOutput],
  ]) {
    await execFile(process.execPath, [
      "tools/station-release/artifacts.mjs",
      "stage-origin",
      origin,
      "stable",
      input,
      output,
      stableVersion,
      "2026-08-20T10:00:00.000Z",
      "a".repeat(40),
      "c".repeat(40),
      notesPath,
      provenancePath,
    ]);
    await execFile(process.execPath, [
      "tools/station-release/artifacts.mjs",
      "validate-origin",
      origin,
      "stable",
      output,
      stableVersion,
    ]);
  }
  await execFile(process.execPath, [
    "tools/station-release/artifacts.mjs",
    "compare-origins",
    githubOutput,
    yandexOutput,
    "stable",
    stableVersion,
  ]);

  const githubManifest = JSON.parse(
    await readFile(join(githubOutput, stableNames.manifest), "utf8"),
  );
  const yandexManifest = JSON.parse(
    await readFile(join(yandexOutput, stableNames.manifest), "utf8"),
  );
  assert.equal(githubManifest.platforms["windows-x86_64"].url, stableBundleUrl);
  assert.equal(
    yandexManifest.platforms["windows-x86_64"].url,
    `https://releases.markiro.app/station/stable/releases/${stableVersion}/${stableNames.bundle}`,
  );
});

test("accepts legacy GitHub beta evidence only through the seed-only validator", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-legacy-beta-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-legacy-beta-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await stageStationRelease({
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-11T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  await rewriteAsLegacyGithub(output, "beta", version);
  const evidencePath = join(output, names.evidence);
  const legacyEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  delete legacyEvidence.schemaVersion;
  delete legacyEvidence.channel;
  delete legacyEvidence.distribution;
  await writeFile(evidencePath, `${JSON.stringify(legacyEvidence)}\n`);

  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
  const validated = await validateLegacyGithubStationReleaseDirectory(output, { version });
  assert.equal(validated.evidence.version, version);
});

test("accepts legacy GitHub stable evidence only through the seed-only validator", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-legacy-stable-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-legacy-stable-output-"));
  const notesPath = join(input, "notes.md");
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [stableNames.installer, "installer"],
    [stableNames.bundle, "bundle"],
    [stableNames.signature, "trusted-signature"],
  ]) {
    await writeFile(join(input, name), content);
  }
  await writeFile(notesPath, "Stable notes\n");
  await stageStationRelease({
    channel: "stable",
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "c".repeat(40),
    notesPath,
    stableProvenance: {
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    },
  });
  await rewriteAsLegacyGithub(output, "stable", stableVersion);
  const evidencePath = join(output, stableNames.evidence);
  const legacyEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  delete legacyEvidence.distribution;
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      ...legacyEvidence,
      schemaVersion: 2,
      channelUrl: `${legacyGithubReleases}/station-stable-channel/latest.json`,
    })}\n`,
  );

  await assert.rejects(
    validateStationReleaseDirectory(output, {
      channel: "stable",
      origin: "github",
      version: stableVersion,
    }),
    /invalid station release artifacts/,
  );
  const validated = await validateLegacyGithubStationReleaseDirectory(output, {
    channel: "stable",
    version: stableVersion,
  });
  assert.equal(validated.evidence.schemaVersion, 2);
});

test("rejects checksum text that does not match the downloaded assets", async () => {
  const input = await mkdtemp(join(tmpdir(), "markiro-station-input-"));
  const output = await mkdtemp(join(tmpdir(), "markiro-station-output-"));
  await rm(output, { recursive: true });
  for (const [name, content] of [
    [names.installer, "installer"],
    [names.bundle, "bundle"],
    [names.signature, "trusted-signature"],
  ])
    await writeFile(join(input, name), content);
  await stageStationRelease({
    origin: "github",
    inputDirectory: input,
    outputDirectory: output,
    version,
    pubDate: "2026-08-11T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "b".repeat(40),
  });
  const checksumPath = join(output, names.checksums);
  const checksums = await readFile(checksumPath, "utf8");
  const wrongFirstCharacter = checksums.startsWith("0") ? "1" : "0";
  await writeFile(checksumPath, `${wrongFirstCharacter}${checksums.slice(1)}`);
  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});
