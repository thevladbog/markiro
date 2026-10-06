/**
 * Saves a file through a throwaway `<a download>` and a blob URL: the
 * webview's own download, with no host round trip. The URL is revoked right
 * after the synchronous click, by which time the download has its data.
 */
export function downloadFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * A document of the domain's generators as its bytes, one byte per
 * character, after the cloud's `latin1ToUint8Array`: TSPL's `BITMAP` carries
 * raw bytes as characters 0x00–0xFF, and a ZPL `^FD` may carry a Latin-1
 * byte, while a `Blob` of the string would write each character from 0x80 up
 * as two UTF-8 bytes. `& 0xff` keeps the result whole for any other text.
 */
export function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** A ZPL document to save: text, byte for byte. */
export function zplBlob(zpl: string): Blob {
  return new Blob([latin1Bytes(zpl)], { type: "text/plain" });
}

/** A TSPL document to save: it may hold binary bitmap bytes. */
export function tsplBlob(tspl: string): Blob {
  return new Blob([latin1Bytes(tspl)], { type: "application/octet-stream" });
}
