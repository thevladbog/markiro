import { renderCode128Svg, renderQrSvg } from "@markiro/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeOfferTermsHtml } from "../platform-offers/offer-terms";
import {
  amountInWords,
  documentBarcodeValue,
  documentKindLabel,
  documentSubject,
  formatMoney,
  formatPrintDate,
  formatPrintDateTime,
  paymentPurpose,
  paymentQrPayload,
  profileIdentity,
} from "./print-document-layout";
import type { BillingProfileSnapshot, PrintDocumentModel, PrintLine } from "./print-document-model";

const markiroLogoDataUri = `data:image/png;base64,${readFileSync(
  join(__dirname, "assets/markiro-logo-on-light.png"),
).toString("base64")}`;

const escape = (value: unknown) =>
  (typeof value === "string" || typeof value === "number" ? String(value) : "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const inlineSvg = (svg: string, label: string) =>
  svg.replace("<svg ", `<svg role="img" aria-label="${escape(label)}" `);

const code128Background = (svg: string) => {
  const width = Number(svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)?.[1]);
  if (!Number.isFinite(width) || width <= 0) throw new Error("document_barcode_render_failed");
  const bars = [...svg.matchAll(/<path[^>]*stroke-width="([\d.]+)"[^>]*d="([^"]+)"/g)].flatMap(
    (path) => {
      const strokeWidth = Number(path[1]);
      return [...(path[2] ?? "").matchAll(/M([\d.]+)\s/g)].map((line) => {
        const x = Number(line[1]);
        return {
          start: Math.max(0, ((x - strokeWidth / 2) / width) * 100),
          end: Math.min(100, ((x + strokeWidth / 2) / width) * 100),
        };
      });
    },
  );
  if (bars.length === 0) throw new Error("document_barcode_render_failed");
  bars.sort((left, right) => left.start - right.start);
  const stops = ["transparent 0"];
  for (const bar of bars) {
    const start = `${bar.start.toFixed(4)}%`;
    const end = `${bar.end.toFixed(4)}%`;
    stops.push(`transparent ${start}`, `#000 ${start}`, `#000 ${end}`, `transparent ${end}`);
  }
  stops.push("transparent 100%");
  return `background:linear-gradient(to right,${stops.join(",")})`;
};

const profileBlock = (label: string, profile: BillingProfileSnapshot) =>
  `<section class="party"><div class="section-label">${label}</div><strong>${escape(profile.legalName)}</strong><div class="mono muted">${escape(profileIdentity(profile))}</div>${profile.address ? `<div class="party-address">${escape(profile.address)}</div>` : ""}</section>`;

const lineRows = (lines: PrintLine[]) =>
  lines
    .map(
      (line) =>
        `<tr><td class="mono number">${line.position}</td><td><strong>${escape(line.name)}</strong>${line.description ? `<small>${escape(line.description)}</small>` : ""}</td><td>${escape(line.unit)}</td><td class="mono numeric">${line.quantity}</td><td class="mono numeric">${escape(formatMoney(line.unitPrice))}</td><td class="mono numeric">${escape(formatMoney(line.lineTotal))}</td></tr>`,
    )
    .join("");

const documentHeader = (model: PrintDocumentModel, firstPage = false) => {
  const logo = `<img class="brand-logo--markiro" src="${markiroLogoDataUri}" alt="${firstPage ? "" : "Маркиро"}">`;
  return `<header class="document-header${firstPage ? " print-first" : ""}"${firstPage ? ' aria-hidden="true"' : ""}>${logo}<div class="document-id"><strong>${documentKindLabel(model)}</strong><span>№ ${escape(model.number)} · ${formatPrintDate(model.issuedOrPublishedAt)}</span></div></header>`;
};

const documentFooter = (model: PrintDocumentModel, barcode: string, firstPage = false) => {
  const barcodeValue = documentBarcodeValue(model);
  return `<footer class="document-footer${firstPage ? " print-first" : ""}"${firstPage ? ' aria-hidden="true"' : ""}><div class="form-barcode-group"><div class="form-barcode" role="img" aria-label="Штрихкод формы" data-barcode-value="${escape(barcodeValue)}" style="${barcode}"></div><span class="form-barcode-caption">${escape(barcodeValue)}</span></div><span>Сформировано системой Markiro · ${formatPrintDateTime(model.issuedOrPublishedAt)}</span></footer>`;
};

const bankBlock = (model: PrintDocumentModel) => {
  const seller = model.seller;
  const payload = paymentQrPayload(model);
  const qr = payload
    ? `<div class="payment-qr">${inlineSvg(renderQrSvg(payload), "QR-код для оплаты счёта")}</div>`
    : "";
  return `<section class="bank${payload ? "" : " bank--compact"}"><div class="bank-main"><div class="section-label">БАНКОВСКИЕ РЕКВИЗИТЫ</div><span class="muted">Получатель</span><strong>${escape(seller.legalName)}</strong><span class="mono">${seller.taxId ? `ИНН ${escape(seller.taxId)}` : ""}${seller.kpp ? ` · КПП ${escape(seller.kpp)}` : ""}</span><span class="mono">${seller.bic ? `БИК ${escape(seller.bic)}` : ""}${seller.correspondentAccount ? ` · к/с ${escape(seller.correspondentAccount)}` : ""}</span></div><div class="bank-account"><span class="muted">Расчётный счёт</span><strong class="mono account">${escape(seller.bankAccount)}</strong><span>${escape(seller.bankName)}</span><span class="mono muted">Валюта: ${escape(seller.currency ?? "RUB")}</span></div>${qr}</section>`;
};

const itemsTable = (lines: PrintLine[]) =>
  `<table class="items-table"><thead><tr><th>№</th><th>ПОЗИЦИЯ</th><th>ЕД.</th><th>КОЛ-ВО</th><th>ЦЕНА</th><th>СУММА</th></tr></thead><tbody>${lineRows(lines)}</tbody></table>`;

const totals = (model: PrintDocumentModel) =>
  `<section class="total-block"><div><span>Подытог</span><strong>${escape(formatMoney(model.subtotal))}</strong></div><div><span>НДС</span><strong>${escape(formatMoney(model.vatTotal))}</strong></div><div class="grand-total"><span>ИТОГО</span><strong>${escape(formatMoney(model.total))}</strong></div><p>${escape(amountInWords(model.total))}</p></section>`;

const closing = (model: PrintDocumentModel) => {
  const terms =
    model.kind === "offer" && model.termsHtml
      ? `<section class="terms"><div class="section-label">УСЛОВИЯ СОТРУДНИЧЕСТВА</div>${sanitizeOfferTermsHtml(model.termsHtml)}</section>`
      : "";
  const payment =
    model.kind === "invoice"
      ? `<section class="purpose"><div class="section-label">НАЗНАЧЕНИЕ ПЛАТЕЖА</div><p>${escape(paymentPurpose(model))}</p></section>`
      : '<p class="offer-notice">Не является счётом на оплату</p>';
  return `${totals(model)}${terms}${payment}<section class="signing"><div class="signature"><div class="section-label">ПОСТАВЩИК</div><span>________________ / ____________________</span><small>подпись / расшифровка</small></div><div class="stamp"><span>МЕСТО ДЛЯ ПЕЧАТИ</span></div></section>`;
};

export function renderPrintHtml(model: PrintDocumentModel): string {
  const meta =
    model.kind === "invoice"
      ? `от ${formatPrintDate(model.issuedOrPublishedAt)} · оплатить до ${formatPrintDate(model.dueOrExpiresAt)}`
      : `от ${formatPrintDate(model.issuedOrPublishedAt)} · действительно до ${formatPrintDate(model.dueOrExpiresAt)}`;
  const rawBarcode = renderCode128Svg(documentBarcodeValue(model), { includeText: false });
  const barcode = code128Background(rawBarcode);
  // Chromium only clones this fixed header on continuation pages when it has generated content.
  const styles = `@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#e8e8e4;color:#181a18;font:10px "IBM Plex Sans",Arial,sans-serif}.print-page{width:210mm;min-height:297mm;margin:8mm auto;background:#fff;padding:10mm 11mm 8mm;display:flex;flex-direction:column}.document-header{height:16mm;border-bottom:1px solid #c9cbc4;display:flex;justify-content:space-between;align-items:flex-start}.brand-logo--markiro{width:40mm;height:9mm;display:block}.document-id{text-align:right;display:flex;flex-direction:column;gap:1.5mm}.document-id strong,.section-label,.items-heading{font-size:8px;letter-spacing:1px;font-weight:600;color:#565b54}.document-id span,.mono{font-family:"IBM Plex Mono",monospace}main{flex:1;padding-top:7mm}h1{font-size:21px;line-height:1.1;margin:0 0 2mm;max-width:135mm;letter-spacing:-.35px}.meta{margin:0 0 4mm;color:#6a6f68}.bank{border:1px solid #bec1b8;background:#fafaf8;min-height:39mm;padding:2mm 2.5mm;display:grid;grid-template-columns:1.35fr 1fr 35mm;gap:4mm;align-items:center}.bank--compact{min-height:26mm;grid-template-columns:1.35fr 1fr}.bank-main,.bank-account{display:flex;flex-direction:column;justify-content:center;gap:1mm;min-width:0}.bank-main .section-label{margin-bottom:1.5mm}.bank-main strong{font-size:11px}.bank-account .account{font-size:13px;letter-spacing:.35px}.payment-qr{width:35mm;height:35mm;background:#fff;padding:2mm}.payment-qr svg{width:100%;height:100%;display:block}.muted{color:#747a72}.parties{display:grid;grid-template-columns:1fr 1fr;gap:7mm;margin:3.5mm 0}.party{min-height:19mm;border-top:1px solid #c9cbc4;padding-top:2mm}.party strong{display:block;font-size:10.5px;margin:1.2mm 0}.party-address{margin-top:1mm;color:#535750}.items-heading{display:flex;justify-content:space-between;align-items:center;margin:3mm 0 2mm}.items-table{border-collapse:collapse;width:100%;table-layout:fixed}.items-table th,.items-table td{border:1px solid #c1c4bc;padding:2mm 1.7mm;vertical-align:top;text-align:left}.items-table th{background:#f0f1ed;font-size:7px;letter-spacing:.55px;color:#585d56}.items-table th:nth-child(1),.items-table td:nth-child(1){width:7mm}.items-table th:nth-child(3),.items-table td:nth-child(3){width:17mm}.items-table th:nth-child(4),.items-table td:nth-child(4){width:15mm}.items-table th:nth-child(5),.items-table td:nth-child(5),.items-table th:nth-child(6),.items-table td:nth-child(6){width:25mm}.items-table td strong{display:block;font-size:9.2px}.items-table td small{display:block;color:#666;margin-top:1mm;font-size:7.5px;line-height:1.25;white-space:pre-line}.numeric{text-align:right}.total-block{width:79mm;margin:4mm 0 0 auto}.total-block>div{display:flex;justify-content:space-between;padding:1.3mm 0}.total-block .grand-total{border-top:1.5px solid #2f6d50;margin-top:1mm;padding-top:2mm;font-size:13px}.total-block .grand-total strong{color:#2f6d50}.total-block p{margin:1.5mm 0 0;color:#5e635c;font-size:8px}.terms,.purpose{margin-top:4mm;border-top:1px solid #c9cbc4;padding-top:2mm}.terms h1,.terms h2,.terms h3,.terms h4,.terms h5,.terms h6{margin:2.5mm 0 1mm;font-size:10px}.terms p,.purpose p{margin:1.5mm 0}.terms ul,.terms ol{margin:1.5mm 0;padding-left:5mm}.terms a{color:#2f6d50;text-decoration:underline}.terms table{border-collapse:collapse;width:100%;margin:2mm 0}.terms th,.terms td{border:1px solid #c1c4bc;padding:1.5mm;text-align:left;vertical-align:top}.terms th{background:#f0f1ed}.offer-notice{display:inline-block;margin:3mm 0 0;padding:1.5mm 2mm;background:#eef4eb;color:#2f6d50;font-weight:600}.signing{display:grid;grid-template-columns:1fr 31mm;gap:12mm;align-items:end;margin-top:5mm}.signature span{display:block;margin-top:8mm}.signature small{display:block;color:#777c75;margin-top:1mm}.stamp{width:31mm;height:31mm;border:1px dashed #a9ada5;background:#f2f3f0;display:flex;align-items:center;justify-content:center;text-align:center;color:#9a9e97;font-size:7px;letter-spacing:.6px}.document-footer{height:12mm;border-top:1px solid #c9cbc4;margin-top:4mm;padding-top:2mm;display:flex;align-items:flex-start;justify-content:space-between;color:#777c75;font-size:7px}.form-barcode-group{display:flex;flex-direction:column;gap:.6mm}.form-barcode{width:52mm;height:7mm;overflow:hidden}.form-barcode-caption{font:600 6px "IBM Plex Mono",monospace;letter-spacing:.35px;color:#565b54}.print-first{display:none}@media print{body{background:#fff}.print-page{width:210mm;min-height:297mm;margin:0;padding:28mm 11mm 18mm;display:block;box-decoration-break:clone;-webkit-box-decoration-break:clone}.document-header{position:fixed;top:8mm;left:11mm;right:11mm;height:16mm}.document-id span::after{content:""}main{padding-top:0}.document-footer{position:fixed;left:11mm;right:11mm;bottom:6mm;height:12mm;margin:0}.print-first{display:flex}.document-header.print-first{position:absolute}.document-footer.print-first{position:absolute;top:279mm;bottom:auto}.items-table thead{display:table-header-group}.items-table tr,.total-block,.signing{break-inside:avoid}}`;
  const firstPageChrome = `${documentHeader(model, true)}${documentFooter(model, barcode, true)}`;
  const body = `${firstPageChrome}<article class="print-page">${documentHeader(model)}<main><h1>${escape(documentSubject(model))}</h1><p class="meta">${meta}</p>${bankBlock(model)}<div class="parties">${profileBlock("ПОСТАВЩИК", model.seller)}${profileBlock("ПОКУПАТЕЛЬ", model.buyer)}</div><div class="items-heading"><span>СОСТАВ ${model.kind === "invoice" ? "СЧЁТА" : "ПРЕДЛОЖЕНИЯ"}</span><span class="mono muted">${model.lines.length} поз.</span></div>${itemsTable(model.lines)}${closing(model)}</main>${documentFooter(model, barcode)}</article>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ № ${escape(model.number)}</title><style>${styles}</style></head><body>${body}</body></html>`;
}
