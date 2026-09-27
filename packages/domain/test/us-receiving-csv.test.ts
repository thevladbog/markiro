import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

const header =
  "product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes";
const row =
  "00000000-0000-4000-8000-000000000001,,create_on_finalize,,000123,,,,,500.000,lb,false,,,,,00042,plain";
const parse = (text: string, version = "markiro-receiving-v1") =>
  domain.parseReceivingCsv(new TextEncoder().encode(text), version);

describe("fixed Receiving CSV bytes and records", () => {
  it("exports the decoder through the domain boundary", () => {
    expect(domain).toHaveProperty("parseReceivingCsv", expect.any(Function));
  });
  it.each(["\n", "\r\n"])("preserves cells and a final %j", (ending) => {
    expect(parse(header + ending + row + ending)).toEqual({
      ok: true,
      rows: [
        {
          rowNumber: 1,
          lineNumber: 2,
          cells: [
            "00000000-0000-4000-8000-000000000001",
            "",
            "create_on_finalize",
            "",
            "000123",
            "",
            "",
            "",
            "",
            "500.000",
            "lb",
            "false",
            "",
            "",
            "",
            "",
            "00042",
            "plain",
          ],
          issues: [],
        },
      ],
    });
  });
  it("accepts one BOM without trimming text or evaluating formulas", () => {
    const result = parse("\ufeff" + header + "\n" + row.replace(/plain$/, '" =SUM(1,2) "'));
    expect(result).toMatchObject({
      ok: true,
      rows: [{ cells: expect.arrayContaining([" =SUM(1,2) "]) }],
    });
  });
  it("keeps escaped quotes, embedded CRLF and physical row locations", () => {
    expect(
      parse(header + "\n" + row.replace(/plain$/, '"a,""b""\r\nc"') + "\n" + row),
    ).toMatchObject({
      ok: true,
      rows: [
        { rowNumber: 1, lineNumber: 2, cells: expect.arrayContaining(['a,"b"\r\nc']) },
        { rowNumber: 2, lineNumber: 4 },
      ],
    });
  });
  it("reports an extra blank record without losing the following row", () => {
    expect(parse(header + "\n\n" + row)).toMatchObject({
      ok: true,
      rows: [
        { rowNumber: 1, lineNumber: 2, cells: [""], issues: [{ code: "column_count" }] },
        { rowNumber: 2, lineNumber: 3, issues: [] },
      ],
    });
  });
  it.each([row + ",extra", row.slice(0, row.lastIndexOf(","))])(
    "retains a wrong-width row",
    (value) => {
      expect(parse(header + "\n" + value)).toMatchObject({
        ok: true,
        rows: [{ issues: [{ code: "column_count" }] }],
      });
    },
  );
  it.each(["", "\ufeff", header, header + "\n"])("rejects empty data %j", (value) => {
    expect(parse(value)).toMatchObject({ ok: false, error: { code: "no_rows" } });
  });
  it.each([
    header.replace("product_id", "name"),
    header.replace("product_id", "product_gtin"),
    header + ",unknown",
    header.replace("product_id,product_gtin", "product_gtin,product_id"),
    header.toUpperCase(),
    "\ufeff\ufeff" + header,
  ])("rejects a non-template header", (value) => {
    expect(parse(value + "\n" + row)).toMatchObject({ ok: false, error: { code: "header" } });
  });
  it.each(['a"b', '"unfinished', '"closed"x', '"closed" ', '"a\rb"', "a\rb"])(
    "rejects malformed CSV %j without partial rows",
    (value) => {
      expect(parse(header + "\n" + row + "\n" + value)).toMatchObject({
        ok: false,
        error: { code: "syntax", lineNumber: 3 },
      });
      expect(parse(header + "\n" + row + "\n" + value)).not.toHaveProperty("rows");
    },
  );
  it("rejects NUL", () => {
    expect(parse(header + "\n" + row + "\0")).toMatchObject({ ok: false, error: { code: "nul" } });
  });
  it.each([[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xef, 0xbb]])(
    "rejects invalid UTF-8 %j",
    (...bytes) => {
      expect(domain.parseReceivingCsv(new Uint8Array(bytes), "markiro-receiving-v1")).toMatchObject(
        { ok: false, error: { code: "invalid_utf8" } },
      );
    },
  );
  it("rejects unsupported versions", () => {
    expect(parse(header + "\n" + row, "v2")).toMatchObject({
      ok: false,
      error: { code: "version" },
    });
  });
  it("accepts exactly 100 rows but never truncates row 101", () => {
    const accepted = parse(header + "\n" + Array(100).fill(row).join("\n"));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("Expected exactly 100 decoded records");
    expect(accepted.rows).toHaveLength(100);
    expect(accepted.rows[99]).toMatchObject({ rowNumber: 100, lineNumber: 101 });
    const result = parse(header + "\n" + Array(101).fill(row).join("\n"));
    expect(result).toMatchObject({ ok: false, error: { code: "row_limit" } });
    expect(result).not.toHaveProperty("rows");
  });
  it("checks original bytes, including BOM and multibyte cells", () => {
    const prefix = "\ufeff" + header + "\n" + row.slice(0, -5);
    const padding = 262144 - new TextEncoder().encode(prefix + "é").length;
    expect(parse(prefix + "é" + "x".repeat(padding))).toMatchObject({ ok: true });
    expect(parse(prefix + "é" + "x".repeat(padding + 1))).toMatchObject({
      ok: false,
      error: { code: "byte_limit" },
    });
  });
});
