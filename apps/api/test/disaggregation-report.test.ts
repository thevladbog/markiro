import { describe, expect, it } from "vitest";
import {
  renderDisaggregationReportHtml,
  type DisaggregationReportData,
  type DisaggregationReportLine,
} from "../src/modules/disaggregation/report";

/**
 * GS (ASCII 0x1D) — the real KM segment separator byte (see kiosk-orders.e2e.test.ts
 * for the full rationale on why fixtures must use it, not a printable stand-in).
 */
const GS = String.fromCharCode(0x1d);

/**
 * `renderDataMatrixSvg` enforces the AI-01 GTIN mod-10 check digit —
 * "04600682000013" is check-digit VALID (same vector as slip.test.ts).
 */
const GTIN = "04600682000013";

function line(n: number, codeCount: number): DisaggregationReportLine {
  return {
    n,
    sscc: `0014600703496700${String(n).padStart(4, "0")}`,
    productName: `Жигулёвское светлое 0,5 л (партия ${n})`,
    codeCount,
    codes: Array.from({ length: codeCount }, (_, index) => ({
      gtin14: GTIN,
      serial: `BOX${n}SER${index + 1}`,
      rawKm: `01${GTIN}21BOX${n}SER${index + 1}${GS}93Abcd`,
    })),
  };
}

function fixture(overrides: Partial<DisaggregationReportData> = {}): DisaggregationReportData {
  return {
    docNo: "DSG-26-0007",
    status: "applied",
    createdAt: new Date("2026-08-20T09:12:00.000Z"),
    appliedAt: new Date("2026-08-21T10:30:00.000Z"),
    org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
    createdByName: "Иванова Мария Сергеевна",
    appliedByName: "Смирнов Алексей Петрович",
    reasonName: "Повреждение упаковки",
    comment: "Короба намокли при разгрузке",
    includeContents: false,
    lines: [line(1, 3), line(2, 2)],
    ...overrides,
  };
}

describe("renderDisaggregationReportHtml", () => {
  it("is a pure function of its input (no I/O): same fixture -> identical HTML", () => {
    expect(renderDisaggregationReportHtml(fixture())).toBe(
      renderDisaggregationReportHtml(fixture()),
    );
  });

  it("shows the document number, performer, reason and comment", () => {
    const html = renderDisaggregationReportHtml(fixture());
    expect(html).toContain("DSG-26-0007");
    expect(html).toContain("Смирнов Алексей Петрович");
    expect(html).toContain("Повреждение упаковки");
    expect(html).toContain("Короба намокли при разгрузке");
    expect(html).toContain("Операцию провёл");
  });

  it("boxes variant renders one SSCC barcode per line and no DataMatrix", () => {
    const html = renderDisaggregationReportHtml(fixture());
    expect(html.match(/class="sscc-box"/g)).toHaveLength(2);
    expect(html).not.toContain('class="dm-box"');
    expect(html).toContain("(00)146007034967000001");
    expect(html).toContain("(00)146007034967000002");
    expect(html.match(/class="code128-box"/g)).toHaveLength(1);
  });

  it("full variant renders the box bands plus one DataMatrix per unit code", () => {
    const html = renderDisaggregationReportHtml(fixture({ includeContents: true }));
    expect(html.match(/class="rep-band"/g)).toHaveLength(2);
    expect(html.match(/class="dm-box"/g)).toHaveLength(5);
    expect(html).toContain(`01 ${GTIN} 21 BOX1SER1`);
    expect(html).toContain(`01 ${GTIN} 21 BOX2SER2`);
  });

  it("never prints prices", () => {
    const boxesHtml = renderDisaggregationReportHtml(fixture());
    const fullHtml = renderDisaggregationReportHtml(fixture({ includeContents: true }));
    for (const html of [boxesHtml, fullHtml]) {
      expect(html).not.toContain("₽");
      expect(html).not.toMatch(/[Цц]ена/);
      expect(html).not.toContain("Итого по заявке");
    }
  });

  it("declares an A4 @page", () => {
    const html = renderDisaggregationReportHtml(fixture());
    expect(html).toContain("@page");
    expect(html).toMatch(/size:\s*A4/);
  });

  it("totals and signatures land once, at the end of the document", () => {
    const html = renderDisaggregationReportHtml(fixture());
    expect(html.match(/class="rep-final-blocks"/g)).toHaveLength(1);
    expect(html).toContain("коробов — 2 · кодов — 5");
    expect(html.match(/class="signature-line"/g)).toHaveLength(2);
    expect(html).toMatch(
      /class="signature-line"[^>]*><\/span>\s*<span class="signature-name">Смирнов Алексей Петрович<\/span>/,
    );
  });

  it("paginates a long boxes-only act into numbered pages with repeated furniture", () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({
      ...line(index + 1, 1),
      codes: [],
    }));
    const html = renderDisaggregationReportHtml(fixture({ lines }));
    const pageCount = html.match(/data-report-page="\d+"/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThan(1);
    expect(html.match(/class="rep-table-head"/g)).toHaveLength(pageCount);
    expect(html.match(/class="code128-box"/g)).toHaveLength(pageCount);
    expect(html).toContain(`стр. 1 из ${pageCount}`);
    expect(html).toContain(`стр. ${pageCount} из ${pageCount}`);
    expect(html.match(/class="rep-final-blocks"/g)).toHaveLength(1);
    const pages = html.match(/<section class="rep-page"[\s\S]*?<\/section>/g) ?? [];
    const renderedSscc = pages.flatMap((page) =>
      Array.from(page.matchAll(/\(00\)1460070349670(\d{5})/g), (match) => Number(match[1])),
    );
    expect(renderedSscc).toEqual(lines.map((l) => l.n));
  });

  it("paginates the contents variant without orphaning a box band at a page break", () => {
    const lines = Array.from({ length: 12 }, (_, index) => line(index + 1, 9));
    const html = renderDisaggregationReportHtml(fixture({ includeContents: true, lines }));
    const pages = html.match(/<section class="rep-page"[\s\S]*?<\/section>/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      // A box band is never the last unit of a page: its first codes row
      // always sits after it on the same page.
      if (!page.includes('class="rep-band"')) continue;
      expect(page.lastIndexOf('class="rep-band"')).toBeLessThan(
        page.lastIndexOf('class="rep-codes-row"'),
      );
    }
    expect(html.match(/class="dm-box"/g)).toHaveLength(12 * 9);
  });

  it("keeps the act printable when one stored code cannot be rendered", () => {
    const broken = line(1, 1);
    broken.codes[0]!.rawKm = "not-a-valid-km";
    const html = renderDisaggregationReportHtml(
      fixture({ includeContents: true, lines: [broken] }),
    );
    expect(html).toContain("Код не отображается");
    expect(html).toContain("DSG-26-0007");
  });

  it("draft acts name the author and the draft status instead of an applier", () => {
    const html = renderDisaggregationReportHtml(
      fixture({ status: "draft", appliedAt: null, appliedByName: null }),
    );
    expect(html).toContain("Документ составил");
    expect(html).toContain("Иванова Мария Сергеевна");
    expect(html).toContain("Черновик");
  });

  it("uses organization branding when safe and falls back to Markiro for unsafe sources", () => {
    const organizationHtml = renderDisaggregationReportHtml(
      fixture({
        org: {
          name: "ООО Логотип",
          inn: "1234567890",
          logo: "https://assets.example.test/logo.svg?a=1&b=2",
        },
      }),
    );
    expect(organizationHtml).toContain('src="https://assets.example.test/logo.svg?a=1&amp;b=2"');
    expect(organizationHtml).not.toContain('data-brand-logo="markiro"');

    const fallbackHtml = renderDisaggregationReportHtml(
      fixture({
        org: { name: "ООО Небезопасный URL", inn: null, logo: "javascript:alert(1)" },
      }),
    );
    expect(fallbackHtml).not.toContain("javascript:alert(1)");
    expect(fallbackHtml).toContain('data-brand-logo="markiro"');
  });
});
