import { renderLiteralDataMatrixSvg } from "../barcodes/svg.js";

import { escapeHtml } from "./task-form-chrome.js";

/**
 * The printed PAIRING CARD of a device (standalone office, «Подключить
 * устройство»): one A4 or A5 page with the DataMatrix of the pairing payload,
 * the typed code in large type, the host's addresses and the certificate
 * fingerprint formatted for a side-by-side comparison, and how long the code
 * lives. The code is a one-time secret: the card is drawn on demand from what
 * the dialog holds and is never kept.
 *
 * Pure: no I/O, no clock. The markup is also well-formed XML (no named
 * entities, closed tags), so a caller can rasterise the same fragment through
 * an SVG `foreignObject` for a PDF without a second layout.
 */

export type PairingCardFormat = "a4" | "a5";

export interface PairingCardData {
  /** The DataMatrix payload, `markiro-host:1?…`, drawn as is. */
  payload: string;
  /** The canonical code, ten characters; printed in two groups of five. */
  code: string;
  /** The host's addresses with the port, `192.168.1.10:45710`; may be empty. */
  addresses: readonly string[];
  /** The certificate fingerprint as the screens write it, groups of four. */
  fingerprint: string;
  /** How long the code lives after it is made, in minutes. */
  validMinutes: number;
  /** Until when by the printing PC's clock, as text; `null` leaves it out. */
  validUntil: string | null;
  /** The organization, `null` when unknown. */
  organizationName: string | null;
}

interface Size {
  page: string;
  widthMm: number;
  heightMm: number;
  matrixMm: number;
  codePt: number;
  bodyPt: number;
  paddingMm: number;
}

const SIZES: Record<PairingCardFormat, Size> = {
  a4: {
    page: "A4 portrait",
    widthMm: 210,
    heightMm: 297,
    matrixMm: 80,
    codePt: 40,
    bodyPt: 11,
    paddingMm: 16,
  },
  a5: {
    page: "A5 portrait",
    widthMm: 148,
    heightMm: 210,
    matrixMm: 52,
    codePt: 28,
    bodyPt: 9,
    paddingMm: 10,
  },
};

const STEPS = [
  "На устройстве откройте «Подключение к хосту в сети».",
  "Наведите сканер на код выше или введите код вручную.",
  "Сверьте отпечаток на экране устройства с отпечатком в этой карточке и подтвердите.",
];

function pairingCardCss(size: Size): string {
  return `    * { box-sizing: border-box; }
    .pc-page { width: ${size.widthMm}mm; height: ${size.heightMm}mm; padding: ${size.paddingMm}mm; background: #fff; color: #17161a; font-family: Arial, "Helvetica Neue", sans-serif; font-size: ${size.bodyPt}pt; line-height: 1.35; display: flex; flex-direction: column; overflow: hidden; }
    .pc-eyebrow { color: #706d67; font-size: ${size.bodyPt - 2}pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .pc-title { margin: 2mm 0 0; font-size: ${size.bodyPt + 9}pt; line-height: 1.1; font-weight: 700; }
    .pc-org { margin: 1.5mm 0 0; color: #4f4c47; }
    .pc-scan { display: flex; flex-direction: column; align-items: center; margin-top: 6mm; padding: 5mm 0; border-top: .35mm solid #17161a; border-bottom: .25mm solid #cbc7bf; }
    .pc-matrix { width: ${size.matrixMm}mm; height: ${size.matrixMm}mm; padding: 3mm; background: #fff; border: .25mm solid #cbc7bf; }
    .pc-matrix svg { display: block; width: 100%; height: 100%; }
    .pc-code { margin-top: 5mm; font: 700 ${size.codePt}pt/1.1 ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; letter-spacing: .1em; }
    .pc-code-label { margin-top: 2mm; color: #4f4c47; }
    .pc-params { margin: 5mm 0 0; padding: 0; }
    .pc-param { display: grid; grid-template-columns: 38mm minmax(0, 1fr); gap: 4mm; padding: 2mm 0; border-bottom: .2mm solid #d8d5cf; }
    .pc-param dt { margin: 0; color: #706d67; font-size: ${size.bodyPt - 2}pt; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
    .pc-param dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-weight: 700; overflow-wrap: anywhere; }
    .pc-param dd.pc-plain { font-family: Arial, "Helvetica Neue", sans-serif; }
    .pc-steps { margin: 4mm 0 0; padding-left: 5mm; color: #4f4c47; }
    .pc-warning { margin-top: auto; padding: 3mm 4mm; border: .25mm solid #e3c88f; border-radius: 2mm; background: #fbf3df; color: #6a4a07; font-size: ${size.bodyPt - 1}pt; }`;
}

function param(label: string, value: string, plain = false): string {
  return `<div class="pc-param"><dt>${escapeHtml(label)}</dt><dd${plain ? ' class="pc-plain"' : ""}>${value}</dd></div>`;
}

/**
 * The card's style and markup, both well-formed XML; `renderPairingCardHtml`
 * wraps them in a document, and a rasteriser lays the same fragment out
 * inside an SVG `foreignObject`.
 */
export function renderPairingCardFragment(
  data: PairingCardData,
  format: PairingCardFormat,
): { css: string; html: string; widthMm: number; heightMm: number } {
  const size = SIZES[format];
  const code = `${data.code.slice(0, 5)} ${data.code.slice(5)}`;
  const addresses =
    data.addresses.length === 0
      ? "нет адреса в локальной сети: введите адрес хоста на устройстве вручную"
      : data.addresses.map((address) => escapeHtml(address)).join("<br/>");
  const lifetime = `${data.validMinutes} мин, код одноразовый${
    data.validUntil === null ? "" : `; действует до ${escapeHtml(data.validUntil)}`
  }`;
  const html = `<div class="pc-page" xmlns="http://www.w3.org/1999/xhtml">
  <div class="pc-eyebrow">Markiro Автоном</div>
  <h1 class="pc-title">Подключение устройства к хосту</h1>${
    data.organizationName === null
      ? ""
      : `
  <div class="pc-org">${escapeHtml(data.organizationName)}</div>`
  }
  <div class="pc-scan">
    <div class="pc-matrix">${renderLiteralDataMatrixSvg(data.payload)}</div>
    <div class="pc-code">${escapeHtml(code)}</div>
    <div class="pc-code-label">Код подключения</div>
  </div>
  <dl class="pc-params">
    ${param("Адрес хоста", addresses)}
    ${param("Отпечаток хоста", escapeHtml(data.fingerprint))}
    ${param("Срок действия", escapeHtml(lifetime), true)}
  </dl>
  <ol class="pc-steps">${STEPS.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
  <div class="pc-warning">Код подключения одноразовый и секретный: не оставляйте лист без присмотра, после подключения уничтожьте его.</div>
</div>`;
  return { css: pairingCardCss(size), html, widthMm: size.widthMm, heightMm: size.heightMm };
}

/** Pure: the print-ready pairing card document, A4 or A5. */
export function renderPairingCardHtml(data: PairingCardData, format: PairingCardFormat): string {
  const { css, html } = renderPairingCardFragment(data, format);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Подключение устройства</title>
<style>
@page { size: ${SIZES[format].page}; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
${css}
</style>
</head>
<body>
${html}
</body>
</html>
`;
}
