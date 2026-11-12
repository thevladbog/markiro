import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { renderStandaloneSetExport } from "../src/standalone-exports.js";

const set = "010460712345678121S1\u001d93Ab12";
const item = "010460712345680421A&Z\u001d93Cd34";
const secondSet = "010460712345678121S2\u001d93Ef56";
const secondItem = '010460712345680421B;"C\u001d93Gh78';
const sets = [
  { code: set, items: [item] },
  { code: secondSet, items: [secondItem] },
];

describe("standalone set exports", () => {
  it("preserves the complete item and parent marking strings for 1C", () => {
    const part = renderStandaloneSetExport("shift_csv_unf_set_items", "NOV26-018", sets);
    expect(part).toMatchObject({ partNumber: 1, codeCount: 2, boxCount: 0, palletCount: 0 });
    expect(new TextDecoder().decode(part.bytes)).toBe(
      `Штрихкод или код маркировки;Код упаковки\r\n${item};${set}\r\n"010460712345680421B;""C\u001d93Gh78";${secondSet}\r\n`,
    );
  });

  it("writes a reproducible XLSX workbook containing both CIS strings as text", () => {
    const part = renderStandaloneSetExport("shift_xlsx_chz_set_registry", "NOV26-018", sets);
    expect(part.mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(part.filename).toMatch(/\.xlsx$/);
    const workbook = unzipSync(part.bytes);
    expect(Object.keys(workbook)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = strFromU8(workbook["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t>010460712345678121S1</t>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t>010460712345680421A&amp;Z</t>');
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t>010460712345678121S2</t>');
    expect(sheet).toContain('<c r="B3" t="inlineStr"><is><t>010460712345680421B;"C</t>');
    expect(sheet).not.toContain("93Ab12");
    expect(sheet).not.toContain("93Cd34");
    expect(
      renderStandaloneSetExport("shift_xlsx_chz_set_registry", "NOV26-018", sets).bytes,
    ).toEqual(part.bytes);
  });
});
