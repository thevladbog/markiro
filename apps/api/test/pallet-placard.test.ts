import { describe, expect, it } from "vitest";
import {
  PLACARD_ROW_CAP,
  SIZES,
  datesWord,
  namePtFor,
  renderPalletPlacardHtml,
  renderShiftPlacardsHtml,
  summarizeByProductionDate,
  type PalletPlacardBox,
  type PalletPlacardData,
} from "../src/modules/code-search/pallet-placard";

function box(productionDate: string | null, codeCount = 20, disassembledAt: Date | null = null) {
  return { productionDate, codeCount, disassembledAt } satisfies PalletPlacardBox;
}

function fixture(overrides: Partial<PalletPlacardData> = {}): PalletPlacardData {
  return {
    sscc: "00104600682000000019",
    status: "closed",
    productName: "Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ",
    gtin14: "04600682000013",
    shelfLifeDays: 180,
    org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
    boxes: [box("2026-09-10"), box("2026-09-14"), box("2026-09-10")],
    ...overrides,
  };
}

describe("summarizeByProductionDate", () => {
  it("groups live boxes by production date, ascending, with inclusive expiry", () => {
    const rows = summarizeByProductionDate(fixture().boxes, 180, 12);
    expect(rows).toEqual([
      { productionDate: "2026-09-10", expiryDate: "2027-03-08", boxCount: 2, unitCount: 40 },
      { productionDate: "2026-09-14", expiryDate: "2027-03-12", boxCount: 1, unitCount: 20 },
    ]);
  });

  it("prints no expiry without a shelf life and puts undated boxes last", () => {
    const rows = summarizeByProductionDate([box(null), box("2026-09-10")], null, 12);
    expect(rows).toEqual([
      { productionDate: "2026-09-10", expiryDate: null, boxCount: 1, unitCount: 20 },
      { productionDate: null, expiryDate: null, boxCount: 1, unitCount: 20 },
    ]);
  });

  it("excludes a disassembled box from every count", () => {
    const rows = summarizeByProductionDate(
      [box("2026-09-10"), box("2026-09-10", 20, new Date("2026-09-15T00:00:00Z"))],
      180,
      12,
    );
    expect(rows.map((r) => [r.boxCount, r.unitCount])).toEqual([[1, 20]]);
  });

  it("folds the tail past the row cap into one row whose counts keep the total exact", () => {
    const boxes = Array.from({ length: 9 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const rows = summarizeByProductionDate(boxes, null, 6);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).map((r) => r.productionDate)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(rows[5]).toEqual({
      productionDate: null,
      expiryDate: null,
      boxCount: 4,
      unitCount: 80,
      foldedDates: 4,
    });
    expect(rows.reduce((n, r) => n + r.boxCount, 0)).toBe(9);
  });

  it("keeps the undated group as the last row and folds only the dated tail", () => {
    const dated = Array.from({ length: 6 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const rows = summarizeByProductionDate([...dated, box(null), box(null, 5)], 180, 6);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 4).map((r) => r.productionDate)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    // The fold covers dated rows five and six only …
    expect(rows[4]).toEqual({
      productionDate: null,
      expiryDate: null,
      boxCount: 2,
      unitCount: 40,
      foldedDates: 2,
    });
    // … and the undated group keeps its own row after it, never folded.
    expect(rows[5]).toEqual({ productionDate: null, expiryDate: null, boxCount: 2, unitCount: 25 });
    expect(rows.reduce((n, r) => n + r.boxCount, 0)).toBe(8);
  });
});

describe("pallet placard", () => {
  it("prints the header with only the word ПАЛЛЕТА, the organisation and the product", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("ПАЛЛЕТА");
    expect(html).toContain("ООО «Атолл»");
    expect(html).toContain("Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ");
    expect(html).toContain("04600682000013");
    // No status word, no kind, no closing time in the header.
    expect(html).not.toContain("Закрыта");
    expect(html).not.toContain("складская");
    expect(html).not.toContain("ИНН не указан");
  });

  it("steps the product name size down with its length so it fits four lines", () => {
    // 47 characters: past the first threshold, under the second.
    const medium = "Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ";
    const long =
      "Напиток безалкогольный сильногазированный ароматизированный «Атолл Лимон-Лайм Премиум» с подсластителями 0,5 л, ПЭТ";
    expect(namePtFor("Вода «Атолл» 0,5 л", SIZES.a4)).toBe(30);
    expect(namePtFor(medium, SIZES.a4)).toBe(24);
    expect(namePtFor(long, SIZES.a4)).toBe(20);
    expect(namePtFor(long, SIZES.a5)).toBe(14);
    expect(namePtFor(null, SIZES.a4)).toBe(30);
    expect(renderPalletPlacardHtml(fixture({ productName: long }), "a4")).toContain(
      'class="pl-name" style="font-size: 20pt"',
    );
    expect(renderPalletPlacardHtml(fixture({ productName: long }), "a4")).toContain(
      "-webkit-line-clamp: 4;",
    );
  });

  it("sends the reader to the boxes' own labels when a box has no declared production date", () => {
    const html = renderPalletPlacardHtml(fixture({ boxes: [box("2026-09-10"), box(null)] }), "a4");
    // Both the date and the expiry cell of the undated group, never a dash
    // that would read as «no shelf life».
    expect(html.match(/См\. на продукции/g)?.length).toBe(2);
    expect(html).toContain("10.09.2026");
  });

  it("folds the dated tail but still prints «См. на продукции» for undated boxes", () => {
    const dated = Array.from({ length: 6 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const html = renderPalletPlacardHtml(fixture({ boxes: [...dated, box(null)] }), "a5");
    expect(html).toContain("и ещё 2 даты");
    expect(html.match(/См\. на продукции/g)?.length).toBe(2);
    expect(html.match(/<tr>/g)?.length).toBe(1 + 6);
  });

  it("prints the counts, the date summary and the total", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("10.09.2026");
    expect(html).toContain("08.03.2027");
    expect(html).toContain("14.09.2026");
    expect(html).toContain("Итого");
    expect(html).toMatch(/pl-figure-value">3</);
    expect(html).toMatch(/pl-figure-value">60</);
  });

  it("prints the SSCC symbol and its HRI once, in one unbroken line", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain("<svg");
    expect(html.match(/\(00\)104600682000000019/g)?.length).toBe(1);
  });

  it("stretches the SSCC symbol to the full content width", () => {
    const html = renderPalletPlacardHtml(fixture(), "a4");
    expect(html).toContain('<svg preserveAspectRatio="none"');
    expect(html).toContain(".pl-bars svg { display: block; width: 100%;");
  });

  it("sizes the page per format and drops the units column on A5", () => {
    const a4 = renderPalletPlacardHtml(fixture(), "a4");
    const a5 = renderPalletPlacardHtml(fixture(), "a5");
    expect(a4).toContain("@page { size: A4;");
    expect(a5).toContain("@page { size: A5;");
    expect(a4).toContain('<th class="n">Единиц</th>');
    expect(a5).not.toContain('<th class="n">Единиц</th>');
    expect(a5).toContain("Произв.");
    expect(a4).toContain("ИНН 7701234567");
    expect(a5).not.toContain("ИНН 7701234567");
  });

  it("folds a long date list on A5 and says how many dates were folded", () => {
    const boxes = Array.from({ length: 9 }, (_, i) =>
      box(`2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    const html = renderPalletPlacardHtml(fixture({ boxes }), "a5");
    expect(html).toContain("и ещё 4 даты");
    expect(PLACARD_ROW_CAP.a5).toBe(6);
  });

  it("picks the correct Russian plural for «дата» by folded-date count", () => {
    expect(datesWord(1)).toBe("дата");
    expect(datesWord(4)).toBe("даты");
    expect(datesWord(5)).toBe("дат");
    expect(datesWord(11)).toBe("дат");
    expect(datesWord(21)).toBe("дата");
  });

  it("watermarks a disassembled pallet and nothing else", () => {
    expect(renderPalletPlacardHtml(fixture(), "a4")).not.toContain("РАСФОРМИРОВАНА");
    expect(renderPalletPlacardHtml(fixture({ status: "disassembled" }), "a4")).toContain(
      "РАСФОРМИРОВАНА",
    );
  });

  it("prints dashes for a missing GTIN, shelf life and organisation", () => {
    const html = renderPalletPlacardHtml(
      fixture({ gtin14: null, shelfLifeDays: null, org: null }),
      "a4",
    );
    expect(html).toContain('pl-figure-value--gtin mono">—<');
    expect(html).not.toContain("ИНН");
    expect(html).toContain('data-brand-logo="markiro"');
  });

  it("lays out a whole shift as one page per pallet, in the order given, each sized by its own name", () => {
    const long =
      "Напиток безалкогольный сильногазированный ароматизированный «Атолл Лимон-Лайм Премиум» с подсластителями 0,5 л, ПЭТ";
    const html = renderShiftPlacardsHtml(
      [
        fixture({ sscc: "00104600682000000019" }),
        fixture({ sscc: "00104600682000000026", productName: long }),
      ],
      "a5",
      "SEP26-004/S",
    );
    expect(html).toContain("<title>Ярлыки паллет смены SEP26-004/S</title>");
    const pages = html.match(/data-placard-sscc="(\d{20})"/g) ?? [];
    expect(pages).toEqual([
      'data-placard-sscc="00104600682000000019"',
      'data-placard-sscc="00104600682000000026"',
    ]);
    // One stylesheet, one @page size, a break after every page but the last.
    expect(html.match(/@page \{ size: A5;/g)?.length).toBe(1);
    expect(html).toContain("break-after: page; page-break-after: always;");
    expect(html).toContain(".pl-page:last-child { break-after: auto;");
    // A5: the 47-character fixture name sizes to 16 pt, the long one to 14 pt.
    expect(html).toContain('class="pl-name" style="font-size: 16pt"');
    expect(html).toContain('class="pl-name" style="font-size: 14pt"');
    expect(html.match(/\(00\)104600682000000019/g)?.length).toBe(1);
    expect(html.match(/\(00\)104600682000000026/g)?.length).toBe(1);
  });

  it("escapes tenant-controlled text", () => {
    const html = renderPalletPlacardHtml(
      fixture({
        productName: '<script>alert("x")</script>',
        org: { name: "A & <b>", inn: null, logo: null },
      }),
      "a4",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; &lt;b&gt;");
  });
});
