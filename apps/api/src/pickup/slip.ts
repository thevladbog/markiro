import { renderCode128Svg, renderDataMatrixSvg, renderQrSvg } from "@markiro/domain";

/** One row of the "Ведомость отбора" KM table. */
export interface PickupSlipItem {
  n: number;
  productName: string;
  gtin14: string;
  serial: string;
  /** The raw stored KM — fed as-is to `renderDataMatrixSvg`. */
  rawKm: string;
  unitPrice: string | null;
}

/**
 * Everything `renderPickupSlipHtml` needs to build the A4 printed slip for
 * one pickup order. Gathered by `PickupOrdersService.slipData` from the
 * order + its items(+products) + the employee's active badge + this
 * tenant's `orgProfiles` row (any of which may legitimately be missing —
 * `org`/`employee.role`/`employee.badgeCode` are nullable, not required).
 */
export interface PickupSlipData {
  orderNo: string;
  createdAt: Date;
  org: { name: string; inn: string | null; logo: string | null } | null;
  employee: { id: string; fullName: string; role: string | null; badgeCode: string | null };
  kioskName: string;
  reason: "buy" | "writeoff";
  writeoffReasonName: string | null;
  printEmployeeQrOnSlip: boolean;
  /** Pre-computed order total, formatted as a decimal string (e.g. "126.00"), or null if unknown. */
  total: string | null;
  items: PickupSlipItem[];
}

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "23 июля 2026 г." — UTC, so the printed slip reads the same regardless of the server's local timezone. */
function formatDateLong(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()} г.`;
}

/** "23.07.2026 14:05" — UTC (see formatDateLong). */
function formatDateTime(d: Date): string {
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "…4412" — the last 4 characters of a badge code, matching the prototype's masking. */
function maskBadge(code: string): string {
  return code.length > 4 ? `…${code.slice(-4)}` : code;
}

function reasonLabel(reason: "buy" | "writeoff"): string {
  return reason === "buy" ? "Покупка" : "Списание";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: string | null): string {
  return value === null ? "—" : value;
}

const REGULAR_PAGE_ITEM_CAPACITY = 10;
const FINAL_PAGE_ITEM_CAPACITY = 8;

function paginatePickupSlipItems(items: PickupSlipItem[]): PickupSlipItem[][] {
  if (items.length === 0) return [[]];
  if (items.length <= FINAL_PAGE_ITEM_CAPACITY) return [items];

  const pageCount =
    1 + Math.ceil((items.length - FINAL_PAGE_ITEM_CAPACITY) / REGULAR_PAGE_ITEM_CAPACITY);
  const finalPageSize = Math.min(FINAL_PAGE_ITEM_CAPACITY, Math.ceil(items.length / pageCount));
  const regularItemCount = items.length - finalPageSize;
  const regularPageCount = pageCount - 1;
  const pages: PickupSlipItem[][] = [];
  let offset = 0;

  for (let pageIndex = 0; pageIndex < regularPageCount; pageIndex += 1) {
    const remainingPages = regularPageCount - pageIndex;
    const remainingItems = regularItemCount - offset;
    const pageSize = Math.min(
      REGULAR_PAGE_ITEM_CAPACITY,
      Math.ceil(remainingItems / remainingPages),
    );
    pages.push(items.slice(offset, offset + pageSize));
    offset += pageSize;
  }

  pages.push(items.slice(offset));
  return pages;
}

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

function brandLogo(data: PickupSlipData): string {
  const organizationLogo = safeLogoSrc(data.org?.logo ?? null);
  if (organizationLogo) {
    return `<img class="brand-logo brand-logo--organization" src="${escapeHtml(organizationLogo)}" alt="${escapeHtml(data.org?.name ?? "Логотип организации")}">`;
  }
  return `<svg class="brand-logo brand-logo--markiro" data-brand-logo="markiro" viewBox="0 0 150 34" role="img" aria-label="Маркиро" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="5" width="24" height="24" rx="5" fill="#17161A"/>
    <path d="M6 23V11h3.8l2.2 5.6 2.2-5.6H18v12h-3v-6.8l-2 4.8h-2l-2-4.8V23H6Z" fill="#fff"/>
    <text x="32" y="24" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#17161A">маркиро</text>
  </svg>`;
}

/** Human-readable AI breakdown ("01 <gtin14> 21 <serial>") — the crypto tail isn't printable text. */
function kmLabel(item: PickupSlipItem): string {
  return `01 ${item.gtin14} 21 ${item.serial}`;
}

function itemRow(item: PickupSlipItem): string {
  let dm: string;
  try {
    dm = renderDataMatrixSvg(item.rawKm);
  } catch {
    dm =
      '<span style="font-size: 9px; line-height: 1.2; color: #6B6862; text-align: center">Код не отображается</span>';
  }
  return `
      <tr class="slip-item-row">
        <td class="mono slip-item-number">${item.n}</td>
        <td><span class="slip-product-name">${escapeHtml(item.productName)}</span></td>
        <td class="mono slip-km-label">${escapeHtml(kmLabel(item))}</td>
        <td class="mono slip-price">${escapeHtml(money(item.unitPrice))}</td>
        <td><span class="dm-box">${dm}</span></td>
      </tr>`;
}

function metadataBlock(data: PickupSlipData, orgBlock: string, employeeTail: string): string {
  return `<div class="slip-meta">
    <div class="slip-meta-cell">
      <span class="slip-meta-label">Организация</span>
      ${orgBlock}
    </div>
    <div class="slip-meta-cell">
      <span class="slip-meta-label">Сотрудник</span>
      <span class="slip-meta-value">${escapeHtml(data.employee.fullName)}</span>
      <span class="slip-meta-detail">${escapeHtml(employeeTail) || "—"}</span>
    </div>
    <div class="slip-meta-cell">
      <span class="slip-meta-label">Заявка</span>
      <span class="slip-meta-value">№ ${escapeHtml(data.orderNo)} · ${formatDateTime(data.createdAt)}</span>
      <span class="slip-meta-detail">${escapeHtml(data.kioskName)} · причина: <strong>${reasonLabel(data.reason)}</strong></span>
    </div>
  </div>`;
}

function tableHead(): string {
  return `<thead class="slip-table-head">
    <tr>
      <th>№</th>
      <th>Продукт</th>
      <th>Код маркировки (КМ)</th>
      <th class="slip-price">Цена, ₽</th>
      <th class="slip-dm-heading">DataMatrix</th>
    </tr>
  </thead>`;
}

function finalBlocks(data: PickupSlipData, writeoffSubReason: string, badgeQr: string): string {
  return `<div class="slip-final-blocks">
    <div class="slip-total">
      <span>Итого по заявке:</span>
      <span class="mono">${data.items.length} шт. · ${escapeHtml(money(data.total))}</span>
    </div>
    <div class="slip-operation">
      <span class="slip-meta-label">Способ вывода из оборота</span>
      <div class="slip-operation-options">
        <span><i class="checkbox-mark"></i>Продажа сотруднику — чек ККТ № ______</span>
        <span><i class="checkbox-mark"></i>Списание — акт № ______ · подпричина: ____________</span>
      </div>
      <span>Причина, выбранная сотрудником на киоске: <strong>${reasonLabel(data.reason)}</strong>${writeoffSubReason}.</span>
      <strong class="slip-price-notice">Цена является информационной. Окончательная цена будет указана в чеке.</strong>
      <span class="slip-operation-note">DataMatrix в таблице пригоден для сканирования на кассе. После операции статусы кодов обновятся в ГИС МТ автоматически.</span>
    </div>
    ${badgeQr}
    <div class="slip-signatures">
      <div class="slip-signature">
        <span class="slip-meta-label">Продукцию получил</span>
        <span class="signature-line"></span>
        <span class="signature-name">${escapeHtml(data.employee.fullName)}</span>
      </div>
      <div class="slip-signature">
        <span class="slip-meta-label">Администратор</span>
        <span class="signature-line"></span>
        <span class="signature-name">ФИО</span>
      </div>
    </div>
  </div>`;
}

/** Pure: builds the print-ready A4 "Ведомость отбора по заявке" document. No I/O, no `Date.now()`. */
export function renderPickupSlipHtml(data: PickupSlipData): string {
  const orgBlock = data.org
    ? `<span class="slip-meta-value">${escapeHtml(data.org.name)}</span>
      <span class="slip-meta-detail">${data.org.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "ИНН не указан"}</span>`
    : `<span class="slip-meta-value">—</span>
      <span class="slip-meta-detail">Профиль организации не заполнен</span>`;

  const employeeTail = [
    data.employee.role,
    data.employee.badgeCode ? `бейдж ${maskBadge(data.employee.badgeCode)}` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" · ");

  const writeoffSubReason = data.writeoffReasonName
    ? ` (подпричина: ${escapeHtml(data.writeoffReasonName)})`
    : "";

  const badgeLabel = data.employee.badgeCode
    ? ` (бейдж ${escapeHtml(maskBadge(data.employee.badgeCode))})`
    : "";
  const badgeQr = data.printEmployeeQrOnSlip
    ? `<div class="slip-employee-qr">
      <span class="qr-box">${renderQrSvg(data.employee.id)}</span>
      <span class="slip-employee-qr-copy">
        <strong>Отсканируйте код, чтобы найти сотрудника на кассе или в системе</strong>
        <span>QR сотрудника ${escapeHtml(data.employee.fullName)}${badgeLabel} — открывает карточку сотрудника и его заявки.</span>
      </span>
    </div>`
    : "";

  const orderBarcode = renderCode128Svg(data.orderNo, { includeText: false });
  const pages = paginatePickupSlipItems(data.items);
  const totalPages = pages.length;
  const logo = brandLogo(data);
  const metadata = metadataBlock(data, orgBlock, employeeTail);
  const renderedPages = pages
    .map((items, index) => {
      const pageNumber = index + 1;
      const isLastPage = pageNumber === totalPages;
      return `<section class="slip-page" data-slip-page="${pageNumber}">
    <header class="slip-header">
      <div class="slip-brand">${logo}</div>
      <div class="slip-title">
        <span class="slip-title-label">Ведомость отбора по заявке</span>
        <span class="slip-title-order">№ ${escapeHtml(data.orderNo)}</span>
        <span class="slip-title-detail">от ${formatDateLong(data.createdAt)} · ${escapeHtml(data.kioskName)}, причина: <strong>${reasonLabel(data.reason)}</strong>${writeoffSubReason}</span>
      </div>
    </header>
    ${metadata}
    <main class="slip-content">
      <table class="slip-table">
        <colgroup><col class="col-n"><col class="col-product"><col class="col-km"><col class="col-price"><col class="col-dm"></colgroup>
        ${tableHead()}
        <tbody>${items.map(itemRow).join("")}</tbody>
      </table>
      ${isLastPage ? finalBlocks(data, writeoffSubReason, badgeQr) : ""}
    </main>
    <footer class="slip-footer">
      <span class="code128-box">${orderBarcode}</span>
      <span class="slip-footer-copy">Сформировано в Маркиро · Заявка № ${escapeHtml(data.orderNo)}</span>
      <span class="slip-page-number">стр. ${pageNumber} из ${totalPages}</span>
    </footer>
  </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Ведомость отбора по заявке № ${escapeHtml(data.orderNo)}</title>
<style>
@page { size: A4; margin: 0 }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: #E9E7E1; font-family: Arial, sans-serif; color: #17161A; }
.mono { font-family: monospace; font-variant-numeric: tabular-nums; }
.slip-page { width: 210mm; height: 297mm; margin: 8mm auto; padding: 11mm 14mm 10mm; background: #fff; display: grid; grid-template-rows: auto auto 1fr auto; gap: 4mm; overflow: hidden; break-after: page; page-break-after: always; font-size: 11px; line-height: 1.35; }
.slip-page:last-child { break-after: auto; page-break-after: auto; }
.slip-header { min-height: 18mm; display: flex; align-items: flex-start; justify-content: space-between; gap: 10mm; }
.slip-brand { width: 48mm; min-width: 48mm; height: 12mm; display: flex; align-items: center; }
.brand-logo { display: block; max-width: 44mm; max-height: 12mm; width: auto; height: auto; object-fit: contain; object-position: left center; }
.brand-logo--markiro { width: 40mm; height: 9mm; }
.slip-title { min-width: 0; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 1mm; }
.slip-title-label, .slip-title-order { font-size: 18px; line-height: 1.05; font-weight: 700; }
.slip-title-order { overflow-wrap: anywhere; }
.slip-title-detail { color: #45433E; font-size: 10.5px; }
.slip-meta { min-height: 18mm; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6mm; }
.slip-meta-cell { min-width: 0; display: flex; flex-direction: column; gap: 1mm; }
.slip-meta-label { color: #6B6862; font-size: 9px; line-height: 1; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.slip-meta-value { font-weight: 700; }
.slip-meta-detail { color: #45433E; font-size: 10px; }
.slip-content { min-height: 0; display: flex; flex-direction: column; gap: 2.5mm; overflow: hidden; }
.slip-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.col-n { width: 8mm; } .col-product { width: auto; } .col-km { width: 58mm; } .col-price { width: 18mm; } .col-dm { width: 17mm; }
.slip-table-head { display: table-header-group; }
.slip-table-head tr { height: 7mm; background: #17161A; color: #FAFAF8; }
.slip-table-head th { padding: 1.5mm 2mm; font-size: 8.5px; line-height: 1; text-align: left; text-transform: uppercase; letter-spacing: .04em; }
.slip-table-head th:first-child { border-radius: 2mm 0 0 0; }
.slip-table-head th:last-child { border-radius: 0 2mm 0 0; }
.slip-item-row { height: 14.5mm; break-inside: avoid; page-break-inside: avoid; border-bottom: .25mm solid #E0DED7; }
.slip-item-row td { height: 14.5mm; padding: 1mm 2mm; vertical-align: middle; overflow: hidden; }
.slip-item-number { text-align: center; }
.slip-product-name { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; line-height: 1.25; }
.slip-km-label { color: #45433E; font-size: 8.5px; overflow-wrap: anywhere; }
.slip-price { text-align: right !important; white-space: nowrap; }
.slip-dm-heading { text-align: center !important; }
.dm-box svg, .qr-box svg { display: block; width: 100%; height: 100%; }
.dm-box { width: 11.5mm; height: 11.5mm; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
.slip-final-blocks { break-inside: avoid; page-break-inside: avoid; display: flex; flex-direction: column; gap: 2.5mm; }
.slip-total { min-height: 7mm; padding: 1.5mm 2mm; border-bottom: .25mm solid #C9C6BD; display: flex; justify-content: flex-end; align-items: baseline; gap: 8mm; font-size: 12px; font-weight: 700; }
.slip-operation { padding: 3mm 4mm; border: .25mm solid #E0DED7; border-radius: 2mm; background: #F7F6F2; display: flex; flex-direction: column; gap: 1.5mm; color: #45433E; font-size: 9.5px; }
.slip-operation-options { display: flex; gap: 7mm; }
.slip-operation-options > span { display: flex; align-items: center; gap: 2mm; }
.checkbox-mark { width: 3mm; height: 3mm; border: .35mm solid #45433E; border-radius: .5mm; display: inline-block; flex: 0 0 auto; }
.slip-price-notice { color: #17161A; }
.slip-operation-note { color: #6B6862; }
.slip-employee-qr { min-height: 23mm; padding: 2mm 4mm; border: .25mm solid #E0DED7; border-radius: 2mm; display: flex; align-items: center; gap: 4mm; }
.qr-box { width: 19mm; height: 19mm; flex: 0 0 auto; }
.slip-employee-qr-copy { display: flex; flex-direction: column; gap: 1mm; color: #6B6862; font-size: 9px; }
.slip-employee-qr-copy strong { color: #17161A; font-size: 10.5px; }
.slip-signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; padding: 1mm 3mm 0; }
.slip-signature { display: grid; grid-template-columns: 1fr; gap: 1.5mm; }
.signature-line { width: 48mm; height: 4mm; border-bottom: .35mm solid #17161A; display: block; }
.signature-name { min-height: 4mm; color: #6B6862; font-size: 9.5px; }
.slip-footer { min-height: 11mm; padding-top: 2mm; border-top: .25mm solid #E0DED7; display: grid; grid-template-columns: 48mm 1fr auto; align-items: center; gap: 4mm; color: #6B6862; font: 9px/1.3 monospace; }
.code128-box { height: 9mm; display: flex; align-items: center; }
.code128-box svg { display: block; width: auto; height: 100%; }
.slip-footer-copy { text-align: right; }
.slip-page-number { min-width: 20mm; text-align: right; color: #17161A; font-weight: 700; }
@media print {
  body { background: #fff; }
  .slip-page { margin: 0; }
}
</style>
</head>
<body>${renderedPages}</body>
</html>`;
}
