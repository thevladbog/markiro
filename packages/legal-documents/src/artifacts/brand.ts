const INK = [0x17, 0x16, 0x1a, 0xff] as const;
const PAPER = [0xfa, 0xfa, 0xf8, 0xff] as const;
const WHITE = [0xff, 0xff, 0xff, 0xff] as const;
const ACCENT = [0x3d, 0xdc, 0x7a, 0xff] as const;
const TRANSPARENT = [0x00, 0x00, 0x00, 0x00] as const;

type Rgba = readonly [number, number, number, number];

const MARKIRO_MODULES = [
  { x: 14, y: 14, color: PAPER },
  { x: 14, y: 26, color: PAPER },
  { x: 14, y: 38, color: PAPER },
  { x: 26, y: 22, color: PAPER },
  { x: 38, y: 14, color: PAPER },
  { x: 38, y: 26, color: PAPER },
  { x: 38, y: 38, color: PAPER },
  { x: 26, y: 42, color: ACCENT },
] as const;

export const MARKIRO_COLORS = {
  ink: "17161A",
  paper: "FAFAF8",
  accent: "3DDC7A",
  muted: "6B6862",
  line: "E0DED7",
} as const;

export function renderMarkiroSymbolSvg(): string {
  const modules = MARKIRO_MODULES.map(
    ({ x, y, color }) => `<rect x="${x}" y="${y}" width="8" height="8" fill="#${hex(color)}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" fill="#17161A"/>${modules}</svg>`;
}

export function renderMarkiroSymbolPng(): Uint8Array {
  return renderRgbaPng(64, 64, (x, y) => {
    for (const module of MARKIRO_MODULES) {
      if (x >= module.x && x < module.x + 8 && y >= module.y && y < module.y + 8) {
        return module.color;
      }
    }
    return x >= 4 && x < 60 && y >= 4 && y < 60 ? INK : TRANSPARENT;
  });
}

export function prepareDataMatrixMedia(svg: string): {
  readonly svg: string;
  readonly png: Uint8Array;
} {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  // PINS bwip-js to 4.11.2: this regex requires `fill="#000000"` on the
  // generated path, and 4.11.4 stopped emitting it. Upgrading without relaxing
  // the match produces a subtly wrong barcode rather than a test failure, so
  // re-verify a scanned Data Matrix before moving the pin.
  const path = /<path d="([^"]+)"[^>]*fill="#000000"[^>]*\/>/.exec(svg);
  if (!viewBox || !path) throw new Error("Literal Data Matrix SVG has unsupported geometry");
  const pathData = path[1];
  if (!pathData) throw new Error("Literal Data Matrix SVG path is empty");

  const symbolWidth = Number(viewBox[1]);
  const symbolHeight = Number(viewBox[2]);
  if (symbolWidth !== symbolHeight || symbolWidth < 1) {
    throw new Error("Literal Data Matrix SVG must be a non-empty square");
  }

  const quietZone = 6;
  const size = symbolWidth + quietZone * 2;
  const polygons = parsePath(pathData);
  const opaqueSvg = svg
    .replace(
      `viewBox="0 0 ${symbolWidth} ${symbolHeight}"`,
      `viewBox="-${quietZone} -${quietZone} ${size} ${size}"`,
    )
    .replace(
      /(<svg[^>]*>)/,
      `$1<rect x="-${quietZone}" y="-${quietZone}" width="${size}" height="${size}" fill="#FFFFFF"/>`,
    );
  const png = renderRgbaPng(size, size, (x, y) => {
    const symbolX = x - quietZone + 0.5;
    const symbolY = y - quietZone + 0.5;
    return insideEvenOdd(polygons, symbolX, symbolY) ? ([0, 0, 0, 0xff] as const) : WHITE;
  });

  return { svg: opaqueSvg, png };
}

function hex(color: Rgba): string {
  return color
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function parsePath(path: string): readonly (readonly (readonly [number, number])[])[] {
  const tokens = path.match(/[MLZ]|-?\d+(?:\.\d+)?/g);
  if (!tokens) throw new Error("Literal Data Matrix SVG path is empty");

  const polygons: [number, number][][] = [];
  let polygon: [number, number][] | undefined;
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M") {
      if (polygon && polygon.length > 2) polygons.push(polygon);
      polygon = [];
    } else if (command === "Z") {
      if (polygon && polygon.length > 2) polygons.push(polygon);
      polygon = undefined;
    } else if (command !== "L") {
      throw new Error(`Unsupported literal Data Matrix SVG command: ${String(command)}`);
    }

    if (command === "M" || command === "L") {
      const x = Number(tokens[index++]);
      const y = Number(tokens[index++]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !polygon) {
        throw new Error("Literal Data Matrix SVG path contains invalid coordinates");
      }
      polygon.push([x, y]);
    }
  }
  if (polygon && polygon.length > 2) polygons.push(polygon);
  return polygons;
}

function insideEvenOdd(
  polygons: readonly (readonly (readonly [number, number])[])[],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (const polygon of polygons) {
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
      const currentPoint = polygon[index];
      const previousPoint = polygon[previous];
      if (!currentPoint || !previousPoint) continue;
      const [currentX, currentY] = currentPoint;
      const [previousX, previousY] = previousPoint;
      if (
        currentY > y !== previousY > y &&
        x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function renderRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
): Uint8Array {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    scanlines[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const color = pixel(x, y);
      scanlines.set(color, offset);
      offset += 4;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStore(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function zlibStore(input: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < input.length; offset += 0xffff) {
    const length = Math.min(0xffff, input.length - offset);
    const block = new Uint8Array(5 + length);
    block[0] = offset + length === input.length ? 1 : 0;
    block[1] = length & 0xff;
    block[2] = length >>> 8;
    const inverse = ~length & 0xffff;
    block[3] = inverse & 0xff;
    block[4] = inverse >>> 8;
    block.set(input.subarray(offset, offset + length), 5);
    blocks.push(block);
  }
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, adler32(input));
  blocks.push(checksum);
  return concat(blocks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concat([typeBytes, data])));
  return chunk;
}

function adler32(input: Uint8Array): number {
  let first = 1;
  let second = 0;
  for (const value of input) {
    first = (first + value) % 65521;
    second = (second + first) % 65521;
  }
  return ((second << 16) | first) >>> 0;
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of input) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
