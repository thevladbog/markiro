import { describe, expect, it } from "vitest";

import {
  renderShiftTaskFormHtml,
  type ShiftTaskFormData,
} from "../src/modules/shifts/shift-task-form";

const SHIFT_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

function fixture(overrides: Partial<ShiftTaskFormData> = {}): ShiftTaskFormData {
  return {
    shiftId: SHIFT_ID,
    shiftNumber: "SEP26-014",
    status: "planned",
    mode: "aggregation",
    organizationName: "ООО «Атолл»",
    productId: PRODUCT_ID,
    productName: "Вода питьевая «Атолл» негазированная, ПЭТ 0,5 л",
    productPrintName: "Атолл 0,5 л н/г",
    gtin14: "04607091380019",
    imageChecksum: "a".repeat(64),
    lineName: "Линия розлива №2",
    plannedDate: "2026-09-21",
    productionDate: "2026-09-21",
    plannedQty: 12_000,
    boxCapacity: 24,
    palletsEnabled: true,
    palletBoxCapacity: 40,
    counterpartyName: "ООО «Торговый дом Ромашка»",
    ssccIssuerName: null,
    validationPrintMode: "none",
    validationPrintVerification: "none",
    allowPreviouslyAcceptedCodes: false,
    generatedAt: new Date("2026-09-19T11:20:00.000Z"),
    ...overrides,
  };
}

describe("renderShiftTaskFormHtml", () => {
  it("carries the station token and the human shift number as separate identities", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain(`data-task-token="markiro:shift:v1:${SHIFT_ID}"`);
    expect(html).toContain("SEP26-014");
    expect(html).toContain("Отсканируйте на терминале, чтобы открыть смену");
  });

  it("renders the token as a compact Data Matrix, not a stretched one", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain('data-barcode-symbology="datamatrix"');
    expect(html).not.toContain('preserveAspectRatio="none"');
  });

  it("prints aggregation parameters and hides validation printing ones", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain("ВМЕСТИМОСТЬ КОРОБА");
    expect(html).toContain("24 бутылки");
    expect(html).toContain("Собираются, 40 коробов");
    expect(html).toContain("Собственные");
    expect(html).not.toContain("ПЕЧАТЬ ЭТИКЕТКИ");
  });

  it("prints the issuing counterparty when the boxes carry someone else's numbers", () => {
    const html = renderShiftTaskFormHtml(fixture({ ssccIssuerName: "ООО «Ромашка»" }));

    expect(html).toContain("ООО «Ромашка»");
    expect(html).not.toContain(">Собственные<");
  });

  it("prints validation printing parameters and hides aggregation ones", () => {
    const html = renderShiftTaskFormHtml(
      fixture({
        mode: "validation",
        palletsEnabled: false,
        palletBoxCapacity: null,
        boxCapacity: null,
        validationPrintMode: "duplicate_dm",
        validationPrintVerification: "required",
        allowPreviouslyAcceptedCodes: true,
      }),
    );

    expect(html).toContain("ПЕЧАТЬ ЭТИКЕТКИ");
    expect(html).toContain("Дубликат Data Matrix · обязательная проверка");
    expect(html).toContain("ПОВТОРНАЯ ОБРАБОТКА");
    expect(html).not.toContain("ВМЕСТИМОСТЬ КОРОБА");
    expect(html).not.toContain("ПАЛЛЕТЫ");
  });

  it("omits the reprocessing row when reprocessing is off", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ mode: "validation", validationPrintMode: "duplicate_dm" }),
    );

    expect(html).not.toContain("ПОВТОРНАЯ ОБРАБОТКА");
  });

  it("references the product photo relatively so both origins resolve it", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain(`src="../../products/${PRODUCT_ID}/image/${"a".repeat(64)}"`);
  });

  it("drops the photo box entirely when the product has no image", () => {
    const html = renderShiftTaskFormHtml(fixture({ imageChecksum: null }));

    expect(html).not.toContain("<img");
    expect(html).toContain("Вода питьевая «Атолл» негазированная, ПЭТ 0,5 л");
  });

  it("names the defaults a shop floor needs instead of printing dashes", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ lineName: null, productionDate: null, plannedQty: null }),
    );

    expect(html).toContain("Не назначена");
    expect(html).toContain("По дате смены");
    expect(html).toContain("Без плана");
  });

  it("labels both printable statuses", () => {
    expect(renderShiftTaskFormHtml(fixture())).toContain("К запуску");
    expect(renderShiftTaskFormHtml(fixture({ status: "active" }))).toContain("В работе");
  });

  it("escapes tenant-controlled text instead of interpolating markup", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ productName: '<script>alert("x")</script>', counterpartyName: "A & B" }),
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });

  it("is deterministic for the same input", () => {
    expect(renderShiftTaskFormHtml(fixture())).toBe(renderShiftTaskFormHtml(fixture()));
  });

  it("switches to the compact layout when the names would overflow one page", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ productName: "П".repeat(150), counterpartyName: "К".repeat(120) }),
    );

    expect(html).toContain('data-layout="compact"');
  });

  /**
   * The boundary below was measured against the rendered sheet in a browser:
   * at 180 combined code points the standard layout lands its footer exactly on
   * the bottom margin, and one code point more pushes it past. Moving either
   * side of this pair without re-measuring is how the sheet silently starts
   * printing its footer into the margin again.
   */
  it("keeps the standard layout at the measured limit and drops to compact past it", () => {
    // Four names of similar length, each well under the separate 100-per-name
    // limit, so this pins the combined rule and nothing else.
    const names = (total: number) => ({
      organizationName: "О".repeat(45),
      lineName: "Л".repeat(45),
      counterpartyName: "К".repeat(45),
      productName: "П".repeat(total - 135),
    });

    expect(renderShiftTaskFormHtml(fixture(names(180)))).toContain('data-layout="standard"');
    expect(renderShiftTaskFormHtml(fixture(names(181)))).toContain('data-layout="compact"');
  });

  /**
   * These two sizes are what make the sheet fit A4: the shift form carries a
   * product block the inventory form does not, so it overrides the shared
   * chrome's 32mm barcode and its own 28mm photo. Both were cut to the values
   * below after measuring the real sheet; dropping either override reintroduces
   * the clipped footer that shipped in #616.
   */
  it("keeps the print dimensions the A4 fit depends on", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toMatch(/\.barcode\s*\{[^}]*width:\s*28mm[^}]*height:\s*28mm/s);
    expect(html).toMatch(/\.product-photo\s*\{[^}]*width:\s*22mm[^}]*height:\s*22mm/s);
  });

  it("labels the product block the way the printed design does", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain('<div class="product-eyebrow">Продукция</div>');
  });

  it("omits the terminal short name when the catalog has none", () => {
    const html = renderShiftTaskFormHtml(fixture({ productPrintName: null }));

    expect(html).not.toContain("На терминале:");
    expect(html).toContain("GTIN");
  });

  it("escapes every tenant-controlled name, not only the two on the hero line", () => {
    const html = renderShiftTaskFormHtml(
      fixture({
        organizationName: "<b>Орг</b>",
        lineName: "<i>Линия</i>",
        productPrintName: "<u>Крат</u>",
        ssccIssuerName: "<s>Эмитент</s>",
      }),
    );

    expect(html).not.toContain("<b>Орг</b>");
    expect(html).not.toContain("<i>Линия</i>");
    expect(html).not.toContain("<u>Крат</u>");
    expect(html).not.toContain("<s>Эмитент</s>");
    expect(html).toContain("&lt;b&gt;Орг&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;Линия&lt;/i&gt;");
    expect(html).toContain("&lt;u&gt;Крат&lt;/u&gt;");
    expect(html).toContain("&lt;s&gt;Эмитент&lt;/s&gt;");
  });
});
