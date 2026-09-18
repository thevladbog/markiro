import { shelfLifeExpiryDate } from "@markiro/domain";
import { brandLogo, escapeHtml, ssccBarcode, ssccHri, type ReportOrg } from "./contents-report";

/**
 * The printed pallet PLACARD (spec 2026-09-18): one page, A4 or A5, meant to
 * be taped to the stack — not the "Состав паллеты" contents list next door.
 * Large GS1-128 SSCC at the bottom, the pallet's identity above it, and a
 * per-production-date summary, because a warehouse pallet carries boxes from
 * several shifts and «дата — количество» is how the stock is counted.
 *
 * Pure: no I/O, no `Date.now()`, no timezone (only civil dates are printed).
 */

export type PlacardFormat = "a4" | "a5";

export interface PalletPlacardBox {
  /** The box's shift's DECLARED production day (`YYYY-MM-DD`); null prints «См. на продукции». */
  productionDate: string | null;
  /** Live unit codes inside the box. */
  codeCount: number;
  /** Set once the box was taken off; it keeps its `pallet_id` either way. */
  disassembledAt: Date | null;
}

export interface PalletPlacardData {
  /** 20-character machine form `00…`, or null for a pallet closed without one. */
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  productName: string | null;
  gtin14: string | null;
  shelfLifeDays: number | null;
  org: ReportOrg | null;
  /** Every box that ever joined, disassembled ones included. */
  boxes: PalletPlacardBox[];
}

export interface PlacardDateRow {
  /** Null for the undated group and for the folded tail row. */
  productionDate: string | null;
  /** `YYYY-MM-DD` or null when there is no shelf life or no date. */
  expiryDate: string | null;
  boxCount: number;
  unitCount: number;
  /** Set only on the folded tail row: how many distinct dates it stands for. */
  foldedDates?: number;
}

/**
 * What a box with no DECLARED production date prints in the date and expiry
 * cells (owner decision 2026-09-18): the reader checks the boxes' own labels
 * instead of trusting a planned or guessed date on the placard.
 */
export const SEE_ON_PRODUCT = "См. на продукции";

/** Date rows a page can hold before the tail is folded (spec §2.1). */
export const PLACARD_ROW_CAP: Record<PlacardFormat, number> = { a4: 12, a5: 6 };

/**
 * Live boxes grouped by production date, ascending, undated last; the tail
 * past `maxRows` collapses into one row so `Итого` stays the sum of what is
 * printed. Exported for tests.
 */
export function summarizeByProductionDate(
  boxes: PalletPlacardBox[],
  shelfLifeDays: number | null,
  maxRows: number,
): PlacardDateRow[] {
  const groups = new Map<string | null, { boxCount: number; unitCount: number }>();
  for (const box of boxes) {
    if (box.disassembledAt !== null) continue;
    const group = groups.get(box.productionDate) ?? { boxCount: 0, unitCount: 0 };
    group.boxCount += 1;
    group.unitCount += box.codeCount;
    groups.set(box.productionDate, group);
  }
  const dated = [...groups.entries()]
    .filter(
      (entry): entry is [string, { boxCount: number; unitCount: number }] => entry[0] !== null,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productionDate, counts]) => {
      const expiry = shelfLifeExpiryDate(productionDate, shelfLifeDays);
      return { productionDate, expiryDate: expiry === "" ? null : expiry, ...counts };
    });
  const undated = groups.get(null);
  const rows: PlacardDateRow[] = undated
    ? [...dated, { productionDate: null, expiryDate: null, ...undated }]
    : dated;

  if (rows.length <= maxRows || maxRows < 2) return rows;
  const kept = rows.slice(0, maxRows - 1);
  const folded = rows.slice(maxRows - 1);
  return [
    ...kept,
    {
      productionDate: null,
      expiryDate: null,
      boxCount: folded.reduce((n, r) => n + r.boxCount, 0),
      unitCount: folded.reduce((n, r) => n + r.unitCount, 0),
      foldedDates: folded.length,
    },
  ];
}

/**
 * Stretches the SSCC symbol to the full content width (spec: "GS1-128 SSCC
 * full content width") by forcing `preserveAspectRatio="none"` onto the
 * `<svg>` markup from `ssccBarcode`. Uniform horizontal stretch keeps Code 128
 * module ratios. Leaves the «Код не отображается» fallback span untouched.
 */
function stretchBarcodeSvg(markup: string): string {
  if (!markup.startsWith("<svg")) return markup;
  if (markup.includes("preserveAspectRatio=")) return markup;
  return markup.replace("<svg ", '<svg preserveAspectRatio="none" ');
}

/**
 * The product name is the largest text on the page, but a long SKU name must
 * still FIT: the size steps down with length so up to `NAME_LINES` lines hold
 * it instead of the clamp cutting it off. Thresholds are character counts —
 * the same estimate the label wrap uses — not measured glyphs, so a name
 * near a threshold may end a line early rather than overflow; that is the
 * safe side. Exported for tests.
 */
export function namePtFor(name: string | null, size: PageSize): number {
  const length = name?.length ?? 0;
  if (length <= 40) return size.namePt;
  if (length <= 80) return size.nameMediumPt;
  return size.nameLongPt;
}

/** `2026-09-10` → `10.09.2026`; anything else is printed as given. */
function civilDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function dash(value: string | null): string {
  return value === null || value === "" ? "—" : escapeHtml(value);
}

/**
 * Russian plural of «дата» for the folded row: 1 дата, 2–4 даты, 5+ дат.
 * Exported for tests.
 */
export function datesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "дата";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "даты";
  return "дат";
}

export interface PageSize {
  page: "A4" | "A5";
  widthMm: number;
  heightMm: number;
  marginMm: number;
  /** Product name up to 40 characters. */
  namePt: number;
  /** Product name of 41–80 characters. */
  nameMediumPt: number;
  /** Product name past 80 characters. */
  nameLongPt: number;
  figurePt: number;
  tablePt: number;
  barsMm: number;
  hriPt: number;
}

/** Lines the product name may take before the clamp cuts it. */
const NAME_LINES = 4;

export const SIZES: Record<PlacardFormat, PageSize> = {
  a4: {
    page: "A4",
    widthMm: 210,
    heightMm: 297,
    marginMm: 14,
    // Read from a forklift, not a desk: the product name is the largest
    // text on the page (owner review 2026-09-18: «продукцию на А4 крупнее»).
    namePt: 30,
    nameMediumPt: 24,
    nameLongPt: 20,
    figurePt: 22,
    tablePt: 13,
    barsMm: 30,
    hriPt: 18,
  },
  a5: {
    page: "A5",
    widthMm: 148,
    heightMm: 210,
    marginMm: 10,
    namePt: 20,
    nameMediumPt: 16,
    nameLongPt: 14,
    figurePt: 16,
    tablePt: 11,
    barsMm: 22,
    hriPt: 13,
  },
};

function dateTable(rows: PlacardDateRow[], format: PlacardFormat): string {
  const compact = format === "a5";
  const head = compact
    ? '<tr><th>Произв.</th><th>Годен до</th><th class="n">Кор.</th></tr>'
    : '<tr><th>Дата производства</th><th>Годен до</th><th class="n">Коробов</th><th class="n">Единиц</th></tr>';
  const body = rows
    .map((row) => {
      const label =
        row.foldedDates !== undefined
          ? `и ещё ${row.foldedDates} ${datesWord(row.foldedDates)}`
          : row.productionDate === null
            ? SEE_ON_PRODUCT
            : civilDate(row.productionDate);
      // No declared date means no computable expiry either: both cells send
      // the reader to the boxes' own labels rather than printing a dash that
      // reads as «no shelf life».
      const expiry =
        row.expiryDate !== null
          ? civilDate(row.expiryDate)
          : row.productionDate === null && row.foldedDates === undefined
            ? SEE_ON_PRODUCT
            : "—";
      const units = compact ? "" : `<td class="n">${row.unitCount}</td>`;
      return `<tr><td>${escapeHtml(label)}</td><td>${expiry}</td><td class="n">${row.boxCount}</td>${units}</tr>`;
    })
    .join("");
  const boxes = rows.reduce((n, r) => n + r.boxCount, 0);
  const units = rows.reduce((n, r) => n + r.unitCount, 0);
  const total = compact
    ? `<tr class="total"><td colspan="2">Итого</td><td class="n">${boxes}</td></tr>`
    : `<tr class="total"><td colspan="2">Итого</td><td class="n">${boxes}</td><td class="n">${units}</td></tr>`;
  return `<table class="pl-dates">${head}${body}${total}</table>`;
}

/** Pure: builds the print-ready placard document. */
export function renderPalletPlacardHtml(data: PalletPlacardData, format: PlacardFormat): string {
  const size = SIZES[format];
  const live = data.boxes.filter((box) => box.disassembledAt === null);
  const boxCount = live.length;
  const unitCount = live.reduce((n, box) => n + box.codeCount, 0);
  const rows = summarizeByProductionDate(data.boxes, data.shelfLifeDays, PLACARD_ROW_CAP[format]);
  const hri = data.sscc ? ssccHri(data.sscc) : null;
  const title = data.sscc ?? "без SSCC";
  const orgName = dash(data.org?.name ?? null);
  const namePt = namePtFor(data.productName, size);
  const inn = data.org?.inn ? `ИНН ${escapeHtml(data.org.inn)}` : "";
  const footer =
    format === "a4"
      ? `<span>${inn}</span><span>Сформировано в Маркиро</span>`
      : `<span></span><span>Маркиро</span>`;
  const barcode = data.sscc
    ? `<div class="pl-bars">${stretchBarcodeSvg(ssccBarcode(data.sscc))}</div><div class="pl-hri mono">${escapeHtml(hri ?? "")}</div>`
    : `<div class="pl-hri">Без SSCC</div>`;
  const watermark =
    data.status === "disassembled"
      ? `<div class="pl-watermark" aria-hidden="true">РАСФОРМИРОВАНА</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Ярлык паллеты ${escapeHtml(title)}</title>
<style>
@page { size: ${size.page}; margin: 0 }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: #E9E7E1; font-family: Arial, sans-serif; color: #17161A; }
.mono { font-family: monospace; font-variant-numeric: tabular-nums; }
.pl-page { position: relative; width: ${size.widthMm}mm; height: ${size.heightMm}mm; margin: 8mm auto; padding: ${size.marginMm}mm; background: #fff; display: flex; flex-direction: column; gap: 4mm; overflow: hidden; font-size: ${size.tablePt}pt; line-height: 1.3; }
.pl-header { display: flex; justify-content: space-between; align-items: center; gap: 6mm; padding-bottom: 3mm; border-bottom: .4mm solid #17161A; }
.pl-brand { display: flex; align-items: center; gap: 3mm; min-width: 0; }
.brand-logo { display: block; max-width: 40mm; max-height: 12mm; width: auto; height: auto; object-fit: contain; }
.brand-logo--markiro { width: 36mm; height: 8mm; }
.pl-org { font-weight: 700; }
.pl-title { font-size: ${size.figurePt}pt; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
.pl-name { font-size: ${namePt}pt; font-weight: 700; line-height: 1.2; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${NAME_LINES}; line-clamp: ${NAME_LINES}; overflow: hidden; }
.pl-figures { display: flex; border-top: .3mm solid #C9C6BD; border-bottom: .3mm solid #C9C6BD; }
.pl-figure { flex: 1; padding: 2mm 3mm; border-left: .3mm solid #C9C6BD; min-width: 0; }
.pl-figure:first-child { border-left: 0; padding-left: 0; }
.pl-figure--gtin { flex: 1.7; }
.pl-figure-label { display: block; color: #6B6862; font-size: ${size.tablePt - 2}pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.pl-figure-value { display: block; font-size: ${size.figurePt}pt; font-weight: 700; overflow-wrap: anywhere; }
.pl-figure-value--gtin { font-size: ${Math.round(size.figurePt * 0.72)}pt; white-space: nowrap; }
.pl-dates { width: 100%; border-collapse: collapse; }
.pl-dates th { text-align: left; font-weight: 700; color: #6B6862; padding: 1mm 2mm; border-bottom: .3mm solid #C9C6BD; border-left: .25mm solid #EDEBE5; }
.pl-dates td { padding: 1mm 2mm; border-bottom: .25mm solid #EDEBE5; border-left: .25mm solid #EDEBE5; }
.pl-dates th:first-child, .pl-dates td:first-child { border-left: 0; padding-left: 0; }
.pl-dates .n { text-align: right; }
.pl-dates .total td { font-weight: 700; border-bottom: 0; }
.pl-code { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 2mm; }
.pl-bars { height: ${size.barsMm}mm; width: 100%; display: flex; justify-content: center; }
.pl-bars svg { display: block; width: 100%; height: ${size.barsMm}mm; }
.pl-hri { font-size: ${size.hriPt}pt; font-weight: 700; white-space: nowrap; letter-spacing: .04em; }
.pl-footer { display: flex; justify-content: space-between; padding-top: 2mm; border-top: .25mm solid #E0DED7; color: #6B6862; font: ${size.tablePt - 2}pt/1.3 monospace; }
.pl-watermark { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: ${size.figurePt * 2.5}pt; font-weight: 700; letter-spacing: .1em; color: rgba(23, 22, 26, .16); white-space: nowrap; pointer-events: none; }
.rep-code-missing { font-size: 9pt; color: #6B6862; }
@media print { body { background: #fff; } .pl-page { margin: 0; } }
</style>
</head>
<body>
<section class="pl-page">
  ${watermark}
  <header class="pl-header">
    <div class="pl-brand">${brandLogo(data.org)}<span class="pl-org">${orgName}</span></div>
    <span class="pl-title">ПАЛЛЕТА</span>
  </header>
  <div class="pl-name">${dash(data.productName)}</div>
  <div class="pl-figures">
    <div class="pl-figure pl-figure--gtin"><span class="pl-figure-label">GTIN</span><span class="pl-figure-value pl-figure-value--gtin mono">${dash(data.gtin14)}</span></div>
    <div class="pl-figure"><span class="pl-figure-label">Коробов</span><span class="pl-figure-value">${boxCount}</span></div>
    <div class="pl-figure"><span class="pl-figure-label">Единиц</span><span class="pl-figure-value">${unitCount}</span></div>
  </div>
  ${dateTable(rows, format)}
  <div class="pl-code">${barcode}</div>
  <footer class="pl-footer">${footer}</footer>
</section>
</body>
</html>`;
}
