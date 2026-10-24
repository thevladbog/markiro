import { createHash } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { createCatalogClient } from "../release-catalog/client.mjs";
import { createStationCatalogPublisher } from "./catalog-publisher.mjs";
import { stationAssetNames, validateStationReleaseDirectory } from "./artifacts.mjs";
import {
  runYandexPublisherCli,
  parseSourceVersion,
  validateBootstrapRelease,
  stageReseedTrees,
  readReseedInput,
} from "./yandex-publisher.mjs";

async function record(path, value) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
async function publicBody(url, limit, fetchImpl, collect = false) {
  const response = await fetchImpl(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(3600000),
  });
  if (!response.ok || !response.body) throw Error("station catalog readback unavailable");
  const reader = response.body.getReader(),
    digest = createHash("sha256"),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("station readback exceeds bound");
      digest.update(value);
      if (collect) chunks.push(Buffer.from(value));
    }
    return { size, sha256: digest.digest("hex"), bytes: collect ? Buffer.concat(chunks) : null };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function verifyStationCatalogChannel({ tree, channel, version, fetchImpl = fetch }) {
  const accepted = await validateStationReleaseDirectory(tree, {
    channel,
    origin: "yandex",
    version,
  });
  const base = `https://releases.markiro.app/station/${channel}`;
  const before = await publicBody(`${base}/latest.json`, 262144, fetchImpl, true);
  if (!isDeepStrictEqual(JSON.parse(before.bytes.toString("utf8")), accepted.manifest))
    throw Error("station channel changed");
  const names = stationAssetNames(version),
    size = (await lstat(join(tree, names.installer))).size;
  const alias =
    channel === "stable" ? "https://releases.markiro.app/station/download" : `${base}/download`;
  const downloaded = await publicBody(alias, size, fetchImpl);
  if (downloaded.size !== size || downloaded.sha256 !== accepted.assets[names.installer])
    throw Error("station download changed");
  const after = await publicBody(`${base}/latest.json`, 262144, fetchImpl, true);
  if (!before.bytes.equals(after.bytes)) throw Error("station channel changed during readback");
}
export async function reseedStationCatalog(
  input,
  { publisher, stateDirectory, fetchImpl = fetch, verifyChannel = verifyStationCatalogChannel },
) {
  if (input.confirmation !== "--confirm-reseed-from-github")
    throw Error("invalid station reseed confirmation");
  const { channel, sourceTag } = input,
    version = parseSourceVersion(channel, sourceTag);
  const release = JSON.parse((await readReseedInput(input.releaseMetadataPath)).toString("utf8"));
  validateBootstrapRelease(release, channel, sourceTag);
  const source = await validateStationReleaseDirectory(input.githubTree, {
    channel,
    origin: "github",
    version,
  });
  const manifest = await readFile(join(input.githubTree, stationAssetNames(version).manifest));
  if (!manifest.equals(await readReseedInput(input.githubChannelManifestPath)))
    throw Error("station GitHub channel provenance mismatch");
  const trees = await stageReseedTrees({ githubTree: input.githubTree, channel, version, source });
  try {
    const snapshot = await publisher.snapshot({ channel, stateDirectory });
    if (snapshot.revision !== "0")
      throw Error("station reseed refuses a nonempty channel; use protected promote-existing");
    if (snapshot.publicationId !== null) throw Error("station empty channel inconsistent");
    const publication = await publisher.register({
      tree: trees.yandexDirectory,
      channel,
      version,
      stateDirectory,
    });
    const result = await publisher.promote({
      tree: trees.yandexDirectory,
      channel,
      version,
      stateDirectory,
    });
    await verifyChannel({ tree: trees.yandexDirectory, channel, version, fetchImpl });
    await record(input.recordPath, {
      schemaVersion: 1,
      operation: "station-catalog-reseed",
      sourceTag,
      release,
      releaseSha: source.evidence.releaseSha,
      publicationId: publication.publicationId,
      revision: result.revision,
    });
    return result;
  } finally {
    await rm(trees.root, { recursive: true, force: true });
  }
}
export async function runStationCatalogMain(args, { env = process.env, fetchImpl = fetch } = {}) {
  const catalog = createCatalogClient({
    env: {
      ...env,
      RELEASES_S3_ACCESS_KEY_ID: env.RELEASES_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
      RELEASES_S3_SECRET_ACCESS_KEY: env.RELEASES_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
    },
    fetchImpl,
  });
  const publisher = createStationCatalogPublisher({ catalog, env });
  if (!env.RUNNER_TEMP) throw Error("station runner journal directory required");
  const state = (channel) => join(env.RUNNER_TEMP, `station-catalog-${channel}`);
  if (args[0] === "verify-channel") {
    if (args.length !== 4) throw Error("invalid station channel verification");
    return verifyStationCatalogChannel({
      tree: args[1],
      channel: args[2],
      version: args[3],
      fetchImpl,
    });
  }
  const historyRequired = () => {
    throw Error(
      "legacy baseline requires reviewed catalog history import; no direct storage bootstrap",
    );
  };
  return runYandexPublisherCli(args, {
    publisher: {
      publishImmutable: (input) =>
        publisher.register({ ...input, stateDirectory: state(input.channel) }),
      validatePublic: (input) => publisher.verify(input),
      prepareSeedImmutable: historyRequired,
      preflightSeedMutables: historyRequired,
      seedBaseline: historyRequired,
      backupMutables: (input) =>
        publisher.snapshot({ channel: input.channel, stateDirectory: state(input.channel) }),
      async promote(input) {
        const manifest = JSON.parse(
          (await readReseedInput(join(input.tree, "latest.json"))).toString("utf8"),
        );
        return publisher.promote({
          ...input,
          version: manifest.version,
          stateDirectory: state(input.channel),
        });
      },
      rollback() {
        throw Error("ambiguous catalog CAS requires reconciliation; automatic rollback forbidden");
      },
      reseedFromGithub: (input) =>
        reseedStationCatalog(input, {
          publisher,
          stateDirectory: state(input.channel),
          fetchImpl,
        }),
    },
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runStationCatalogMain(process.argv.slice(2)).catch(() => {
    console.error("Station catalog operation failed; retain journal and reconcile before retry.");
    process.exitCode = 1;
  });
}
