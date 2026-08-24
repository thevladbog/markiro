import { renderCode128Svg, renderDataMatrixSvg } from "@markiro/domain";

/** One unit code inside the box — feeds `renderDataMatrixSvg` as-is. */
export interface BoxReportCode {
  gtin14: string;
  serial: string;
  /** The canonical stored KM (`codes.canonical_raw`). */
  rawKm: string;
}

/**
 * Everything `renderBoxReportHtml` needs to build the printed A4 "Состав
 * короба" form for one box. Gathered by `CodeSearchService.boxReportData`.
 * Same self-contained-HTML print contract as disaggregation's `report.ts`
 * (which this file is modelled on), reduced to a single box: one tree table
 * with the box row (SSCC + Code128) and its unit codes (DataMatrix)
 * indented underneath. Deliberately price-free, like the act.
 */
export interface BoxReportData {
  /** 20-character machine form `00…`, or null for a box without an SSCC. */
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  productName: string | null;
  org: { name: string; inn: string | null; logo: string | null } | null;
  openedAt: Date;
  closedAt: Date | null;
  disassembledAt: Date | null;
  codes: BoxReportCode[];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "23.07.2026 14:05" — UTC, so the printed form reads the same regardless of the server's local timezone. */
function formatDateTime(d: Date): string {
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `(00)146007034967000010` — human-readable HRI form of the 20-char machine SSCC. */
function ssccHri(sscc20: string): string {
  return `(00)${sscc20.slice(2)}`;
}

/** Human-readable AI breakdown ("01 <gtin14> 21 <serial>") — the crypto tail isn't printable text. */
function kmLabel(code: BoxReportCode): string {
  return `01 ${code.gtin14} 21 ${code.serial}`;
}

const STATUS_LABEL: Record<BoxReportData["status"], string> = {
  open: "Открыт",
  closed: "Закрыт",
  disassembled: "Расформирован",
};

// ---- pagination ------------------------------------------------------------
//
// Same fixed-A4-page packing as disaggregation's report.ts: units with known
// per-unit millimetre heights, and the box-header "band" is never orphaned
// as the last unit of a page.

type ReportUnit =
  | { kind: "row"; heightMm: number; html: string }
  | { kind: "band"; heightMm: number; html: string };

/** Free vertical space inside `.rep-content` on every page. */
const CONTENT_BUDGET_MM = 212;
/** Height reserved on the LAST page for the totals row. */
const FINAL_BLOCKS_MM = 10;

function paginateUnits(units: ReportUnit[], headOverheadMm: number): ReportUnit[][] {
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

function brandLogo(data: BoxReportData): string {
  const organizationLogo = safeLogoSrc(data.org?.logo ?? null);
  if (organizationLogo) {
    return `<img class="brand-logo brand-logo--organization" src="${escapeHtml(organizationLogo)}" alt="${escapeHtml(data.org?.name ?? "Логотип организации")}">`;
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

function ssccBarcode(sscc20: string): string {
  try {
    return renderCode128Svg(sscc20, { includeText: false });
  } catch {
    return '<span class="rep-code-missing">Код не отображается</span>';
  }
}

function dataMatrix(rawKm: string): string {
  try {
    return renderDataMatrixSvg(rawKm);
  } catch {
    return '<span class="rep-code-missing">Код не отображается</span>';
  }
}

function metadataBlock(data: BoxReportData): string {
  const orgBlock = data.org
    ? `<span class="rep-meta-value">${escapeHtml(data.org.name)}</span>
      <span class="rep-meta-detail">${data.org.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "ИНН не указан"}</span>`
    : `<span class="rep-meta-value">—</span>
      <span class="rep-meta-detail">Профиль организации не заполнен</span>`;

  const lifecycle = [
    `открыт ${formatDateTime(data.openedAt)}`,
    ...(data.closedAt ? [`закрыт ${formatDateTime(data.closedAt)}`] : []),
    ...(data.disassembledAt ? [`расформирован ${formatDateTime(data.disassembledAt)}`] : []),
  ].join(" · ");

  return `<div class="rep-meta">
    <div class="rep-meta-cell">
      <span class="rep-meta-label">Организация</span>
      ${orgBlock}
    </div>
    <div class="rep-meta-cell">
      <span class="rep-meta-label">Продукт</span>
      <span class="rep-meta-value">${data.productName ? escapeHtml(data.productName) : "—"}</span>
      <span class="rep-meta-detail">Кодов в коробе: ${data.codes.length}</span>
    </div>
    <div class="rep-meta-cell">
      <span class="rep-meta-label">Короб</span>
      <span class="rep-meta-value">${STATUS_LABEL[data.status]}</span>
      <span class="rep-meta-detail">${lifecycle}</span>
    </div>
  </div>`;
}

function finalBlocks(data: BoxReportData): string {
  return `<div class="rep-final-blocks">
    <div class="rep-total">
      <span>Итого по коробу:</span>
      <span class="mono">кодов — ${data.codes.length}</span>
    </div>
  </div>`;
}

// ---- table rows ------------------------------------------------------------
//
// ONE table, same tree shape as the disaggregation act's contents variant:
// the top-level row is the box with the SSCC Code128 in the right column,
// and each unit code follows underneath as an indented tree row (├/└) with
// the code's DataMatrix in that same right column.

const TABLE_HEAD_MM = 8;
const BOX_ROW_MM = 13;
const CODE_ROW_MM = 14.5;
const EMPTY_NOTE_MM = 8;

function tableHead(): string {
  return `<thead class="rep-table-head">
    <tr>
      <th>№</th>
      <th>Код упаковки (SSCC) / код маркировки (КМ)</th>
      <th>Продукт</th>
      <th class="rep-count">Кодов, шт.</th>
      <th class="rep-barcode-heading">Штрихкод / DataMatrix</th>
    </tr>
  </thead>`;
}

function boxRow(data: BoxReportData): string {
  return `
      <tr class="rep-box-row">
        <td class="mono rep-item-number">1</td>
        <td class="mono rep-sscc-label">${data.sscc ? escapeHtml(ssccHri(data.sscc)) : "Без SSCC"}</td>
        <td><span class="rep-product-name">${data.productName ? escapeHtml(data.productName) : "—"}</span></td>
        <td class="mono rep-count">${data.codes.length}</td>
        <td>${data.sscc ? `<span class="sscc-box">${ssccBarcode(data.sscc)}</span>` : ""}</td>
      </tr>`;
}

function codeRow(code: BoxReportCode, isLast: boolean): string {
  return `
      <tr class="rep-code-row">
        <td></td>
        <td class="mono rep-km-label"><span class="rep-tree">${isLast ? "└" : "├"}</span>${escapeHtml(kmLabel(code))}</td>
        <td></td>
        <td></td>
        <td><span class="dm-box">${dataMatrix(code.rawKm)}</span></td>
      </tr>`;
}

function contentsUnits(data: BoxReportData): ReportUnit[] {
  const units: ReportUnit[] = [{ kind: "band", heightMm: BOX_ROW_MM, html: boxRow(data) }];
  if (data.codes.length === 0) {
    units.push({
      kind: "row",
      heightMm: EMPTY_NOTE_MM,
      html: `
      <tr class="rep-code-row rep-code-row--empty">
        <td></td>
        <td class="rep-km-label" colspan="4"><span class="rep-tree">└</span>Короб пуст</td>
      </tr>`,
    });
    return units;
  }
  data.codes.forEach((code, index) => {
    units.push({
      kind: "row",
      heightMm: CODE_ROW_MM,
      html: codeRow(code, index === data.codes.length - 1),
    });
  });
  return units;
}

// ---- document --------------------------------------------------------------

/** Pure: builds the print-ready A4 "Состав короба" document. No I/O, no `Date.now()`. */
export function renderBoxReportHtml(data: BoxReportData): string {
  const units = contentsUnits(data);
  const pages = paginateUnits(units, TABLE_HEAD_MM);
  const totalPages = pages.length;
  const logo = brandLogo(data);
  const metadata = metadataBlock(data);
  const titleDoc = data.sscc ? ssccHri(data.sscc) : "Без SSCC";
  const footBarcode = data.sscc
    ? `<span class="code128-box">${ssccBarcode(data.sscc)}</span>`
    : "<span></span>";

  const renderedPages = pages
    .map((pageUnits, index) => {
      const pageNumber = index + 1;
      const isLastPage = pageNumber === totalPages;
      const body = `<table class="rep-table">
        <colgroup><col class="col-n"><col class="col-sscc"><col class="col-product"><col class="col-count"><col class="col-barcode"></colgroup>
        ${tableHead()}
        <tbody>${pageUnits.map((unit) => unit.html).join("")}</tbody>
      </table>`;
      return `<section class="rep-page" data-report-page="${pageNumber}">
    <header class="rep-header">
      <div class="rep-brand">${logo}</div>
      <div class="rep-title">
        <span class="rep-title-label">Состав короба</span>
        <span class="rep-title-doc">${escapeHtml(titleDoc)}</span>
        <span class="rep-title-detail">открыт ${formatDateTime(data.openedAt)} · статус: <strong>${STATUS_LABEL[data.status]}</strong></span>
      </div>
    </header>
    ${metadata}
    <main class="rep-content">
      ${body}
      ${isLastPage ? finalBlocks(data) : ""}
    </main>
    <footer class="rep-footer">
      ${footBarcode}
      <span class="rep-footer-copy">Сформировано в Маркиро · Короб ${escapeHtml(titleDoc)}</span>
      <span class="rep-page-number">стр. ${pageNumber} из ${totalPages}</span>
    </footer>
  </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Состав короба ${escapeHtml(titleDoc)}</title>
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
.col-n { width: 8mm; } .col-sscc { width: 52mm; } .col-product { width: auto; } .col-count { width: 20mm; } .col-barcode { width: 52mm; }
.rep-table-head { display: table-header-group; }
.rep-table-head tr { height: 7mm; background: #17161A; color: #FAFAF8; }
.rep-table-head th { padding: 1.5mm 2mm; font-size: 8.5px; line-height: 1; text-align: left; text-transform: uppercase; letter-spacing: .04em; }
.rep-table-head th:first-child { border-radius: 2mm 0 0 0; }
.rep-table-head th:last-child { border-radius: 0 2mm 0 0; }
.rep-box-row { height: 13mm; background: #F7F6F2; break-inside: avoid; page-break-inside: avoid; border-top: .25mm solid #C9C6BD; border-bottom: .25mm solid #E0DED7; }
.rep-box-row td { height: 13mm; padding: 1mm 2mm; vertical-align: middle; overflow: hidden; }
.rep-code-row { height: 14.5mm; break-inside: avoid; page-break-inside: avoid; border-bottom: .25mm solid #EDEBE5; }
.rep-code-row td { height: 14.5mm; padding: 1mm 2mm; vertical-align: middle; overflow: hidden; }
.rep-km-label { color: #45433E; font-size: 8.5px; overflow-wrap: anywhere; padding-left: 5mm !important; }
.rep-tree { display: inline-block; width: 3.5mm; color: #A5A29A; }
.rep-code-row--empty { height: 8mm; }
.rep-code-row--empty td { height: 8mm; color: #6B6862; font-size: 9.5px; }
.rep-item-number { text-align: center; }
.rep-product-name { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; line-height: 1.25; }
.rep-sscc-label { font-size: 9.5px; font-weight: 700; overflow-wrap: anywhere; }
.rep-count { text-align: right !important; white-space: nowrap; }
.rep-barcode-heading { text-align: center !important; }
.sscc-box { height: 8mm; display: flex; align-items: center; justify-content: center; }
.sscc-box svg { display: block; width: auto; max-width: 48mm; height: 100%; }
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
