import { canonicalExportDigest } from "@markiro/domain";
import type { UsExportBuildIdentity } from "@markiro/platform-contracts";
import {
  parseUsSyntheticHostedConfig,
  type UsSyntheticHostedConfig,
  type UsSyntheticHostedService,
} from "./us-synthetic-hosted-config";
import { UsHostedReleaseFiles } from "./us-hosted-release-files";
import { verifyUsHostedPackage } from "./us-hosted-package-verification";

const invalid = () => new Error("us_hosted_release_invalid");
const releaseType: unique symbol = Symbol("verified_us_hosted_release");
export type VerifiedUsHostedRelease = Readonly<{ [releaseType]: true }>;
export type UsHostedReleaseIdentity = Readonly<{
  service: UsSyntheticHostedService;
  config: UsSyntheticHostedConfig;
  build: Readonly<UsExportBuildIdentity>;
  sourceSha: string;
  manifestSha256: string;
  configurationDigest: string;
  descriptorDigest: string;
  inventoryDigest: string;
}>;
type Record = { identity: UsHostedReleaseIdentity; disposed: boolean };
const issued = new WeakMap<object, Record>();
function record(value: unknown): Record {
  if (!value || typeof value !== "object") throw invalid();
  const result = issued.get(value);
  if (!result || result.disposed) throw invalid();
  return result;
}
export function assertUsHostedRelease(value: unknown): asserts value is VerifiedUsHostedRelease {
  record(value);
}
export function usHostedReleaseIdentity(value: unknown): UsHostedReleaseIdentity {
  return record(value).identity;
}
export function disposeUsHostedRelease(value: unknown): void {
  if (!value || typeof value !== "object") throw invalid();
  const result = issued.get(value);
  if (!result) throw invalid();
  result.disposed = true;
}
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Sole issuer: fixed protected package acquisition precedes all material/runtime construction. */
export async function verifyUsHostedRelease(
  service: UsSyntheticHostedService,
): Promise<VerifiedUsHostedRelease> {
  let files: UsHostedReleaseFiles | undefined;
  try {
    if (service !== "api" && service !== "worker") throw invalid();
    files = new UsHostedReleaseFiles();
    const config = parseUsSyntheticHostedConfig(
      text(await files.read(`us-synthetic-${service}.json`, 16_384)),
      service,
    );
    const { manifest, descriptorDigest, inventoryDigest } = await verifyUsHostedPackage(files, {
      sourceSha: config.release.sourceSha,
      manifestSha256: config.release.manifestSha256,
    });
    await files.assertUnchanged();
    const identity: UsHostedReleaseIdentity = Object.freeze({
      service,
      config,
      build: Object.freeze({ ...manifest.build }),
      sourceSha: config.release.sourceSha,
      manifestSha256: config.release.manifestSha256,
      configurationDigest: canonicalExportDigest(config),
      descriptorDigest,
      inventoryDigest,
    });
    const handle: VerifiedUsHostedRelease = Object.freeze({ [releaseType]: true });
    issued.set(handle, { identity, disposed: false });
    return handle;
  } catch {
    throw invalid();
  } finally {
    files?.dispose();
  }
}
