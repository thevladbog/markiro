import type { MonoBitmap } from "@markiro/domain";

/**
 * A 1-bit logo as a PNG data URL, for the printed forms (an `<img>` in the
 * form's HTML). Written by hand so it needs no canvas: the 1-bit grayscale
 * rows are stored in zlib "stored" blocks (a logo is at most 1024 x 512 dots,
 * 66 KB of rows). Ink (a set bit of the bitmap) is black, the rest white; the
 * padding bits of a row are white.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
}

/** zlib "stored" blocks of at most 65 535 bytes, with the Adler-32 trailer. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const part = raw.subarray(at, Math.min(raw.length, at + 65535));
    const last = at + 65535 >= raw.length;
    out.push(
      last ? 1 : 0,
      part.length & 0xff,
      part.length >>> 8,
      ~part.length & 0xff,
      (~part.length >>> 8) & 0xff,
    );
    for (const byte of part) out.push(byte);
    if (last) break;
  }
  out.push(...u32(adler32(raw)));
  return Uint8Array.from(out);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

/** The bitmap as a PNG (bytes). */
export function bitmapPng(bitmap: MonoBitmap): Uint8Array {
  const rowBytes = Math.ceil(bitmap.width / 8);
  const raw = new Uint8Array(bitmap.height * (rowBytes + 1));
  for (let y = 0; y < bitmap.height; y++) {
    const at = y * (rowBytes + 1);
    raw[at] = 0; // filter: none
    for (let x = 0; x < rowBytes; x++) {
      const ink = bitmap.pixels[y * bitmap.stride + x] ?? 0;
      // PNG's 1-bit gray: 0 is black. Ink is black, so the bits are inverted;
      // the padding bits of the last byte are white.
      let value = ~ink & 0xff;
      if (x === rowBytes - 1 && bitmap.width % 8 !== 0) value |= 0xff >> (bitmap.width % 8);
      raw[at + 1 + x] = value;
    }
  }
  const header = Uint8Array.from([...u32(bitmap.width), ...u32(bitmap.height), 1, 0, 0, 0, 0]);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** `data:image/png;base64,…` of the bitmap. */
export function bitmapPngDataUrl(bitmap: MonoBitmap): string {
  return `data:image/png;base64,${toBase64(bitmapPng(bitmap))}`;
}
