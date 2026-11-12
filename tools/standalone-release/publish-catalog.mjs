import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { appendFile, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { publisherJournal } from "../release-catalog/journal.mjs";
import { loadStandaloneCiArtifact, MAX_INSTALLER_BYTES } from "./ci-artifact.mjs";
import { UPDATE_PRODUCT } from "./prepare.mjs";
import {
  checkManifest,
  compareVersions,
  manifestFileName,
  readReleaseKeyset,
  verifyCompact,
} from "./sign-update.mjs";

const base = "https://releases.markiro.app/standalone/stable";
const latestUrl = `${base}/latest.json`;
const scope = { product: "standalone", channel: "stable" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Bind an owner-signed manifest to the exact evidence already verified from CI. */
export async function verifySignedStandaloneRelease(prepared, compact, keysetPath) {
  if (
    typeof compact !== "string" ||
    compact.length > 65536 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(compact)
  ) {
    throw new Error("standalone release requires a compact signed JWS");
  }
  let kid;
  try {
    ({ kid } = JSON.parse(Buffer.from(compact.split(".")[0], "base64url").toString("utf8")));
  } catch {
    throw new Error("invalid standalone JWS header");
  }
  const keyset = await readReleaseKeyset(keysetPath);
  const keys = keyset.keys.filter((key) => key?.kid === kid);
  if (keys.length !== 1 || keyset.retiredKids.includes(kid)) {
    throw new Error("standalone release signing key is unknown or retired");
  }
  const { payload } = verifyCompact(createPublicKey({ key: keys[0].jwk, format: "jwk" }), compact);
  const manifest = checkManifest(payload);
  const { draft } = prepared;
  if (
    manifest.channel !== scope.channel ||
    manifest.v !== draft.v ||
    manifest.product !== draft.product ||
    manifest.version !== draft.version ||
    manifest.sourceSha !== draft.sourceSha ||
    manifest.protocol !== draft.protocol ||
    manifest.minProtocol !== draft.minProtocol ||
    !isDeepStrictEqual(manifest.installer, draft.installer) ||
    manifest.installer.sizeBytes > MAX_INSTALLER_BYTES
  ) {
    throw new Error("signed standalone manifest does not match the stable CI installer and source");
  }
  return manifest;
}

async function readLatest(fetchImpl) {
  const response = await fetchImpl(latestUrl, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body) throw new Error("standalone stable pointer is unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 65536) throw new Error("standalone stable pointer is too large");
    chunks.push(chunk);
  }
  const pointer = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (pointer?.v !== 1 || pointer.product !== UPDATE_PRODUCT || pointer.channel !== scope.channel) {
    throw new Error("standalone stable pointer is invalid");
  }
  manifestFileName(pointer.version);
  return pointer;
}

function expectedPointer(manifest) {
  return {
    v: 1,
    product: manifest.product,
    channel: manifest.channel,
    version: manifest.version,
    releasedAt: manifest.releasedAt,
    installer: {
      url: `${base}/${manifest.version}/${manifest.installer.name}`,
      sha256: manifest.installer.sha256,
      sizeBytes: manifest.installer.sizeBytes,
    },
    manifestUrl: `${base}/${manifest.version}/${manifestFileName(manifest.version)}`,
    notes: manifest.notes,
  };
}

async function register(catalog, state, operationId, publication, bodies) {
  const intent = await catalog.createIntent(operationId, publication);
  await state.retain("intent.json", { id: intent.id, files: intent.files });
  const receipts = [];
  for (const { name, bytes } of bodies) {
    const record = await state.read(`uploaded-${name}.json`);
    if (record) {
      if (record.intentId !== intent.id || record.receipt.name !== name) {
        throw new Error("standalone publication receipt does not match the intent");
      }
      receipts.push(record.receipt);
      continue;
    }
    if (await state.read(`attempted-${name}.json`)) {
      throw new Error("ambiguous standalone upload; reconcile before retry");
    }
    await state.write(`attempted-${name}.json`, { intentId: intent.id, name });
    const receipt = await catalog.uploadFile(intent, name, bytes);
    await state.write(`uploaded-${name}.json`, { intentId: intent.id, receipt });
    receipts.push(receipt);
  }
  // The catalog client verifies every immutable public asset in full before accepting commit.
  return catalog.commitIntent(intent, receipts);
}

/** Register verified bytes, move stable forward by revision, and read back the public pointer. */
export async function publishStandaloneCatalogRelease({
  prepared,
  compact,
  keysetPath,
  catalog,
  stateDirectory,
  operationId,
  fetchImpl = fetch,
}) {
  const manifest = await verifySignedStandaloneRelease(prepared, compact, keysetPath);
  const installerPath = join(prepared.directory, manifest.installer.name);
  const info = await lstat(installerPath);
  if (!info.isFile() || info.size !== manifest.installer.sizeBytes) {
    throw new Error("standalone CI installer size changed before publication");
  }
  const installer = await readFile(installerPath);
  if (installer.length !== info.size || sha256(installer) !== manifest.installer.sha256) {
    throw new Error("standalone CI installer SHA-256 changed before publication");
  }
  const manifestName = manifestFileName(manifest.version);
  const bodies = [
    { name: manifest.installer.name, bytes: installer, contentType: "application/octet-stream" },
    {
      name: manifestName,
      bytes: Buffer.from(`${compact}\n`),
      contentType: "application/octet-stream",
    },
  ];
  const publication = {
    identity: { ...scope, version: manifest.version },
    sourceSha: manifest.sourceSha,
    files: bodies.map(({ name, bytes, contentType }) => ({
      name,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      contentType,
    })),
    evidence: { kind: "standalone", manifestName },
  };
  const pointer = expectedPointer(manifest);
  const state = await publisherJournal(stateDirectory);
  await state.retain("operation.json", {
    operationId,
    runId: prepared.runId,
    runAttempt: prepared.runAttempt,
    artifactId: prepared.artifactId,
    archiveSha: prepared.archiveSha,
    authenticode: prepared.evidence.authenticode,
    publication,
  });
  let committed = await catalog.getPublication(publication);
  const snapshot = await catalog.getChannel(scope);
  if (!snapshot.readable || !snapshot.publicationId || snapshot.revision === "0") {
    throw new Error("standalone stable catalog must already be initialized and readable");
  }
  const current = await readLatest(fetchImpl);
  if (committed?.publicationId === snapshot.publicationId) {
    if (!isDeepStrictEqual(current, pointer)) {
      throw new Error("public standalone stable pointer does not match the committed release");
    }
    return {
      ...pointer,
      installerUrl: pointer.installer.url,
      latestUrl,
      publicationId: committed.publicationId,
      revision: snapshot.revision,
    };
  }
  if (compareVersions(manifest.version, current.version) <= 0) {
    throw new Error("standalone stable release must advance the current version");
  }
  await state.retain("channel-before.json", snapshot);
  committed ??= await register(catalog, state, operationId, publication, bodies);
  await state.retain("publication.json", committed);
  const channelId = sha256(`standalone-channel:${operationId}`);
  const change = {
    operationId: `${channelId.slice(0, 8)}-${channelId.slice(8, 12)}-4${channelId.slice(13, 16)}-8${channelId.slice(17, 20)}-${channelId.slice(20, 32)}`,
    expectedRevision: snapshot.revision,
    targetPublicationId: committed.publicationId,
    kind: "forward",
  };
  await state.retain("channel-attempt.json", change);
  const changed = await catalog.changeChannel(scope, change);
  await state.retain("channel-accepted.json", changed);
  if (!isDeepStrictEqual(await readLatest(fetchImpl), pointer)) {
    throw new Error("public standalone stable pointer does not match the committed release");
  }
  return {
    ...pointer,
    installerUrl: pointer.installer.url,
    latestUrl,
    publicationId: committed.publicationId,
    revision: changed.revision,
  };
}

async function main() {
  const {
    GITHUB_REPOSITORY,
    GITHUB_REPOSITORY_ID,
    GITHUB_SHA,
    GITHUB_STEP_SUMMARY,
    RUNNER_TEMP,
    CI_RUN_ID,
    ARTIFACT_ID,
    UPDATE_JWS,
  } = process.env;
  if (
    !RUNNER_TEMP ||
    !ARTIFACT_ID ||
    !GITHUB_REPOSITORY_ID ||
    !/^[a-f0-9]{40}$/u.test(GITHUB_SHA ?? "")
  ) {
    throw new Error("missing standalone publication workflow inputs");
  }
  const prepared = await loadStandaloneCiArtifact({
    repository: GITHUB_REPOSITORY,
    repositoryId: GITHUB_REPOSITORY_ID,
    runId: CI_RUN_ID,
    artifactId: ARTIFACT_ID,
    directory: join(RUNNER_TEMP, "standalone-ci"),
  });
  const { createCatalogClient } = await import("../release-catalog/client.mjs");
  const result = await publishStandaloneCatalogRelease({
    prepared,
    compact: UPDATE_JWS,
    catalog: createCatalogClient(),
    operationId: randomUUID(),
    stateDirectory: join(RUNNER_TEMP, "standalone-catalog"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (GITHUB_STEP_SUMMARY) {
    await appendFile(
      GITHUB_STEP_SUMMARY,
      [
        `## Markiro Автоном ${result.version} · stable`,
        "",
        `- Коммит приложения \`${prepared.sourceSha}\``,
        `- Коммит публикации \`${GITHUB_SHA}\``,
        `- [Windows CI №${prepared.runId}](https://github.com/${prepared.repository}/actions/runs/${prepared.runId}/attempts/${prepared.runAttempt})`,
        `- Артефакт Windows CI \`${prepared.artifactId}\``,
        `- SHA-256 установщика \`${result.installer.sha256}\``,
        `- [Установщик](${result.installerUrl}) · [Манифест](${result.manifestUrl}) · [Указатель stable](${result.latestUrl})`,
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
