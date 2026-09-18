import {
  CHILD_ROW_MM,
  parentRowHeightMm,
  dataMatrix,
  emptyNoteUnit,
  escapeHtml,
  formatDateTime,
  kmLabel,
  renderContentsReportHtml,
  ssccBarcode,
  ssccHri,
  type ReportCode,
  type ReportOrg,
  type ReportUnit,
} from "./contents-report";

/** One unit code inside the box — feeds `renderDataMatrixSvg` as-is. */
export type BoxReportCode = ReportCode;

/**
 * Everything `renderBoxReportHtml` needs to build the printed A4 "Состав
 * короба" form for one box. Gathered by `CodeSearchService.boxReportData`.
 * The page shell, CSS and pagination live in `contents-report.ts`, shared
 * with the pallet form; this file is only what makes the document a BOX
 * report: one tree table with the box row (SSCC + Code128) and its unit
 * codes (DataMatrix) indented underneath. Deliberately price-free, like the
 * disaggregation act.
 */
export interface BoxReportData {
  /** 20-character machine form `00…`, or null for a box without an SSCC. */
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  productName: string | null;
  org: ReportOrg | null;
  openedAt: Date;
  closedAt: Date | null;
  disassembledAt: Date | null;
  codes: BoxReportCode[];
}

const STATUS_LABEL: Record<BoxReportData["status"], string> = {
  open: "Открыт",
  closed: "Закрыт",
  disassembled: "Расформирован",
};

function metadataBlock(data: BoxReportData, timeZone: string): string {
  const orgBlock = data.org
    ? `<span class="rep-meta-value">${escapeHtml(data.org.name)}</span>
      <span class="rep-meta-detail">${data.org.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "ИНН не указан"}</span>`
    : `<span class="rep-meta-value">—</span>
      <span class="rep-meta-detail">Профиль организации не заполнен</span>`;

  const lifecycle = [
    `открыт ${formatDateTime(data.openedAt, timeZone)}`,
    ...(data.closedAt ? [`закрыт ${formatDateTime(data.closedAt, timeZone)}`] : []),
    ...(data.disassembledAt
      ? [`расформирован ${formatDateTime(data.disassembledAt, timeZone)}`]
      : []),
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
  const units: ReportUnit[] = [
    { kind: "band", heightMm: parentRowHeightMm(data.productName), html: boxRow(data) },
  ];
  if (data.codes.length === 0) {
    units.push(emptyNoteUnit("Короб пуст"));
    return units;
  }
  data.codes.forEach((code, index) => {
    units.push({
      kind: "row",
      heightMm: CHILD_ROW_MM,
      html: codeRow(code, index === data.codes.length - 1),
    });
  });
  return units;
}

/** Pure: builds the print-ready A4 "Состав короба" document. No I/O, no `Date.now()`. */
export function renderBoxReportHtml(data: BoxReportData, timeZone = "UTC"): string {
  const titleDoc = data.sscc ? ssccHri(data.sscc) : "Без SSCC";
  return renderContentsReportHtml({
    titleLabel: "Состав короба",
    titleDoc,
    titleDetailHtml: `открыт ${formatDateTime(data.openedAt, timeZone)} · статус: <strong>${STATUS_LABEL[data.status]}</strong>`,
    org: data.org,
    metadataHtml: metadataBlock(data, timeZone),
    tableHeadHtml: tableHead(),
    units: contentsUnits(data),
    finalBlocksHtml: finalBlocks(data),
    footerSscc: data.sscc,
    footerSubject: "Короб",
  });
}
