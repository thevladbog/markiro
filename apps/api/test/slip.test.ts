import { describe, expect, it } from "vitest";
import { renderPickupSlipHtml, type PickupSlipData } from "../src/pickup/slip";

/**
 * GS (ASCII 0x1D) — the real KM segment separator byte (see kiosk-orders.e2e.test.ts
 * for the full rationale on why fixtures must use it, not a printable stand-in).
 */
const GS = String.fromCharCode(0x1d);

/**
 * `renderDataMatrixSvg` uses `bcid: "gs1datamatrix"`, which enforces the AI-01
 * GTIN mod-10 check digit. "04600682000013" is check-digit VALID (same vector
 * used by kiosk-orders.e2e.test.ts / pickup-slip.e2e.test.ts) — the plan's
 * prototype vector "04650075195923" is NOT and would make this fixture throw.
 */
const GTIN = "04600682000013";

function fixture(overrides: Partial<PickupSlipData> = {}): PickupSlipData {
  return {
    orderNo: "ORD-26-0042",
    createdAt: new Date("2026-07-23T14:05:00.000Z"),
    org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
    employee: {
      fullName: "Смирнов Алексей Петрович",
      role: "оператор линии",
      badgeCode: "MARKIRO-BADGE-4412",
    },
    kioskName: "Киоск-1, проходная цеха",
    reason: "buy",
    writeoffReasonName: null,
    printEmployeeQrOnSlip: false,
    total: "126.00",
    items: [
      {
        n: 1,
        productName: "Жигулёвское светлое 0,5 л",
        gtin14: GTIN,
        serial: "KYC9X7MQ",
        rawKm: `01${GTIN}21KYC9X7MQ${GS}93Abcd`,
        unitPrice: "52.00",
      },
      {
        n: 2,
        productName: "Квас традиционный 1,5 л",
        gtin14: GTIN,
        serial: "XT9NL3VB",
        rawKm: `01${GTIN}21XT9NL3VB${GS}93Abcd`,
        unitPrice: "74.00",
      },
    ],
    ...overrides,
  };
}

describe("renderPickupSlipHtml", () => {
  it("is a pure function of its input (no I/O): same fixture -> identical HTML", () => {
    expect(renderPickupSlipHtml(fixture())).toBe(renderPickupSlipHtml(fixture()));
  });

  it("contains the order number", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html).toContain("ORD-26-0042");
  });

  it("contains both product names", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html).toContain("Жигулёвское светлое 0,5 л");
    expect(html).toContain("Квас традиционный 1,5 л");
  });

  it("omits the employee QR block by default", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html.match(/class="dm-box"/g)).toHaveLength(2);
    expect(html.match(/class="code128-box"/g)).toHaveLength(1);
    expect(html).not.toContain('class="qr-box"');
    expect(html).not.toContain("Отсканируйте код, чтобы найти сотрудника");
  });

  it("renders the employee QR block when the kiosk setting is enabled", () => {
    const html = renderPickupSlipHtml(fixture({ printEmployeeQrOnSlip: true }));
    expect(html.match(/class="dm-box"/g)).toHaveLength(2);
    expect(html.match(/class="code128-box"/g)).toHaveLength(1);
    expect(html.match(/class="qr-box"/g)).toHaveLength(1);
    expect(html).toContain("Отсканируйте код, чтобы найти сотрудника");
  });

  it("declares an A4 @page", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html).toContain("@page");
    expect(html).toMatch(/size:\s*A4/);
  });

  it("renders explicit numbered A4 pages with repeated document furniture", () => {
    const baseItem = fixture().items[0]!;
    const items = Array.from({ length: 17 }, (_, index) => ({
      ...baseItem,
      n: index + 1,
      productName: `Товар ${index + 1}`,
      serial: `SERIAL${index + 1}`,
      rawKm: `01${GTIN}21SERIAL${index + 1}${GS}93Abcd`,
    }));

    const html = renderPickupSlipHtml(fixture({ items }));
    expect(html.match(/data-slip-page="\d+"/g)).toHaveLength(3);
    expect(html.match(/class="slip-table-head"/g)).toHaveLength(3);
    expect(html.match(/class="code128-box"/g)).toHaveLength(3);
    expect(html.match(/стр\. \d+ из \d+/g)).toEqual(["стр. 1 из 3", "стр. 2 из 3", "стр. 3 из 3"]);
    expect(html.match(/class="slip-final-blocks"/g)).toHaveLength(1);
  });

  it("uses organization branding when safe and falls back to Markiro for unsafe sources", () => {
    const organizationHtml = renderPickupSlipHtml(
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

    const fallbackHtml = renderPickupSlipHtml(
      fixture({
        org: { name: "ООО Небезопасный URL", inn: null, logo: "javascript:alert(1)" },
      }),
    );
    expect(fallbackHtml).not.toContain("javascript:alert(1)");
    expect(fallbackHtml).toContain('data-brand-logo="markiro"');
  });

  it("prints document copy, price, title and signatures in the required layout", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html).toContain(
      "Цена является информационной. Окончательная цена будет указана в чеке.",
    );
    expect(html).not.toMatch(/(?:52\.00|74\.00|126\.00)\s*₽/);
    expect(html).not.toContain("Платформа маркировки «Честный ЗНАК»");
    expect(html).toContain('<span class="slip-title-order">№ ORD-26-0042</span>');
    expect(html).toContain('class="code128-box"><svg viewBox="0 0 290 58"');
    expect(html).not.toContain('class="code128-box"><svg viewBox="0 0 290 74"');
    expect(html).toMatch(
      /class="signature-line"[^>]*><\/span>\s*<span class="signature-name">Смирнов Алексей Петрович<\/span>/,
    );
  });

  it("renders gracefully with no org profile and no active badge", () => {
    const html = renderPickupSlipHtml(
      fixture({ org: null, employee: { fullName: "Без бейджа", role: null, badgeCode: null } }),
    );
    expect(html).toContain("Без бейджа");
    expect(html.match(/class="dm-box"/g)).toHaveLength(2);
    expect(html.match(/class="code128-box"/g)).toHaveLength(1);
    expect(html).not.toContain('class="qr-box"');
  });

  it("keeps the printable slip available when one stored marking code cannot be rendered", () => {
    const html = renderPickupSlipHtml(
      fixture({
        items: [
          {
            n: 1,
            productName: "Товар с повреждённым кодом",
            gtin14: GTIN,
            serial: "BROKEN",
            rawKm: "not-a-valid-km",
            unitPrice: "52.00",
          },
        ],
      }),
    );

    expect(html).toContain("Товар с повреждённым кодом");
    expect(html).toContain("Код не отображается");
    expect(html).toContain("ORD-26-0042");
  });
});
