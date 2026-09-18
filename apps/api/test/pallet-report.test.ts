import { describe, expect, it } from "vitest";
import { PARENT_ROW_MM, parentRowHeightMm } from "../src/modules/code-search/contents-report";
import {
  renderPalletReportHtml,
  type PalletReportData,
} from "../src/modules/code-search/pallet-report";

function box(n: number, codeCount = 12, disassembledAt: Date | null = null) {
  return {
    sscc: `0014600703496700${String(n).padStart(4, "0")}`,
    codeCount,
    disassembledAt,
  };
}

function fixture(overrides: Partial<PalletReportData> = {}): PalletReportData {
  return {
    sscc: "00146007034967100001",
    status: "closed",
    productName: "Жигулёвское светлое 0,5 л",
    org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
    openedAt: new Date("2026-09-11T06:00:00.000Z"),
    closedAt: new Date("2026-09-11T09:30:00.000Z"),
    disassembledAt: null,
    boxes: [box(1), box(2), box(3)],
    ...overrides,
  };
}

describe("pallet contents report", () => {
  it("prints the pallet and each member box with its own SSCC and count", () => {
    const html = renderPalletReportHtml(fixture());
    expect(html).toContain("Состав паллеты");
    expect(html).toContain("(00)146007034967100001");
    for (const n of [1, 2, 3]) expect(html).toContain(`(00)14600703496700000${n}`);
    expect(html.match(/<tr class="rep-code-row">/g)?.length).toBe(3);
    // Units are the sum across boxes, not a per-box figure.
    expect(html).toContain("коробов — 3 · единиц — 36");
  });

  /**
   * The defining rule, shared with `PalletDao.boxCount` and the station: a box
   * taken off the stack keeps its membership as history, stays visible on the
   * form, and does NOT count. A clerk counting boxes against the total has to
   * find what is physically there.
   */
  it("lists a box taken off the pallet but excludes it from the totals", () => {
    const html = renderPalletReportHtml(
      fixture({ boxes: [box(1), box(2, 12, new Date("2026-09-11T10:00:00.000Z")), box(3)] }),
    );
    expect(html).toContain("(00)146007034967000002");
    expect(html).toContain("снят 11.09.2026 10:00");
    expect(html).toContain("коробов — 2 · единиц — 24");
    expect(html).toContain("Коробов на паллете: 2 · единиц: 24");
  });

  it("says so when the pallet carries no boxes", () => {
    const html = renderPalletReportHtml(fixture({ boxes: [], status: "open", closedAt: null }));
    expect(html).toContain("На паллете нет коробов");
    expect(html).toContain("коробов — 0 · единиц — 0");
    expect(html).toContain("Открыта");
  });

  it("survives a pallet closed without an SSCC and a box without one", () => {
    const html = renderPalletReportHtml(
      fixture({ sscc: null, boxes: [{ sscc: null, codeCount: 5, disassembledAt: null }] }),
    );
    expect(html).toContain("Без SSCC");
    expect(html).toContain("коробов — 1 · единиц — 5");
  });

  it("renders the viewer's timezone, not the server's", () => {
    const data = fixture();
    expect(renderPalletReportHtml(data, "Europe/Moscow")).toContain("11.09.2026 09:00");
    expect(renderPalletReportHtml(data, "UTC")).toContain("11.09.2026 06:00");
  });

  /** Many boxes must paginate rather than overflow one A4 page. */
  it("paginates a tall pallet across pages", () => {
    const many = Array.from({ length: 40 }, (_, i) => box(i + 1));
    const html = renderPalletReportHtml(fixture({ boxes: many }));
    const pages = html.match(/data-report-page="\d+"/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    expect(html).toContain(`стр. ${pages.length} из ${pages.length}`);
  });

  /**
   * Owner review 2026-09-18: the product name in the pallet row must print
   * in full, however long. The row grows instead of clamping, and the
   * pagination budget grows with it so the row cannot overrun the page.
   */
  it("prints a long product name in full and reserves a taller pallet row for it", () => {
    const long =
      "Сидр фруктовый газированный жемчужный фильтрованный пастеризованный «Кармилла Сайдер» 0,33 л, стекло, упаковка 12 шт.";
    const html = renderPalletReportHtml(fixture({ productName: long }));
    expect(html).toContain(`<span class="rep-product-name">${long}</span>`);
    expect(html).not.toContain("line-clamp");
    expect(html).toContain(".rep-box-row { min-height: 13mm;");
    expect(parentRowHeightMm(null)).toBe(PARENT_ROW_MM);
    expect(parentRowHeightMm("Cola")).toBe(PARENT_ROW_MM);
    expect(parentRowHeightMm(long)).toBeGreaterThan(PARENT_ROW_MM);
    // Five wrapped lines at ~28 characters: 2 + 5 × 4.6 → 25 mm.
    expect(parentRowHeightMm(long)).toBe(25);
  });

  it("escapes tenant-controlled text", () => {
    const html = renderPalletReportHtml(
      fixture({
        productName: '<script>alert("x")</script>',
        org: { name: "ООО «А» & <b>Б</b>", inn: null, logo: null },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});
