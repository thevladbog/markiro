import { renderCode128Svg } from "@markiro/domain";

import { formatInventoryTaskBarcode } from "./station-inventory.dto";

export interface InventoryTaskFormData {
  inventoryId: string;
  inventoryNumber: string;
  status: "ready" | "running" | "closed" | "completed";
  organizationName: string;
  productName: string;
  gtin14: string;
  lineName: string;
  mode: "check" | "repack";
  productionDateFrom: string;
  productionDateTo: string;
  expectedCount: number;
  boxCapacity: number | null;
  generatedAt: Date;
}

const STATUS_LABEL: Record<InventoryTaskFormData["status"], string> = {
  ready: "К запуску",
  running: "В работе",
  closed: "Закрыта",
  completed: "Завершена",
};

const PRINT_TEXT_MAX_CODE_POINTS = 200;

function boundPrintText(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= PRINT_TEXT_MAX_CODE_POINTS) return value;
  return `${codePoints.slice(0, PRINT_TEXT_MAX_CODE_POINTS - 1).join("")}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCivilDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function formatGeneratedAt(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(value)
    .replace(",", "");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replaceAll("\u00a0", "&nbsp;");
}

function countNoun(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
  }
  return many;
}

function logo(): string {
  return `<svg class="brand-logo" data-brand-logo="markiro" viewBox="0 0 280 64" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Маркиро" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="56" height="56" fill="#17161A"/>
    <g fill="#FAFAF8">
      <rect x="14" y="14" width="8" height="8"/><rect x="14" y="26" width="8" height="8"/><rect x="14" y="38" width="8" height="8"/>
      <rect x="26" y="22" width="8" height="8"/><rect x="38" y="14" width="8" height="8"/><rect x="38" y="26" width="8" height="8"/>
      <rect x="38" y="38" width="8" height="8"/><rect x="26" y="42" width="8" height="8" fill="#3DDC7A"/>
    </g>
    <text x="76" y="45" font-family="Arial, sans-serif" font-weight="700" font-size="34" fill="#17161A">маркиро</text>
  </svg>`;
}

function parameter(label: string, value: string): string {
  return `<div class="parameter"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function step(number: number, text: string): string {
  return `<li><span class="step-number">${number}</span><span>${text}</span></li>`;
}

export function renderInventoryTaskFormHtml(data: InventoryTaskFormData): string {
  const number = escapeHtml(data.inventoryNumber);
  const organizationText = boundPrintText(data.organizationName);
  const productText = boundPrintText(data.productName);
  const lineText = boundPrintText(data.lineName);
  const organization = escapeHtml(organizationText);
  const product = escapeHtml(productText);
  const line = escapeHtml(lineText);
  const token = formatInventoryTaskBarcode(data.inventoryId);
  const barcode = renderCode128Svg(token, { includeText: false }).replace(
    "<svg ",
    '<svg preserveAspectRatio="none" ',
  );
  const isRepack = data.mode === "repack";
  const mode = isRepack ? "С переупаковкой" : "Без переупаковки";
  const capacity = data.boxCapacity;
  const compact =
    organizationText.length + productText.length + lineText.length > 240 ||
    [organizationText, productText, lineText].some((value) => value.length > 100);
  const finalStep = isRepack
    ? `Отсканируйте старый короб, затем все бутылки. Новый короб закроется и напечатается автоматически после ${capacity ?? "заданного"}-го кода.`
    : "Сканируйте коды единиц. Закрытую упаковку можно проверить одним сканированием кода упаковки.";
  const repackRule = isRepack
    ? "<li>При переупаковке содержимое старого короба всегда сканируется поштучно.</li>"
    : "<li>При простой проверке сканирование кода короба отмечает его известное содержимое.</li>";

  const parameters = [
    parameter("ПРОДУКТ", product),
    parameter("GTIN", data.gtin14),
    parameter("ЛИНИЯ", line),
    parameter("РЕЖИМ", mode),
    parameter(
      "ДАТА ПРОИЗВОДСТВА",
      `${formatCivilDate(data.productionDateFrom)} - ${formatCivilDate(data.productionDateTo)}`,
    ),
    parameter(
      "ОЖИДАЕТСЯ К ПРОВЕРКЕ",
      `${formatInteger(data.expectedCount)} ${countNoun(data.expectedCount, "код", "кода", "кодов")}`,
    ),
    ...(isRepack && capacity !== null
      ? [
          parameter(
            "ВМЕСТИМОСТЬ НОВОГО КОРОБА",
            `${capacity} ${countNoun(capacity, "бутылка", "бутылки", "бутылок")}`,
          ),
        ]
      : []),
  ].join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Форма-задание на инвентаризацию ${number}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #efefed; color: #17161a; font-family: Arial, "Helvetica Neue", sans-serif; }
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .page { width: 210mm; height: 297mm; margin: 0 auto; padding: 16mm; background: #fafaf8; display: flex; flex-direction: column; overflow: hidden; }
    .top { display: flex; justify-content: space-between; align-items: center; padding-bottom: 6mm; border-bottom: .25mm solid #cbc7bf; }
    .brand-logo { width: 34mm; height: 8mm; display: block; }
    .task-id { text-align: right; }
    .eyebrow { display: block; color: #706d67; font-size: 8pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .task-id strong { display: block; margin-top: 1.5mm; font: 700 14pt/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .hero { display: grid; grid-template-columns: 1fr auto; gap: 8mm; align-items: end; padding: 8mm 0 7mm; }
    h1 { margin: 0; font-size: 23pt; line-height: 1.08; letter-spacing: -.02em; }
    .subtitle { margin: 2.5mm 0 0; color: #4f4c47; font-size: 11pt; }
    .status { min-width: 36mm; padding: 4mm 5mm; border: .25mm solid #b7dfc8; border-radius: 3mm; background: #e7f6ed; color: #126b39; font-size: 9pt; font-weight: 800; text-align: center; text-transform: uppercase; }
    .scan-zone { height: 43mm; border: .35mm solid #cbc7bf; border-radius: 4mm; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #fff; }
    .barcode { width: 150mm; height: 17mm; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .barcode svg { display: block; max-width: 100%; width: 100%; height: 100%; }
    .barcode-caption { margin-top: 1mm; font: 700 12pt/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .scan-hint { margin-top: 1mm; color: #77736d; font-size: 8pt; }
    h2 { margin: 4.5mm 0 2mm; font-size: 12pt; line-height: 1.2; }
    dl { margin: 0; }
    .parameter { min-height: 8mm; display: grid; grid-template-columns: 1fr minmax(62mm, auto); align-items: center; gap: 6mm; border-bottom: .2mm solid #d8d5cf; }
    dt { color: #706d67; font-size: 8pt; }
    dd { margin: 0; max-width: 110mm; text-align: right; font-size: 10pt; font-weight: 700; overflow-wrap: anywhere; }
    .steps { margin-top: 4mm; padding-top: 1mm; border-top: .2mm solid #d8d5cf; }
    .steps ol { display: grid; gap: 2mm; margin: 0; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 7mm 1fr; gap: 3mm; align-items: start; color: #4f4c47; font-size: 8.5pt; line-height: 1.28; }
    .step-number { width: 6mm; height: 6mm; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: #17161a; color: #fff; font-size: 7pt; font-weight: 800; }
    .rules { margin-top: 5mm; padding: 4mm 5mm; border: .25mm solid #c6daf5; border-radius: 3.5mm; background: #e6f0fd; color: #1756a6; }
    .rules h2 { margin: 0 0 2mm; color: #1756a6; }
    .rules ul { margin: 0; padding-left: 5mm; display: grid; gap: 1.2mm; font-size: 8pt; line-height: 1.25; }
    .footer { margin-top: auto; padding-top: 3.5mm; border-top: .2mm solid #d8d5cf; display: flex; justify-content: space-between; color: #77736d; font-size: 7.5pt; }
    .compact { padding: 12mm 14mm; }
    .compact .top { padding-bottom: 4mm; }
    .compact .hero { padding: 4mm 0; }
    .compact h1 { font-size: 19pt; }
    .compact .subtitle { margin-top: 1mm; max-width: 126mm; font-size: 8.5pt; line-height: 1.15; overflow-wrap: anywhere; }
    .compact .status { padding: 3mm 4mm; }
    .compact .scan-zone { height: 38mm; }
    .compact .barcode { width: 150mm; height: 17mm; }
    .compact h2 { margin: 2.5mm 0 1.2mm; font-size: 10.5pt; }
    .compact .parameter { min-height: 6mm; padding: .5mm 0; }
    .compact dt { font-size: 7pt; }
    .compact dd { font-size: 8.5pt; line-height: 1.08; }
    .compact .steps { margin-top: 2mm; padding-top: 0; }
    .compact .steps ol { gap: 1mm; }
    .compact .steps li { font-size: 7.5pt; line-height: 1.2; }
    .compact .rules { margin-top: 3mm; padding: 3mm 4mm; }
    .compact .rules ul { gap: .7mm; font-size: 7pt; line-height: 1.18; }
    .compact .footer { padding-top: 2mm; font-size: 7pt; }
    @media screen { .page { box-shadow: 0 2mm 8mm rgba(23, 22, 26, .12); } }
    @media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main class="page${compact ? " compact" : ""}" data-layout="${compact ? "compact" : "standard"}">
    <header class="top">${logo()}<div class="task-id"><span class="eyebrow">Форма-задание</span><strong>${number}</strong></div></header>
    <section class="hero"><div><h1>Задание на инвентаризацию</h1><p class="subtitle">${mode} · ${organization}</p></div><div class="status">${STATUS_LABEL[data.status]}</div></section>
    <section class="scan-zone" aria-label="Штрихкод задания"><div class="barcode" data-task-token="${escapeHtml(token)}">${barcode}</div><div class="barcode-caption">${number}</div><div class="scan-hint">Отсканируйте на терминале, чтобы открыть задание</div></section>
    <section><h2>Параметры задания</h2><dl>${parameters}</dl></section>
    <section class="steps"><h2>Как начать работу</h2><ol>${step(1, "Откройте терминал на выбранной линии и войдите оператором.")}${step(2, "Отсканируйте штрихкод задания. На своей линии оно также будет видно в списке.")}${step(3, "Если терминал относится к другой линии, подтвердите предупреждение перед входом.")}${step(4, finalStep)}</ol></section>
    <aside class="rules"><h2>Важные правила</h2><ul><li><strong>MOVING_BY_UD:</strong> код в отгрузке. Его нельзя учитывать, списывать или включать в документы.</li>${repackRule}<li>Дата производства действует на терминале до следующего изменения; в одном новом коробе одна дата.</li><li>Чтобы поставить работу на паузу, выйдите из задания. Закрыть инвентаризацию можно только в админке.</li><li>На время инвентаризации движения продукции по складу остановлены.</li></ul></aside>
    <footer class="footer"><span>Сформировано: ${formatGeneratedAt(data.generatedAt)} · Маркиро</span><span>${number} · 1 / 1</span></footer>
  </main>
</body>
</html>`;
}
