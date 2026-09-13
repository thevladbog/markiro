import {
  CHILD_ROW_MM,
  PARENT_ROW_MM,
  emptyNoteUnit,
  escapeHtml,
  formatDateTime,
  renderContentsReportHtml,
  ssccBarcode,
  ssccHri,
  type ReportOrg,
  type ReportUnit,
} from "./contents-report";

/** One box standing on the pallet. */
export interface PalletReportBox {
  /** 20-character machine form `00…`, or null for a box closed without one. */
  sscc: string | null;
  /** Live unit codes inside that box. */
  codeCount: number;
  /** Set once the box was taken apart; it keeps its `pallet_id` either way. */
  disassembledAt: Date | null;
}

/**
 * Everything `renderPalletReportHtml` needs for the printed A4 "Состав
 * паллеты" form.
 *
 * A pallet holds BOXES, not unit codes, so the tree is one level shallower
 * than the box form's: the pallet row, then each member box with its own
 * SSCC and its own code count. Going a third level deep and printing every
 * unit would put hundreds of DataMatrix symbols on the page; a clerk who
 * needs that opens the box's own "Состав короба".
 */
export interface PalletReportData {
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  productName: string | null;
  org: ReportOrg | null;
  openedAt: Date;
  closedAt: Date | null;
  disassembledAt: Date | null;
  /** Every box that ever joined, disassembled ones included — see `liveBoxes`. */
  boxes: PalletReportBox[];
}

const STATUS_LABEL: Record<PalletReportData["status"], string> = {
  open: "Открыта",
  closed: "Закрыта",
  disassembled: "Расформирована",
};

/**
 * What is physically on the stack right now.
 *
 * Membership is never cleared when a box is taken off — the 06d spec keeps it
 * as the record that the box stood there — so a disassembled box still
 * arrives in `boxes`. It is listed, because dropping it from a printed form
 * would hide a real event, but it does NOT count: the totals are what a
 * goods-in clerk counts off the stack, and `PalletDao.boxCount` and
 * `apps/station/src/lib/pallets.ts` already answer this question the same way.
 */
function liveBoxes(data: PalletReportData): PalletReportBox[] {
  return data.boxes.filter((box) => box.disassembledAt === null);
}

function totalCodes(boxes: PalletReportBox[]): number {
  return boxes.reduce((sum, box) => sum + box.codeCount, 0);
}

function metadataBlock(data: PalletReportData, timeZone: string): string {
  const live = liveBoxes(data);
  const orgBlock = data.org
    ? `<span class="rep-meta-value">${escapeHtml(data.org.name)}</span>
      <span class="rep-meta-detail">${data.org.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "ИНН не указан"}</span>`
    : `<span class="rep-meta-value">—</span>
      <span class="rep-meta-detail">Профиль организации не заполнен</span>`;

  const lifecycle = [
    `сформирована ${formatDateTime(data.openedAt, timeZone)}`,
    ...(data.closedAt ? [`закрыта ${formatDateTime(data.closedAt, timeZone)}`] : []),
    ...(data.disassembledAt
      ? [`расформирована ${formatDateTime(data.disassembledAt, timeZone)}`]
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
      <span class="rep-meta-detail">Коробов на паллете: ${live.length} · единиц: ${totalCodes(live)}</span>
    </div>
    <div class="rep-meta-cell">
      <span class="rep-meta-label">Паллета</span>
      <span class="rep-meta-value">${STATUS_LABEL[data.status]}</span>
      <span class="rep-meta-detail">${lifecycle}</span>
    </div>
  </div>`;
}

function finalBlocks(data: PalletReportData): string {
  const live = liveBoxes(data);
  return `<div class="rep-final-blocks">
    <div class="rep-total">
      <span>Итого по паллете:</span>
      <span class="mono">коробов — ${live.length} · единиц — ${totalCodes(live)}</span>
    </div>
  </div>`;
}

function tableHead(): string {
  return `<thead class="rep-table-head">
    <tr>
      <th>№</th>
      <th>Код упаковки (SSCC) паллеты и коробов</th>
      <th>Продукт</th>
      <th class="rep-count">Единиц, шт.</th>
      <th class="rep-barcode-heading">Штрихкод</th>
    </tr>
  </thead>`;
}

function palletRow(data: PalletReportData): string {
  const live = liveBoxes(data);
  return `
      <tr class="rep-box-row">
        <td class="mono rep-item-number">1</td>
        <td class="mono rep-sscc-label">${data.sscc ? escapeHtml(ssccHri(data.sscc)) : "Без SSCC"}</td>
        <td><span class="rep-product-name">${data.productName ? escapeHtml(data.productName) : "—"}</span></td>
        <td class="mono rep-count">${totalCodes(live)}</td>
        <td>${data.sscc ? `<span class="sscc-box">${ssccBarcode(data.sscc)}</span>` : ""}</td>
      </tr>`;
}

function boxRow(box: PalletReportBox, index: number, isLast: boolean, timeZone: string): string {
  const label = box.sscc ? ssccHri(box.sscc) : "Без SSCC";
  // A retired box keeps its place in the list and loses its count, so the
  // column never adds up to something the stack does not hold.
  const retired = box.disassembledAt
    ? ` <span class="rep-row-note">снят ${formatDateTime(box.disassembledAt, timeZone)}</span>`
    : "";
  return `
      <tr class="rep-code-row">
        <td class="mono rep-item-number">1.${index + 1}</td>
        <td class="mono rep-km-label"><span class="rep-tree">${isLast ? "└" : "├"}</span>${escapeHtml(label)}${retired}</td>
        <td></td>
        <td class="mono rep-count">${box.disassembledAt ? "—" : box.codeCount}</td>
        <td>${box.sscc ? `<span class="sscc-box">${ssccBarcode(box.sscc)}</span>` : ""}</td>
      </tr>`;
}

function contentsUnits(data: PalletReportData, timeZone: string): ReportUnit[] {
  const units: ReportUnit[] = [{ kind: "band", heightMm: PARENT_ROW_MM, html: palletRow(data) }];
  if (data.boxes.length === 0) {
    units.push(emptyNoteUnit("На паллете нет коробов"));
    return units;
  }
  data.boxes.forEach((box, index) => {
    units.push({
      kind: "row",
      heightMm: CHILD_ROW_MM,
      html: boxRow(box, index, index === data.boxes.length - 1, timeZone),
    });
  });
  return units;
}

/** Pure: builds the print-ready A4 "Состав паллеты" document. No I/O, no `Date.now()`. */
export function renderPalletReportHtml(data: PalletReportData, timeZone = "UTC"): string {
  const titleDoc = data.sscc ? ssccHri(data.sscc) : "Без SSCC";
  return renderContentsReportHtml({
    titleLabel: "Состав паллеты",
    titleDoc,
    titleDetailHtml: `сформирована ${formatDateTime(data.openedAt, timeZone)} · статус: <strong>${STATUS_LABEL[data.status]}</strong>`,
    org: data.org,
    metadataHtml: metadataBlock(data, timeZone),
    tableHeadHtml: tableHead(),
    units: contentsUnits(data, timeZone),
    finalBlocksHtml: finalBlocks(data),
    footerSscc: data.sscc,
    footerSubject: "Паллета",
  });
}
