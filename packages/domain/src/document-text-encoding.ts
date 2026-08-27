const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const textEncoder = new TextEncoder();

/** Creates a lexicographic UTF-8 comparator with a sort-local encoding cache. */
export function createUtf8ByteComparator<T>(
  textOf: (value: T) => string,
): (left: T, right: T) => number {
  const encoded = new Map<string, Uint8Array>();
  const bytesOf = (value: T): Uint8Array => {
    const text = textOf(value);
    const cached = encoded.get(text);
    if (cached !== undefined) return cached;
    const bytes = textEncoder.encode(text);
    encoded.set(text, bytes);
    return bytes;
  };

  return (left, right) => compareBytes(bytesOf(left), bytesOf(right));
}

export function encodeLfText(lines: readonly string[]): Uint8Array {
  if (lines.length === 0) return new Uint8Array();
  return textEncoder.encode(`${lines.join("\n")}\n`);
}

export function encodeSemicolonCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Uint8Array {
  const content = [header, ...rows].map((row) => row.map(csvField).join(";")).join("\r\n") + "\r\n";
  const encoded = textEncoder.encode(content);
  const bytes = new Uint8Array(UTF8_BOM.length + encoded.length);
  bytes.set(UTF8_BOM);
  bytes.set(encoded, UTF8_BOM.length);
  return bytes;
}

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new Error("UTF-8 byte comparison index out of bounds");
    }
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}
