import { canonicalExportDigest } from "@markiro/domain";
import {
  usExportBuildIdentitySchema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
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

export function assertUsRequestWorkerExecutionIdentity(
  identity: UsRequestWorkerExecutionIdentity,
): void {
  if (!identity || typeof identity !== "object" || !loaded.has(identity)) throw invalid();
}
