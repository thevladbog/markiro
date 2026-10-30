// Hosted execution imports.
import {
  assertUsHostedRelease,
  usHostedReleaseIdentity,
  type VerifiedUsHostedRelease,
} from "../../../deployment/us-hosted-release-verifier";
import {
  assertUsHostedMaterial,
  type UsHostedMaterialOwner,
} from "../../../deployment/us-hosted-material-owner";
// End hosted execution imports.
import { canonicalExportDigest } from "@markiro/domain";
import {
  usExportBuildIdentitySchema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  assertLoadedUsRequestBuildDescriptor,
  type LoadedUsRequestBuildDescriptor,
} from "../../../deployment/us-request-build-descriptor";
import { loadUsDevelopmentEnv } from "../../../deployment/entry-policy";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
} from "./us-request-package-types";

export type UsRequestWorkerExecutionIdentity = Readonly<{
  build: Readonly<UsExportBuildIdentity>;
  digest: string;
}>;
const loaded = new WeakSet<object>();
const invalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_execution_invalid" });

/** Runtime authority is granted only by the checked local descriptor loader. */
export function createUsRequestRuntimeExecutionIdentity(
  descriptor: LoadedUsRequestBuildDescriptor,
  source: NodeJS.ProcessEnv,
): UsRequestWorkerExecutionIdentity {
  try {
    assertLoadedUsRequestBuildDescriptor(descriptor);
    loadUsDevelopmentEnv(source);
    return createSyntheticUsRequestExecutionIdentity(descriptor.document.build, source);
  } catch {
    throw invalid();
  }
}

/** Explicit synthetic seam only. Never derives operational identity from Git or ambient env. */
export function createSyntheticUsRequestExecutionIdentity(
  build: UsExportBuildIdentity,
  source: NodeJS.ProcessEnv,
): UsRequestWorkerExecutionIdentity {
  try {
    if (
      source.MARKIRO_DEPLOYMENT_EDITION !== "US" ||
      !["test", "development"].includes(source.NODE_ENV ?? "")
    )
      throw invalid();
    const copy = Object.freeze(usExportBuildIdentitySchema.parse(build));
    const identity = Object.freeze({
      build: copy,
      digest: canonicalExportDigest({
        schemaVersion: 1,
        executionKind: "synthetic-us-development",
        build: copy,
        packageVersion: US_REQUEST_PACKAGE_VERSION,
        reportVersion: US_REQUEST_REPORT_PDF_VERSION,
        libraries: { "@react-pdf/renderer": "4.6.1", "write-excel-file": "4.1.1", fflate: "0.8.3" },
      }),
    });
    loaded.add(identity);
    return identity;
  } catch {
    throw invalid();
  }
}

// Hosted execution authority.
const hosted = new WeakMap<
  object,
  { release: VerifiedUsHostedRelease; material: UsHostedMaterialOwner }
>();

export function createHostedUsRequestExecutionIdentity(
  release: unknown,
  material: unknown,
): UsRequestWorkerExecutionIdentity {
  try {
    assertUsHostedRelease(release);
    assertUsHostedMaterial(material, release, "worker");
    const verified = usHostedReleaseIdentity(release);
    if (verified.service !== "worker") throw invalid();
    const copy = Object.freeze(usExportBuildIdentitySchema.parse(verified.build));
    const identity = Object.freeze({
      build: copy,
      digest: canonicalExportDigest({
        schemaVersion: 1,
        executionKind: "synthetic-us-hosted",
        build: copy,
        packageVersion: US_REQUEST_PACKAGE_VERSION,
        reportVersion: US_REQUEST_REPORT_PDF_VERSION,
        libraries: { "@react-pdf/renderer": "4.6.1", "write-excel-file": "4.1.1", fflate: "0.8.3" },
        release: {
          sourceSha: verified.sourceSha,
          manifestSha256: verified.manifestSha256,
          configurationDigest: verified.configurationDigest,
          descriptorDigest: verified.descriptorDigest,
          inventoryDigest: verified.inventoryDigest,
        },
      }),
    });
    hosted.set(identity, { release, material });
    return identity;
  } catch {
    throw invalid();
  }
}

/** Idempotent hosted deregistration never revokes the distinct local/synthetic registry. */
export function disposeUsHostedRequestExecutionIdentity(
  identity: UsRequestWorkerExecutionIdentity,
): void {
  if (identity && typeof identity === "object") hosted.delete(identity);
}
// End hosted execution authority.

export function assertUsRequestWorkerExecutionIdentity(
  identity: UsRequestWorkerExecutionIdentity,
): void {
  // Hosted assertion branch.
  if (!identity || typeof identity !== "object") throw invalid();
  if (loaded.has(identity)) return;
  const owners = hosted.get(identity);
  if (!owners) throw invalid();
  try {
    assertUsHostedRelease(owners.release);
    assertUsHostedMaterial(owners.material, owners.release, "worker");
  } catch {
    hosted.delete(identity);
    throw invalid();
  }
  // End hosted assertion branch.
}
