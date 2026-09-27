import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";
const columns = [
  "product_id",
  "product_gtin",
  "lot_link_mode",
  "lot_id",
  "tlc",
  "source_kind",
  "source_location_id",
  "source_reference_url",
  "source_resolved_location_id",
  "quantity",
  "unit_of_measure",
  "exempt_supplier",
  "exempt_reason",
  "exempt_evidence_url",
  "exempt_tlc_handling",
  "proposed_tlc",
  "supplier_lot_reference",
  "notes",
];
function cells(patch: Record<string, string> = {}) {
  const input: Record<string, string> = {
    product_id: id,
    lot_link_mode: "create_on_finalize",
    tlc: "000123",
    quantity: "500.000",
    unit_of_measure: "lb",
    exempt_supplier: "false",
    ...patch,
  };
  return columns.map((column) => input[column] ?? "");
}

describe("Receiving CSV draft-field adapter", () => {
  it("exports the pure adapter", () => {
    expect(contracts).toHaveProperty("parseReceivingCsvRow", expect.any(Function));
  });
  it("maps ID input to an incomplete draft without manufacturing source or lot", () => {
    expect(contracts.parseReceivingCsvRow(cells())).toMatchObject({
      ok: true,
      productSelector: { kind: "id", value: id },
      normalizations: [],
      item: {
        productId: id,
        lotLinkMode: "create_on_finalize",
        lotId: null,
        tlc: "000123",
        source: null,
        quantity: "500.000",
        unitOfMeasure: "lb",
        exemptSupplier: false,
        exemptReason: null,
        exemptReceipt: null,
        supplierLotReference: null,
        notes: null,
      },
    });
  });
  it("keeps supplied GTIN spelling but uses a canonical lookup key, not a fabricated UUID", () => {
    expect(
      contracts.parseReceivingCsvRow(cells({ product_id: "", product_gtin: "036000291452" })),
    ).toMatchObject({
      ok: true,
      raw: { product_gtin: "036000291452" },
      productSelector: { kind: "gtin", value: "00036000291452" },
      item: { productId: null },
      normalizations: [{ column: "product_gtin", before: "036000291452", after: "00036000291452" }],
    });
  });
  it.each([
    { product_id: "", product_gtin: "" },
    { product_gtin: "036000291452" },
    { product_id: "Product name" },
    { product_id: "", product_gtin: "036000291453" },
  ])("rejects invalid/ambiguous product selectors %j", (patch) => {
    expect(contracts.parseReceivingCsvRow(cells(patch))).toMatchObject({ ok: false });
  });
  it.each([
    { lot_link_mode: "" },
    { lot_link_mode: "guess" },
    { lot_link_mode: "link_existing" },
    { lot_id: id },
    { lot_link_mode: "link_existing", lot_id: "not-uuid" },
  ])("rejects an implicit/invalid link choice %j", (patch) => {
    expect(contracts.parseReceivingCsvRow(cells(patch))).toMatchObject({ ok: false });
  });
  it("preserves an explicit linked lot", () => {
    expect(
      contracts.parseReceivingCsvRow(cells({ lot_link_mode: "link_existing", lot_id: sourceId })),
    ).toMatchObject({ ok: true, item: { lotId: sourceId, lotLinkMode: "link_existing" } });
  });
  it.each(["location", "reference"])(
    "reports UUID case normalization for a %s source and linked lot",
    (source_kind) => {
      const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
      const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const sourceColumn =
        source_kind === "location" ? "source_location_id" : "source_resolved_location_id";
      expect(
        contracts.parseReceivingCsvRow(
          cells({
            product_id: upper,
            lot_link_mode: "link_existing",
            lot_id: upper,
            source_kind,
            [sourceColumn]: upper,
            ...(source_kind === "reference"
              ? { source_reference_url: "https://source.example.test" }
              : {}),
          }),
        ),
      ).toMatchObject({
        ok: true,
        item: { productId: lower, lotId: lower },
        normalizations: [
          { column: "product_id", before: upper, after: lower },
          { column: "lot_id", before: upper, after: lower },
          { column: sourceColumn, before: upper, after: lower },
        ],
      });
    },
  );
  it.each(["", "False", "0", "yes", " true "])(
    "rejects nonliteral boolean %j",
    (exempt_supplier) => {
      expect(contracts.parseReceivingCsvRow(cells({ exempt_supplier }))).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([{ column: "exempt_supplier", code: "boolean" }]),
      });
    },
  );
  it("maps physical source IDs", () => {
    expect(
      contracts.parseReceivingCsvRow(
        cells({ source_kind: "location", source_location_id: sourceId }),
      ),
    ).toMatchObject({ ok: true, item: { source: { kind: "location", locationId: sourceId } } });
  });
  it("keeps reference source and evidence URL separate", () => {
    expect(
      contracts.parseReceivingCsvRow(
        cells({
          source_kind: "reference",
          source_reference_url: "https://source.example.test/x",
          source_resolved_location_id: sourceId,
          exempt_supplier: "true",
          exempt_reason: "Supplier rationale",
          exempt_evidence_url: "https://evidence.example.test/x",
          exempt_tlc_handling: "assign_if_missing",
          proposed_tlc: "=Own-001",
        }),
      ),
    ).toMatchObject({
      ok: true,
      item: {
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://source.example.test/x",
          resolvedLocationId: sourceId,
        },
        exemptReceipt: {
          evidenceUrl: "https://evidence.example.test/x",
          tlcHandling: "assign_if_missing",
          proposedTlc: "=Own-001",
        },
        tlc: "000123",
      },
    });
  });
  it.each([
    { source_kind: "unknown" },
    { source_location_id: sourceId },
    { source_kind: "location" },
    {
      source_kind: "location",
      source_location_id: sourceId,
      source_reference_url: "https://a.test",
    },
    { source_kind: "reference", source_reference_url: "https://a.test" },
    {
      source_kind: "reference",
      source_reference_url: "https://a.test",
      source_resolved_location_id: sourceId,
      source_location_id: sourceId,
    },
    {
      source_kind: "reference",
      source_reference_url: "javascript:alert(1)",
      source_resolved_location_id: sourceId,
    },
  ])("rejects lossy/malformed source %j", (patch) => {
    expect(contracts.parseReceivingCsvRow(cells(patch))).toMatchObject({ ok: false });
  });
  it("retains hidden exemption input and empty nullable draft fields", () => {
    expect(
      contracts.parseReceivingCsvRow(
        cells({
          tlc: "",
          quantity: "",
          unit_of_measure: "",
          exempt_evidence_url: "https://evidence.example.test",
          exempt_tlc_handling: "preserve_existing",
        }),
      ),
    ).toMatchObject({
      ok: true,
      item: {
        tlc: null,
        quantity: null,
        unitOfMeasure: null,
        exemptSupplier: false,
        exemptReceipt: {
          evidenceUrl: "https://evidence.example.test",
          tlcHandling: "preserve_existing",
          proposedTlc: null,
        },
      },
    });
  });
  it("reports existing normalization while preserving exact raw text", () => {
    const raw = cells({ quantity: " 1.200 ", notes: "  =SUM(1,2)  " });
    const before = [...raw];
    expect(contracts.parseReceivingCsvRow(raw)).toMatchObject({
      ok: true,
      raw: { quantity: " 1.200 ", notes: "  =SUM(1,2)  " },
      item: { quantity: "1.200", notes: "=SUM(1,2)" },
      normalizations: [
        { column: "quantity", before: " 1.200 ", after: "1.200" },
        { column: "notes", before: "  =SUM(1,2)  ", after: "=SUM(1,2)" },
      ],
    });
    expect(raw).toEqual(before);
  });
  it.each([
    ["quantity", "1e3"],
    ["quantity", "1.2345"],
    ["unit_of_measure", "pounds"],
    ["tlc", "x".repeat(121)],
    ["notes", "x".repeat(2001)],
    ["supplier_lot_reference", "x".repeat(129)],
    ["exempt_tlc_handling", "auto"],
    ["exempt_evidence_url", "javascript:x"],
    ["proposed_tlc", "\0"],
    ["exempt_reason", "\ud800"],
  ])("maps current contract errors back to %s", (column, value) => {
    expect(contracts.parseReceivingCsvRow(cells({ [column]: value }))).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ column, code: "value" }]),
    });
  });
  it("rejects wrong width without constructing partial input", () => {
    expect(contracts.parseReceivingCsvRow([])).toEqual({
      ok: false,
      issues: [{ column: null, code: "column_count" }],
    });
  });
});
