import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareStationReleaseOrigins,
  stageStationRelease,
  stationAssetNames,
  validateLegacyGithubStationReleaseDirectory,
  validateStationReleaseDirectory,
} from "./artifacts.mjs";
import { createStationObjectStore, validateStationImmutableObject } from "./object-storage.mjs";
import { stationReleaseLocation } from "./origins.mjs";
import { parseStationBetaTag, parseStationStableTag } from "./version.mjs";

const PUBLIC_BASE_URL = "https://releases.markiro.app";
const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";
const MAX_BACKUP_INDEX_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MUTABLE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const BOOTSTRAP_CONFIRMATION = "--confirm-empty-channel-bootstrap";
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
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
const CONTENT_TYPES = Object.freeze({
  installer: "application/vnd.microsoft.portable-executable",
  bundle: "application/zip",
  signature: "text/plain",
  manifest: "application/json",
  checksums: "text/plain",
  notes: "text/markdown",
  evidence: "application/json",
});

function invalid() {
  throw new Error("invalid station release publication");
}

function publicationFailed() {
  throw new Error("station release publication failed");
}

function baselineRecoveryFailed() {
  throw new Error("station release baseline recovery failed");
}

function invalidBackup() {
  throw new Error("invalid station release backup");
}

function commandInvalid() {
  throw new Error("invalid station release publisher command");
}

function environmentInvalid() {
  throw new Error("invalid station release publisher environment");
}

function bootstrapInvalid() {
  throw new Error("invalid station release bootstrap");
}

function incompleteBaseline() {
  throw new Error("incomplete station release baseline");
}

function validBucket(bucket) {
  return (
    typeof bucket === "string" &&
    bucket.length >= 3 &&
    bucket.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) &&
    !bucket.includes("..")
  );
}

async function closePublicBody(body) {
  if (!body || typeof body !== "object") return;
  try {
    if (typeof body.destroy === "function") await body.destroy();
    else if (typeof body.cancel === "function") await body.cancel();
  } catch {
    // A cleanup failure must not expose a provider response.
  }
}

async function readBoundedPublicBody(body, contentLength, maxBytes) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_INSTALLER_BYTES ||
    (contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes))
  ) {
    await closePublicBody(body);
    bootstrapInvalid();
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength === 0 || body.byteLength > maxBytes) bootstrapInvalid();
    return Buffer.from(body);
  }
  if (!body || typeof body !== "object") bootstrapInvalid();

  let iterable = body;
  if (!(Symbol.asyncIterator in iterable)) {
    if (typeof body.getReader !== "function") bootstrapInvalid();
    iterable = {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of iterable) {
    if (!(chunk instanceof Uint8Array)) bootstrapInvalid();
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      await closePublicBody(body);
      bootstrapInvalid();
    }
    chunks.push(bytes);
  }
  if (total === 0) bootstrapInvalid();
  return Buffer.concat(chunks, total);
}

export function createYandexProviderReader({ bucket, fetchImpl = fetch } = {}) {
  if (!validBucket(bucket) || typeof fetchImpl !== "function") bootstrapInvalid();
  return Object.freeze({
    async readPublic(key, expected) {
      if (
        typeof key !== "string" ||
        !/^station\/[a-z0-9./_-]+$/.test(key) ||
        key.includes("..") ||
        key.includes("//") ||
        !hasExactKeys(expected, [
          "contentType",
          "cacheControl",
          "contentDisposition",
          "maxBytes",
        ]) ||
        typeof expected.contentType !== "string" ||
        typeof expected.cacheControl !== "string" ||
        (expected.contentDisposition !== null && typeof expected.contentDisposition !== "string")
      ) {
        bootstrapInvalid();
      }
      const url = `${YANDEX_S3_ENDPOINT}/${bucket}/${key}`;
      let response;
      try {
        response = await fetchImpl(url, { redirect: "error", cache: "no-store" });
        if (
          !response?.ok ||
          response.redirected === true ||
          (typeof response.url === "string" && response.url.length > 0 && response.url !== url) ||
          response.headers?.get?.("content-type") !== expected.contentType ||
          response.headers?.get?.("cache-control") !== expected.cacheControl ||
          response.headers?.get?.("content-disposition") !== expected.contentDisposition
        ) {
          bootstrapInvalid();
        }
        const lengthText = response.headers?.get?.("content-length");
        const contentLength =
          lengthText === null || lengthText === undefined ? undefined : Number(lengthText);
        return await readBoundedPublicBody(response.body, contentLength, expected.maxBytes);
      } catch (error) {
        await closePublicBody(response?.body);
        if (error?.message === "invalid station release bootstrap") throw error;
        bootstrapInvalid();
      }
    },
  });
}

function ensureChannel(channel) {
  if (!CHANNELS.has(channel)) invalid();
}

function ensureChannelVersion(channel, version) {
  try {
    return stationReleaseLocation({ channel, origin: "yandex", version });
  } catch {
    invalid();
  }
}

async function canonicalExistingDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalid();
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  } catch (error) {
    if (error?.message === "invalid station release publication") throw error;
    invalid();
  }
  return path;
}

function ensureNewAbsoluteDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) invalid();
}

async function validateLocalTree(tree, channel, version) {
  await canonicalExistingDirectory(tree);
  ensureChannelVersion(channel, version);
  try {
    return await validateStationReleaseDirectory(tree, { channel, origin: "yandex", version });
  } catch {
    invalid();
  }
}

function descriptors(channel, version, tree) {
  const location = ensureChannelVersion(channel, version);
  const names = stationAssetNames(version);
  return [
    [names.installer, CONTENT_TYPES.installer],
    [names.bundle, CONTENT_TYPES.bundle],
    [names.signature, CONTENT_TYPES.signature],
    [names.manifest, CONTENT_TYPES.manifest],
    [names.checksums, CONTENT_TYPES.checksums],
    [names.notes, CONTENT_TYPES.notes],
    [names.evidence, CONTENT_TYPES.evidence],
  ].map(([name, contentType]) => ({
    name,
    key: `${location.immutablePrefix}${name}`,
    file: join(tree, name),
    contentType,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentDisposition: null,
    maxBytes:
      name === names.signature
        ? MAX_SIGNATURE_BYTES
        : name === names.installer || name === names.bundle
          ? MAX_INSTALLER_BYTES
          : MAX_BACKUP_INDEX_BYTES,
  }));
}

function equalBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

async function readPublicTree({ reader, tree, channel, version }) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-public-"));
  try {
    const objects = descriptors(channel, version, tree);
    for (const object of objects) {
      const bytes = await reader.readPublic(object.key, {
        contentType: object.contentType,
        cacheControl: object.cacheControl,
        contentDisposition: object.contentDisposition,
        maxBytes: object.maxBytes,
      });
      await writeFile(join(directory, object.name), bytes, { flag: "wx", mode: 0o600 });
    }
    let local;
    let remote;
    try {
      [local, remote] = await Promise.all([
        validateStationReleaseDirectory(tree, { channel, origin: "yandex", version }),
        validateStationReleaseDirectory(directory, { channel, origin: "yandex", version }),
      ]);
    } catch {
      publicationFailed();
    }
    for (const object of objects) {
      if (local.assets[object.name] !== remote.assets[object.name]) publicationFailed();
    }
  } catch (error) {
    if (error?.message === "station release publication failed") throw error;
    publicationFailed();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function inferVersion(tree, channel) {
  await canonicalExistingDirectory(tree);
  let evidence;
  try {
    const info = await lstat(join(tree, "release-evidence.json"));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > MAX_BACKUP_INDEX_BYTES
    )
      invalid();
    evidence = JSON.parse(await readFile(join(tree, "release-evidence.json"), "utf8"));
  } catch (error) {
    if (error?.message === "invalid station release publication") throw error;
    invalid();
  }
  if (evidence?.channel !== channel || typeof evidence.version !== "string") invalid();
  ensureChannelVersion(channel, evidence.version);
  await validateLocalTree(tree, channel, evidence.version);
  return evidence.version;
}

function mutableDescriptors(channel) {
  ensureChannel(channel);
  const version = channel === "beta" ? "0.0.1-beta.1" : "0.0.1";
  const location = ensureChannelVersion(channel, version);
  return [
    {
      key: location.mutableManifestKey,
      expectedContentType: CONTENT_TYPES.manifest,
      maxBytes: MAX_BACKUP_INDEX_BYTES,
      sourceKind: "none",
    },
    {
      key: location.mutableInstallerKey,
      expectedContentType: CONTENT_TYPES.installer,
      maxBytes: MAX_INSTALLER_BYTES,
      sourceKind: "immutable-installer",
    },
  ];
}

function immutableInstallerSource(sourceKey, channel) {
  if (typeof sourceKey !== "string" || sourceKey.includes("\\") || sourceKey.includes("..")) {
    invalidBackup();
  }
  const parts = sourceKey.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== "station" ||
    parts[1] !== channel ||
    parts[2] !== "releases"
  ) {
    invalidBackup();
  }
  const version = parts[3];
  let location;
  let names;
  try {
    location = stationReleaseLocation({ channel, origin: "yandex", version });
    names = stationAssetNames(version);
  } catch {
    invalidBackup();
  }
  if (sourceKey !== `${location.immutablePrefix}${names.installer}`) invalidBackup();
  return { immutableKey: sourceKey, attachmentFilename: names.installer };
}

function validSourceKey(sourceKey, descriptor, channel) {
  if (descriptor.sourceKind === "none") return sourceKey === null;
  try {
    immutableInstallerSource(sourceKey, channel);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeExclusive(path, bytes) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeBackup(backupDirectory, channel, objects) {
  ensureNewAbsoluteDirectory(backupDirectory);
  if (objects.length !== 2 || objects.some((object) => object.bytes.byteLength === 0)) {
    throw new Error("complete mutable backup required");
  }
  const expected = mutableDescriptors(channel);
  if (
    objects.some(
      (object, index) =>
        object.key !== expected[index].key ||
        object.contentType !== expected[index].expectedContentType ||
        object.bytes.byteLength > expected[index].maxBytes ||
        !validSourceKey(object.sourceKey, expected[index], channel),
    )
  ) {
    throw new Error("complete mutable backup required");
  }
  let created = false;
  try {
    await canonicalExistingDirectory(dirname(backupDirectory));
    await mkdir(backupDirectory, { mode: 0o700 });
    created = true;
    const index = { schemaVersion: 1, channel, objects: [] };
    for (const [position, object] of objects.entries()) {
      const backupPath = `object-${position}.bin`;
      await writeExclusive(join(backupDirectory, backupPath), object.bytes);
      index.objects.push({
        key: object.key,
        contentType: object.contentType,
        sha256: sha256(object.bytes),
        backupPath,
        sourceKey: object.sourceKey,
      });
    }
    await writeExclusive(
      join(backupDirectory, "backup.json"),
      `${JSON.stringify(index, null, 2)}\n`,
    );
    return index;
  } catch (error) {
    if (error?.message === "complete mutable backup required") throw error;
    if (created) {
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    invalidBackup();
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function readBootstrapJson(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) bootstrapInvalid();
  let bytes;
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > MAX_BACKUP_INDEX_BYTES
    ) {
      bootstrapInvalid();
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error?.message === "invalid station release bootstrap") throw error;
    bootstrapInvalid();
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
  } catch {
    bootstrapInvalid();
  }
}

function validateInfrastructureEvidence(evidence) {
  if (
    !hasExactKeys(evidence, [
      "schemaVersion",
      "targetSha",
      "planSha256",
      "planVersionId",
      "enableStationReleasePublicDns",
    ]) ||
    evidence.schemaVersion !== 1 ||
    !SHA.test(evidence.targetSha) ||
    !SHA256.test(evidence.planSha256) ||
    typeof evidence.planVersionId !== "string" ||
    evidence.planVersionId.length === 0 ||
    evidence.planVersionId.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(evidence.planVersionId) ||
    evidence.enableStationReleasePublicDns !== false
  ) {
    bootstrapInvalid();
  }
  return evidence;
}

function parseSourceVersion(channel, sourceTag) {
  const parsed =
    channel === "beta" ? parseStationBetaTag(sourceTag) : parseStationStableTag(sourceTag);
  if (!parsed || sourceTag !== `station-v${parsed.text}`) bootstrapInvalid();
  return parsed.text;
}

function validateBootstrapRelease(release, channel, sourceTag, evidence) {
  if (
    !hasExactKeys(release, ["tagName", "isDraft", "isPrerelease", "targetCommitish"]) ||
    release.tagName !== sourceTag ||
    release.isDraft !== false ||
    release.isPrerelease !== (channel === "beta") ||
    !SHA.test(release.targetCommitish) ||
    release.targetCommitish !== evidence.releaseSha
  ) {
    bootstrapInvalid();
  }
}

async function ensureNewBootstrapOutput(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) bootstrapInvalid();
  try {
    await canonicalExistingDirectory(dirname(path));
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    bootstrapInvalid();
  }
  bootstrapInvalid();
}

function stableProvenanceFrom(evidence) {
  return Object.fromEntries(STABLE_PROVENANCE_KEYS.map((key) => [key, evidence[key]]));
}

async function stageBootstrapTrees({ githubTree, channel, version, source }) {
  const root = await mkdtemp(join(tmpdir(), "markiro-station-bootstrap-"));
  const githubDirectory = join(root, "github");
  const yandexDirectory = join(root, "yandex");
  const common = {
    channel,
    inputDirectory: githubTree,
    version,
    pubDate: source.evidence.publishedAt,
    baseSha: source.evidence.baseSha,
    releaseSha: source.evidence.releaseSha,
    ...(channel === "stable"
      ? {
          notesPath: join(githubTree, stationAssetNames(version).notes),
          stableProvenance: stableProvenanceFrom(source.evidence),
        }
      : {}),
  };
  try {
    await stageStationRelease({ ...common, origin: "github", outputDirectory: githubDirectory });
    await stageStationRelease({ ...common, origin: "yandex", outputDirectory: yandexDirectory });
    const [github, yandex] = await Promise.all([
      validateStationReleaseDirectory(githubDirectory, {
        channel,
        origin: "github",
        version,
      }),
      validateStationReleaseDirectory(yandexDirectory, {
        channel,
        origin: "yandex",
        version,
      }),
    ]);
    await compareStationReleaseOrigins({
      githubDirectory,
      yandexDirectory,
      channel,
      version,
    });
    const names = stationAssetNames(version);
    for (const name of [names.installer, names.bundle, names.signature, names.notes]) {
      if (source.assets[name] !== github.assets[name]) bootstrapInvalid();
    }
    return { root, githubDirectory, yandexDirectory, github, yandex, names };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error?.message === "invalid station release bootstrap") throw error;
    bootstrapInvalid();
  }
}

function mutableTargetObjects(targets) {
  return [
    {
      key: targets.manifest.key,
      bytes: targets.manifest.bytes,
      contentType: targets.manifest.contentType,
      sourceKey: null,
    },
    {
      key: targets.installer.aliasKey,
      bytes: targets.installer.bytes,
      contentType: targets.installer.contentType,
      sourceKey: targets.installer.immutableKey,
    },
  ];
}

function isCompleteTargetBaseline(current, targets) {
  const targetObjects = mutableTargetObjects(targets);
  return current.every(
    (object, index) =>
      object !== null &&
      object.contentType === targetObjects[index].contentType &&
      object.sourceKey === targetObjects[index].sourceKey &&
      equalBytes(object.bytes, targetObjects[index].bytes),
  );
}

async function loadBackup(backupDirectory, channel) {
  ensureChannel(channel);
  await canonicalExistingDirectory(backupDirectory).catch(() => invalidBackup());
  let backup;
  try {
    const indexPath = join(backupDirectory, "backup.json");
    const info = await lstat(indexPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > MAX_BACKUP_INDEX_BYTES
    )
      invalidBackup();
    backup = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    if (error?.message === "invalid station release backup") throw error;
    invalidBackup();
  }
  const expected = mutableDescriptors(channel);
  if (
    !hasExactKeys(backup, ["schemaVersion", "channel", "objects"]) ||
    backup.schemaVersion !== 1 ||
    backup.channel !== channel ||
    !Array.isArray(backup.objects) ||
    backup.objects.length !== expected.length
  ) {
    invalidBackup();
  }
  const objects = [];
  for (const [position, object] of backup.objects.entries()) {
    const backupPath = `object-${position}.bin`;
    if (
      !hasExactKeys(object, ["key", "contentType", "sha256", "backupPath", "sourceKey"]) ||
      object.key !== expected[position].key ||
      object.contentType !== expected[position].expectedContentType ||
      !/^[0-9a-f]{64}$/.test(object.sha256) ||
      object.backupPath !== backupPath ||
      !validSourceKey(object.sourceKey, expected[position], channel)
    ) {
      invalidBackup();
    }
    let bytes;
    try {
      const path = join(backupDirectory, backupPath);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size <= 0 ||
        info.size > expected[position].maxBytes
      ) {
        invalidBackup();
      }
      bytes = await readFile(path);
    } catch (error) {
      if (error?.message === "invalid station release backup") throw error;
      invalidBackup();
    }
    if (sha256(bytes) !== object.sha256) invalidBackup();
    objects.push({
      key: object.key,
      contentType: object.contentType,
      bytes,
      sourceKey: object.sourceKey,
    });
  }
  return objects;
}

async function restoreAndVerify(store, objects, channel) {
  const [manifest, installer] = objects;
  await store.putMutable(manifest.key, manifest.bytes, manifest.contentType);
  const source = immutableInstallerSource(installer.sourceKey, channel);
  await store.copyImmutableToAlias({
    ...source,
    aliasKey: installer.key,
  });
  for (const object of objects) {
    if (!equalBytes(await store.readPublic(object.key), object.bytes)) {
      throw new Error("station release rollback verification failed");
    }
  }
}

function releaseTargets(channel, version, tree) {
  const location = ensureChannelVersion(channel, version);
  const names = stationAssetNames(version);
  return {
    location,
    names,
    manifest: {
      key: location.mutableManifestKey,
      bytesPath: join(tree, names.manifest),
      contentType: CONTENT_TYPES.manifest,
      cacheControl: MUTABLE_CACHE_CONTROL,
      contentDisposition: null,
      maxBytes: MAX_BACKUP_INDEX_BYTES,
    },
    installer: {
      immutableKey: `${location.immutablePrefix}${names.installer}`,
      aliasKey: location.mutableInstallerKey,
      bytesPath: join(tree, names.installer),
      contentType: CONTENT_TYPES.installer,
      attachmentFilename: names.installer,
      cacheControl: MUTABLE_CACHE_CONTROL,
      contentDisposition: `attachment; filename="${names.installer}"`,
      maxBytes: MAX_INSTALLER_BYTES,
    },
  };
}

async function readTargets(targets) {
  return {
    manifest: { ...targets.manifest, bytes: await readFile(targets.manifest.bytesPath) },
    installer: { ...targets.installer, bytes: await readFile(targets.installer.bytesPath) },
  };
}

async function verifyTargets(reader, targets) {
  if (
    !equalBytes(
      await reader.readPublic(targets.manifest.key, {
        contentType: targets.manifest.contentType,
        cacheControl: targets.manifest.cacheControl,
        contentDisposition: targets.manifest.contentDisposition,
        maxBytes: targets.manifest.maxBytes,
      }),
      targets.manifest.bytes,
    )
  ) {
    throw new Error("manifest verification failed");
  }
  if (
    !equalBytes(
      await reader.readPublic(targets.installer.aliasKey, {
        contentType: targets.installer.contentType,
        cacheControl: targets.installer.cacheControl,
        contentDisposition: targets.installer.contentDisposition,
        maxBytes: targets.installer.maxBytes,
      }),
      targets.installer.bytes,
    )
  ) {
    throw new Error("installer verification failed");
  }
}

async function promoteTargets(store, targets, reader = store) {
  await store.putMutable(
    targets.manifest.key,
    targets.manifest.bytes,
    targets.manifest.contentType,
  );
  if (
    !equalBytes(
      await reader.readPublic(targets.manifest.key, {
        contentType: targets.manifest.contentType,
        cacheControl: targets.manifest.cacheControl,
        contentDisposition: targets.manifest.contentDisposition,
        maxBytes: targets.manifest.maxBytes,
      }),
      targets.manifest.bytes,
    )
  ) {
    throw new Error("manifest verification failed");
  }
  await store.copyImmutableToAlias({
    immutableKey: targets.installer.immutableKey,
    aliasKey: targets.installer.aliasKey,
    attachmentFilename: targets.installer.attachmentFilename,
  });
  if (
    !equalBytes(
      await reader.readPublic(targets.installer.aliasKey, {
        contentType: targets.installer.contentType,
        cacheControl: targets.installer.cacheControl,
        contentDisposition: targets.installer.contentDisposition,
        maxBytes: targets.installer.maxBytes,
      }),
      targets.installer.bytes,
    )
  ) {
    throw new Error("installer verification failed");
  }
}

function ensureStore(store) {
  const methods = [
    "assertAbsent",
    "putImmutable",
    "getMutable",
    "putMutable",
    "copyImmutableToAlias",
    "readPublic",
  ];
  if (!store || methods.some((method) => typeof store[method] !== "function")) invalid();
}

function ensureProviderReader(reader) {
  if (!reader || typeof reader.readPublic !== "function") bootstrapInvalid();
}

async function publishBootstrapImmutables({ store, providerReader, tree, channel, version }) {
  const objects = descriptors(channel, version, tree);
  try {
    await Promise.all(objects.map((object) => validateStationImmutableObject(object)));
  } catch {
    bootstrapInvalid();
  }
  const absent = [];
  try {
    for (const object of objects) {
      try {
        await store.assertAbsent(object.key);
        absent.push(object);
      } catch (error) {
        if (error?.message !== "station release object already exists") throw error;
      }
    }
    for (const object of absent) {
      await store.putImmutable(object.key, object.file, object.contentType);
    }
    await readPublicTree({ reader: providerReader, tree, channel, version });
  } catch (error) {
    if (error?.message === "invalid station release bootstrap") throw error;
    publicationFailed();
  }
  return absent.length === 0 ? "existing-and-provider-verified" : "published-and-provider-verified";
}

function originBootstrapEvidence(origin, validated, names) {
  return {
    origin,
    evidenceSha256: validated.assets[names.evidence],
    manifestSha256: validated.assets[names.manifest],
    checksumsSha256: validated.assets[names.checksums],
  };
}

async function writeBootstrapRecord({
  path,
  channel,
  version,
  sourceTag,
  source,
  releaseMetadataSha256,
  infrastructure,
  infrastructureEvidenceSha256,
  trees,
  backup,
  backupDirectory,
  result,
}) {
  const backupIndex = await readBootstrapJson(join(backupDirectory, "backup.json"));
  const record = {
    schemaVersion: 1,
    operation: "station-release-empty-channel-bootstrap",
    channel,
    version,
    source: {
      tagName: sourceTag,
      baseSha: source.evidence.baseSha,
      releaseSha: source.evidence.releaseSha,
      releaseMetadataSha256,
      evidenceSha256: source.assets[trees.names.evidence],
    },
    infrastructure: {
      targetSha: infrastructure.targetSha,
      planSha256: infrastructure.planSha256,
      planVersionId: infrastructure.planVersionId,
      enableStationReleasePublicDns: false,
      evidenceSha256: infrastructureEvidenceSha256,
    },
    origins: {
      github: originBootstrapEvidence("github", trees.github, trees.names),
      yandex: originBootstrapEvidence("yandex", trees.yandex, trees.names),
    },
    commonAssets: {
      installerSha256: trees.github.assets[trees.names.installer],
      bundleSha256: trees.github.assets[trees.names.bundle],
      signatureSha256: trees.github.assets[trees.names.signature],
      notesSha256: trees.github.assets[trees.names.notes],
    },
    mutableBackup: {
      indexSha256: backupIndex.sha256,
      manifestSha256: backup.objects[0].sha256,
      installerSha256: backup.objects[1].sha256,
    },
    result,
  };
  try {
    await writeExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    bootstrapInvalid();
  }
}

export function createYandexPublisher({ store, providerReader } = {}) {
  ensureStore(store);
  if (providerReader !== undefined) ensureProviderReader(providerReader);
  return Object.freeze({
    async publishImmutable({ tree, channel, version } = {}) {
      await validateLocalTree(tree, channel, version);
      const objects = descriptors(channel, version, tree);
      try {
        await Promise.all(objects.map((object) => validateStationImmutableObject(object)));
      } catch {
        invalid();
      }
      try {
        for (const object of objects) await store.assertAbsent(object.key);
        for (const object of objects) {
          await store.putImmutable(object.key, object.file, object.contentType);
        }
        await readPublicTree({ reader: store, tree, channel, version });
      } catch (error) {
        if (error?.message === "invalid station release publication") throw error;
        publicationFailed();
      }
    },

    async validatePublic({ tree, channel, version } = {}) {
      await validateLocalTree(tree, channel, version);
      await readPublicTree({ reader: store, tree, channel, version });
    },

    async backupMutables({ channel, backupDirectory } = {}) {
      const expected = mutableDescriptors(channel);
      let objects;
      try {
        objects = await Promise.all(
          expected.map(async (descriptor) => {
            const { key, expectedContentType } = descriptor;
            const object = await store.getMutable(key);
            if (
              !object ||
              object.bytes.byteLength === 0 ||
              object.contentType !== expectedContentType ||
              !validSourceKey(object.sourceKey, descriptor, channel)
            ) {
              throw new Error("complete mutable backup required");
            }
            return {
              key,
              bytes: Buffer.from(object.bytes),
              contentType: object.contentType,
              sourceKey: object.sourceKey,
            };
          }),
        );
      } catch (error) {
        if (error?.message === "complete mutable backup required") throw error;
        publicationFailed();
      }
      await writeBackup(backupDirectory, channel, objects);
    },

    async seedBaseline(input = {}) {
      if (
        !hasExactKeys(input, [
          "githubTree",
          "sourceTag",
          "releaseMetadataPath",
          "infrastructureEvidencePath",
          "channel",
          "backupDirectory",
          "recordPath",
          "confirmation",
        ]) ||
        input.confirmation !== BOOTSTRAP_CONFIRMATION
      ) {
        bootstrapInvalid();
      }
      ensureProviderReader(providerReader);
      const { channel } = input;
      ensureChannel(channel);
      const version = parseSourceVersion(channel, input.sourceTag);
      await Promise.all([
        canonicalExistingDirectory(input.githubTree).catch(() => bootstrapInvalid()),
        ensureNewBootstrapOutput(input.backupDirectory),
        ensureNewBootstrapOutput(input.recordPath),
      ]);
      const [releaseMetadata, infrastructureEvidence] = await Promise.all([
        readBootstrapJson(input.releaseMetadataPath),
        readBootstrapJson(input.infrastructureEvidencePath),
      ]);
      const infrastructure = validateInfrastructureEvidence(infrastructureEvidence.value);
      let source;
      try {
        source = await validateLegacyGithubStationReleaseDirectory(input.githubTree, {
          channel,
          version,
        });
      } catch {
        bootstrapInvalid();
      }
      validateBootstrapRelease(releaseMetadata.value, channel, input.sourceTag, source.evidence);

      const trees = await stageBootstrapTrees({
        githubTree: input.githubTree,
        channel,
        version,
        source,
      });
      try {
        const targets = await readTargets(releaseTargets(channel, version, trees.yandexDirectory));
        const mutable = mutableDescriptors(channel);
        let current;
        try {
          current = await Promise.all(mutable.map(({ key }) => store.getMutable(key)));
        } catch {
          publicationFailed();
        }
        const present = current.filter((object) => object !== null).length;
        if (present === 1 || (present === 2 && !isCompleteTargetBaseline(current, targets))) {
          incompleteBaseline();
        }

        const immutableResult = await publishBootstrapImmutables({
          store,
          providerReader,
          tree: trees.yandexDirectory,
          channel,
          version,
        });
        const backup = await writeBackup(
          input.backupDirectory,
          channel,
          mutableTargetObjects(targets),
        );
        const recordResult = (result) =>
          writeBootstrapRecord({
            path: input.recordPath,
            channel,
            version,
            sourceTag: input.sourceTag,
            source,
            releaseMetadataSha256: releaseMetadata.sha256,
            infrastructure,
            infrastructureEvidenceSha256: infrastructureEvidence.sha256,
            trees,
            backup,
            backupDirectory: input.backupDirectory,
            result,
          });
        let channelBaseline;
        if (present === 0) {
          try {
            await promoteTargets(store, targets, providerReader);
          } catch {
            try {
              await promoteTargets(store, targets, providerReader);
            } catch {
              await recordResult({
                immutables: immutableResult,
                channelBaseline: "unknown-after-failed-compensation",
                recovery: "failed",
              }).catch(() => undefined);
              baselineRecoveryFailed();
            }
            await recordResult({
              immutables: immutableResult,
              channelBaseline: "created-after-compensation-and-provider-verified",
              recovery: "complete-baseline-reapplied-and-provider-verified",
            });
            publicationFailed();
          }
          channelBaseline = "created-and-provider-verified";
        } else {
          try {
            await verifyTargets(providerReader, targets);
          } catch {
            publicationFailed();
          }
          channelBaseline = "already-complete-and-provider-verified";
        }
        await recordResult({
          immutables: immutableResult,
          channelBaseline,
          recovery: "not-required",
        });
      } finally {
        await rm(trees.root, { recursive: true, force: true });
      }
    },

    async promote({ tree, channel, backupDirectory } = {}) {
      const version = await inferVersion(tree, channel);
      const backup = await loadBackup(backupDirectory, channel);
      await readPublicTree({ reader: store, tree, channel, version });
      const targets = await readTargets(releaseTargets(channel, version, tree));
      try {
        await promoteTargets(store, targets);
      } catch {
        try {
          await restoreAndVerify(store, backup, channel);
        } catch {
          throw new Error("station release rollback failed");
        }
        throw new Error("station release promotion failed");
      }
    },

    async rollback({ channel, backupDirectory } = {}) {
      const backup = await loadBackup(backupDirectory, channel);
      try {
        await restoreAndVerify(store, backup, channel);
      } catch {
        throw new Error("station release rollback failed");
      }
    },
  });
}

function ensureCliPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) commandInvalid();
}

function ensureCliChannel(channel) {
  if (!CHANNELS.has(channel)) commandInvalid();
}

function ensureCliVersion(channel, version) {
  try {
    stationReleaseLocation({ channel, origin: "yandex", version });
  } catch {
    commandInvalid();
  }
}

export async function runYandexPublisherCli(args, { publisher } = {}) {
  if (!Array.isArray(args) || !publisher) commandInvalid();
  const [command, ...values] = args;
  if (command === "publish-immutable" || command === "validate-public") {
    if (values.length !== 3) commandInvalid();
    const [tree, channel, version] = values;
    ensureCliPath(tree);
    ensureCliChannel(channel);
    ensureCliVersion(channel, version);
    return publisher[command === "publish-immutable" ? "publishImmutable" : "validatePublic"]({
      tree,
      channel,
      version,
    });
  }
  if (command === "seed-baseline") {
    if (values.length !== 8) commandInvalid();
    const [
      githubTree,
      sourceTag,
      releaseMetadataPath,
      infrastructureEvidencePath,
      channel,
      backupDirectory,
      recordPath,
      confirmation,
    ] = values;
    for (const path of [
      githubTree,
      releaseMetadataPath,
      infrastructureEvidencePath,
      backupDirectory,
      recordPath,
    ]) {
      ensureCliPath(path);
    }
    ensureCliChannel(channel);
    try {
      parseSourceVersion(channel, sourceTag);
    } catch {
      commandInvalid();
    }
    if (confirmation !== BOOTSTRAP_CONFIRMATION) commandInvalid();
    return publisher.seedBaseline({
      githubTree,
      sourceTag,
      releaseMetadataPath,
      infrastructureEvidencePath,
      channel,
      backupDirectory,
      recordPath,
      confirmation,
    });
  }
  if (command === "promote") {
    if (values.length !== 3) commandInvalid();
    const [tree, channel, backupDirectory] = values;
    ensureCliPath(tree);
    ensureCliChannel(channel);
    ensureCliPath(backupDirectory);
    return publisher.promote({ tree, channel, backupDirectory });
  }
  if (command === "backup-mutables" || command === "rollback") {
    if (values.length !== 2) commandInvalid();
    const [channel, backupDirectory] = values;
    ensureCliChannel(channel);
    ensureCliPath(backupDirectory);
    return publisher[command === "backup-mutables" ? "backupMutables" : "rollback"]({
      channel,
      backupDirectory,
    });
  }
  commandInvalid();
}

function boundedPrintable(value, minBytes, maxBytes) {
  return (
    typeof value === "string" &&
    value.length >= minBytes &&
    value.length <= maxBytes &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

export function createYandexPublisherClientConfig(env) {
  const endpoint = env?.YANDEX_STATION_RELEASE_ENDPOINT;
  const bucket = env?.YANDEX_STATION_RELEASE_BUCKET;
  const accessKeyId = env?.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env?.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env?.AWS_SESSION_TOKEN;
  if (
    endpoint !== YANDEX_S3_ENDPOINT ||
    !validBucket(bucket) ||
    typeof accessKeyId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(accessKeyId) ||
    !boundedPrintable(secretAccessKey, 16, 256) ||
    (sessionToken !== undefined && !boundedPrintable(sessionToken, 1, 4096))
  ) {
    environmentInvalid();
  }
  return {
    bucket,
    client: {
      endpoint,
      region: "ru-central1",
      maxAttempts: 3,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken === undefined ? {} : { sessionToken }),
      },
    },
  };
}

export async function runYandexPublisherMain(
  args,
  { env = process.env, Client = S3Client, fetchImpl = fetch } = {},
) {
  const config = createYandexPublisherClientConfig(env);
  const client = new Client(config.client);
  try {
    const store = createStationObjectStore({
      client,
      bucket: config.bucket,
      publicBaseUrl: PUBLIC_BASE_URL,
      fetchImpl,
    });
    await runYandexPublisherCli(args, {
      publisher: createYandexPublisher({
        store,
        providerReader: createYandexProviderReader({ bucket: config.bucket, fetchImpl }),
      }),
    });
  } finally {
    client.destroy?.();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runYandexPublisherMain(process.argv.slice(2));
}
