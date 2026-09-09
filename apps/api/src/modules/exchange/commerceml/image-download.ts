import { downloadBoundedImage, type ImageDownloadDeps } from "../../media/bounded-image-download";

export {
  ImageDownloadError,
  isForbiddenAddress,
  type ImageDownloadDeps,
  type ImageDownloadReason,
} from "../../media/bounded-image-download";

export const IMAGE_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const IMAGE_DOWNLOAD_MAX_REDIRECTS = 3;

/** CommerceML compatibility wrapper retaining the established limits. */
export function downloadImage(rawUrl: string, deps: ImageDownloadDeps = {}): Promise<Buffer> {
  return downloadBoundedImage(
    rawUrl,
    {
      maxBytes: IMAGE_DOWNLOAD_MAX_BYTES,
      timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
      maxRedirects: IMAGE_DOWNLOAD_MAX_REDIRECTS,
      allowedHosts: null,
    },
    deps,
  );
}
