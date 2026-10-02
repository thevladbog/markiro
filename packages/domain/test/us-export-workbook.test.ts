import { describe, expect, it } from "vitest";
import type { ExportInputV1 } from "../../platform-contracts/dist/index.js";
import {
  at,
  snapshotV3,
} from "../../platform-contracts/test/support/us-receiving-lifecycle-fixture.js";
import { traceExportRegistryHash } from "../src/traceability/export/registry-v1.js";
import { ExportWorkbookInputError } from "../src/traceability/export/validation.js";
import {
  buildUsExportWorkbook,
  type ExportWorkbookInput,
  type WorkbookModel,
} from "../src/traceability/export/workbook.js";

const eventId = "00000000-0000-4000-8000-000000000001";
const sourceRecord = `receiving:${eventId}:1:item:1`;
const line = at(snapshotV3.items, 0);
function fixture(): ExportInputV1 {
  return {
    schemaVersion: 1,
    mode: "export_ready_candidate",
    tenantId: "synthetic",
    events: [
      {
        type: "receiving",
        eventId,
        revision: 1,
        lifecycle: "current_finalized",
        timeZone: "America/Los_Angeles",
        payload: { kind: "frozen", snapshot: snapshotV3 },
      },
    ],
    findings: [],
    metadata: {
      mode: "export_ready_candidate",
      profile: "US_FSMA204_PROCESSOR",
      scopeLabel: "Captured receipts",
      timeZone: "America/Chicago",
      generatedAt: "2026-10-02T10:00:00.000Z",
      baselineId: "US-REG-2026-09-03",
      registryId: "fda_sortable_xlsx",
      registryVersion: 1,
      registryHash: traceExportRegistryHash(),
      build: { apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: true },
    },
  };
}
function withLine(
  values: Partial<
    Omit<typeof line, "unitOfMeasure" | "source"> & {
      unitOfMeasure: string;
      source: typeof line.source | { kind: "location"; locationId: string };
    }
  >,
): ExportWorkbookInput {
  const input = fixture();
  return {
    ...input,
    events: [
      {
        ...at(input.events, 0),
        type: "receiving",
        payload: {
          kind: "frozen",
          snapshot: { ...snapshotV3, items: [{ ...line, ...values }] },
        },
      },
    ],
  };
}
function sheet(model: WorkbookModel | null, name: string) {
  const found = model?.sheets.find((value) => value.name === name);
  if (!found) throw new Error(`Missing ${name} sheet`);
  return found;
}
function cell(model: WorkbookModel | null, name: string, key: string, row = 0) {
  const target = sheet(model, name);
  return target.rows[row]?.cells[target.columns.findIndex((column) => column.key === key)];
}

function transformationApplicabilityFixture(): ExportWorkbookInput {
  const base = fixture();
  const input = {
    kind: "ftl_lot" as const,
    lineNo: 1,
    lotId: line.lotId,
    tlc: null,
    quantity: null,
    unitOfMeasure: null,
    product: { id: line.productId, description: "Frozen apples | opaque" },
    source: { kind: "location" as const, description: "Saved grower" },
  };
  const nonFtl = {
    kind: "non_ftl" as const,
    lineNo: 2,
    quantity: "2",
    unitOfMeasure: "lb",
    reference: "Salt batch A",
    product: { id: line.productId, description: "Frozen salt | opaque" },
    source: { kind: "location" as const, description: "Saved salt supplier" },
  };
  return {
    ...base,
    events: [
      {
        type: "transformation",
        eventId,
        revision: 1,
        lifecycle: "current_finalized",
        timeZone: "America/Chicago",
        payload: {
          kind: "frozen",
          snapshot: {
            snapshotVersion: 1,
            eventDate: "2026-09-07",
            processor: { description: "Saved processor" },
            documents: [],
            inputs: [input, nonFtl],
            outputs: [{ ...input, tlc: "OUTPUT", quantity: "5", unitOfMeasure: "lb" }],
          },
        },
      },
    ],
  };
}

describe("US workbook model", () => {
  it.each(["5.00", "05", "-0"])(
    "retains noncanonical safe numeric lexeme %s as text with its own info finding",
    (quantity) => {
      const result = buildUsExportWorkbook(withLine({ quantity }));
      expect(cell(result.model, "Receiving", "quantity")).toEqual({
        kind: "text",
        value: quantity,
      });
      expect(result.findings.filter((finding) => finding.fieldKey === "quantity")).toEqual([
        {
          code: "NUMERIC_LEXEME_PRESERVED_AS_TEXT",
          severity: "info",
          sourceRecord,
          eventId,
          revision: 1,
          lineNo: 1,
          fieldKey: "quantity",
          message: "The exact numeric source spelling is retained as text to avoid normalization.",
        },
      ]);
      expect(result.model?.mode).toBe("export_ready_candidate");
    },
  );

  it("keeps canonical safe numeric text sortable without a quantity preservation finding", () => {
    const result = buildUsExportWorkbook(withLine({ quantity: "5" }));
    expect(cell(result.model, "Receiving", "quantity")).toEqual({
      kind: "number",
      value: 5,
      sourceValue: "5",
    });
    expect(result.findings.filter((finding) => finding.fieldKey === "quantity")).toEqual([]);
  });

  // Catches output-only KDE requirements leaking onto ingredient rows and missing-lot drafts being mistaken for non-FTL.
  it("requires only applicable FTL ingredient KDEs on a Transformation input", () => {
    const result = buildUsExportWorkbook(transformationApplicabilityFixture());
    const identity = `transformation:${eventId}:1:input:1`;
    const findings = result.findings.filter((finding) => finding.sourceRecord === identity);
    expect(findings.map((finding) => finding.fieldKey).sort()).toEqual([
      "product_name",
      "product_packaging_size_uom",
      "product_packaging_size_value",
      "product_packaging_style",
      "quantity",
      "tlc",
      "unit_of_measure",
    ]);
    expect(
      findings.every(
        (finding) =>
          finding.eventId === eventId &&
          finding.revision === 1 &&
          finding.lineNo === 1 &&
          finding.code === "REQUIRED_KDE_MISSING",
      ),
    ).toBe(true);
  });

  it("retains non-FTL ingredient facts without assigning FTL or output KDE findings", () => {
    const result = buildUsExportWorkbook(transformationApplicabilityFixture());
    expect(
      result.findings.filter(
        (finding) => finding.sourceRecord === `transformation:${eventId}:1:input:2`,
      ),
    ).toEqual([]);
    expect(sheet(result.model, "Transformation").rows).toHaveLength(3);
    expect(cell(result.model, "Transformation", "non_ftl_reference", 1)).toEqual({
      kind: "text",
      value: "Salt batch A",
    });
    expect(cell(result.model, "Transformation", "quantity", 1)).toEqual({
      kind: "number",
      value: 2,
      sourceValue: "2",
    });
    expect(cell(result.model, "Transformation", "tlc_source_description_original", 1)).toEqual({
      kind: "text",
      value: "Saved salt supplier",
    });
    expect(cell(result.model, "Transformation", "product_description_original", 1)).toEqual({
      kind: "text",
      value: "Frozen salt | opaque",
    });
  });

  it("keeps output location, source and reference-document requirements on Transformation outputs", () => {
    const result = buildUsExportWorkbook(transformationApplicabilityFixture());
    const identity = `transformation:${eventId}:1:output:1`;
    const findings = result.findings.filter((finding) => finding.sourceRecord === identity);
    expect(findings.map((finding) => finding.fieldKey)).toEqual(
      expect.arrayContaining([
        "transformation_location_business_name",
        "tlc_source_business_name",
        "reference_document_types",
        "reference_document_numbers",
      ]),
    );
    expect(
      findings.every(
        (finding) => finding.eventId === eventId && finding.revision === 1 && finding.lineNo === 1,
      ),
    ).toBe(true);
  });

  it.each(["unknown", undefined])(
    "never treats an unknown or absent ingredient kind as non-FTL",
    (kind) => {
      const input = transformationApplicabilityFixture();
      const event = at(input.events, 0);
      if (event.type !== "transformation" || event.payload.kind !== "frozen")
        throw new Error("Expected Transformation fixture");
      Object.assign(at(event.payload.snapshot.inputs, 1), { kind });
      const result = buildUsExportWorkbook(input);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          code: "REQUIRED_KDE_MISSING",
          fieldKey: "tlc",
          eventId,
          revision: 1,
          lineNo: 2,
          sourceRecord: `transformation:${eventId}:1:input:2`,
        }),
      );
    },
  );

  it("uses saved draft ingredient kind rather than missing lot ID to determine FTL applicability", () => {
    const base = fixture();
    const input: ExportInputV1 = {
      ...base,
      mode: "available_records_incomplete",
      metadata: { ...base.metadata, mode: "available_records_incomplete" },
      events: [
        {
          type: "transformation",
          eventId,
          revision: 1,
          lifecycle: "draft",
          timeZone: "America/Chicago",
          payload: {
            kind: "saved_draft",
            draft: {
              eventDate: null,
              processorLocationId: null,
              reason: null,
              reasonNote: null,
              notes: null,
              documentIds: [],
              inputs: [
                { kind: "ftl_lot", lotId: null, quantity: null, unitOfMeasure: null },
                {
                  kind: "non_ftl",
                  productId: line.productId,
                  sourceLocationId: null,
                  reference: "Salt batch A",
                  quantity: null,
                  unitOfMeasure: null,
                },
              ],
              outputs: [
                { productId: line.productId, tlc: "OUT", quantity: "1", unitOfMeasure: "lb" },
              ],
            },
          },
        },
      ],
    };
    const result = buildUsExportWorkbook(input);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_KDE_MISSING",
        fieldKey: "tlc",
        sourceRecord: `transformation:${eventId}:1:input:1`,
        eventId,
        revision: 1,
        lineNo: 1,
      }),
    );
    expect(
      result.findings.filter(
        (finding) => finding.sourceRecord === `transformation:${eventId}:1:input:2`,
      ),
    ).toEqual([]);
    expect(
      result.findings
        .filter((finding) => finding.fieldKey === "transformation_completed_date")
        .map((finding) => finding.sourceRecord),
    ).toEqual([`transformation:${eventId}:1:output:1`]);
  });

  // Catches dropped sheets/columns, blank definitions, missing frozen metadata and timezone substitution.
  it("builds a clean candidate with English registry columns, definitions and frozen metadata", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = buildUsExportWorkbook(input);
    expect(result.failure).toBeNull();
    expect(
      result.findings.map((finding) => [finding.fieldKey, finding.code, finding.severity]),
    ).toEqual([
      ["product_packaging_size_value", "NUMERIC_LEXEME_PRESERVED_AS_TEXT", "info"],
      ["quantity", "NUMERIC_LEXEME_PRESERVED_AS_TEXT", "info"],
    ]);
    expect(result.model?.mode).toBe("export_ready_candidate");
    expect(result.model?.sheets.map((value) => value.name)).toEqual([
      "Metadata",
      "Definitions",
      "Receiving",
      "Validation",
    ]);
    expect(sheet(result.model, "Receiving").columns.slice(0, 4)).toEqual([
      { key: "tlc", header: "Traceability lot code" },
      { key: "quantity", header: "Quantity" },
      { key: "unit_of_measure", header: "Unit of measure" },
      { key: "product_name", header: "Product name" },
    ]);
    // 3 lot/quantity + 8 product + 3*13 location + date + 3 documents + 9 provenance.
    expect(sheet(result.model, "Receiving").columns).toHaveLength(63);
    expect(sheet(result.model, "Definitions").rows).toHaveLength(63);
    expect(sheet(result.model, "Definitions").rows[0]?.cells.map((value) => value.value)).toEqual([
      "Receiving",
      "tlc",
      "Traceability lot code",
      "Lot",
      "yes",
      "text",
      "line.tlc",
      "21 CFR 1.1345; FDA Receiving!A1",
      "https://www.ecfr.gov/current/title-21/part-1/section-1.1345",
      1,
    ]);
    const metadata = Object.fromEntries(
      sheet(result.model, "Metadata").rows.map((row) => row.cells.map((value) => value.value)),
    );
    expect(metadata).toMatchObject({
      mode: "export_ready_candidate",
      requested_mode: "export_ready_candidate",
      tenant_id: "synthetic",
      profile: "US_FSMA204_PROCESSOR",
      scope_label: "Captured receipts",
      time_zone: "America/Chicago",
      generated_at: "2026-10-02T10:00:00.000Z",
      baseline_id: "US-REG-2026-09-03",
      registry_id: "fda_sortable_xlsx",
      registry_version: 1,
      registry_hash: traceExportRegistryHash(),
      api_version: "0.1.0",
      git_sha: "a".repeat(40),
      dirty: "true",
      input_schema_version: 1,
    });
    expect(cell(result.model, "Receiving", "event_timezone")).toEqual({
      kind: "text",
      value: "America/Los_Angeles",
    });
    expect(input).toEqual(before);
  });

  // Catches lost readable lines, lost readiness findings, wrong provenance and false complete verdicts.
  it("keeps missing KDE and unknown coverage findings linked to every readable source", () => {
    const base = fixture();
    const unknown = {
      code: "COVERAGE_UNKNOWN",
      severity: "error" as const,
      eventId,
      revision: 1,
      lineNo: 2,
      fieldKey: "coverage",
      sourceRecord: `receiving:${eventId}:1:item:2`,
      message: "Coverage is unknown.",
    };
    const result = buildUsExportWorkbook({
      ...base,
      mode: "available_records_incomplete",
      metadata: { ...base.metadata, mode: "available_records_incomplete" },
      findings: [unknown],
      events: [
        {
          ...at(base.events, 0),
          type: "receiving",
          payload: {
            kind: "frozen",
            snapshot: {
              ...snapshotV3,
              items: [
                line,
                {
                  ...line,
                  lineNo: 2,
                  productDescription: { ...line.productDescription, productName: "" },
                },
              ],
            },
          },
        },
      ],
    });
    expect(result.failure).toBeNull();
    expect(result.model?.mode).toBe("available_records_incomplete");
    expect(sheet(result.model, "Receiving").rows).toHaveLength(2);
    expect(result.findings).toContainEqual(unknown);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_KDE_MISSING",
        severity: "error",
        eventId,
        revision: 1,
        lineNo: 2,
        fieldKey: "product_name",
        sourceRecord: `receiving:${eventId}:1:item:2`,
      }),
    );
    const validation = sheet(result.model, "Validation");
    const gap = validation.rows.find((row) => row.cells[1]?.value === "REQUIRED_KDE_MISSING");
    expect(gap?.cells.map((value) => value.value).slice(0, 9)).toEqual([
      "error",
      "REQUIRED_KDE_MISSING",
      "Receiving",
      "product_name",
      eventId,
      1,
      2,
      line.lotId,
      `receiving:${eventId}:1:item:2`,
    ]);
  });

  it("downgrades a candidate with blocking findings but never upgrades explicit incomplete mode", () => {
    const missing = buildUsExportWorkbook(withLine({ unitOfMeasure: "" }));
    expect(missing.model?.mode).toBe("available_records_incomplete");
    const base = fixture();
    expect(
      buildUsExportWorkbook({
        ...base,
        mode: "available_records_incomplete",
        metadata: {
          ...base.metadata,
          mode: "available_records_incomplete",
        },
      }).model?.mode,
    ).toBe("available_records_incomplete");
  });

  it("accounts for empty saved drafts at event scope without inventing a quantity row", () => {
    const base = fixture();
    const result = buildUsExportWorkbook({
      ...base,
      mode: "available_records_incomplete",
      metadata: {
        ...base.metadata,
        mode: "available_records_incomplete",
      },
      events: [
        {
          type: "receiving",
          eventId,
          revision: 2,
          timeZone: "America/Los_Angeles",
          lifecycle: "draft",
          payload: {
            kind: "saved_draft",
            draft: { dateReceived: null, documentIds: [], items: [] },
          },
        },
      ],
    });
    expect(sheet(result.model, "Receiving").rows).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_RECORD_HAS_NO_LINES",
        severity: "error",
        sourceRecord: `receiving:${eventId}:2`,
        eventId,
        revision: 2,
      }),
    );
    expect(sheet(result.model, "Validation").rows.length).toBeGreaterThan(0);
  });

  it("does not infer split KDEs from opaque Transformation descriptions", () => {
    const base = fixture();
    const result = buildUsExportWorkbook({
      ...base,
      events: [
        {
          type: "transformation",
          eventId,
          revision: 1,
          lifecycle: "current_finalized",
          timeZone: "America/Chicago",
          payload: {
            kind: "frozen",
            snapshot: {
              snapshotVersion: 1,
              eventDate: "2026-09-07",
              documents: [{ id: "doc", type: "bol", number: "B-1" }],
              processor: { description: "Processor, 555 0000, 100 Way" },
              inputs: [],
              outputs: [
                {
                  lineNo: 1,
                  lotId: line.lotId,
                  tlc: "OUT",
                  product: { id: line.productId, description: "Apple, 25 lb case" },
                  source: { kind: "location", description: "Processor, 555 0000, 100 Way" },
                  quantity: "5",
                  unitOfMeasure: "lb",
                },
              ],
            },
          },
        },
      ],
    });
    expect(cell(result.model, "Transformation", "product_description_original")).toEqual({
      kind: "text",
      value: "Apple, 25 lb case",
    });
    expect(cell(result.model, "Transformation", "product_name")).toEqual({
      kind: "blank",
      value: null,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_KDE_MISSING",
        fieldKey: "product_name",
        eventId,
        revision: 1,
        lineNo: 1,
        sourceRecord: `transformation:${eventId}:1:output:1`,
      }),
    );
    expect(result.model?.mode).toBe("available_records_incomplete");
  });

  // Catches date conversion across timezones, silent rounding, formula interpretation and length truncation.
  it("matches the hand-checked semantic cell dump", () => {
    const result = buildUsExportWorkbook(fixture());
    expect(
      [
        "tlc",
        "quantity",
        "unit_of_measure",
        "product_gtin",
        "date_received",
        "event_revision",
        "source_record",
      ].map((key) => [key, cell(result.model, "Receiving", key)]),
    ).toEqual([
      ["tlc", { kind: "text", value: "=Case/Ä-001" }],
      ["quantity", { kind: "text", value: "500.000" }],
      ["unit_of_measure", { kind: "text", value: "lb" }],
      ["product_gtin", { kind: "text", value: "00000000000000" }],
      ["date_received", { kind: "date", value: "2026-09-07" }],
      ["event_revision", { kind: "number", value: 1, sourceValue: "1" }],
      ["source_record", { kind: "text", value: sourceRecord }],
    ]);
  });

  it.each(["=SUM(A1:A2)", "+1", "-2", "@payload", "  =BOL-0001  "])(
    "retains %s as explicit exact text",
    (tlc) => {
      expect(cell(buildUsExportWorkbook(withLine({ tlc })).model, "Receiving", "tlc")).toEqual({
        kind: "text",
        value: tlc,
      });
    },
  );

  it.each(["9007199254740993", "0.1234567890123456", "999999999999999.9"])(
    "preserves unsafe decimal %s as text plus info",
    (quantity) => {
      const result = buildUsExportWorkbook(withLine({ quantity }));
      expect(result.failure).toBeNull();
      expect(cell(result.model, "Receiving", "quantity")).toEqual({
        kind: "text",
        value: quantity,
      });
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          code: "NUMERIC_PRECISION_PRESERVED_AS_TEXT",
          severity: "info",
          sourceRecord,
          eventId,
          revision: 1,
          lineNo: 1,
          fieldKey: "quantity",
        }),
      );
    },
  );

  it("permits the cell limit but rejects 32768 characters without producing a partial model", () => {
    expect(
      cell(buildUsExportWorkbook(withLine({ tlc: "x".repeat(32767) })).model, "Receiving", "tlc")
        ?.value,
    ).toHaveLength(32767);
    const result = buildUsExportWorkbook(withLine({ tlc: "x".repeat(32768) }));
    expect(result.model).toBeNull();
    expect(result.failure).toEqual({ code: "CELL_LIMIT_EXCEEDED", sourceRecord, fieldKey: "tlc" });
  });

  it("applies cell safety to frozen metadata and existing findings too", () => {
    const input = fixture();
    expect(
      buildUsExportWorkbook({
        ...input,
        metadata: { ...input.metadata, scopeLabel: "x".repeat(32768) },
      }).failure,
    ).toEqual({ code: "CELL_LIMIT_EXCEEDED", sourceRecord: "metadata", fieldKey: "scope_label" });
    expect(
      buildUsExportWorkbook({
        ...input,
        findings: [
          { code: "UNKNOWN", severity: "error", sourceRecord, message: "x".repeat(32768) },
        ],
      }).failure,
    ).toEqual({ code: "CELL_LIMIT_EXCEEDED", sourceRecord, fieldKey: "message" });
  });

  it("fails unreadable sources and unsupported profiles as execution errors before returning a model", () => {
    const input = fixture();
    expect(() =>
      buildUsExportWorkbook({ ...input, metadata: { ...input.metadata, profile: "unsupported" } }),
    ).toThrow(ExportWorkbookInputError);
    const corrupt = { ...at(input.events, 0), payload: null };
    Object.assign(input, { events: [corrupt] });
    expect(() => buildUsExportWorkbook(input)).toThrow(
      expect.objectContaining({
        code: "INVALID_SOURCE_RECORD",
        sourceRecord: `receiving:${eventId}:1`,
      }),
    );
  });

  it("rejects missing source alternatives and missing parallel document values as findings", () => {
    const input = withLine({
      source: { kind: "location", locationId: "saved" },
      sourceDescription: {
        ...line.sourceDescription,
        businessName: "",
        phoneNumber: "",
      },
    });
    const result = buildUsExportWorkbook(input);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_KDE_MISSING",
        fieldKey: "tlc_source_business_name",
        sourceRecord,
      }),
    );
    const base = fixture();
    const draft = buildUsExportWorkbook({
      ...base,
      mode: "available_records_incomplete",
      metadata: {
        ...base.metadata,
        mode: "available_records_incomplete",
      },
      events: [
        {
          type: "receiving",
          eventId,
          revision: 2,
          timeZone: "America/Chicago",
          lifecycle: "draft",
          payload: {
            kind: "saved_draft",
            draft: {
              dateReceived: null,
              documentIds: ["doc"],
              items: [{ quantity: "1", unitOfMeasure: "lb", source: null }],
            },
          },
        },
      ],
    });
    expect(draft.findings).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_KDE_MISSING",
        fieldKey: "reference_document_numbers",
        eventId,
        revision: 2,
        lineNo: 1,
        sourceRecord: `receiving:${eventId}:2:item:1`,
      }),
    );
  });

  it("keeps model and findings deterministic when incomplete event input order changes", () => {
    const base = fixture();
    const first = withLine({ productDescription: { ...line.productDescription, productName: "" } });
    const second = { ...at(first.events, 0), eventId: "00000000-0000-4000-8000-000000000002" };
    const result = buildUsExportWorkbook({ ...base, events: [...first.events, second] });
    const reversed = buildUsExportWorkbook({ ...base, events: [second, ...first.events] });
    expect(reversed).toEqual(result);
  });

  it("preserves XML-invalid text by refusing the artifact rather than silently removing it", () => {
    const result = buildUsExportWorkbook(withLine({ tlc: "LOT\u0000A" }));
    expect(result.model).toBeNull();
    expect(result.failure).toEqual({
      code: "CELL_VALUE_UNREPRESENTABLE",
      sourceRecord,
      fieldKey: "tlc",
    });
  });

  it.each(["\ud800", "\ufffe", "\uffff"])(
    "rejects an unrepresentable Unicode source cell",
    (tlc) => {
      const result = buildUsExportWorkbook(withLine({ tlc }));
      expect(result.model).toBeNull();
      expect(result.failure).toEqual({
        code: "CELL_VALUE_UNREPRESENTABLE",
        sourceRecord,
        fieldKey: "tlc",
      });
    },
  );

  it("checks the numeric source lexeme length before a writer could discard it", () => {
    const result = buildUsExportWorkbook(withLine({ quantity: `0.${"0".repeat(32766)}` }));
    expect(result.model).toBeNull();
    expect(result.failure).toEqual({
      code: "CELL_LIMIT_EXCEEDED",
      sourceRecord,
      fieldKey: "quantity",
    });
  });

  it("preserves a subnormal decimal whose number conversion would change its value", () => {
    const quantity = `0.${"0".repeat(323)}7`;
    const result = buildUsExportWorkbook(withLine({ quantity }));
    expect(cell(result.model, "Receiving", "quantity")).toEqual({ kind: "text", value: quantity });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "NUMERIC_PRECISION_PRESERVED_AS_TEXT",
        fieldKey: "quantity",
        sourceRecord,
      }),
    );
  });

  it("rejects an unsupported snapshot version at its first source pin", () => {
    const input = fixture();
    const event = at(input.events, 0);
    if (event.payload.kind !== "frozen") throw new Error("Expected frozen fixture");
    const corrupt = {
      ...event,
      payload: { kind: "frozen", snapshot: { ...event.payload.snapshot, snapshotVersion: 999 } },
    };
    Object.assign(input, { events: [corrupt] });
    expect(() => buildUsExportWorkbook(input)).toThrow(
      expect.objectContaining({
        code: "INVALID_SOURCE_RECORD",
        sourceRecord: `receiving:${eventId}:1`,
      }),
    );
  });

  it("rejects dates outside the workbook calendar without shifting the captured civil day", () => {
    const base = fixture();
    const result = buildUsExportWorkbook({
      ...base,
      events: [
        {
          ...at(base.events, 0),
          type: "receiving",
          payload: {
            kind: "frozen",
            snapshot: { ...snapshotV3, dateReceived: "1899-12-31" },
          },
        },
      ],
    });
    expect(result.failure).toEqual({
      code: "CELL_VALUE_UNREPRESENTABLE",
      sourceRecord,
      fieldKey: "date_received",
    });
    expect(result.model).toBeNull();
  });
});
