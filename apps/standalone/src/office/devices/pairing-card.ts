import {
  renderPairingCardFragment,
  renderPairingCardHtml,
  type PairingCardData,
  type PairingCardFormat,
} from "@markiro/domain";

import { formatFingerprint } from "../../app/fingerprint.js";
import { parsePairingPayload } from "../../host/pairing-code.js";
import type { PairingCode } from "../../host/protocol.js";

/** Pixels per millimetre at the CSS reference of 96 per inch. */
const CSS_PX_PER_MM = 96 / 25.4;
/** The resolution the card is drawn at for the PDF: 200 dpi keeps a DataMatrix module 15+ px wide. */
const PDF_DPI = 200;
/** PDF points (1/72 inch) per millimetre. */
const PT_PER_MM = 72 / 25.4;

/**
 * What the card prints, from the code on the dialog's screen. `null` when the
 * payload cannot be read (it always can: the host made it); the dialog then
 * offers neither button. `validUntil` is this PC's clock, as the countdown is.
 */
export function pairingCardData(
  code: PairingCode,
  deadline: number,
  lifetimeMs: number,
): PairingCardData | null {
  const payload = parsePairingPayload(code.payload);
  if (payload === null) return null;
  return {
    payload: code.payload,
    code: code.code,
    addresses: payload.addresses.map((host) => `${host}:${payload.port}`),
    fingerprint: formatFingerprint(payload.fingerprint),
    validMinutes: Math.round(lifetimeMs / 60_000),
    validUntil: new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(
      new Date(deadline),
    ),
    organizationName: null,
  };
}

/** The card's HTML for the office's print frame. */
export function pairingCardHtml(data: PairingCardData, format: PairingCardFormat): string {
  return renderPairingCardHtml(data, format);
}

/** A drawn page: JPEG bytes and the pixels they are. */
export interface CardImage {
  jpeg: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/** Draws the card to a JPEG; tests pass their own, since jsdom has no canvas. */
export type CardRasterizer = (
  data: PairingCardData,
  format: PairingCardFormat,
) => Promise<CardImage>;

/**
 * The card drawn by the webview itself: the same markup the print uses is
 * laid out inside an SVG `foreignObject`, which the browser rasterises onto a
 * white canvas. No network, no new dependency; the fonts are the system's,
 * as for the printed page.
 */
export const rasterizeCard: CardRasterizer = async (data, format) => {
  const { css, html, widthMm, heightMm } = renderPairingCardFragment(data, format);
  const width = Math.round((widthMm / 25.4) * PDF_DPI);
  const height = Math.round((heightMm / 25.4) * PDF_DPI);
  const cssWidth = widthMm * CSS_PX_PER_MM;
  const cssHeight = heightMm * CSS_PX_PER_MM;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${cssWidth} ${cssHeight}"><foreignObject width="${cssWidth}" height="${cssHeight}">` +
    `<style>${css}</style>${html}</foreignObject></svg>`;
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("the pairing card did not draw"));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.95),
  );
  if (blob === null) throw new Error("the pairing card did not encode");
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width, height };
};

function ascii(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * A one-page PDF of a page-sized JPEG: the image fills the page. Written by
 * hand (catalog, pages, page, image, content, cross-reference table) so no
 * PDF library is needed; `pageWidthMm`/`pageHeightMm` size the page.
 */
export function pdfOfImage(
  image: CardImage,
  pageWidthMm: number,
  pageHeightMm: number,
): Uint8Array<ArrayBuffer> {
  const width = (pageWidthMm * PT_PER_MM).toFixed(2);
  const height = (pageHeightMm * PT_PER_MM).toFixed(2);
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Uint8Array<ArrayBuffer>) => {
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (number: number, head: string, stream?: Uint8Array<ArrayBuffer>) => {
    offsets[number] = length;
    push(ascii(`${number} 0 obj\n${head}`));
    if (stream !== undefined) {
      push(ascii("\nstream\n"));
      push(stream);
      push(ascii("\nendstream"));
    }
    push(ascii("\nendobj\n"));
  };
  push(ascii("%PDF-1.4\n%âãÏÓ\n"));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
  );
  object(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>`,
    image.jpeg,
  );
  object(5, `<< /Length ${content.length} >>`, ascii(content));
  const xref = length;
  let table = `xref\n0 6\n0000000000 65535 f \n`;
  for (let number = 1; number <= 5; number++) {
    table += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(ascii(table));
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The pairing card as a PDF file's bytes: drawn, then wrapped; nothing is kept. */
export async function pairingCardPdf(
  data: PairingCardData,
  format: PairingCardFormat,
  rasterize: CardRasterizer = rasterizeCard,
): Promise<Blob> {
  const { widthMm, heightMm } = renderPairingCardFragment(data, format);
  const bytes = pdfOfImage(await rasterize(data, format), widthMm, heightMm);
  return new Blob([bytes], { type: "application/pdf" });
}
