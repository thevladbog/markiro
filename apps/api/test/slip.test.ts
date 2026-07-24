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
    org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641" },
    employee: {
      fullName: "Смирнов Алексей Петрович",
      role: "оператор линии",
      badgeCode: "MARKIRO-BADGE-4412",
    },
    kioskName: "Киоск-1, проходная цеха",
    reason: "buy",
    writeoffReasonName: null,
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

  it("embeds at least 2 item DataMatrix SVGs + 1 Code128 SVG (>= 3 <svg occurrences)", () => {
    const html = renderPickupSlipHtml(fixture());
    const svgCount = (html.match(/<svg/g) ?? []).length;
    // 2 items' DataMatrix + footer Code128 = 3 minimum; a badge QR (present in
    // this fixture) brings it to 4.
    expect(svgCount).toBeGreaterThanOrEqual(3);
    expect(svgCount).toBe(4);
  });

  it("declares an A4 @page", () => {
    const html = renderPickupSlipHtml(fixture());
    expect(html).toContain("@page");
    expect(html).toMatch(/size:\s*A4/);
  });

  it("renders gracefully with no org profile and no active badge", () => {
    const html = renderPickupSlipHtml(
      fixture({ org: null, employee: { fullName: "Без бейджа", role: null, badgeCode: null } }),
    );
    expect(html).toContain("Без бейджа");
    const svgCount = (html.match(/<svg/g) ?? []).length;
    // No badge -> no QR block; still 2 DataMatrix + 1 Code128.
    expect(svgCount).toBe(3);
  });
});
