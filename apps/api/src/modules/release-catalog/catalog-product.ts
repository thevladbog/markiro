import { verifyStandaloneUpdateManifest, type StandaloneUpdateKeyset } from "@markiro/domain";
import {
  publicationRequestSchema,
  standaloneInstallerFileName,
  standaloneManifestFileName,
  standaloneLatestPointerSchema,
  STANDALONE_RELEASE_PRODUCT,
  type PublicationRequest,
} from "@markiro/platform-contracts";
import {
  handheldApkName,
  parseHandheldManifest,
  stationAssetNames,
  validateStationReleaseFiles,
} from "@markiro/release-validation";
import { z } from "zod";
import { STANDALONE_RELEASE_KEYSET } from "../standalone-releases/release-trust-keys";
import { derivePublicPath } from "./catalog-policy";
import { CatalogFault, type VerifiedInputFiles } from "./catalog-types";
const record = z.record(z.string(), z.unknown());
export interface ProductAcceptance extends Record<string, unknown> {
  product: "station" | "handheld" | "standalone";
  version: string;
  sourceSha: string;
  pointer: Record<string, unknown>;
  versionCode?: number;
  protocol?: number;
  minProtocol?: number;
  minUpgradeFrom?: string;
  evidence?: Record<string, unknown>;
}
/** Inputs are full-hash verified leases, never caller-supplied metadata or current S3 heads. */
export async function assertProductPublication(
  input: PublicationRequest,
  files: VerifiedInputFiles,
  keyset: StandaloneUpdateKeyset = STANDALONE_RELEASE_KEYSET,
): Promise<ProductAcceptance> {
  const request = publicationRequestSchema.parse(input),
    { identity } = request;
  const fail = (): never => {
    throw new CatalogFault("conflict");
  };
  const file = (name: string) => files.get(name) ?? fail();
  if (files.size !== request.files.length) fail();
  for (const spec of request.files) {
    const f = file(spec.name);
    if (
      f.sha256 !== spec.sha256 ||
      f.sizeBytes !== spec.sizeBytes ||
      f.spec.contentType !== spec.contentType
    )
      fail();
  }
  const text = async (name: string, maximum = 65536) => {
    const f = file(name);
    if (f.sizeBytes > maximum) fail();
    const bytes = await f.read(maximum);
    if (bytes.length !== f.sizeBytes) fail();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const exact = (names: string[]) => {
    if (files.size !== names.length || names.some((name) => !files.has(name))) fail();
  };
  try {
    if (request.evidence.kind === "handheld") {
      const name = handheldApkName(identity.version);
      exact(["manifest.json", name]);
      const manifest = parseHandheldManifest(await text("manifest.json"), {
        channel: identity.channel,
      });
      const apk = file(name);
      if (
        manifest.versionName !== identity.version ||
        manifest.sourceSha !== request.sourceSha ||
        manifest.versionCode !== request.evidence.versionCode ||
        manifest.sha256 !== apk.sha256 ||
        manifest.bytes !== apk.sizeBytes
      )
        fail();
      return {
        product: "handheld",
        version: identity.version,
        sourceSha: request.sourceSha,
        versionCode: manifest.versionCode,
        pointer: { ...manifest },
      };
    }
    if (request.evidence.kind === "station") {
      const checked = await validateStationReleaseFiles(
        {
          names: [...files.keys()],
          size: (name) => file(name).sizeBytes,
          text,
          digest: (name) => Promise.resolve(file(name).sha256),
        },
        { channel: identity.channel, origin: "yandex", version: identity.version },
      );
      const evidence = record.parse(checked.evidence);
      if (evidence.baseSha !== request.sourceSha) fail();
      return {
        product: "station",
        version: identity.version,
        sourceSha: request.sourceSha,
        pointer: record.parse(checked.manifest),
        evidence,
      };
    }
    if (request.evidence.kind !== "standalone") fail();
    const installerName = standaloneInstallerFileName(identity.version),
      manifestName = standaloneManifestFileName(identity.version);
    exact([installerName, manifestName]);
    if (request.evidence.manifestName !== manifestName) fail();
    const verification = await verifyStandaloneUpdateManifest(
      (await text(manifestName)).trim(),
      keyset,
    );
    if (!verification.ok) throw new CatalogFault("conflict");
    const { manifest } = verification;
    const installer = file(installerName);
    if (
      manifest.product !== STANDALONE_RELEASE_PRODUCT ||
      manifest.channel !== identity.channel ||
      manifest.version !== identity.version ||
      manifest.sourceSha !== request.sourceSha ||
      manifest.installer.name !== installerName ||
      manifest.installer.sha256 !== installer.sha256 ||
      manifest.installer.sizeBytes !== installer.sizeBytes ||
      installer.sizeBytes > 268435456
    )
      fail();
    const url = (name: string) => `https://releases.markiro.app${derivePublicPath(identity, name)}`;
    const pointer = standaloneLatestPointerSchema.parse({
      v: 1,
      product: manifest.product,
      channel: manifest.channel,
      version: manifest.version,
      releasedAt: manifest.releasedAt,
      installer: {
        url: url(installerName),
        sha256: installer.sha256,
        sizeBytes: installer.sizeBytes,
      },
      manifestUrl: url(manifestName),
      notes: manifest.notes,
    });
    return {
      product: "standalone",
      version: identity.version,
      sourceSha: request.sourceSha,
      protocol: manifest.protocol,
      minProtocol: manifest.minProtocol,
      minUpgradeFrom: manifest.minUpgradeFrom,
      pointer: { ...pointer },
    };
  } catch (error) {
    if (error instanceof CatalogFault) throw error;
    throw new CatalogFault("conflict");
  }
}

/** Numeric ordering after the strict public identity schema; never locale/lexicographic ordering. */
export function compareCatalogVersions(a: string, b: string): number {
  const parse = (s: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(s);
    if (!match) throw new CatalogFault("conflict");
    return match
      .slice(1)
      .map((n, index) => (n === undefined && index === 3 ? Infinity : Number(n)));
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 4; i++) {
    const l = left[i],
      r = right[i];
    if (l === undefined || r === undefined) throw new CatalogFault("conflict");
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** Stable promotion reuses accepted beta binaries; provenance cannot be manufactured from JSON alone. */
export function assertStationPromotion(
  next: ProductAcceptance,
  beta: ProductAcceptance,
  nextHashes: ReadonlyMap<string, string>,
  betaHashes: ReadonlyMap<string, string>,
) {
  const e = next.evidence,
    b = beta.evidence;
  if (
    !e ||
    !b ||
    next.product !== "station" ||
    beta.product !== "station" ||
    e.betaVersion !== beta.version ||
    e.betaReleaseSha !== b.releaseSha ||
    e.baseSha !== b.baseSha ||
    e.betaEvidenceSha256 !== betaHashes.get("release-evidence.json")
  )
    throw new CatalogFault("conflict");
  const nextNames = stationAssetNames(next.version),
    betaNames = stationAssetNames(beta.version);
  for (const kind of ["installer", "bundle", "signature"] as const) {
    if (
      !nextHashes.get(nextNames[kind]) ||
      nextHashes.get(nextNames[kind]) !== betaHashes.get(betaNames[kind])
    )
      throw new CatalogFault("conflict");
  }
}
