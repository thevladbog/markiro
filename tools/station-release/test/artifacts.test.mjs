import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBetaUpdateManifest,
  createStationUpdateManifest,
  parseBetaUpdateManifest,
  stageStationRelease,
  stationAssetNames,
  validateLegacyGithubStationReleaseDirectory,
  validateStationReleaseDirectory,
} from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";

const version = "0.1.0-beta.1";
const names = stationAssetNames(version);
const bundleUrl = `https://github.com/thevladbog/markiro/releases/download/station-v${version}/${names.bundle}`;
const stableVersion = "0.1.0";
const stableNames = stationAssetNames(stableVersion);
const stableBundleUrl = `https://github.com/thevladbog/markiro/releases/download/station-v${stableVersion}/${stableNames.bundle}`;

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
  assert.match(await readFile(join(output, names.checksums), "utf8"), /[0-9a-f]{64}  latest\.json/);
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
  const evidencePath = join(output, stableNames.evidence);
  const legacyEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  delete legacyEvidence.distribution;
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      ...legacyEvidence,
      schemaVersion: 2,
      channelUrl: stationReleaseLocation({
        channel: "stable",
        origin: "github",
        version: stableVersion,
      }).channelUrl,
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
  await writeFile(checksumPath, checksums.replace(/^./, "0"));
  await assert.rejects(
    validateStationReleaseDirectory(output, { origin: "github", version }),
    /invalid station release artifacts/,
  );
});
