import { UsClientError } from "../client.js";

const maxBytes = 8_000_000;

/** Bound actual bytes before allocation, independently of server length claims. */
export async function readPlanPdfResponse(response: Response, expectedRevision: number | null) {
  const length = response.headers.get("Content-Length");
  const revision = response.headers.get("X-Plan-Draft-Revision");
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get("Content-Type") !== "application/pdf" ||
    response.headers.get("Content-Disposition") !==
      'attachment; filename="traceability-plan.pdf"' ||
    (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) > maxBytes)) ||
    (expectedRevision !== null &&
      (revision === null ||
        !/^[1-9][0-9]*$/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) ||
        Number(revision) !== expectedRevision)) ||
    !response.body
  )
    throw new UsClientError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new UsClientError("invalid_response");
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new UsClientError("invalid_response");
  } finally {
    reader.releaseLock();
  }
  if (size < 5 || (length !== null && Number(length) !== size))
    throw new UsClientError("invalid_response");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
    throw new UsClientError("invalid_response");
  return {
    bytes,
    filename: "traceability-plan.pdf",
    draftRevision: expectedRevision === null ? null : Number(revision),
  };
}
