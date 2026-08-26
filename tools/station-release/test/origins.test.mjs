import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareStationReleaseOrigins,
  stageStationRelease,
  stationAssetNames,
} from "../artifacts.mjs";
import { stationReleaseLocation } from "../origins.mjs";

const version = "0.2.0-beta.7";
const publishedAt = "2026-08-23T10:00:00.000Z";
const baseSha = "a".repeat(40);
const releaseSha = "b".repeat(40);

async function createInput(inputVersion = version, values = {}) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-origin-input-"));
  const names = stationAssetNames(inputVersion);
  for (const [name, content] of [
    [names.installer, values.installer ?? "installer"],
    [names.bundle, values.bundle ?? "bundle"],
    [names.signature, values.signature ?? "signature"],
  ]) {
    await writeFile(join(directory, name), content);
  }
  return directory;
}

async function stagePair({
  github = {},
  yandex = {},
  yandexVersion = version,
  yandexPubDate = publishedAt,
} = {}) {
  const githubInput = await createInput(version, github);
  const yandexInput = await createInput(yandexVersion, yandex);
  const githubDirectory = await mkdtemp(join(tmpdir(), "markiro-station-origin-github-"));
  const yandexDirectory = await mkdtemp(join(tmpdir(), "markiro-station-origin-yandex-"));
  await rm(githubDirectory, { recursive: true });
  await rm(yandexDirectory, { recursive: true });
  await stageStationRelease({
    channel: "beta",
    origin: "github",
    inputDirectory: githubInput,
    outputDirectory: githubDirectory,
    version,
    pubDate: publishedAt,
    baseSha,
    releaseSha,
  });
  await stageStationRelease({
    channel: "beta",
    origin: "yandex",
    inputDirectory: yandexInput,
    outputDirectory: yandexDirectory,
    version: yandexVersion,
    pubDate: yandexPubDate,
    baseSha,
    releaseSha,
  });
  return { githubDirectory, yandexDirectory };
}

test("maps canonical origins to their exact immutable and mutable locations", () => {
  const yandexBeta = stationReleaseLocation({ channel: "beta", origin: "yandex", version });
  assert.equal(Object.isFrozen(yandexBeta), true);
  assert.deepEqual(yandexBeta, {
    origin: "yandex",
    channelUrl: "https://releases.markiro.app/station/beta/latest.json",
    releaseBaseUrl: "https://releases.markiro.app/station/beta/releases/0.2.0-beta.7",
    immutablePrefix: "station/beta/releases/0.2.0-beta.7/",
    mutableManifestKey: "station/beta/latest.json",
    mutableInstallerKey: "station/beta/download",
  });
  assert.deepEqual(
    stationReleaseLocation({ channel: "stable", origin: "github", version: "0.2.0" }),
    {
      origin: "github",
      channelUrl:
        "https://github.com/thevladbog/markiro-station-releases/releases/download/station-stable-channel/latest.json",
      releaseBaseUrl:
        "https://github.com/thevladbog/markiro-station-releases/releases/download/station-v0.2.0",
      immutablePrefix: null,
      mutableManifestKey: null,
      mutableInstallerKey: null,
    },
  );
  assert.deepEqual(
    stationReleaseLocation({ channel: "stable", origin: "yandex", version: "0.2.0" }),
    {
      origin: "yandex",
      channelUrl: "https://releases.markiro.app/station/stable/latest.json",
      releaseBaseUrl: "https://releases.markiro.app/station/stable/releases/0.2.0",
      immutablePrefix: "station/stable/releases/0.2.0/",
      mutableManifestKey: "station/stable/latest.json",
      mutableInstallerKey: "station/download",
    },
  );
});

test("rejects channel-version mismatches and URL-shaped origin input", () => {
  for (const input of [
    { channel: "beta", origin: "github", version: "0.2.0" },
    { channel: "stable", origin: "yandex", version },
    { channel: "beta", origin: "https://releases.markiro.app", version },
    { channel: "beta", origin: "github", version: "0.2.0-beta.7/../../evil" },
    { channel: "beta", origin: "github", version: "0.2.0-beta.7?host=evil" },
    { channel: "beta", origin: "github", version, baseUrl: "https://evil.example" },
  ]) {
    assert.throws(() => stationReleaseLocation(input), /invalid station release origin/);
  }
});

test("accepts matching origin trees despite canonical manifest URL and metadata digest differences", async () => {
  const pair = await stagePair();
  await compareStationReleaseOrigins({ ...pair, channel: "beta", version });
});

test("rejects an origin tree whose updater target differs", async () => {
  const pair = await stagePair();
  const manifestPath = join(pair.yandexDirectory, "latest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.platforms = { "windows-aarch64": manifest.platforms["windows-x86_64"] };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    compareStationReleaseOrigins({ ...pair, channel: "beta", version }),
    /invalid station release artifacts/,
  );
});

for (const [name, options] of [
  ["bundle bytes", { yandex: { bundle: "different-bundle" } }],
  ["installer bytes", { yandex: { installer: "different-installer" } }],
  ["signature bytes and manifest signature", { yandex: { signature: "different-signature" } }],
  ["version", { yandexVersion: "0.2.0-beta.8" }],
  ["publication date", { yandexPubDate: "2026-08-23T11:00:00.000Z" }],
]) {
  test(`rejects origin trees with different ${name}`, async () => {
    const pair = await stagePair(options);
    await assert.rejects(
      compareStationReleaseOrigins({ ...pair, channel: "beta", version }),
      /invalid station release artifacts/,
    );
  });
}
