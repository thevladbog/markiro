import { usRequestsResponseErrorCode, type UsRequestsClientErrorCode } from "./error-codes.js";
import type { UsRequestArtifact, VerifiedUsRequestDownload } from "./types.js";

const artifactCaps = {
  xlsx: 16 * 1024 * 1024,
  plan_pdf: 8_000_000,
  validation_report: 16 * 1024 * 1024,
  request_report: 4 * 1024 * 1024,
  manifest: 1024 * 1024,
  package_zip: 64 * 1024 * 1024,
} as const;
const jsonMime = (value: string) => /^application\/json(?:;\s*charset=utf-8)?$/i.test(value);

export async function readUsRequestArtifactResponse(
  response: Response,
  descriptor: UsRequestArtifact,
  options: { signal: AbortSignal; makeError: (code: UsRequestsClientErrorCode) => Error },
): Promise<VerifiedUsRequestDownload> {
  const safeErrors = new WeakSet<Error>();
  function fail(code: UsRequestsClientErrorCode): never {
    const error = options.makeError(code);
    safeErrors.add(error);
    throw error;
  }
  if (options.signal.aborted) return fail("unavailable");
  if (
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect" ||
    (response.status >= 200 && response.status < 400 && response.status !== 200)
  ) {
    // Underlying cancellation must not delay the safe failure or owned cleanup.
    void response.body?.cancel().catch(() => undefined);
    return fail("invalid_response");
  }
  if (!response.body)
    return fail(
      response.status === 200
        ? "invalid_response"
        : usRequestsResponseErrorCode(response.status, undefined),
    );
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return fail("unavailable");
  }
  const cancel = () => reader.cancel().catch(() => undefined);
  let abortHash: (() => void) | undefined;
  const abort = () => {
    void cancel();
    abortHash?.();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  const success = response.status === 200;
  const cap = success ? artifactCaps[descriptor.kind] : 16 * 1024;
  const mime = response.headers.get("content-type") ?? "";
  try {
    const length = response.headers.get("content-length");
    if (success) {
      if (
        descriptor.byteSize > cap ||
        !Number.isSafeInteger(descriptor.byteSize) ||
        descriptor.byteSize <= 0 ||
        length === null ||
        !/^[1-9][0-9]*$/.test(length) ||
        Number(length) !== descriptor.byteSize ||
        (descriptor.mediaType === "application/json"
          ? !jsonMime(mime)
          : mime !== descriptor.mediaType) ||
        response.headers.get("content-disposition") !==
          `attachment; filename="${descriptor.name}"` ||
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-content-type-options") !== "nosniff"
      )
        return fail("invalid_response");
    } else if (
      [401, 403, 429].includes(response.status) ||
      !jsonMime(mime) ||
      (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > cap))
    )
      return fail(usRequestsResponseErrorCode(response.status, undefined));
    for (;;) {
      if (options.signal.aborted) return fail("unavailable");
      const next = await reader.read();
      if (options.signal.aborted) return fail("unavailable");
      if (next.done) break;
      total += next.value.byteLength;
      if (total > cap || (success && total > descriptor.byteSize))
        return fail(
          success ? "invalid_response" : usRequestsResponseErrorCode(response.status, undefined),
        );
      chunks.push(next.value);
    }
    if (success && total !== descriptor.byteSize) return fail("invalid_response");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!success) {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        /* Malformed error envelopes remain opaque. */
      }
      return fail(usRequestsResponseErrorCode(response.status, body));
    }
    const digest = await new Promise<ArrayBuffer>((resolve, reject) => {
      abortHash = () => {
        const error = options.makeError("unavailable");
        safeErrors.add(error);
        reject(error);
      };
      if (options.signal.aborted) abortHash();
      else void crypto.subtle.digest("SHA-256", bytes).then(resolve, reject);
    });
    const hash = new Uint8Array(digest);
    if (options.signal.aborted) return fail("unavailable");
    const sha256 = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
    if (sha256 !== descriptor.sha256) return fail("invalid_response");
    return { bytes, filename: descriptor.name, sha256 };
  } catch (error) {
    void cancel();
    if (error instanceof Error && safeErrors.has(error)) throw error;
    return fail("unavailable");
  } finally {
    abortHash = undefined;
    options.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
