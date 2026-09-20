import { formatShiftTaskBarcode, renderLiteralDataMatrixSvg } from "@markiro/domain";

import {
  boundPrintText,
  countNoun,
  escapeHtml,
  formatCivilDate,
  formatGeneratedAt,
  formatInteger,
  TASK_FORM_BASE_CSS,
  taskFormLogoSvg,
  taskFormParameter,
  taskFormStep,
} from "../print/task-form-chrome";

export interface ShiftTaskFormData {
  shiftId: string;
  shiftNumber: string;
  status: "planned" | "active";
  mode: "validation" | "aggregation";
  organizationName: string;
  productId: string;
  productName: string;
  productPrintName: string | null;
  gtin14: string;
  imageChecksum: string | null;
  lineName: string | null;
  plannedDate: string | null;
  productionDate: string | null;
  plannedQty: number | null;
  boxCapacity: number | null;
  palletsEnabled: boolean;
  palletBoxCapacity: number | null;
  counterpartyName: string | null;
  ssccIssuerName: string | null;
  validationPrintMode: "none" | "duplicate_dm";
  validationPrintVerification: "none" | "required";
  allowPreviouslyAcceptedCodes: boolean;
  generatedAt: Date;
}

const STATUS_LABEL: Record<ShiftTaskFormData["status"], string> = {
  planned: "К запуску",
  active: "В работе",
};

const SHIFT_FORM_CSS = `    .product { display: grid; grid-template-columns: 28mm minmax(0, 1fr); gap: 5mm; align-items: center; padding: 5mm 0 4mm; border-bottom: .2mm solid #d8d5cf; }
    .product--no-photo { grid-template-columns: minmax(0, 1fr); }
    .product-photo { width: 28mm; height: 28mm; border: .2mm solid #d8d5cf; background: #f1efe8; overflow: hidden; }
    .product-photo img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .product-eyebrow { color: #706d67; font-size: 8pt; letter-spacing: .03em; text-transform: uppercase; }
    .product-name { margin-top: 1mm; font-size: 12pt; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
    .product-meta { margin-top: 1mm; color: #4f4c47; font-size: 9pt; }
    .product-meta strong, .product-meta span { font-weight: 700; }
    .compact .product { grid-template-columns: 22mm minmax(0, 1fr); gap: 4mm; padding: 3mm 0; }
    .compact .product--no-photo { grid-template-columns: minmax(0, 1fr); }
    .compact .product-photo { width: 22mm; height: 22mm; }
    .compact .product-name { font-size: 10pt; }
    .compact .product-meta { font-size: 8pt; }`;

export function renderShiftTaskFormHtml(data: ShiftTaskFormData): string {
  const number = escapeHtml(data.shiftNumber);
  const token = formatShiftTaskBarcode(data.shiftId);
  const barcode = renderLiteralDataMatrixSvg(token);
  const organizationText = boundPrintText(data.organizationName);
  const productText = boundPrintText(data.productName);
  const lineText = data.lineName === null ? "" : boundPrintText(data.lineName);
  const counterpartyText =
    data.counterpartyName === null ? "" : boundPrintText(data.counterpartyName);
  const compact =
    organizationText.length + productText.length + lineText.length + counterpartyText.length >
      240 ||
    [organizationText, productText, lineText, counterpartyText].some((value) => value.length > 100);
  const aggregation = data.mode === "aggregation";
  const modeTitle = aggregation
    ? data.palletsEnabled
      ? "Агрегация с паллетами"
      : "Агрегация"
    : "Проверка";
  const organization = escapeHtml(organizationText);
  const product = escapeHtml(productText);

  const line = data.lineName === null ? "Не назначена" : escapeHtml(boundPrintText(data.lineName));
  const shiftDate = data.plannedDate === null ? "Не назначена" : formatCivilDate(data.plannedDate);
  const productionDate =
    data.productionDate === null ? "По дате смены" : formatCivilDate(data.productionDate);
  const plan =
    data.plannedQty === null
      ? "Без плана"
      : `${formatInteger(data.plannedQty)} ${countNoun(data.plannedQty, "единица", "единицы", "единиц")}`;
  const boxes =
    data.boxCapacity === null
      ? "Не задана"
      : `${formatInteger(data.boxCapacity)} ${countNoun(data.boxCapacity, "бутылка", "бутылки", "бутылок")}`;
  const pallets =
    !data.palletsEnabled || data.palletBoxCapacity === null
      ? "Не собираются"
      : `Собираются, ${formatInteger(data.palletBoxCapacity)} ${countNoun(data.palletBoxCapacity, "короб", "короба", "коробов")}`;
  const issuer =
    data.ssccIssuerName === null ? "Собственные" : escapeHtml(boundPrintText(data.ssccIssuerName));
  const printing =
    data.validationPrintMode === "none"
      ? "Без печати"
      : data.validationPrintVerification === "required"
        ? "Дубликат Data Matrix · обязательная проверка"
        : "Дубликат Data Matrix";

  const parameters = [
    taskFormParameter("ЛИНИЯ", line),
    taskFormParameter("ДАТА СМЕНЫ", shiftDate),
    taskFormParameter("ДАТА ПРОИЗВОДСТВА", productionDate),
    taskFormParameter("ПЛАН", plan),
    ...(aggregation
      ? [
          taskFormParameter("ВМЕСТИМОСТЬ КОРОБА", boxes),
          taskFormParameter("ПАЛЛЕТЫ", pallets),
          taskFormParameter("НОМЕРА SSCC", issuer),
        ]
      : [
          taskFormParameter("ПЕЧАТЬ ЭТИКЕТКИ", printing),
          ...(data.allowPreviouslyAcceptedCodes
            ? [taskFormParameter("ПОВТОРНАЯ ОБРАБОТКА", "Коды прошлых смен разрешены")]
            : []),
        ]),
    ...(data.counterpartyName === null
      ? []
      : [taskFormParameter("ДЛЯ КОНТРАГЕНТА", escapeHtml(counterpartyText))]),
  ].join("");

  const photo =
    data.imageChecksum === null
      ? ""
      : `<div class="product-photo"><img src="../../products/${escapeHtml(data.productId)}/image/${escapeHtml(data.imageChecksum)}" alt=""></div>`;

  const printNameSegment =
    data.productPrintName === null
      ? ""
      : `На терминале: <strong>${escapeHtml(boundPrintText(data.productPrintName))}</strong> · `;

  const step1 =
    data.lineName === null
      ? "Откройте терминал и войдите оператором."
      : `Откройте терминал на линии «${line}» и войдите оператором.`;
  const step4 = aggregation
    ? data.boxCapacity === null
      ? "Сканируйте коды единиц. Короб закроется по заданной вместимости."
      : `Сканируйте коды единиц. Короб закроется и напечатается после ${formatInteger(data.boxCapacity)}-го кода.`
    : "Сканируйте коды единиц. Смена принимает каждый код один раз.";

  const rules = [
    "<li><strong>Бланк отражает параметры на момент печати.</strong> Если мастер изменил смену, терминал покажет актуальные значения — верьте экрану.</li>",
    ...(aggregation && data.palletsEnabled && data.palletBoxCapacity !== null
      ? [
          "<li>Паллета закрывается автоматически по достижении вместимости; закрыть её раньше можно на терминале вручную.</li>",
        ]
      : []),
    ...(!aggregation && data.validationPrintMode === "duplicate_dm"
      ? [
          "<li>На внешнюю упаковку переносится полный код с продукции; количество продукции при этом не меняется.</li>",
        ]
      : []),
    "<li>Дата производства держится до следующего изменения; в одном коробе одна дата.</li>",
    "<li>Смену закрывает станция, которая её открыла. Вторая станция — только через админку.</li>",
    "<li>Чтобы поставить работу на паузу, выйдите из смены: она останется активной.</li>",
  ].join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Бланк смены ${number}</title>
  <style>
${TASK_FORM_BASE_CSS}
${SHIFT_FORM_CSS}
  </style>
</head>
<body>
  <main class="page${compact ? " compact" : ""}" data-layout="${compact ? "compact" : "standard"}">
    <header class="top">${taskFormLogoSvg()}<div class="task-id"><span class="eyebrow">Бланк смены</span><strong>${number}</strong></div></header>
    <section class="task-passport"><section class="hero"><div><h1>Сменное задание</h1><p class="subtitle">${modeTitle} · ${organization}</p></div><div class="status">${STATUS_LABEL[data.status]}</div></section><section class="scan-zone" aria-label="Штрихкод смены"><div class="barcode" data-barcode-symbology="datamatrix" data-task-token="${escapeHtml(token)}">${barcode}</div><div class="barcode-caption">${number}</div><div class="scan-hint">Отсканируйте на терминале, чтобы открыть смену</div></section></section>
    <section class="product${data.imageChecksum === null ? " product--no-photo" : ""}">${photo}<div><div class="product-eyebrow">Продукция</div><div class="product-name">${product}</div><div class="product-meta">${printNameSegment}GTIN <span>${data.gtin14}</span></div></div></section>
    <section class="parameters"><h2>Параметры смены</h2><dl>${parameters}</dl></section>
    <section class="steps"><h2>Как начать работу</h2><ol>${taskFormStep(1, step1)}${taskFormStep(2, "Отсканируйте штрихкод бланка. На своей линии смена также видна в списке.")}${taskFormStep(3, "Сверьте продукцию и дату производства на экране перед первым сканированием.")}${taskFormStep(4, step4)}</ol></section>
    <aside class="rules"><h2>Важные правила</h2><ul>${rules}</ul></aside>
    <section class="comments" aria-label="Комментарии оператора"><div class="comments-header"><h2>Комментарии оператора</h2><span>Простои · номера коробов · замечания</span></div></section>
    <footer class="footer"><span>Сформировано: ${formatGeneratedAt(data.generatedAt)} · Маркиро</span><span>${number} · 1 / 1</span></footer>
  </main>
</body>
</html>`;
}
