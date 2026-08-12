import type { BillingProfileSnapshot, PrintDocumentModel } from "./print-document-model";

const escape = (value: unknown) =>
  (typeof value === "string" || typeof value === "number" ? String(value) : "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const date = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "—");
const profileRows = (profile: BillingProfileSnapshot) =>
  [
    ["Наименование", profile.legalName],
    ["ИНН", profile.taxId],
    ["Регистрационный номер", profile.registrationId],
    ["Адрес", profile.address],
    ["Расчётный счёт", profile.bankAccount],
    ["Банк", profile.bankName],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`)
    .join("");

export function renderPrintHtml(model: PrintDocumentModel): string {
  const title = model.kind === "invoice" ? "Счёт на оплату" : "Коммерческое предложение";
  const disclaimer =
    model.kind === "offer" ? '<p class="disclaimer">Не является счётом на оплату</p>' : "";
  const rows = model.lines
    .map(
      (line) =>
        `<tr><td>${line.position}</td><td><strong>${escape(line.name)}</strong>${line.description ? `<small>${escape(line.description)}</small>` : ""}</td><td>${escape(line.unit)}</td><td>${line.quantity}</td><td>${escape(line.unitPrice)} ₽</td><td>${escape(line.lineTotal)} ₽</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escape(title)} ${escape(model.number)}</title><style>@page{size:A4;margin:16mm}body{font:14px Arial,sans-serif;color:#171717;margin:0}h1{font-size:24px;margin:0 0 6px}.meta{color:#555}.profiles{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0}.profiles h2{font-size:14px}.profiles dl{margin:0}.profiles dl div{display:grid;grid-template-columns:130px 1fr;gap:8px;margin:4px 0}.profiles dt{color:#666}.profiles dd{margin:0}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#f3f3f3}td small{display:block;color:#666;margin-top:3px}.totals{margin:24px 0 0 auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:4px}.totals div:last-child{border-top:1px solid #777;font-weight:bold}.terms{margin-top:28px}.disclaimer{font-weight:bold}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:48px}.signature{border-top:1px solid #777;padding-top:8px;color:#555}</style></head><body><h1>${escape(title)} № ${escape(model.number)}</h1><p class="meta">Дата: ${date(model.issuedOrPublishedAt)} · ${model.kind === "invoice" ? `Срок оплаты: ${date(model.dueOrExpiresAt)}` : `Действительно до: ${date(model.dueOrExpiresAt)}`}</p>${disclaimer}<section class="profiles"><div><h2>Поставщик</h2><dl>${profileRows(model.seller)}</dl></div><div><h2>Покупатель</h2><dl>${profileRows(model.buyer)}</dl></div></section><table><thead><tr><th>№</th><th>Позиция</th><th>Ед.</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${rows}</tbody></table><div class="totals"><div><span>Подытог</span><strong>${escape(model.subtotal)} ₽</strong></div><div><span>НДС</span><strong>${escape(model.vatTotal)} ₽</strong></div><div><span>Итого</span><strong>${escape(model.total)} ₽</strong></div></div>${model.termsHtml ? `<section class="terms"><h2>Условия</h2>${model.termsHtml}</section>` : ""}<section class="signatures"><div class="signature">Поставщик / подпись</div><div class="signature">Покупатель / подпись</div></section></body></html>`;
}
