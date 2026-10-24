import { STANDALONE_RELEASE_ERROR_CODES } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { BucketUploadError } from "./api.js";

export type ReleaseOperation = "upload" | "register" | "setLatest";

export interface ReleaseErrorMessage {
  key: string;
  params?: Record<string, string | number>;
  /** Rejected staging evidence is retained; registration never deletes objects. */
  filesRetained?: boolean;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(STANDALONE_RELEASE_ERROR_CODES);

const FALLBACK_KEYS: Record<ReleaseOperation, string> = {
  upload: "standaloneReleases.errors.uploadFailed",
  register: "standaloneReleases.errors.registerFailed",
  setLatest: "standaloneReleases.errors.setLatestFailed",
};

export function releaseErrorMessage(
  operation: ReleaseOperation,
  error: unknown,
  params: Record<string, string | number> = {},
): ReleaseErrorMessage {
  if (error instanceof BucketUploadError) {
    return error.reason === "rejected"
      ? { key: "standaloneReleases.errors.bucketRejected", params: { status: error.status ?? 0 } }
      : { key: `standaloneReleases.errors.bucket_${error.reason}` };
  }
  if (!(error instanceof ApiRequestError)) return { key: FALLBACK_KEYS[operation] };
  if (error.kind === "network") return { key: "standaloneReleases.errors.network" };
  const code = error.kind === "domain" ? error.code : null;
  if (code === null || !KNOWN_CODES.has(code)) return { key: FALLBACK_KEYS[operation] };
  return {
    key: `standaloneReleases.errors.${code}`,
    params,
    // Neither a failed validation nor an immutable conflict deletes evidence.
    filesRetained:
      operation === "register" &&
      (error.status === 422 || code === "standalone_release_version_not_newer"),
  };
}
