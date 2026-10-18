import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  codeReleaseRecordSchema,
  DISAGGREGATION_CONSTRAINTS,
  DISAGGREGATION_MAX_LINES_PER_REQUEST,
  disaggregationCreateSchema,
  disaggregationDetailSchema,
  disaggregationDocumentSchema,
  disaggregationExportRecordSchema,
  disaggregationLineStatusSchema,
  disaggregationLinesAddSchema,
  disaggregationQuery,
  disaggregationReasonCreateSchema,
  disaggregationReasonSchema,
  disaggregationReasonUpdateSchema,
  disaggregationReportRowsSchema,
  disaggregationTransitionSchema,
  disaggregationUpdateSchema,
} from "../src/host/disaggregation.js";
import { changesResponseSchema, errorBodySchema } from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("disaggregation documents on the wire (plan ДЗГ)", () => {
  it("reads every fixture as the host writes it", () => {
    const cases = [
      [disaggregationDetailSchema, "disaggregation-detail.json"],
      [disaggregationDocumentSchema, "disaggregation-document.json"],
      [disaggregationReasonSchema, "disaggregation-reason.json"],
      [disaggregationReasonCreateSchema, "disaggregation-reason-create.json"],
      [disaggregationReasonUpdateSchema, "disaggregation-reason-update.json"],
      [disaggregationCreateSchema, "disaggregation-create.json"],
      [disaggregationUpdateSchema, "disaggregation-update.json"],
      [disaggregationLinesAddSchema, "disaggregation-lines-add.json"],
      [disaggregationTransitionSchema, "disaggregation-transition.json"],
    ] as const;
    for (const [schema, name] of cases) {
      expect(schema.parse(fixture(name)), name).toEqual(fixture(name));
    }
    const detail = disaggregationDetailSchema.parse(fixture("disaggregation-detail.json"));
    expect(detail.lines.map((line) => line.status)).toEqual([
      "ok",
      "shift_open",
      "already_disassembled",
      "duplicate",
      "not_found",
    ]);
  });

  it("reads a code release from the feed, keyed by its box", () => {
    const page = changesResponseSchema.parse(fixture("changes-code-releases.json"));
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item?.entity).toBe("code_releases");
    expect(item?.id).toBe("b0000000-0000-4000-8000-000000000001");
    expect(codeReleaseRecordSchema.parse(item?.data)).toEqual({
      shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      documentId: "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c",
      releasedAt: "2026-10-13T09:05:00Z",
      codeCount: 12,
    });
  });

  it("refuses a request past the limits or with an unknown field", () => {
    const line = { input: "MRK-000742", sscc: null };
    const many = Array.from({ length: DISAGGREGATION_MAX_LINES_PER_REQUEST + 1 }, () => line);
    expect(disaggregationLinesAddSchema.safeParse({ lines: many, import: false }).success).toBe(
      false,
    );
    expect(disaggregationLinesAddSchema.safeParse({ lines: [], import: false }).success).toBe(
      false,
    );
    expect(
      disaggregationLinesAddSchema.safeParse({
        lines: [{ ...line, boxId: "b0000000-0000-4000-8000-000000000001" }],
        import: false,
      }).success,
    ).toBe(false);
    expect(
      disaggregationLinesAddSchema.safeParse({
        lines: [{ input: "x", sscc: "04600682000001500" }],
        import: false,
      }).success,
    ).toBe(false);
    expect(disaggregationLineStatusSchema.safeParse("written_off").success).toBe(false);
  });

  it("names the constraint of the invalid-lines error", () => {
    const error = errorBodySchema.parse(fixture("error-disaggregation-invalid-lines.json"));
    expect(error.error.details?.["constraint"]).toBe("invalid_lines");
    expect(DISAGGREGATION_CONSTRAINTS).toContain(error.error.details?.["constraint"]);
  });

  it("builds the list's query in a fixed order", () => {
    expect(disaggregationQuery({ q: "0001", status: "draft" })).toBe("?status=draft&q=0001");
    expect(disaggregationQuery()).toBe("");
    expect(disaggregationQuery({ q: "" })).toBe("");
    expect(
      disaggregationQuery({
        to: "2026-10-14T00:00:00Z",
        from: "2026-10-13T00:00:00Z",
        reasonId: "d15a0000-0000-4000-8000-000000000003",
      }),
    ).toBe(
      "?reasonId=d15a0000-0000-4000-8000-000000000003&from=2026-10-13T00%3A00%3A00Z&to=2026-10-14T00%3A00%3A00Z",
    );
  });
});

describe("disaggregation act and file (plan ДЗГ-О)", () => {
  it("parses the host's rows of both variants", () => {
    const full = disaggregationReportRowsSchema.parse(
      fixture("disaggregation-report-rows-full.json"),
    );
    expect(full.lines.map((line) => line.items.length)).toEqual([2, 0]);
    expect(full.lines[1]?.boxes).toEqual([
      { sscc: "046007034967000024", units: 12 },
      { sscc: "046007034967000031", units: 12 },
    ]);
    expect(
      disaggregationReportRowsSchema.parse(fixture("disaggregation-report-rows-boxes.json"))
        .variant,
    ).toBe("boxes");
  });

  it("refuses an SSCC with its AI and a record of another format or an extra field", () => {
    const rows = disaggregationReportRowsSchema.parse(
      fixture("disaggregation-report-rows-boxes.json"),
    );
    const [first] = rows.lines;
    expect(first).toBeDefined();
    if (first === undefined) return;
    const changed = disaggregationReportRowsSchema.safeParse({
      ...rows,
      lines: [{ ...first, sscc: `00${first.sscc}` }],
    });
    expect(changed.success).toBe(false);
    const record = disaggregationExportRecordSchema.parse(
      fixture("disaggregation-export-record.json"),
    );
    expect(
      disaggregationExportRecordSchema.safeParse({
        ...record,
        formatId: "shift_xml_gismt_aggregation",
      }).success,
    ).toBe(false);
    expect(
      disaggregationExportRecordSchema.safeParse({ ...record, fileName: "x.xml" }).success,
    ).toBe(false);
  });

  it("names the restore hold as a constraint of a conflict", () => {
    const error = errorBodySchema.parse(fixture("error-disaggregation-restore-hold.json"));
    expect(DISAGGREGATION_CONSTRAINTS).toContain(error.error.details?.["constraint"]);
    expect(error.error.details?.["constraint"]).toBe("restore_hold");
  });
});
