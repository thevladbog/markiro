import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { stationReleaseLocation } from "./origins.mjs";
import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const SECRET_TEXT = /ghp_|github_pat_|TAURI_SIGNING_PRIVATE_KEY|api[_ -]?key|pairing_code/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHANNELS = new Set(["beta", "stable"]);
const ORIGINS = new Set(["github", "yandex"]);
const LEGACY_CLI_ORIGIN = "github";
const STABLE_PROVENANCE_KEYS = [
  "sourceBetaTag",
  "betaVersion",
  "betaReleaseSha",
  "betaEvidenceSha256",
  "acceptanceConfirmed",
  "previousStableTag",
  "previousStableBaseSha",
  "changelogFromSha",
  "changelogToSha",
];
const STABLE_EVIDENCE_KEYS = [
  "schemaVersion",
  "channel",
  "version",
  "publishedAt",
  "baseSha",
  "releaseSha",
  ...STABLE_PROVENANCE_KEYS,
  "authenticode",
  "physicalAcceptance",
  "notesSha256",
  "assets",
  "distribution",
];
const BETA_EVIDENCE_KEYS = [
  "schemaVersion",
  "channel",
  "version",
  "publishedAt",
  "baseSha",
  "releaseSha",
  "assets",
  "distribution",
];
const LEGACY_STABLE_EVIDENCE_KEYS = [
  "schemaVersion",
  "channel",
  "channelUrl",
  "version",
  "publishedAt",
  "baseSha",
  "releaseSha",
  ...STABLE_PROVENANCE_KEYS,
  "authenticode",
  "physicalAcceptance",
  "notesSha256",
  "assets",
];

function invalid() {
  throw new Error("invalid station release artifacts");
}

function releaseLocation(input) {
  try {
    return stationReleaseLocation(input);
  } catch {
    invalid();
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parsedVersion(channel, version) {
  if (typeof version !== "string") return null;
  if (channel === "beta") return parseStationBetaTag(`station-v${version}`);
  if (channel === "stable") return parseStationStableTag(`station-v${version}`);
  return null;
}

function ensureChannelVersion(channel, version) {
  if (!CHANNELS.has(channel) || parsedVersion(channel, version)?.text !== version) invalid();
}

function ensureAnyVersion(version) {
  if (
    typeof version !== "string" ||
    (!parseStationBetaTag(`station-v${version}`) && !parseStationStableTag(`station-v${version}`))
  ) {
    invalid();
  }
}

function ensureSafeText(value, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes)
    invalid();
  if (SECRET_TEXT.test(value) || UNSAFE_CONTROL_TEXT.test(value)) invalid();
}

function ensureDate(value) {
  if (typeof value !== "string") invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
  if (date.getTime() > Date.now()) invalid();
}

function releaseAssetUrl(location, assetName) {
  return new URL(assetName, `${location.releaseBaseUrl}/`).href;
}

function ensureBundleUrl(url, expectedUrl) {
  ensureSafeText(url, 2048);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid();
  }
  if (parsed.protocol !== "https:" || parsed.href !== url) invalid();
  if (
    url !== expectedUrl ||
    basename(parsed.pathname).includes("\r") ||
    basename(parsed.pathname).includes("\n")
  ) {
    invalid();
  }
}

export function stationAssetNames(version) {
  ensureAnyVersion(version);
  return {
    installer: `markiro-station-${version}-windows-x86_64-setup.exe`,
    bundle: `markiro-station-${version}-windows-x86_64.nsis.zip`,
    signature: `markiro-station-${version}-windows-x86_64.nsis.zip.sig`,
    manifest: "latest.json",
    checksums: "SHA256SUMS",
    notes: "release-notes.md",
    evidence: "release-evidence.json",
  };
}

export function createStationUpdateManifest({
  channel,
  origin,
  version,
  pubDate,
  bundleUrl,
  signature,
}) {
  ensureChannelVersion(channel, version);
  const names = stationAssetNames(version);
  ensureDate(pubDate);
  const location = releaseLocation({ channel, origin, version });
  ensureBundleUrl(bundleUrl, releaseAssetUrl(location, names.bundle));
  ensureSafeText(signature, MAX_SIGNATURE_BYTES);
  return {
    version,
    pub_date: pubDate,
    platforms: { "windows-x86_64": { url: bundleUrl, signature } },
  };
}

export function createBetaUpdateManifest(input) {
  return createStationUpdateManifest({ ...input, channel: "beta" });
}

function parseStationUpdateManifest(text, expected) {
  ensureSafeText(text);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid();
  if (Object.keys(manifest).sort().join(",") !== "platforms,pub_date,version") invalid();
  ensureChannelVersion(expected?.channel, manifest.version);
  ensureDate(manifest.pub_date);
  if (manifest.version !== expected?.version) invalid();
  if (!manifest.platforms || Object.keys(manifest.platforms).join(",") !== "windows-x86_64")
    invalid();
  const platform = manifest.platforms["windows-x86_64"];
  if (!platform || Object.keys(platform).sort().join(",") !== "signature,url") invalid();
  const location = releaseLocation({
    channel: expected?.channel,
    origin: expected?.origin,
    version: manifest.version,
  });
  ensureBundleUrl(
    platform.url,
    expected?.bundleUrl ?? releaseAssetUrl(location, stationAssetNames(manifest.version).bundle),
  );
  ensureSafeText(platform.signature, MAX_SIGNATURE_BYTES);
  return manifest;
}

function distributionFor(location) {
  return {
    origin: location.origin,
    channelUrl: location.channelUrl,
    releaseBaseUrl: location.releaseBaseUrl,
  };
}

function validateDistribution(distribution, location) {
  if (
    !hasExactKeys(distribution, ["origin", "channelUrl", "releaseBaseUrl"]) ||
    distribution.origin !== location.origin ||
    distribution.channelUrl !== location.channelUrl ||
    distribution.releaseBaseUrl !== location.releaseBaseUrl
  ) {
    invalid();
  }
}

export function parseBetaUpdateManifest(text, expected) {
  return parseStationUpdateManifest(text, { ...expected, channel: "beta" });
}

async function regularFile(path, maxBytes = MAX_ARTIFACT_BYTES) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) invalid();
  return info;
}

async function sha256(path) {
  const hash = createHash("sha256");
  const content = await readFile(path);
  hash.update(content);
  return hash.digest("hex");
}

function validateSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) invalid();
}

async function ensureEmptyDirectory(path) {
  try {
    await lstat(path);
    invalid();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

function compareStableVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  return 0;
}

function validateStableProvenance(provenance, version, baseSha) {
  if (!hasExactKeys(provenance, STABLE_PROVENANCE_KEYS)) invalid();
  const beta = parseStationBetaTag(provenance.sourceBetaTag);
  const stable = parseStationStableTag(`station-v${version}`);
  const previous =
    provenance.previousStableTag === null
      ? null
      : parseStationStableTag(provenance.previousStableTag);
  if (
    !beta ||
    !stable ||
    beta.text !== provenance.betaVersion ||
    beta.major !== stable.major ||
    beta.minor !== stable.minor ||
    beta.patch !== stable.patch ||
    !SHA.test(provenance.betaReleaseSha) ||
    !SHA256.test(provenance.betaEvidenceSha256) ||
    provenance.acceptanceConfirmed !== true ||
    !SHA.test(provenance.changelogFromSha) ||
    provenance.changelogToSha !== baseSha ||
    (provenance.previousStableTag === null) !== (provenance.previousStableBaseSha === null) ||
    (provenance.previousStableTag !== null &&
      (!previous ||
        !SHA.test(provenance.previousStableBaseSha) ||
        compareStableVersions(previous, stable) >= 0))
  ) {
    invalid();
  }
  return provenance;
}

export async function stageStationRelease({
  channel = "beta",
  origin,
  inputDirectory,
  outputDirectory,
  version,
  pubDate,
  baseSha,
  releaseSha,
  notesPath,
  stableProvenance,
}) {
  ensureChannelVersion(channel, version);
  const location = releaseLocation({ channel, origin, version });
  const names = stationAssetNames(version);
  ensureDate(pubDate);
  validateSha(baseSha);
  validateSha(releaseSha);
  if (channel === "stable") {
    validateStableProvenance(stableProvenance, version, baseSha);
    if (typeof notesPath !== "string" || notesPath.length === 0) invalid();
    await regularFile(notesPath, MAX_TEXT_BYTES);
    ensureSafeText(await readFile(notesPath, "utf8"));
  } else if (notesPath !== undefined || stableProvenance !== undefined) {
    invalid();
  }
  await ensureEmptyDirectory(outputDirectory);
  const inputNames = [names.installer, names.bundle, names.signature];
  for (const name of inputNames) await regularFile(join(inputDirectory, name));
  const signature = (await readFile(join(inputDirectory, names.signature), "utf8")).trim();
  ensureSafeText(signature, MAX_SIGNATURE_BYTES);
  const bundleUrl = releaseAssetUrl(location, names.bundle);
  const manifest = createStationUpdateManifest({
    channel,
    origin,
    version,
    pubDate,
    bundleUrl,
    signature,
  });
  const assets = {};
  for (const name of inputNames) {
    await copyFile(join(inputDirectory, name), join(outputDirectory, name));
    assets[name] = await sha256(join(outputDirectory, name));
  }
  await writeFile(join(outputDirectory, names.manifest), `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  assets[names.manifest] = await sha256(join(outputDirectory, names.manifest));
  const checksums = `${Object.entries(assets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
  await writeFile(join(outputDirectory, names.checksums), checksums, { flag: "wx", mode: 0o600 });
  if (channel === "stable") {
    await copyFile(notesPath, join(outputDirectory, names.notes));
    await chmod(join(outputDirectory, names.notes), 0o600);
  } else {
    await writeFile(
      join(outputDirectory, names.notes),
      [
        `Markiro Station ${version}`,
        "",
        "Manual Windows x64 beta release.",
        "Installer is unsigned; verify SHA256SUMS before manual installation.",
        "Acceptance status: Windows and hardware checks pending operator validation.",
        `baseSha: ${baseSha}`,
        `releaseSha: ${releaseSha}`,
        `publishedAt: ${pubDate}`,
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
  }
  const evidence =
    channel === "stable"
      ? {
          schemaVersion: 3,
          channel: "stable",
          version,
          publishedAt: pubDate,
          baseSha,
          releaseSha,
          ...stableProvenance,
          authenticode: false,
          physicalAcceptance: "NOT RUN",
          notesSha256: await sha256(join(outputDirectory, names.notes)),
          assets,
          distribution: distributionFor(location),
        }
      : {
          schemaVersion: 2,
          channel: "beta",
          version,
          publishedAt: pubDate,
          baseSha,
          releaseSha,
          assets,
          distribution: distributionFor(location),
        };
  await writeFile(join(outputDirectory, names.evidence), `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return evidence;
}

async function validateStationReleaseDirectoryInternal(
  directory,
  expected,
  { legacyGithubOnly } = {},
) {
  const channel = expected?.channel ?? "beta";
  ensureChannelVersion(channel, expected?.version);
  const origin = expected?.origin;
  const location = releaseLocation({ channel, origin, version: expected.version });
  if (legacyGithubOnly && origin !== "github") invalid();
  const names = stationAssetNames(expected.version);
  const entries = await readdir(directory);
  const allowed = new Set(Object.values(names));
  if (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry))) invalid();
  for (const name of [
    names.installer,
    names.bundle,
    names.signature,
    names.manifest,
    names.checksums,
    names.notes,
    names.evidence,
  ]) {
    await regularFile(
      join(directory, name),
      name === names.signature ? MAX_SIGNATURE_BYTES : MAX_ARTIFACT_BYTES,
    );
  }
  const manifest = parseStationUpdateManifest(
    await readFile(join(directory, names.manifest), "utf8"),
    {
      channel,
      origin,
      version: expected.version,
      bundleUrl: releaseAssetUrl(location, names.bundle),
    },
  );
  const detachedSignature = (await readFile(join(directory, names.signature), "utf8")).trim();
  ensureSafeText(detachedSignature, MAX_SIGNATURE_BYTES);
  if (manifest.platforms["windows-x86_64"].signature !== detachedSignature) invalid();
  const checksums = (await readFile(join(directory, names.checksums), "utf8"))
    .split("\n")
    .filter(Boolean);
  const expectedChecksumNames = [
    names.installer,
    names.bundle,
    names.signature,
    names.manifest,
  ].sort();
  if (checksums.length !== expectedChecksumNames.length) invalid();
  const seenChecksumNames = new Set();
  const checksumByName = new Map();
  for (const line of checksums) {
    const name = line.slice(66);
    if (
      !/^[0-9a-f]{64} {2}[^\r\n]+$/.test(line) ||
      !expectedChecksumNames.includes(name) ||
      seenChecksumNames.has(name)
    )
      invalid();
    seenChecksumNames.add(name);
    checksumByName.set(name, line.slice(0, 64));
  }
  for (const name of expectedChecksumNames)
    if (checksumByName.get(name) !== (await sha256(join(directory, name)))) invalid();
  let evidence;
  try {
    evidence = JSON.parse(await readFile(join(directory, names.evidence), "utf8"));
  } catch {
    invalid();
  }
  if (manifest.pub_date !== evidence.publishedAt) invalid();
  if (channel === "beta") {
    const isLegacy = hasExactKeys(evidence, [
      "assets",
      "baseSha",
      "publishedAt",
      "releaseSha",
      "version",
    ]);
    if (
      !(legacyGithubOnly && isLegacy) &&
      (!hasExactKeys(evidence, BETA_EVIDENCE_KEYS) ||
        evidence.schemaVersion !== 2 ||
        evidence.channel !== "beta")
    ) {
      invalid();
    }
    if (!isLegacy) validateDistribution(evidence.distribution, location);
  } else if (
    !(
      legacyGithubOnly &&
      hasExactKeys(evidence, LEGACY_STABLE_EVIDENCE_KEYS) &&
      evidence.schemaVersion === 2 &&
      evidence.channel === "stable" &&
      evidence.channelUrl === location.channelUrl
    ) &&
    (!hasExactKeys(evidence, STABLE_EVIDENCE_KEYS) ||
      evidence.schemaVersion !== 3 ||
      evidence.channel !== "stable")
  ) {
    invalid();
  }
  if (
    channel === "stable" &&
    (evidence.authenticode !== false ||
      evidence.physicalAcceptance !== "NOT RUN" ||
      !SHA256.test(evidence.notesSha256) ||
      evidence.notesSha256 !== (await sha256(join(directory, names.notes))))
  ) {
    invalid();
  }
  if (channel === "stable" && evidence.schemaVersion === 3)
    validateDistribution(evidence.distribution, location);
  if (
    evidence.version !== expected.version ||
    !isPlainObject(evidence.assets) ||
    Object.keys(evidence.assets).sort().join(",") !== expectedChecksumNames.join(",")
  ) {
    invalid();
  }
  if (channel === "stable") {
    validateStableProvenance(
      Object.fromEntries(STABLE_PROVENANCE_KEYS.map((key) => [key, evidence[key]])),
      expected.version,
      evidence.baseSha,
    );
  }
  for (const name of expectedChecksumNames)
    if (evidence.assets[name] !== checksumByName.get(name)) invalid();
  validateSha(evidence.baseSha);
  validateSha(evidence.releaseSha);
  ensureDate(evidence.publishedAt);
  ensureSafeText(await readFile(join(directory, names.notes), "utf8"));
  return {
    manifest,
    evidence,
    assets: Object.fromEntries(
      await Promise.all(entries.map(async (name) => [name, await sha256(join(directory, name))])),
    ),
  };
}

export async function validateStationReleaseDirectory(directory, expected) {
  return validateStationReleaseDirectoryInternal(directory, expected);
}

// Task 5 may call this only while seeding the one-time GitHub baseline.
export async function validateLegacyGithubStationReleaseDirectory(directory, expected) {
  return validateStationReleaseDirectoryInternal(
    directory,
    { ...expected, origin: "github" },
    { legacyGithubOnly: true },
  );
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function compareStationReleaseOrigins({
  githubDirectory,
  yandexDirectory,
  channel,
  version,
} = {}) {
  ensureChannelVersion(channel, version);
  const [github, yandex] = await Promise.all([
    validateStationReleaseDirectory(githubDirectory, { channel, origin: "github", version }),
    validateStationReleaseDirectory(yandexDirectory, { channel, origin: "yandex", version }),
  ]);
  const names = stationAssetNames(version);
  for (const name of [names.installer, names.bundle, names.signature, names.notes]) {
    if (github.assets[name] !== yandex.assets[name]) invalid();
  }
  const githubPlatform = github.manifest.platforms["windows-x86_64"];
  const yandexPlatform = yandex.manifest.platforms["windows-x86_64"];
  if (
    github.manifest.version !== yandex.manifest.version ||
    github.manifest.pub_date !== yandex.manifest.pub_date ||
    !sameValue(Object.keys(github.manifest.platforms), Object.keys(yandex.manifest.platforms)) ||
    githubPlatform.signature !== yandexPlatform.signature
  ) {
    invalid();
  }
  const commonEvidence = (evidence) => {
    const commonEvidence = { ...evidence, assets: { ...evidence.assets } };
    delete commonEvidence.distribution;
    delete commonEvidence.assets[names.manifest];
    return commonEvidence;
  };
  if (!sameValue(commonEvidence(github.evidence), commonEvidence(yandex.evidence))) invalid();
}

export async function checksumsForDirectory(directory, version) {
  const names = stationAssetNames(version);
  const files = [names.installer, names.bundle, names.signature, names.manifest];
  return `${(
    await Promise.all(files.map(async (name) => [name, await sha256(join(directory, name))]))
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === "stage-origin") {
    const [
      origin,
      channel,
      inputDirectory,
      outputDirectory,
      version,
      pubDate,
      baseSha,
      releaseSha,
      ...extra
    ] = args;
    if (
      !ORIGINS.has(origin) ||
      channel !== "beta" ||
      !inputDirectory ||
      !outputDirectory ||
      !version ||
      !pubDate ||
      !baseSha ||
      !releaseSha ||
      extra.length > 0
    ) {
      invalid();
    }
    await stageStationRelease({
      channel,
      origin,
      inputDirectory,
      outputDirectory,
      version,
      pubDate,
      baseSha,
      releaseSha,
    });
    return;
  }
  if (command === "validate-origin") {
    const [origin, channel, directory, version, ...extra] = args;
    if (
      !ORIGINS.has(origin) ||
      !CHANNELS.has(channel) ||
      !directory ||
      !version ||
      extra.length > 0
    ) {
      invalid();
    }
    await validateStationReleaseDirectory(directory, { channel, origin, version });
    return;
  }
  if (command === "compare-origins") {
    const [githubDirectory, yandexDirectory, channel, version, ...extra] = args;
    if (
      !githubDirectory ||
      !yandexDirectory ||
      !CHANNELS.has(channel) ||
      !version ||
      extra.length > 0
    ) {
      invalid();
    }
    await compareStationReleaseOrigins({
      githubDirectory,
      yandexDirectory,
      channel,
      version,
    });
    return;
  }
  if (command === "stage") {
    const hasChannel = CHANNELS.has(args[0]);
    const channel = hasChannel ? args.shift() : "beta";
    const [inputDirectory, outputDirectory, version, pubDate, baseSha, releaseSha, ...extra] = args;
    if (!inputDirectory || !outputDirectory || !version || !pubDate || !baseSha || !releaseSha)
      invalid();
    if (extra.length > 0) invalid();
    await stageStationRelease({
      channel,
      origin: LEGACY_CLI_ORIGIN,
      inputDirectory,
      outputDirectory,
      version,
      pubDate,
      baseSha,
      releaseSha,
    });
    return;
  }
  if (command === "stage-stable") {
    const [
      inputDirectory,
      outputDirectory,
      version,
      pubDate,
      baseSha,
      releaseSha,
      notesPath,
      provenanceJsonPath,
      ...extra
    ] = args;
    if (
      !inputDirectory ||
      !outputDirectory ||
      !version ||
      !pubDate ||
      !baseSha ||
      !releaseSha ||
      !notesPath ||
      !provenanceJsonPath ||
      extra.length > 0
    ) {
      invalid();
    }
    await regularFile(provenanceJsonPath, MAX_TEXT_BYTES);
    let stableProvenance;
    try {
      stableProvenance = JSON.parse(await readFile(provenanceJsonPath, "utf8"));
    } catch {
      invalid();
    }
    await stageStationRelease({
      channel: "stable",
      origin: LEGACY_CLI_ORIGIN,
      inputDirectory,
      outputDirectory,
      version,
      pubDate,
      baseSha,
      releaseSha,
      notesPath,
      stableProvenance,
    });
    return;
  }
  if (command === "checksums") {
    const [directory, version] = args;
    if (!directory || !version) invalid();
    process.stdout.write(await checksumsForDirectory(directory, version));
    return;
  }
  if (command === "validate") {
    const hasChannel = CHANNELS.has(args[0]);
    const channel = hasChannel ? args.shift() : "beta";
    const [directory, version, ...extra] = args;
    if (!directory || !version || extra.length > 0) invalid();
    await validateStationReleaseDirectory(directory, {
      channel,
      origin: LEGACY_CLI_ORIGIN,
      version,
    });
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
