import { renderLiteralDataMatrixSvg } from "@markiro/domain";

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

export function renderInventoryTaskFormHtml(data: InventoryTaskFormData): string {
  const number = escapeHtml(data.inventoryNumber);
  const organizationText = boundPrintText(data.organizationName);
  const productText = boundPrintText(data.productName);
  const lineText = boundPrintText(data.lineName);
  const organization = escapeHtml(organizationText);
  const product = escapeHtml(productText);
  const line = escapeHtml(lineText);
  const token = formatInventoryTaskBarcode(data.inventoryId);
  const barcode = renderLiteralDataMatrixSvg(token);
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
    taskFormParameter("ПРОДУКТ", product),
    taskFormParameter("GTIN", data.gtin14),
    taskFormParameter("ЛИНИЯ", line),
    taskFormParameter("РЕЖИМ", mode),
    taskFormParameter(
      "ДАТА ПРОИЗВОДСТВА",
      `${formatCivilDate(data.productionDateFrom)} - ${formatCivilDate(data.productionDateTo)}`,
    ),
    taskFormParameter(
      "ОЖИДАЕТСЯ К ПРОВЕРКЕ",
      `${formatInteger(data.expectedCount)} ${countNoun(data.expectedCount, "код", "кода", "кодов")}`,
    ),
    ...(isRepack && capacity !== null
      ? [
          taskFormParameter(
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
${TASK_FORM_BASE_CSS}
  </style>
</head>
<body>
  <main class="page${compact ? " compact" : ""}" data-layout="${compact ? "compact" : "standard"}">
    <header class="top">${taskFormLogoSvg()}<div class="task-id"><span class="eyebrow">Форма-задание</span><strong>${number}</strong></div></header>
    <section class="task-passport"><section class="hero"><div><h1>Задание на инвентаризацию</h1><p class="subtitle">${mode} · ${organization}</p></div><div class="status">${STATUS_LABEL[data.status]}</div></section><section class="scan-zone" aria-label="Штрихкод задания"><div class="barcode" data-barcode-symbology="datamatrix" data-task-token="${escapeHtml(token)}">${barcode}</div><div class="barcode-caption">${number}</div><div class="scan-hint">Отсканируйте на терминале, чтобы открыть задание</div></section></section>
    <section class="parameters"><h2>Параметры задания</h2><dl>${parameters}</dl></section>
    <section class="steps"><h2>Как начать работу</h2><ol>${taskFormStep(1, "Откройте терминал на выбранной линии и войдите оператором.")}${taskFormStep(2, "Отсканируйте штрихкод задания. На своей линии оно также будет видно в списке.")}${taskFormStep(3, "Если терминал относится к другой линии, подтвердите предупреждение перед входом.")}${taskFormStep(4, finalStep)}</ol></section>
    <aside class="rules"><h2>Важные правила</h2><ul><li><strong>MOVING_BY_UD:</strong> код в отгрузке. Его нельзя учитывать, списывать или включать в документы.</li>${repackRule}<li>Дата производства действует на терминале до следующего изменения; в одном новом коробе одна дата.</li><li>Чтобы поставить работу на паузу, выйдите из задания. Закрыть инвентаризацию можно только в админке.</li><li>На время инвентаризации движения продукции по складу остановлены.</li></ul></aside>
    <section class="comments" aria-label="Комментарии оператора"><div class="comments-header"><h2>Комментарии оператора</h2><span>Расхождения · номера коробов · замечания</span></div></section>
    <footer class="footer"><span>Сформировано: ${formatGeneratedAt(data.generatedAt)} · Маркиро</span><span>${number} · 1 / 1</span></footer>
  </main>
</body>
</html>`;
}
