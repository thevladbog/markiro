import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_PREFIX = "https://github.com/thevladbog/markiro/releases/download/";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const SECRET_TEXT = /ghp_|github_pat_|TAURI_SIGNING_PRIVATE_KEY|api[_ -]?key|pairing_code/i;
const UNSAFE_CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_CHANNEL_URL = `${REPOSITORY_PREFIX}station-stable-channel/latest.json`;
const CHANNELS = new Set(["beta", "stable"]);
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

function ensureBundleUrl(version, url, expectedUrl = url) {
  ensureSafeText(url, 2048);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid();
  }
  const expectedPrefix = `${REPOSITORY_PREFIX}station-v${version}/`;
  if (parsed.protocol !== "https:" || parsed.href !== url || !url.startsWith(expectedPrefix))
    invalid();
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

export function createStationUpdateManifest({ channel, version, pubDate, bundleUrl, signature }) {
  ensureChannelVersion(channel, version);
  const names = stationAssetNames(version);
  ensureDate(pubDate);
  const expectedUrl = `${REPOSITORY_PREFIX}station-v${version}/${names.bundle}`;
  ensureBundleUrl(version, bundleUrl, expectedUrl);
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
  ensureBundleUrl(manifest.version, platform.url, expected?.bundleUrl);
  ensureSafeText(platform.signature, MAX_SIGNATURE_BYTES);
  return manifest;
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
  const bundleUrl = `${REPOSITORY_PREFIX}station-v${version}/${names.bundle}`;
  const manifest = createStationUpdateManifest({
    channel,
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
          schemaVersion: 2,
          channel: "stable",
          channelUrl: STABLE_CHANNEL_URL,
          version,
          publishedAt: pubDate,
          baseSha,
          releaseSha,
          ...stableProvenance,
          authenticode: false,
          physicalAcceptance: "NOT RUN",
          notesSha256: await sha256(join(outputDirectory, names.notes)),
          assets,
        }
      : { baseSha, releaseSha, version, publishedAt: pubDate, assets };
  await writeFile(join(outputDirectory, names.evidence), `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return evidence;
}

export async function validateStationReleaseDirectory(directory, expected) {
  const channel = expected?.channel ?? "beta";
  ensureChannelVersion(channel, expected?.version);
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
      version: expected.version,
      bundleUrl: `${REPOSITORY_PREFIX}station-v${expected.version}/${names.bundle}`,
    },
  );
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
      !/^[0-9a-f]{64}  [^\r\n]+$/.test(line) ||
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
  if (channel === "beta") {
    if (!hasExactKeys(evidence, ["assets", "baseSha", "publishedAt", "releaseSha", "version"])) {
      invalid();
    }
  } else if (
    !hasExactKeys(evidence, STABLE_EVIDENCE_KEYS) ||
    evidence.schemaVersion !== 2 ||
    evidence.channel !== "stable" ||
    evidence.channelUrl !== STABLE_CHANNEL_URL ||
    evidence.authenticode !== false ||
    evidence.physicalAcceptance !== "NOT RUN" ||
    !SHA256.test(evidence.notesSha256) ||
    evidence.notesSha256 !== (await sha256(join(directory, names.notes)))
  ) {
    invalid();
  }
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
  if (command === "stage") {
    const hasChannel = CHANNELS.has(args[0]);
    const channel = hasChannel ? args.shift() : "beta";
    const [inputDirectory, outputDirectory, version, pubDate, baseSha, releaseSha, ...extra] = args;
    if (!inputDirectory || !outputDirectory || !version || !pubDate || !baseSha || !releaseSha)
      invalid();
    if (extra.length > 0) invalid();
    await stageStationRelease({
      channel,
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
    await validateStationReleaseDirectory(directory, { channel, version });
    return;
  }
  invalid();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
