/**
 * Reads a fixture request body as UTF-8 text.
 *
 * Chunks arrive at arbitrary byte boundaries, so they must be decoded as one buffer:
 * `body += chunk` decodes each chunk on its own, and a Cyrillic letter split between two
 * chunks turns into U+FFFD. The limit counts bytes, not UTF-16 code units.
 */
export async function readFixtureBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += piece.byteLength;
    if (size > maxBytes) throw new Error("fixture request too large");
    chunks.push(piece);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
