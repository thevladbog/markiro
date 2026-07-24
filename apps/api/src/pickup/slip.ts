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
  org: { name: string; inn: string | null } | null;
  employee: { fullName: string; role: string | null; badgeCode: string | null };
  kioskName: string;
  reason: "buy" | "writeoff";
  writeoffReasonName: string | null;
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
  return value === null ? "—" : `${value} ₽`;
}

/** Human-readable AI breakdown ("01 <gtin14> 21 <serial>") — the crypto tail isn't printable text. */
function kmLabel(item: PickupSlipItem): string {
  return `01 ${item.gtin14} 21 ${item.serial}`;
}

function itemRow(item: PickupSlipItem): string {
  const dm = renderDataMatrixSvg(item.rawKm);
  return `
        <div style="display: grid; grid-template-columns: 8mm 1fr 58mm 13mm 15mm; gap: 0 4mm; align-items: center; border-bottom: 1px solid #E0DED7; padding: 4px 10px">
          <span class="mono">${item.n}</span>
          <span>${escapeHtml(item.productName)}</span>
          <span class="mono" style="font-size: 10px; color: #45433E">${escapeHtml(kmLabel(item))}</span>
          <span class="mono" style="text-align: right">${escapeHtml(money(item.unitPrice))}</span>
          <span class="dm-box" style="width: 13mm; height: 13mm; display: flex; align-items: center; justify-content: center; justify-self: center">${dm}</span>
        </div>`;
}

/** Pure: builds the print-ready A4 "Ведомость отбора по заявке" document. No I/O, no `Date.now()`. */
export function renderPickupSlipHtml(data: PickupSlipData): string {
  const orgBlock = data.org
    ? `<span style="font-weight: 600">${escapeHtml(data.org.name)}</span>
        <span style="color: #45433E; font-size: 11.5px">${data.org.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "ИНН не указан"}</span>`
    : `<span style="font-weight: 600">—</span>
        <span style="color: #45433E; font-size: 11.5px">Профиль организации не заполнен</span>`;

  const employeeTail = [
    data.employee.role,
    data.employee.badgeCode ? `бейдж ${maskBadge(data.employee.badgeCode)}` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" · ");

  const writeoffSubReason = data.writeoffReasonName
    ? ` (подпричина: ${escapeHtml(data.writeoffReasonName)})`
    : "";

  const itemCountLabel = `${data.items.length} шт.`;

  const badgeQr = data.employee.badgeCode
    ? `
    <div style="display: flex; align-items: center; gap: 14px; border: 1px solid #E0DED7; border-radius: 8px; padding: 10px 14px">
      <span class="qr-box" style="width: 22mm; height: 22mm; flex-shrink: 0; display: flex; align-items: center; justify-content: center">${renderQrSvg(data.employee.badgeCode)}</span>
      <span style="display: flex; flex-direction: column; gap: 4px">
        <span style="font: 600 12.5px/1.3 sans-serif">Отсканируйте код, чтобы найти сотрудника на кассе или в системе</span>
        <span style="color: #6B6862; font-size: 10.5px">QR бейджа ${escapeHtml(data.employee.fullName)} (${escapeHtml(maskBadge(data.employee.badgeCode))}) — открывает карточку сотрудника и его заявки в Платформе маркиро.</span>
      </span>
    </div>`
    : "";

  const orderBarcode = renderCode128Svg(data.orderNo);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Ведомость отбора по заявке № ${escapeHtml(data.orderNo)}</title>
<style>
@page { size: A4; margin: 0 }
body { margin: 0; font-family: sans-serif; color: #17161A; }
.mono { font-family: monospace; font-variant-numeric: tabular-nums; }
/* The barcode SVGs from @markiro/domain carry no width/height attributes
   (only a viewBox) — force them to fill their sized container instead of
   falling back to the ~300x150 default replaced-element size. */
.dm-box svg, .qr-box svg { display: block; width: 100%; height: 100%; }
.code128-box svg { display: block; width: auto; height: 100%; }
</style>
</head>
<body>
  <section style="background: #FFFFFF; padding: 13mm 15mm; box-sizing: border-box; display: flex; flex-direction: column; gap: 6mm; font-size: 12px; line-height: 1.5">

    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 24px">
      <div style="display: flex; flex-direction: column; gap: 2px">
        <span style="font: 600 22px/1 monospace">маркиро</span>
        <span style="font: 400 11px/1 sans-serif; color: #6B6862">Платформа маркировки «Честный ЗНАК» · markiro.ru</span>
      </div>
      <div style="text-align: right; display: flex; flex-direction: column; gap: 2px">
        <span style="font: 700 20px/1.2 sans-serif">Ведомость отбора по заявке № ${escapeHtml(data.orderNo)}</span>
        <span style="font: 400 12.5px/1.4 sans-serif; color: #45433E">от ${formatDateLong(data.createdAt)} · ${escapeHtml(data.kioskName)}, причина: <strong>${reasonLabel(data.reason)}</strong>${writeoffSubReason}</span>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px">
      <div style="display: flex; flex-direction: column; gap: 3px">
        <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.06em">Организация</span>
        ${orgBlock}
      </div>
      <div style="display: flex; flex-direction: column; gap: 3px">
        <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.06em">Сотрудник</span>
        <span style="font-weight: 600">${escapeHtml(data.employee.fullName)}</span>
        <span style="color: #45433E; font-size: 11.5px">${escapeHtml(employeeTail) || "—"}</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 3px">
        <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.06em">Заявка</span>
        <span style="font-weight: 600">№ ${escapeHtml(data.orderNo)} · ${formatDateTime(data.createdAt)}</span>
        <span style="color: #45433E; font-size: 11.5px">${escapeHtml(data.kioskName)} · причина: <strong>${reasonLabel(data.reason)}</strong></span>
      </div>
    </div>

    <div style="display: flex; flex-direction: column">
      <div style="display: grid; grid-template-columns: 8mm 1fr 58mm 13mm 15mm; gap: 0 4mm; align-items: center; background: #17161A; color: #FAFAF8; border-radius: 6px 6px 0 0; padding: 7px 10px; font: 600 10px/1 sans-serif; text-transform: uppercase; letter-spacing: 0.05em">
        <span>№</span><span>Продукт</span><span>Код маркировки (КМ)</span><span style="text-align: right">Цена, ₽</span><span style="text-align: center">DataMatrix</span>
      </div>${data.items.map(itemRow).join("")}
      <div style="display: flex; justify-content: flex-end; gap: 24px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #C9C6BD">
        <span style="font: 600 13px/1.4 sans-serif">Итого по заявке:</span>
        <span class="mono" style="font: 600 14px/1.4 monospace">${itemCountLabel} · ${escapeHtml(money(data.total))}</span>
      </div>
    </div>

    <div style="background: #F7F6F2; border: 1px solid #E0DED7; border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; color: #45433E">
      <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.05em">Способ вывода из оборота</span>
      <span style="display: flex; gap: 28px">
        <span style="display: flex; align-items: center; gap: 7px"><span style="width: 11px; height: 11px; border: 1.5px solid #45433E; border-radius: 2px; display: inline-block"></span>Продажа сотруднику — чек ККТ № ______</span>
        <span style="display: flex; align-items: center; gap: 7px"><span style="width: 11px; height: 11px; border: 1.5px solid #45433E; border-radius: 2px; display: inline-block"></span>Списание — акт № ______ · подпричина: ____________</span>
      </span>
      <span style="color: #45433E; font-size: 10.5px">Причина, выбранная сотрудником на киоске: <strong>${reasonLabel(data.reason)}</strong>${writeoffSubReason}.</span>
      <span style="color: #6B6862; font-size: 10.5px">DataMatrix в таблице пригоден для сканирования на кассе. После операции статусы кодов обновятся в ГИС МТ автоматически.</span>
    </div>

    ${badgeQr}

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 0 10px">
      <div style="display: flex; flex-direction: column; gap: 14px">
        <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.06em">Продукцию получил</span>
        <span style="display: flex; align-items: baseline; gap: 10px"><span style="display: inline-block; width: 48mm; border-bottom: 1px solid #17161A"></span><span style="font-size: 11px; color: #6B6862">${escapeHtml(data.employee.fullName)}</span></span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px">
        <span style="font: 600 10px/1 sans-serif; color: #6B6862; text-transform: uppercase; letter-spacing: 0.06em">Администратор</span>
        <span style="display: flex; align-items: baseline; gap: 10px"><span style="display: inline-block; width: 48mm; border-bottom: 1px solid #17161A"></span><span style="font-size: 11px; color: #6B6862"></span></span>
      </div>
    </div>

    <div style="border-top: 1px solid #E0DED7; padding-top: 8px; display: flex; justify-content: space-between; align-items: center; font: 400 10px/1.4 monospace; color: #6B6862">
      <span style="display: flex; align-items: center; gap: 8px">
        <span class="code128-box" style="height: 12mm; display: flex; align-items: center">${orderBarcode}</span>
      </span>
      <span style="text-align: right">Сформировано в Платформе маркиро<br>Заявка № ${escapeHtml(data.orderNo)} · стр. 1 из 1</span>
    </div>

  </section>
</body>
</html>`;
}
