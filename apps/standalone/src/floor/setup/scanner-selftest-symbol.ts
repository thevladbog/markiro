import { renderCode128Svg, renderDataMatrixSvg } from "@markiro/domain";

import { GS, type SelfTestKind } from "./scanner-selftest.js";

/**
 * The self-test's symbol in the forms the owner asked for: on the screen (SVG), as a PNG and as a PDF
 * to save and print. All three come from the domain's own encoder (`renderDataMatrixSvg` frames a
 * marking code in GS1 as the product's labels do), so the symbol is the one a label carries.
 */

/** The symbol as an SVG string, or `null` when the encoder refuses the text. */
export function symbolSvg(kind: SelfTestKind, code: string): string | null {
  try {
    return kind === "dm"
      ? renderDataMatrixSvg(code)
      : renderCode128Svg(code, { includeText: false });
  } catch {
    return null;
  }
}

export interface SymbolPath {
  /** `m`, `l`, `h` operations as absolute points: a run of polygons or lines. */
  subpaths: { x: number; y: number }[][];
  closed: boolean[];
  /** Stroked lines (a linear code) carry a width; filled polygons (a matrix code) do not. */
  strokeWidth: number | null;
}

export interface SymbolGeometry {
  width: number;
  height: number;
  paths: SymbolPath[];
}

/**
 * The geometry of a symbol SVG the encoder made: its viewBox and its paths of absolute `M`, `L` and
 * `Z` commands. `null` for anything else, so a changed encoder output disables the saved forms
 * instead of producing a wrong symbol.
 */
export function parseSymbolSvg(svg: string): SymbolGeometry | null {
  const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (box === null) return null;
  const paths: SymbolPath[] = [];
  for (const match of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attributes = match[1] ?? "";
    const d = /\bd="([^"]*)"/.exec(attributes)?.[1];
    if (d === undefined) return null;
    const width = /stroke-width="(\d+(?:\.\d+)?)"/.exec(attributes)?.[1];
    const subpaths: { x: number; y: number }[][] = [];
    const closed: boolean[] = [];
    for (const command of d.matchAll(/([MLZ])\s*(-?\d+(?:\.\d+)?)?[\s,]*(-?\d+(?:\.\d+)?)?/g)) {
      const [, op, a, b] = command;
      if (op === "Z") {
        closed[subpaths.length - 1] = true;
        continue;
      }
      if (a === undefined || b === undefined) return null;
      const point = { x: Number(a), y: Number(b) };
      if (op === "M") {
        subpaths.push([point]);
        closed.push(false);
      } else subpaths.at(-1)?.push(point);
    }
    const leftover = d.replace(/[MLZ\s,]|-?\d+(?:\.\d+)?/g, "");
    if (leftover !== "" || subpaths.length === 0) return null;
    paths.push({ subpaths, closed, strokeWidth: width === undefined ? null : Number(width) });
  }
  if (paths.length === 0) return null;
  return { width: Number(box[1]), height: Number(box[2]), paths };
}

/** A quiet zone of this many module-units around the symbol in PNG and PDF. */
const QUIET = 4;

function trace(
  context: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">,
  path: SymbolPath,
): void {
  path.subpaths.forEach((points, index) => {
    points.forEach((point, at) => {
      if (at === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    if (path.closed[index]) context.closePath();
  });
}

/** The symbol and the word «ТЕСТ» as a PNG, `side` pixels square. Needs a canvas (a browser). */
export async function symbolPng(
  kind: SelfTestKind,
  code: string,
  side = 900,
): Promise<Blob | null> {
  const svg = symbolSvg(kind, code);
  const geometry = svg === null ? null : parseSymbolSvg(svg);
  if (geometry === null) return null;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, side, side);
  const header = Math.round(side * 0.16);
  const room = side - header;
  const unit = Math.min(
    (side * 0.92) / (geometry.width + QUIET * 2),
    (room * 0.92) / (geometry.height + QUIET * 2),
  );
  context.fillStyle = "#000";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${Math.round(header * 0.62)}px sans-serif`;
  context.fillText("ТЕСТ  ·  TEST", side / 2, header / 2);
  context.save();
  context.translate(
    (side - geometry.width * unit) / 2,
    header + (room - geometry.height * unit) / 2,
  );
  context.scale(unit, unit);
  context.strokeStyle = "#000";
  for (const path of geometry.paths) {
    context.beginPath();
    trace(context, path);
    if (path.strokeWidth === null) context.fill("evenodd");
    else {
      context.lineWidth = path.strokeWidth;
      context.stroke();
    }
  }
  context.restore();
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

function pdfText(text: string): string {
  return text.replace(/[\\()]/g, (symbol) => `\\${symbol}`).replace(/[^\x20-\x7e]/g, "?");
}

/**
 * The symbol as a one-page A5 PDF, vector, with the words TEST / NOT A PRODUCT CODE and the code in
 * words (a separator written `<GS>`). A hand-made PDF: Helvetica and path operators only, so no
 * library and no font to bundle.
 */
export function symbolPdf(kind: SelfTestKind, code: string): Blob | null {
  const svg = symbolSvg(kind, code);
  const geometry = svg === null ? null : parseSymbolSvg(svg);
  if (geometry === null) return null;
  const page = { width: 420, height: 595 };
  const box = 300;
  const unit = Math.min(
    box / (geometry.width + QUIET * 2),
    (box * (kind === "dm" ? 1 : 0.5)) / (geometry.height + QUIET * 2),
  );
  const left = (page.width - geometry.width * unit) / 2;
  const top = 190;
  const number = (value: number) => value.toFixed(3);
  const ops: string[] = [];
  ops.push("BT /F2 64 Tf 1 0 0 1 120 520 Tm (TEST) Tj ET");
  ops.push("BT /F1 12 Tf 1 0 0 1 60 490 Tm (Markiro: scanner check. NOT a product code.) Tj ET");
  ops.push(
    `q ${number(unit)} 0 0 ${number(-unit)} ${number(left)} ${number(page.height - top)} cm 0 g 0 G`,
  );
  for (const path of geometry.paths) {
    path.subpaths.forEach((points, index) => {
      points.forEach((point, at) => {
        ops.push(`${number(point.x)} ${number(point.y)} ${at === 0 ? "m" : "l"}`);
      });
      if (path.closed[index]) ops.push("h");
    });
    if (path.strokeWidth === null) ops.push("f*");
    else ops.push(`${number(path.strokeWidth)} w S`);
  }
  ops.push("Q");
  const words = code.replaceAll(GS, "<GS>");
  for (const [index, line] of (words.match(/.{1,62}/g) ?? []).entries()) {
    ops.push(`BT /F3 9 Tf 1 0 0 1 40 ${100 - index * 12} Tm (${pdfText(line)}) Tj ET`);
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}
