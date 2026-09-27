import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import * as csv from "../src/modules/traceability/receiving/us-receiving-csv-input";

const header = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
const request = (text: string) => ({
  templateVersion: "markiro-receiving-v1",
  fileBase64: Buffer.from(text, "utf8").toString("base64"),
  header,
});
const columns =
  "product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes";
const row =
  "00000000-0000-4000-8000-000000000001,,create_on_finalize,,000123,,,,,500.000,lb,false,,,,,00042,=plain";

describe("US server CSV byte preparation (no authorization or persistence)", () => {
  it("exports file preparation", () => {
    expect(csv).toHaveProperty("prepareUsReceivingCsvFile", expect.any(Function));
  });
  it("hashes empty original bytes and returns an explicit file error", () => {
    expect(csv.prepareUsReceivingCsvFile(request(""))).toMatchObject({
      byteSize: 0,
      fileSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      content: { ok: false, error: { code: "no_rows" } },
    });
  });
  it("hashes bytes, not base64 text or normalized file contents", () => {
    expect(csv.prepareUsReceivingCsvFile(request("abc"))).toMatchObject({
      byteSize: 3,
      fileSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      content: { ok: false, error: { code: "header" } },
    });
  });
  it.each(["Zh==", "Zg", "____", "Zg==\n"])(
    "rejects ambiguous transport %j with a safe 400",
    (fileBase64) => {
      try {
        csv.prepareUsReceivingCsvFile({ ...request(""), fileBase64 });
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        if (!(error instanceof BadRequestException)) throw error;
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({ code: "receiving_csv_input_invalid" });
      }
    },
  );
  it.each([
    null,
    {},
    { ...request(""), tenantId: "other" },
    { ...request(""), fileBase64: Buffer.alloc(262145).toString("base64") },
  ])("rejects malformed/oversized input", (input) => {
    expect(() => csv.prepareUsReceivingCsvFile(input)).toThrow(BadRequestException);
  });
  it("preserves exact cells while marking an invalid row without hiding it", () => {
    const result = csv.prepareUsReceivingCsvFile(
      request(columns + "\n" + row + "\n" + row.replace("500.000", "1e3")),
    );
    expect(result.content).toMatchObject({
      ok: true,
      rows: [
        {
          rowNumber: 1,
          lineNumber: 2,
          validation: {
            ok: true,
            raw: {
              tlc: "000123",
              quantity: "500.000",
              supplier_lot_reference: "00042",
              notes: "=plain",
            },
            item: {
              tlc: "000123",
              quantity: "500.000",
              supplierLotReference: "00042",
              notes: "=plain",
            },
          },
        },
        {
          rowNumber: 2,
          lineNumber: 3,
          validation: { ok: false, issues: [{ column: "quantity", code: "value" }] },
        },
      ],
    });
    if (!result.content.ok) throw new Error("Expected row diagnostics");
    expect(result.content.rows).toHaveLength(2);
  });
  it("retains blank-row and multiline locations for a trusted UI error table", () => {
    const result = csv.prepareUsReceivingCsvFile(
      request(columns + "\n\n" + row.replace("=plain", '"one\ntwo"')),
    );
    expect(result.content).toMatchObject({
      ok: true,
      rows: [
        {
          rowNumber: 1,
          lineNumber: 2,
          cells: [""],
          validation: { ok: false, issues: [{ column: null, code: "column_count" }] },
        },
        { rowNumber: 2, lineNumber: 3, validation: { ok: true, item: { notes: "one\ntwo" } } },
      ],
    });
  });
  it("does not expose a partial row set after structural failure", () => {
    const result = csv.prepareUsReceivingCsvFile(request(columns + "\n" + row + '\n"unfinished'));
    expect(result.content).toMatchObject({ ok: false, error: { code: "syntax" } });
    expect(result.content).not.toHaveProperty("rows");
  });
  it("returns invalid UTF-8 as a file error rather than replacement text", () => {
    expect(
      csv.prepareUsReceivingCsvFile({ ...request(""), fileBase64: "/w==" }).content,
    ).toMatchObject({ ok: false, error: { code: "invalid_utf8" } });
  });
  it("preserves BOM and CRLF byte identity despite equivalent parsed rows", () => {
    const plain = csv.prepareUsReceivingCsvFile(request(columns + "\n" + row));
    const alternate = csv.prepareUsReceivingCsvFile(request("\ufeff" + columns + "\r\n" + row));
    expect(alternate.content).toEqual(plain.content);
    expect(alternate.fileSha256).not.toBe(plain.fileSha256);
    expect(alternate.byteSize).toBe(plain.byteSize + 4);
    expect([...alternate.fileBytes.subarray(0, 3)]).toEqual([239, 187, 191]);
  });
  it("snapshots the original header separately from normalized draft values", () => {
    const input = {
      ...request(columns + "\n" + row),
      header: {
        ...header,
        notes: "  original  ",
        documentIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      },
    };
    const result = csv.prepareUsReceivingCsvFile(input);
    expect(result.input.header).toMatchObject({
      notes: "original",
      documentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    });
    expect(result.originalHeader).toEqual({
      ...header,
      notes: "  original  ",
      documentIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
    });
    input.header.notes = "changed";
    input.header.documentIds.length = 0;
    expect(result.originalHeader).toMatchObject({
      notes: "  original  ",
      documentIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
    });
  });
});
