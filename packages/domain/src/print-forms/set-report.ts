import { renderCode128Svg } from "../barcodes/svg.js";
import {
  CHILD_ROW_MM,
  dataMatrix,
  escapeHtml,
  formatDateTime,
  parentRowHeightMm,
  renderContentsReportHtml,
  type ReportOrg,
  type ReportUnit,
} from "./contents-report.js";

export interface SetReportCode {
  identification: string;
  rawKm: string;
}

export interface SetReportItemGroup {
  productName: string | null;
  gtin14: string;
  codes: readonly SetReportCode[];
}

export interface SetReportData {
  shiftNumber: string;
  productName: string;
  closedAt: Date | null;
  org: ReportOrg | null;
  sets: readonly { code: SetReportCode; groups: readonly SetReportItemGroup[] }[];
}

function codeRow(code: SetReportCode, last: boolean): string {
  return `<tr class="rep-code-row">
    <td></td>
    <td class="mono rep-km-label" colspan="2"><span class="rep-tree">${last ? "└" : "├"}</span>${escapeHtml(code.identification)}</td>
    <td></td>
    <td><span class="dm-box">${dataMatrix(code.rawKm)}</span></td>
  </tr>`;
}

function setUnits(data: SetReportData): ReportUnit[] {
  return data.sets.flatMap(({ code, groups }, setIndex) => {
    const units: ReportUnit[] = [];
    const setBand = `<tr class="rep-box-row">
      <td class="mono rep-item-number">${setIndex + 1}</td>
      <td class="mono rep-sscc-label" colspan="2">КИ набора ${escapeHtml(code.identification)}</td>
      <td class="mono rep-count">${groups.reduce((sum, group) => sum + group.codes.length, 0)}</td>
      <td><span class="dm-box">${dataMatrix(code.rawKm)}</span></td>
    </tr>`;
    groups.forEach(({ productName, gtin14, codes }, groupIndex) => {
      const title = productName ?? "Товар без сохранённого названия";
      const groupBand = `<tr class="rep-box-row">
        <td></td>
        <td colspan="2">
          <strong class="rep-product-name">${escapeHtml(title)}</strong>
          <span class="mono rep-row-note">GTIN ${escapeHtml(gtin14)}</span>
        </td>
        <td class="mono rep-count">${codes.length}</td>
        <td></td>
      </tr>`;
      const [first, ...rest] = codes;
      if (first === undefined) return;
      // Keep the first item with its product and the first product with its set.
      const firstGroup = groupIndex === 0;
      units.push({
        kind: "row",
        heightMm: (firstGroup ? 13 : 0) + parentRowHeightMm(title) + 4 + CHILD_ROW_MM,
        html: (firstGroup ? setBand : "") + groupBand + codeRow(first, rest.length === 0),
      });
      rest.forEach((item, index) =>
        units.push({
          kind: "row",
          heightMm: CHILD_ROW_MM,
          html: codeRow(item, index === rest.length - 1),
        }),
      );
    });
    return units;
  });
}

export function renderSetReportHtml(data: SetReportData, timeZone: string): string {
  const total = data.sets.reduce(
    (sum, set) => sum + set.groups.reduce((items, group) => items + group.codes.length, 0),
    0,
  );
  return renderContentsReportHtml({
    titleLabel: "Состав наборов",
    titleDoc: data.shiftNumber,
    titleDetailHtml:
      data.closedAt === null ? "" : `Смена закрыта ${formatDateTime(data.closedAt, timeZone)}`,
    org: data.org,
    metadataHtml: `<div class="rep-meta">
      <div class="rep-meta-cell">
        <span class="rep-meta-label">Организация</span>
        <strong>${escapeHtml(data.org?.name ?? "—")}</strong>
        ${data.org?.inn ? `<span class="rep-meta-detail">ИНН ${escapeHtml(data.org.inn)}</span>` : ""}
      </div>
      <div class="rep-meta-cell">
        <span class="rep-meta-label">Набор</span>
        <strong>${escapeHtml(data.productName)}</strong>
      </div>
    </div>`,
    tableHeadHtml: `<thead class="rep-table-head"><tr>
      <th>№</th><th colspan="2">Код идентификации / товар</th>
      <th class="rep-count">Кодов</th><th class="rep-barcode-heading">Data Matrix</th>
    </tr></thead>`,
    units: setUnits(data),
    finalBlocksHtml: `<div class="rep-total">Наборов: ${data.sets.length} · вложений: ${total}</div>`,
    footerBarcodeSvg: renderCode128Svg(data.shiftNumber, { includeText: false }),
    footerSubject: "Смена",
  });
}
