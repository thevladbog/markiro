import {
  platformStandaloneReleaseContracts,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
  type StandaloneReleaseList,
  type StandaloneReleaseRegistration,
  type StandaloneReleaseTarget,
  type StandaloneReleaseUpload,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

const contracts = platformStandaloneReleaseContracts;
const PATH = "/standalone-releases";

export const standaloneReleaseKeys = {
  all: ["platform", "standalone-releases"] as const,
  list: () => ["platform", "standalone-releases", "list"] as const,
};

export function listStandaloneReleases(): Promise<StandaloneReleaseList> {
  return platformApiFetch(PATH, { responseSchema: contracts.list.response });
}

export function requestStandaloneReleaseUpload(
  target: StandaloneReleaseTarget,
): Promise<StandaloneReleaseUpload> {
  const body = contracts.upload.body.parse(target);
  return platformApiFetch(`${PATH}/uploads`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: contracts.upload.response,
  });
}

export function registerStandaloneRelease(
  target: StandaloneReleaseTarget,
): Promise<StandaloneReleaseRegistration> {
  const body = contracts.register.body.parse(target);
  return platformApiFetch(`${PATH}/registrations`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: contracts.register.response,
  });
}

export function setStandaloneReleaseLatest(
  channel: StandaloneReleaseChannel,
  version: string,
): Promise<StandaloneReleaseChannelView> {
  const params = contracts.setLatest.params.parse({ channel });
  const body = contracts.setLatest.body.parse({ version });
  return platformApiFetch(`${PATH}/${params.channel}/latest`, {
    method: "PUT",
    body: JSON.stringify(body),
    responseSchema: contracts.setLatest.response,
  });
}

export type BucketFailure = "network" | "rejected" | "aborted";

export class BucketUploadError extends Error {
  readonly reason: BucketFailure;
  readonly status: number | null;

  constructor(reason: BucketFailure, status: number | null = null) {
    super(`Release bucket upload ${reason}`);
    this.name = "BucketUploadError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * PUTs one file straight into the release bucket by its presigned URL. The
 * bucket is another origin, so no cookies ride along, and the content type is
 * exactly the one the URL was signed with. XMLHttpRequest, unlike fetch, reports
 * upload progress. A CORS refusal is indistinguishable from a dropped
 * connection in the browser: both arrive as `network`.
 */
export function putToReleaseBucket({
  url,
  contentType,
  file,
  signal,
  onProgress,
}: {
  url: string;
  contentType: string;
  file: Blob;
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BucketUploadError("aborted"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = (error: BucketUploadError | null) => {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    xhr.open("PUT", url);
    xhr.withCredentials = false;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size);
        settle(null);
      } else {
        settle(new BucketUploadError("rejected", xhr.status));
      }
    };
    xhr.onerror = () => settle(new BucketUploadError("network"));
    xhr.onabort = () => settle(new BucketUploadError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(file);
  });
}
