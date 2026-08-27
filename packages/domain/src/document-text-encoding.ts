const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const textEncoder = new TextEncoder();

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
