import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareStationReleaseOrigins,
  stationAssetNames,
  validateStationReleaseDirectory,
} from "./artifacts.mjs";
import { createStationObjectStore, validateStationImmutableObject } from "./object-storage.mjs";
import { stationReleaseLocation } from "./origins.mjs";

const PUBLIC_BASE_URL = "https://releases.markiro.app";
const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";
const MAX_BACKUP_INDEX_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const CHANNELS = new Set(["beta", "stable"]);
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
  }));
}

function equalBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

async function readPublicTree({ store, tree, channel, version }) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-public-"));
  try {
    const objects = descriptors(channel, version, tree);
    for (const object of objects) {
      const bytes = await store.readPublic(object.key);
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
    },
    installer: {
      immutableKey: `${location.immutablePrefix}${names.installer}`,
      aliasKey: location.mutableInstallerKey,
      bytesPath: join(tree, names.installer),
      contentType: CONTENT_TYPES.installer,
      attachmentFilename: names.installer,
    },
  };
}

async function readTargets(targets) {
  return {
    manifest: { ...targets.manifest, bytes: await readFile(targets.manifest.bytesPath) },
    installer: { ...targets.installer, bytes: await readFile(targets.installer.bytesPath) },
  };
}

async function promoteTargets(store, targets) {
  await store.putMutable(
    targets.manifest.key,
    targets.manifest.bytes,
    targets.manifest.contentType,
  );
  if (!equalBytes(await store.readPublic(targets.manifest.key), targets.manifest.bytes)) {
    throw new Error("manifest verification failed");
  }
  await store.copyImmutableToAlias({
    immutableKey: targets.installer.immutableKey,
    aliasKey: targets.installer.aliasKey,
    attachmentFilename: targets.installer.attachmentFilename,
  });
  if (!equalBytes(await store.readPublic(targets.installer.aliasKey), targets.installer.bytes)) {
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

export function createYandexPublisher({ store } = {}) {
  ensureStore(store);
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
        await readPublicTree({ store, tree, channel, version });
      } catch (error) {
        if (error?.message === "invalid station release publication") throw error;
        publicationFailed();
      }
    },

    async validatePublic({ tree, channel, version } = {}) {
      await validateLocalTree(tree, channel, version);
      await readPublicTree({ store, tree, channel, version });
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

    async seedBaseline({ tree, channel, backupDirectory } = {}) {
      await canonicalExistingDirectory(tree);
      let entries;
      try {
        entries = (await readdir(tree)).sort();
      } catch {
        invalid();
      }
      if (entries.join(",") !== "github,yandex") invalid();
      const githubTree = join(tree, "github");
      const yandexTree = join(tree, "yandex");
      await Promise.all([
        canonicalExistingDirectory(githubTree),
        canonicalExistingDirectory(yandexTree),
      ]);
      const version = await inferVersion(yandexTree, channel);
      try {
        await compareStationReleaseOrigins({
          githubDirectory: githubTree,
          yandexDirectory: yandexTree,
          channel,
          version,
        });
      } catch {
        invalid();
      }
      await readPublicTree({ store, tree: yandexTree, channel, version });
      const mutable = mutableDescriptors(channel);
      let current;
      try {
        current = await Promise.all(mutable.map(({ key }) => store.getMutable(key)));
      } catch {
        publicationFailed();
      }
      if (current.some((object) => object !== null)) {
        throw new Error("station release baseline already exists");
      }
      const targets = await readTargets(releaseTargets(channel, version, yandexTree));
      await writeBackup(backupDirectory, channel, [
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
      ]);
      try {
        await promoteTargets(store, targets);
      } catch {
        try {
          await promoteTargets(store, targets);
        } catch {
          baselineRecoveryFailed();
        }
        publicationFailed();
      }
    },

    async promote({ tree, channel, backupDirectory } = {}) {
      const version = await inferVersion(tree, channel);
      const backup = await loadBackup(backupDirectory, channel);
      await readPublicTree({ store, tree, channel, version });
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
  if (command === "seed-baseline" || command === "promote") {
    if (values.length !== 3) commandInvalid();
    const [tree, channel, backupDirectory] = values;
    ensureCliPath(tree);
    ensureCliChannel(channel);
    ensureCliPath(backupDirectory);
    return publisher[command === "seed-baseline" ? "seedBaseline" : "promote"]({
      tree,
      channel,
      backupDirectory,
    });
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
    typeof bucket !== "string" ||
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
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
      publisher: createYandexPublisher({ store }),
    });
  } finally {
    client.destroy?.();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runYandexPublisherMain(process.argv.slice(2));
}
