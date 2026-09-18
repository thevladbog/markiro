import { renderCode128Svg, renderDataMatrixSvg } from "@markiro/domain";

/**
 * The print chrome shared by the "Состав короба" and "Состав паллеты" forms:
 * A4 page shell, CSS, brand lockup, barcode helpers and the fixed-height
 * pagination both use.
 *
 * Extracted from `box-report.ts` when the pallet form arrived rather than
 * copied, because the two documents differ only in what a row IS — a box
 * holding unit codes, or a pallet holding boxes. Every millimetre of the
 * packing arithmetic below is tied to the CSS heights in the same file, so a
 * second copy would be two sets of numbers that have to stay equal by hand.
 */

/** One unit code inside a box — feeds `renderDataMatrixSvg` as-is. */
export interface ReportCode {
  gtin14: string;
  serial: string;
  /** The canonical stored KM (`codes.canonical_raw`). */
  rawKm: string;
}

export interface ReportOrg {
  name: string;
  inn: string | null;
  logo: string | null;
}

/** Match the card's viewer timezone without depending on the server's timezone. */
export function formatDateTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  })
    .format(d)
    .replace(",", "");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `(00)146007034967000010` — human-readable HRI form of the 20-char machine SSCC. */
export function ssccHri(sscc20: string): string {
  return `(00)${sscc20.slice(2)}`;
}

/** Human-readable AI breakdown ("01 <gtin14> 21 <serial>") — the crypto tail isn't printable text. */
export function kmLabel(code: ReportCode): string {
  return `01 ${code.gtin14} 21 ${code.serial}`;
}

// ---- pagination ------------------------------------------------------------
//
// Fixed-A4-page packing: units with known per-unit millimetre heights, and a
// "band" (the top-level row) is never orphaned as the last unit of a page.

export type ReportUnit =
  | { kind: "row"; heightMm: number; html: string }
  | { kind: "band"; heightMm: number; html: string };

/** Free vertical space inside `.rep-content` on every page. */
const CONTENT_BUDGET_MM = 212;
/** Height reserved on the LAST page for the totals row. */
const FINAL_BLOCKS_MM = 10;

export function paginateUnits(units: ReportUnit[], headOverheadMm: number): ReportUnit[][] {
  const regularBudget = CONTENT_BUDGET_MM - headOverheadMm;
  const finalBudget = regularBudget - FINAL_BLOCKS_MM;
  const pages: ReportUnit[][] = [];
  let current: ReportUnit[] = [];
  let used = 0;

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i]!;
    const next = units[i + 1];
    // A band must fit together with the unit that follows it.
    const requiredMm = unit.kind === "band" && next ? unit.heightMm + next.heightMm : unit.heightMm;
    if (current.length > 0 && used + requiredMm > regularBudget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(unit);
    used += unit.heightMm;
  }
  pages.push(current);

  // The last page must also fit the final blocks; spill trailing units onto
  // extra pages until it does (guarding against a single oversized unit).
  for (;;) {
    const last = pages[pages.length - 1]!;
    let lastUsed = last.reduce((mm, unit) => mm + unit.heightMm, 0);
    if (lastUsed <= finalBudget || last.length <= 1) break;
    const overflow: ReportUnit[] = [];
    while (lastUsed > finalBudget && last.length > 1) {
      const moved = last.pop()!;
      overflow.unshift(moved);
      lastUsed -= moved.heightMm;
    }
    // Re-apply the no-orphan-band rule at the new page break.
    if (last.length > 1 && last[last.length - 1]!.kind === "band") {
      overflow.unshift(last.pop()!);
    }
    pages.push(overflow);
  }
  return pages;
}

// ---- shared fragments ------------------------------------------------------

function safeLogoSrc(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(candidate)) {
    return candidate;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : null;
  } catch {
    return null;
  }
}

export function brandLogo(org: ReportOrg | null): string {
  const organizationLogo = safeLogoSrc(org?.logo ?? null);
  if (organizationLogo) {
    return `<img class="brand-logo brand-logo--organization" src="${escapeHtml(organizationLogo)}" alt="${escapeHtml(org?.name ?? "Логотип организации")}">`;
  }
  // The brand lockup from apps/admin/src/assets/markiro-logo-on-light.svg,
  // inlined because this HTML must be self-contained for printing.
  return `<svg class="brand-logo brand-logo--markiro" data-brand-logo="markiro" viewBox="0 0 280 64" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Маркиро" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="56" height="56" fill="#17161A"/>
    <g fill="#FAFAF8">
      <rect x="14" y="14" width="8" height="8"/>
      <rect x="14" y="26" width="8" height="8"/>
      <rect x="14" y="38" width="8" height="8"/>
      <rect x="26" y="22" width="8" height="8"/>
      <rect x="38" y="14" width="8" height="8"/>
      <rect x="38" y="26" width="8" height="8"/>
      <rect x="38" y="38" width="8" height="8"/>
      <rect x="26" y="42" width="8" height="8" fill="#3DDC7A"/>
    </g>
    <text x="76" y="45" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="34" letter-spacing="-0.5" fill="#17161A">маркиро</text>
  </svg>`;
}

export function ssccBarcode(sscc20: string): string {
  try {
    return renderCode128Svg(sscc20, { includeText: false });
  } catch {
    return '<span class="rep-code-missing">Код не отображается</span>';
  }
}

export function dataMatrix(rawKm: string): string {
  try {
    return renderDataMatrixSvg(rawKm);
  } catch {
    return '<span class="rep-code-missing">Код не отображается</span>';
  }
}

// ---- row geometry ----------------------------------------------------------
//
// Each constant matches a height in the stylesheet below; change one and the
// other has to move with it or pagination drifts from what actually renders.

export const TABLE_HEAD_MM = 8;
/** The top-level row: a box in the box form, a pallet in the pallet form. */
export const PARENT_ROW_MM = 13;
/**
 * Roughly how many characters of the product name fit one line of the
 * product column (`.col-product` ≈ 66 mm at 10.5 px Arial). Deliberately a
 * little low: over-estimating the lines only leaves white space, while
 * under-estimating lets a row run past the page budget.
 */
const PRODUCT_CHARS_PER_LINE = 28;
/** One wrapped line of the product name, at its font size and line height. */
const PRODUCT_LINE_MM = 4.6;

/**
 * The top-level row grows with the product name instead of clamping it
 * (owner review 2026-09-18: the name must print in full). The row's own CSS
 * has `min-height` rather than `height`, so this is the pagination's view of
 * the same growth, not a second layout.
 */
export function parentRowHeightMm(productName: string | null): number {
  if (!productName) return PARENT_ROW_MM;
  const lines = productName
    .split(/\s*\n\s*/)
    .reduce(
      (n, paragraph) => n + Math.max(1, Math.ceil(paragraph.length / PRODUCT_CHARS_PER_LINE)),
      0,
    );
  return Math.max(PARENT_ROW_MM, Math.ceil(2 + lines * PRODUCT_LINE_MM));
}
/** A nested row: a unit code under a box, or a box under a pallet. */
export const CHILD_ROW_MM = 14.5;
export const EMPTY_NOTE_MM = 8;

export function emptyNoteUnit(text: string): ReportUnit {
  return {
    kind: "row",
    heightMm: EMPTY_NOTE_MM,
    html: `
      <tr class="rep-code-row rep-code-row--empty">
        <td></td>
        <td class="rep-km-label" colspan="4"><span class="rep-tree">└</span>${escapeHtml(text)}</td>
      </tr>`,
  };
}

// ---- document --------------------------------------------------------------

export interface ContentsReportDocument {
  /** "Состав короба" / "Состав паллеты" — also the HTML title. */
  titleLabel: string;
  /** The SSCC in HRI form, or "Без SSCC". */
  titleDoc: string;
  /** The line under the title, already escaped and allowed to carry `<strong>`. */
  titleDetailHtml: string;
  org: ReportOrg | null;
  metadataHtml: string;
  tableHeadHtml: string;
  units: ReportUnit[];
  finalBlocksHtml: string;
  /** The 20-character machine SSCC repeated in the page footer, when there is one. */
  footerSscc: string | null;
  /** "Короб" / "Паллета" — the footer's subject word. */
  footerSubject: string;
}

/** Pure: builds the print-ready A4 contents document. No I/O, no `Date.now()`. */
export function renderContentsReportHtml(doc: ContentsReportDocument): string {
  const pages = paginateUnits(doc.units, TABLE_HEAD_MM);
  const totalPages = pages.length;
  const logo = brandLogo(doc.org);
  const footBarcode = doc.footerSscc
    ? `<span class="code128-box">${ssccBarcode(doc.footerSscc)}</span>`
    : "<span></span>";

  const renderedPages = pages
    .map((pageUnits, index) => {
      const pageNumber = index + 1;
      const isLastPage = pageNumber === totalPages;
      const body = `<table class="rep-table">
        <colgroup><col class="col-n"><col class="col-sscc"><col class="col-product"><col class="col-count"><col class="col-barcode"></colgroup>
        ${doc.tableHeadHtml}
        <tbody>${pageUnits.map((unit) => unit.html).join("")}</tbody>
      </table>`;
      return `<section class="rep-page" data-report-page="${pageNumber}">
    <header class="rep-header">
      <div class="rep-brand">${logo}</div>
      <div class="rep-title">
        <span class="rep-title-label">${escapeHtml(doc.titleLabel)}</span>
        <span class="rep-title-doc">${escapeHtml(doc.titleDoc)}</span>
        <span class="rep-title-detail">${doc.titleDetailHtml}</span>
      </div>
    </header>
    ${doc.metadataHtml}
    <main class="rep-content">
      ${body}
      ${isLastPage ? doc.finalBlocksHtml : ""}
    </main>
    <footer class="rep-footer">
      ${footBarcode}
      <span class="rep-footer-copy">Сформировано в Маркиро · ${escapeHtml(doc.footerSubject)} ${escapeHtml(doc.titleDoc)}</span>
      <span class="rep-page-number">стр. ${pageNumber} из ${totalPages}</span>
    </footer>
  </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.titleLabel)} ${escapeHtml(doc.titleDoc)}</title>
<style>
@page { size: A4; margin: 0 }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: #E9E7E1; font-family: Arial, sans-serif; color: #17161A; }
.mono { font-family: monospace; font-variant-numeric: tabular-nums; }
.rep-page { width: 210mm; height: 297mm; margin: 8mm auto; padding: 11mm 14mm 10mm; background: #fff; display: grid; grid-template-rows: auto auto 1fr auto; gap: 4mm; overflow: hidden; break-after: page; page-break-after: always; font-size: 11px; line-height: 1.35; }
.rep-page:last-child { break-after: auto; page-break-after: auto; }
.rep-header { min-height: 18mm; display: flex; align-items: flex-start; justify-content: space-between; gap: 10mm; }
.rep-brand { width: 48mm; min-width: 48mm; height: 12mm; display: flex; align-items: center; }
.brand-logo { display: block; max-width: 44mm; max-height: 12mm; width: auto; height: auto; object-fit: contain; object-position: left center; }
.brand-logo--markiro { width: 40mm; height: 9mm; }
.rep-title { min-width: 0; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 1mm; }
.rep-title-label, .rep-title-doc { font-size: 18px; line-height: 1.05; font-weight: 700; }
.rep-title-doc { overflow-wrap: anywhere; }
.rep-title-detail { color: #45433E; font-size: 10.5px; }
.rep-meta { min-height: 18mm; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6mm; }
.rep-meta-cell { min-width: 0; display: flex; flex-direction: column; gap: 1mm; }
.rep-meta-label { color: #6B6862; font-size: 9px; line-height: 1; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.rep-meta-value { font-weight: 700; }
.rep-meta-detail { color: #45433E; font-size: 10px; }
.rep-content { min-height: 0; display: flex; flex-direction: column; gap: 2.5mm; overflow: hidden; }
.rep-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.col-n { width: 8mm; } .col-sscc { width: 44mm; } .col-product { width: auto; } .col-count { width: 18mm; } .col-barcode { width: 46mm; }
.rep-table-head { display: table-header-group; }
.rep-table-head tr { height: 7mm; background: #17161A; color: #FAFAF8; }
.rep-table-head th { padding: 1.5mm 2mm; font-size: 8.5px; line-height: 1; text-align: left; text-transform: uppercase; letter-spacing: .04em; }
.rep-table-head th:first-child { border-radius: 2mm 0 0 0; }
.rep-table-head th:last-child { border-radius: 0 2mm 0 0; }
.rep-box-row { min-height: 13mm; background: #F7F6F2; break-inside: avoid; page-break-inside: avoid; border-top: .25mm solid #C9C6BD; border-bottom: .25mm solid #E0DED7; }
.rep-box-row td { min-height: 13mm; padding: 1mm 2mm; vertical-align: middle; overflow: hidden; }
.rep-code-row { height: 14.5mm; break-inside: avoid; page-break-inside: avoid; border-bottom: .25mm solid #EDEBE5; }
.rep-code-row td { height: 14.5mm; padding: 1mm 2mm; vertical-align: middle; overflow: hidden; }
.rep-km-label { color: #45433E; font-size: 8.5px; overflow-wrap: anywhere; padding-left: 5mm !important; }
.rep-tree { display: inline-block; width: 3.5mm; color: #A5A29A; }
.rep-row-note { color: #6B6862; font-size: 8px; font-family: Arial, sans-serif; }
.rep-code-row--empty { height: 8mm; }
.rep-code-row--empty td { height: 8mm; color: #6B6862; font-size: 9.5px; }
.rep-item-number { text-align: center; }
.rep-product-name { display: block; line-height: 1.25; overflow-wrap: anywhere; }
.rep-sscc-label { font-size: 9.5px; font-weight: 700; overflow-wrap: anywhere; }
.rep-count { text-align: right !important; white-space: nowrap; }
.rep-barcode-heading { text-align: center !important; }
.sscc-box { height: 8mm; display: flex; align-items: center; justify-content: center; }
.sscc-box svg { display: block; width: auto; max-width: 42mm; height: 100%; }
.rep-code-missing { font-size: 9px; line-height: 1.2; color: #6B6862; text-align: center; }
.dm-box { width: 11.5mm; height: 11.5mm; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
.dm-box svg { display: block; width: 100%; height: 100%; }
.rep-final-blocks { margin-top: auto; break-inside: avoid; page-break-inside: avoid; display: flex; flex-direction: column; gap: 2.5mm; }
.rep-total { min-height: 7mm; padding: 1.5mm 2mm; border-bottom: .25mm solid #C9C6BD; display: flex; justify-content: flex-end; align-items: baseline; gap: 8mm; font-size: 12px; font-weight: 700; }
.rep-footer { min-height: 11mm; padding-top: 2mm; border-top: .25mm solid #E0DED7; display: grid; grid-template-columns: 48mm 1fr auto; align-items: center; gap: 4mm; color: #6B6862; font: 9px/1.3 monospace; }
.code128-box { height: 9mm; display: flex; align-items: center; }
.code128-box svg { display: block; width: auto; height: 100%; }
.rep-footer-copy { text-align: right; }
.rep-page-number { min-width: 20mm; text-align: right; color: #17161A; font-weight: 700; }
@media print {
  body { background: #fff; }
  .rep-page { margin: 0; }
}
</style>
</head>
<body>${renderedPages}</body>
</html>`;
}
