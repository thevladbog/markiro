import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import * as preview from "../src/modules/traceability/receiving/us-receiving-csv-preview";
import { prepareUsReceivingCsvFile } from "../src/modules/traceability/receiving/us-receiving-csv-input";
import { csvRequest, csvRow } from "./support/us-receiving-csv-fixture";

const product = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const request = csvRequest([csvRow(product)]);
const prepared = prepareUsReceivingCsvFile(request);
const resolution = { rows: [{ rowNumber: 1, productId: product, issues: [] }], headerIssues: [] };

describe("CSV preview proposal identity", () => {
  it("exports a pure proposal builder and persisted-evidence reader", () => {
    expect(preview).toHaveProperty("buildReceivingCsvProposal", expect.any(Function));
    expect(preview).toHaveProperty("receivingCsvPreviewResponse", expect.any(Function));
  });
  it("builds a draft without filling missing values or converting exact quantities", () => {
    expect(preview.buildReceivingCsvProposal(prepared, resolution)).toMatchObject({
      proposedDraft: {
        ...request.header,
        items: [
          {
            productId: product,
            tlc: "=Case/Ä-001",
            quantity: "500.000",
            source: null,
            notes: null,
          },
        ],
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
  it("ignores filename and original object key order in normalized content identity", () => {
    const reversed = Object.fromEntries(Object.entries(request.header).reverse());
    const second = prepareUsReceivingCsvFile({
      ...request,
      fileName: "different.csv",
      header: reversed,
    });
    expect(preview.buildReceivingCsvProposal(second, resolution)).toEqual(
      preview.buildReceivingCsvProposal(prepared, resolution),
    );
  });
  it("binds original bytes, header and resolved IDs to the digest", () => {
    const base = preview.buildReceivingCsvProposal(prepared, resolution).previewDigest;
    for (const value of [
      {
        ...request,
        fileBase64: Buffer.from(
          "\ufeff" + Buffer.from(request.fileBase64, "base64").toString(),
        ).toString("base64"),
      },
      { ...request, header: { ...request.header, notes: "Another delivery" } },
    ])
      expect(
        preview.buildReceivingCsvProposal(prepareUsReceivingCsvFile(value), resolution)
          .previewDigest,
      ).not.toBe(base);
    const gtin = prepareUsReceivingCsvFile(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    expect(preview.buildReceivingCsvProposal(gtin, resolution).previewDigest).not.toBe(
      preview.buildReceivingCsvProposal(gtin, {
        ...resolution,
        rows: [{ rowNumber: 1, productId: other, issues: [] }],
      }).previewDigest,
    );
  });
  it("retains a failed row rather than producing a partial draft", () => {
    const value = prepareUsReceivingCsvFile(
      csvRequest([csvRow(product), csvRow(product, { quantity: "1e3" })]),
    );
    const result = preview.buildReceivingCsvProposal(value, {
      rows: [...resolution.rows, { rowNumber: 2, productId: null, issues: [] }],
      headerIssues: [],
    });
    expect(result).toEqual({ proposedDraft: null, previewDigest: null });
  });
  it("blocks a proposal on any reference finding", () => {
    expect(
      preview.buildReceivingCsvProposal(
        prepareUsReceivingCsvFile({ ...request, header: { ...request.header, locationId: other } }),
        {
          ...resolution,
          headerIssues: [{ field: "locationId", documentIndex: null, code: "not_found" }],
        },
      ),
    ).toEqual({ proposedDraft: null, previewDigest: null });
    expect(
      preview.buildReceivingCsvProposal(prepared, {
        rows: [
          { rowNumber: 1, productId: null, issues: [{ column: "product_id", code: "not_found" }] },
        ],
        headerIssues: [],
      }),
    ).toEqual({ proposedDraft: null, previewDigest: null });
  });
  it.each([
    {
      ...resolution,
      headerIssues: [{ field: "locationId", documentIndex: null, code: "not_found" }],
    },
    {
      ...resolution,
      headerIssues: [{ field: "documentIds", documentIndex: 0, code: "not_found" }],
    },
    {
      rows: [
        { rowNumber: 1, productId: product, issues: [{ column: "lot_id", code: "inactive" }] },
      ],
      headerIssues: [],
    },
    {
      rows: [
        {
          rowNumber: 1,
          productId: product,
          issues: [{ column: "source_resolved_location_id", code: "inactive" }],
        },
      ],
      headerIssues: [],
    },
    {
      rows: [
        {
          rowNumber: 1,
          productId: null,
          issues: [
            { column: "product_id", code: "not_found" },
            { column: "product_id", code: "inactive" },
          ],
        },
      ],
      headerIssues: [],
    },
  ])("rejects findings not bound to an actual unique input reference", (value) => {
    expect(() => preview.buildReceivingCsvProposal(prepared, value)).toThrow(
      ServiceUnavailableException,
    );
  });
  it.each([
    { rows: [], headerIssues: [] },
    { rows: [{ rowNumber: 2, productId: product, issues: [] }], headerIssues: [] },
    { rows: [{ rowNumber: 1, productId: other, issues: [] }], headerIssues: [] },
    { rows: [{ rowNumber: 1, productId: null, issues: [] }], headerIssues: [] },
  ])("rejects inconsistent saved row bindings", (value) => {
    expect(() => preview.buildReceivingCsvProposal(prepared, value)).toThrow(
      ServiceUnavailableException,
    );
  });
});
