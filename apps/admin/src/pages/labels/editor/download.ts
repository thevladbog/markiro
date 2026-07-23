/**
 * Plan 04 Task 10: label editor chrome -- client-side ZPL/TSPL file download.
 *
 * BYTE-SAFETY (the reason this tiny module exists at all): both
 * `@markiro/domain`'s `generateZpl` and `generateTspl` return a plain JS
 * `string`. For ZPL that string is always printable ASCII (raster images are
 * embedded as `^GFA`'s ASCII-HEX payload -- see `raster-types.ts`'s
 * `buildGfaCommand`), so handing it straight to the `Blob` constructor is
 * safe: `Blob` UTF-8-encodes a JS string, and UTF-8 is a no-op for every
 * code point <= 0x7F.
 *
 * TSPL is different: `generateTspl`'s `BITMAP` command embeds RAW BINARY
 * bytes as one JS string character per byte (code points 0x00-0xFF, produced
 * via `String.fromCharCode` -- see `tspl.ts`'s module doc comment, "BINARY
 * CARRIER STRATEGY"). Handing THAT string straight to `Blob` would corrupt
 * every embedded byte >= 0x80: `Blob`'s UTF-8 encoding turns a single
 * code point like U+00FF into the TWO bytes `0xC3 0xBF`, not the original
 * single byte `0xFF` the printer's `BITMAP` payload actually needs. This is
 * not a theoretical concern -- it was verified directly against this
 * runtime's real `Blob`: `new Blob(["ÿ"]).arrayBuffer()` yields
 * `[0xC3, 0xBF]`, two bytes, not one.
 *
 * `latin1ToUint8Array` sidesteps this entirely by converting the string to
 * exact bytes FIRST (one `charCodeAt` per character, matching the encoding
 * `generateTspl` itself used to produce the string) and handing `Blob` a
 * `Uint8Array` instead of a string -- `Blob` copies typed-array bytes
 * verbatim, with no text-encoding step at all.
 */

/**
 * Converts a Latin-1-semantics string (one JS string code UNIT = one byte,
 * values 0x00-0xFF -- exactly what `generateTspl`'s `BITMAP` payload and
 * `raster-types.ts`'s `invertHexToTsplBytes` produce) into the equivalent
 * raw bytes. `& 0xff` is defensive only: every producer in this codebase
 * already guarantees code points in range, but masking keeps this function
 * total (never `NaN`/out-of-range) even if a future caller feeds it a
 * string containing an ordinary Unicode character by mistake.
 */
export function latin1ToUint8Array(text: string): Uint8Array<ArrayBuffer> {
  // Return type spelled out as the FULL generic `Uint8Array<ArrayBuffer>`
  // (not the bare `Uint8Array` shorthand, which is itself shorthand for the
  // wider `Uint8Array<ArrayBufferLike>`): `new Uint8Array(n)`'s own
  // numeric-length overload already resolves to `Uint8Array<ArrayBuffer>`
  // (a freshly allocated typed array's backing store is always a real
  // `ArrayBuffer`, never a `SharedArrayBuffer`), so spelling out the exact
  // generic here needs no runtime cast at all -- it would only be required
  // (and rejected as unnecessary by lint) if this signature had instead
  // widened it back to the bare shorthand. `BlobPart` (used below in
  // `buildTsplBlob`) is typed against this same narrower `ArrayBuffer`
  // variant, so keeping this exact is what makes that call site typecheck.
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Builds a downloadable ZPL `Blob` -- plain ASCII text, safe to hand to `Blob` as a string directly. */
export function buildZplBlob(zplText: string): Blob {
  return new Blob([zplText], { type: "text/plain" });
}

/**
 * Builds a downloadable TSPL `Blob` -- routes the document through
 * `latin1ToUint8Array` FIRST (see this module's doc comment) so any embedded
 * `BITMAP` binary payload survives byte-for-byte. `application/octet-stream`
 * (not `text/plain`): the file may contain non-text binary bytes.
 */
export function buildTsplBlob(tsplText: string): Blob {
  return new Blob([latin1ToUint8Array(tsplText)], { type: "application/octet-stream" });
}

const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9_-]+/g;

/**
 * Sanitizes a (possibly Cyrillic, possibly empty) template name into a safe
 * download filename stem: every run of characters other than
 * `[a-zA-Z0-9_-]` becomes a single `-` (collapsing e.g. multiple spaces),
 * leading/trailing `-` is trimmed, and an empty result (a name that was
 * entirely non-Latin, e.g. "Короб 100×100") falls back to `"label"` rather
 * than producing a nameless/hidden download.
 */
export function safeFileName(name: string): string {
  const collapsed = name
    .trim()
    .replace(UNSAFE_FILENAME_CHARS, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.length > 0 ? collapsed : "label";
}

/**
 * Triggers a browser file download of `blob` named `filename` via a
 * throwaway `<a download>` element -- the standard client-side download
 * pattern (no server round-trip). `URL.revokeObjectURL` is called
 * immediately after the synchronous `click()` dispatch; per the File API
 * spec the browser has already captured the blob URL's data by then, so
 * revoking does not race the download it just started.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
