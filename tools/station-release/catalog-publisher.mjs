import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { publisherJournal as journal } from "../release-catalog/journal.mjs";
import { isDeepStrictEqual } from "node:util";
import { validateStationReleaseDirectory, stationAssetNames } from "./artifacts.mjs";
import {
  publicationRequestSchema,
  channelSnapshotSchema,
  releaseVersionIdSchema,
} from "../../packages/platform-contracts/dist/release-catalog.js";

const TYPES = {
  installer: "application/octet-stream",
  bundle: "application/zip",
  signature: "text/plain",
  manifest: "application/json",
  checksums: "text/plain",
  notes: "text/markdown",
  evidence: "application/json",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function uuid(text) {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function fail() {
  throw new Error("invalid station catalog journal; reconcile before retry");
}
export async function describeStationCatalogTree({ tree, channel, version }) {
  const validated = await validateStationReleaseDirectory(tree, {
    channel,
    origin: "yandex",
    version,
  });
  const files = [];
  for (const [kind, name] of Object.entries(stationAssetNames(version))) {
    const info = await lstat(join(tree, name));
    if (!info.isFile() || info.isSymbolicLink()) throw Error("invalid station release file");
    files.push({
      name,
      sha256: validated.assets[name],
      sizeBytes: info.size,
      contentType: TYPES[kind],
    });
  }
  return publicationRequestSchema.parse({
    identity: { product: "station", channel, version },
    sourceSha: validated.evidence.releaseSha,
    files,
    evidence: {
      kind: "station",
      manifestName: "latest.json",
      evidenceName: "release-evidence.json",
    },
  });
}
/** Local receipts record every attempted PUT before it starts; missing completion is never retried blindly. */
export function createStationCatalogPublisher({ catalog, env = process.env } = {}) {
  const run = {
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    toolingSha: env.GITHUB_SHA,
  };
  if (
    !/^[1-9][0-9]*$/.test(run.runId ?? "") ||
    !/^[1-9][0-9]*$/.test(run.runAttempt ?? "") ||
    !/^[a-f0-9]{40}$/.test(run.toolingSha ?? "")
  )
    throw Error("invalid station catalog run");
  const scope = (channel) =>
    channelSnapshotSchema.shape.identity.parse({ product: "station", channel });
  const operationId = (channel, version, kind) =>
    uuid(JSON.stringify({ run, channel, version, kind }));
  return {
    async snapshot({ channel, stateDirectory }) {
      const identity = scope(channel),
        state = await journal(stateDirectory),
        old = await state.read("channel.json");
      if (old) {
        if (!isDeepStrictEqual(old.run, run) || !isDeepStrictEqual(old.snapshot.identity, identity))
          fail();
        return channelSnapshotSchema.parse(old.snapshot);
      }
      const snapshot = await catalog.getChannel(identity);
      await state.write("channel.json", { run, snapshot });
      return snapshot;
    },
    async register({ tree, channel, version, stateDirectory }) {
      const request = await describeStationCatalogTree({ tree, channel, version }),
        state = await journal(stateDirectory);
      await state.retain("publication.json", { run, request });
      const accepted = await catalog.getPublication(request);
      if (accepted) return accepted; // Client verified every accepted immutable byte, never HEAD/current S3.
      if (await state.read("accepted.json"))
        throw Error("registered station publication unavailable");
      const intent = await catalog.createIntent(
        operationId(channel, version, "publication"),
        request,
      );
      const files = [];
      for (const spec of request.files) {
        const receiptName = `uploaded-${spec.name}.json`,
          attemptName = `attempted-${spec.name}.json`;
        const receipt = await state.read(receiptName);
        if (receipt) {
          if (receipt.intentId !== intent.id || receipt.file.name !== spec.name) fail();
          releaseVersionIdSchema.parse(receipt.file.versionId);
          files.push(receipt.file);
          continue;
        }
        if (await state.read(attemptName)) fail();
        const bytes = await readFile(join(tree, spec.name));
        if (bytes.length !== spec.sizeBytes || hash(bytes) !== spec.sha256)
          throw Error("station files changed");
        await state.write(attemptName, { intentId: intent.id, spec });
        const file = await catalog.uploadFile(intent, spec.name, bytes);
        await state.write(receiptName, { intentId: intent.id, file });
        files.push(file);
      }
      const result = await catalog.commitIntent(intent, files);
      await state.retain("accepted.json", result);
      return result;
    },
    async verify({ tree, channel, version }) {
      const result = await catalog.getPublication(
        await describeStationCatalogTree({ tree, channel, version }),
      );
      if (!result) throw Error("station publication is not registered");
      return result;
    },
    async promote({ tree, channel, version, stateDirectory }) {
      const identity = scope(channel),
        state = await journal(stateDirectory),
        saved = await state.read("channel.json");
      if (
        !saved ||
        !isDeepStrictEqual(saved.run, run) ||
        !isDeepStrictEqual(saved.snapshot.identity, identity)
      )
        fail();
      const snapshot = channelSnapshotSchema.parse(saved.snapshot);
      const publication = await catalog.getPublication(
        await describeStationCatalogTree({ tree, channel, version }),
      );
      if (!publication) throw Error("station publication is not registered");
      const change = {
        operationId: operationId(channel, version, "forward"),
        expectedRevision: snapshot.revision,
        targetPublicationId: publication.publicationId,
        kind: "forward",
      };
      await state.retain("channel-attempt.json", change);
      const result = await catalog.changeChannel(identity, change);
      await state.retain("channel-accepted.json", result);
      return result;
    },
  };
}
