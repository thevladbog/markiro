import { describe, expect, it } from "vitest";
import { renderBoxReportHtml, type BoxReportData } from "../src/modules/code-search/box-report";

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

function fixture(overrides: Partial<BoxReportData> = {}): BoxReportData {
  return {
    sscc: "00146007034967000010",
    status: "closed",
    productName: "Жигулёвское светлое 0,5 л",
    org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
    openedAt: new Date("2026-08-20T08:00:00.000Z"),
    closedAt: new Date("2026-08-20T08:30:00.000Z"),
    disassembledAt: null,
    codes: Array.from({ length: 3 }, (_, index) => ({
      gtin14: GTIN,
      serial: `SER${index + 1}`,
      rawKm: `01${GTIN}21SER${index + 1}${GS}93Abcd`,
    })),
    ...overrides,
  };
}

describe("renderBoxReportHtml", () => {
  it("is a pure function of its input (no I/O): same fixture -> identical HTML", () => {
    expect(renderBoxReportHtml(fixture())).toBe(renderBoxReportHtml(fixture()));
  });

  it("shows the SSCC, organization, product and status", () => {
    const html = renderBoxReportHtml(fixture());
    expect(html).toContain("Состав короба");
    expect(html).toContain("(00)146007034967000010");
    expect(html).toContain("ООО «Пивзавод „Заря“»");
    expect(html).toContain("Жигулёвское светлое 0,5 л");
    expect(html).toContain("Закрыт");
  });

  it("nests one indented DataMatrix code row under the box row", () => {
    const html = renderBoxReportHtml(fixture());
    expect(html.match(/class="rep-box-row"/g)).toHaveLength(1);
    expect(html.match(/class="rep-code-row"/g)).toHaveLength(3);
    expect(html.match(/class="dm-box"/g)).toHaveLength(3);
    expect(html).toContain(`01 ${GTIN} 21 SER1`);
    expect(html).toContain(`01 ${GTIN} 21 SER3`);
    // Tree glyphs: the last code closes with └, the rest use ├.
    expect(html.match(/class="rep-tree">└/g)).toHaveLength(1);
    expect(html.match(/class="rep-tree">├/g)).toHaveLength(2);
    // The box row carries the SSCC Code128; the footer repeats it on the page.
    expect(html.match(/class="sscc-box"/g)).toHaveLength(1);
    expect(html.match(/class="code128-box"/g)).toHaveLength(1);
  });

  it("totals land once with the code count", () => {
    const html = renderBoxReportHtml(fixture());
    expect(html.match(/class="rep-final-blocks"/g)).toHaveLength(1);
    expect(html).toContain("кодов — 3");
  });

  it("never prints prices", () => {
    const html = renderBoxReportHtml(fixture());
    expect(html).not.toContain("₽");
    expect(html).not.toMatch(/[Цц]ена/);
  });

  it("declares an A4 @page", () => {
    const html = renderBoxReportHtml(fixture());
    expect(html).toContain("@page");
    expect(html).toMatch(/size:\s*A4/);
  });

  it("paginates a full box into numbered pages with repeated furniture", () => {
    const codes = Array.from({ length: 60 }, (_, index) => ({
      gtin14: GTIN,
      serial: `SER${index + 1}`,
      rawKm: `01${GTIN}21SER${index + 1}${GS}93Abcd`,
    }));
    const html = renderBoxReportHtml(fixture({ codes }));
    const pageCount = html.match(/data-report-page="\d+"/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThan(1);
    expect(html.match(/class="rep-table-head"/g)).toHaveLength(pageCount);
    expect(html).toContain(`стр. 1 из ${pageCount}`);
    expect(html).toContain(`стр. ${pageCount} из ${pageCount}`);
    expect(html.match(/class="rep-final-blocks"/g)).toHaveLength(1);
    expect(html.match(/class="dm-box"/g)).toHaveLength(60);
  });

  it("renders an empty box with a note instead of code rows", () => {
    const html = renderBoxReportHtml(fixture({ codes: [] }));
    expect(html).toContain("Короб пуст");
    expect(html).not.toContain('class="dm-box"');
    expect(html).toContain("кодов — 0");
  });

  it("keeps the form printable for a box without an SSCC", () => {
    const html = renderBoxReportHtml(fixture({ sscc: null }));
    expect(html).toContain("Без SSCC");
    expect(html).not.toContain('class="sscc-box"');
    expect(html).not.toContain('class="code128-box"');
  });

  it("keeps the form printable when one stored code cannot be rendered", () => {
    const codes = fixture().codes;
    codes[0]!.rawKm = "not-a-valid-km";
    const html = renderBoxReportHtml(fixture({ codes }));
    expect(html).toContain("Код не отображается");
    expect(html).toContain("(00)146007034967000010");
  });

  it("uses organization branding when safe and falls back to Markiro for unsafe sources", () => {
    const organizationHtml = renderBoxReportHtml(
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

    const fallbackHtml = renderBoxReportHtml(
      fixture({
        org: { name: "ООО Небезопасный URL", inn: null, logo: "javascript:alert(1)" },
      }),
    );
    expect(fallbackHtml).not.toContain("javascript:alert(1)");
    expect(fallbackHtml).toContain('data-brand-logo="markiro"');
  });
});
