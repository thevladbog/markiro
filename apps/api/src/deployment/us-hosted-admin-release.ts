import { createHash } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsExportBuildIdentity } from "@markiro/platform-contracts";
import {
  parseUsHostedAdminConfig,
  parseUsHostedAdminOperation,
  type UnverifiedUsHostedAdminConfig,
  type UsHostedAdminOperation,
} from "./us-hosted-admin-config";
import { parseUsHostedAdminManifest } from "./us-hosted-admin-manifest";
import { UsHostedReleaseFiles } from "./us-hosted-release-files";
import { verifyUsHostedPackage } from "./us-hosted-package-verification";

const invalid = () => new Error("us_hosted_admin_release_invalid");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const adminReleaseType: unique symbol = Symbol("verified_us_hosted_admin_release");
export type VerifiedUsHostedAdminRelease = Readonly<{ [adminReleaseType]: true }>;
export type UsHostedAdminReleaseIdentity = Readonly<{
  operation: UsHostedAdminOperation;
  config: UnverifiedUsHostedAdminConfig;
  build: Readonly<UsExportBuildIdentity>;
  sourceSha: string;
  manifestSha256: string;
  adminManifestSha256: string;
  configurationDigest: string;
  descriptorDigest: string;
  inventoryDigest: string;
}>;
type Record = { identity: UsHostedAdminReleaseIdentity; disposed: boolean };
const issued = new WeakMap<object, Record>();
function record(value: unknown): Record {
  if (!value || typeof value !== "object") throw invalid();
  const result = issued.get(value);
  if (!result || result.disposed) throw invalid();
  return result;
}
export function assertUsHostedAdminRelease(
  value: unknown,
): asserts value is VerifiedUsHostedAdminRelease {
  record(value);
}
export function usHostedAdminReleaseIdentity(value: unknown): UsHostedAdminReleaseIdentity {
  return record(value).identity;
}
export function disposeUsHostedAdminRelease(value: unknown): void {
  if (!value || typeof value !== "object") throw invalid();
  const result = issued.get(value);
  if (!result) throw invalid();
  result.disposed = true;
}

/** Sole administrative issuer. Admission confers no material, connection or execution authority. */
export async function verifyUsHostedAdminRelease(
  operation: UsHostedAdminOperation,
): Promise<VerifiedUsHostedAdminRelease> {
  let files: UsHostedReleaseFiles | undefined;
  try {
    parseUsHostedAdminOperation([operation]);
    files = new UsHostedReleaseFiles();
    const config = parseUsHostedAdminConfig(
      text(await files.read("us-synthetic-admin.json", 16_384)),
      operation,
    );
    const supplementBytes = await files.read("us-synthetic-admin-release.json", 1024 * 1024);
    const supplement = parseUsHostedAdminManifest(text(supplementBytes));
    const adminManifestSha256 = digest(supplementBytes);
    if (
      adminManifestSha256 !== config.release.adminManifestSha256 ||
      supplement.sourceSha !== config.release.sourceSha ||
      supplement.runtimeManifestSha256 !== config.release.manifestSha256
    )
      throw invalid();
    const { manifest, descriptorDigest, inventoryDigest } = await verifyUsHostedPackage(files, {
      sourceSha: config.release.sourceSha,
      manifestSha256: config.release.manifestSha256,
    });
    const entrypoint = manifest.files.find((file) => file.path === supplement.entrypoint.path);
    if (
      !entrypoint ||
      entrypoint.byteSize !== supplement.entrypoint.byteSize ||
      entrypoint.sha256 !== supplement.entrypoint.sha256
    )
      throw invalid();
    await files.assertUnchanged();
    const identity: UsHostedAdminReleaseIdentity = Object.freeze({
      operation: config.operation,
      config,
      build: Object.freeze({ ...manifest.build }),
      sourceSha: config.release.sourceSha,
      manifestSha256: config.release.manifestSha256,
      adminManifestSha256,
      configurationDigest: canonicalExportDigest(config),
      descriptorDigest,
      inventoryDigest,
    });
    const handle: VerifiedUsHostedAdminRelease = Object.freeze({ [adminReleaseType]: true });
    issued.set(handle, { identity, disposed: false });
    return handle;
  } catch {
    throw invalid();
  } finally {
    files?.dispose();
  }
}
