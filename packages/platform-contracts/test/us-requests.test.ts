import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  usTraceRequestScopeV1Schema,
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestCloseBodySchema,
  usTraceRequestPrepareBodySchema,
} from "../src/index.js";

const uuid = "ffb61437-c01b-4cc9-b287-5667d03c7844";
const base = {
  requestNumber: "REQ-2026-APPLE-001",
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: null,
  receivedAt: "2026-09-17T16:00:00Z",
  scope: null,
};
function issue(schema: z.ZodType, value: unknown, path: PropertyKey[], code = "custom") {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path, code }));
}

describe("US trace request contracts", () => {
  it.each([
    ["receivedAt", "2026-01-01T00:00:00.123456Z"],
    ["dueAt", "2026-09-18T16:00:00.000001Z"],
    ["receivedAt", "2026-01-01T00:00:00.123001+05:30"],
    ["dueAt", "2026-09-18T16:00:00.1230001-07:00"],
  ])("rejects nonrepresentable %s in create and update without a server call", (field, instant) => {
    issue(usTraceRequestCreateBodySchema, { ...base, [field]: instant }, [field]);
    issue(usTraceRequestUpdateBodySchema, { expectedRevision: 1, [field]: instant }, [field]);
  });

  it("preserves exactly representable trailing-zero fractions in create and update", () => {
    const times = {
      receivedAt: "2026-01-01T00:00:00.123000Z",
      dueAt: "2026-01-02T05:30:00.123000+05:30",
    };
    expect(usTraceRequestCreateBodySchema.parse({ ...base, ...times })).toEqual({
      ...base,
      ...times,
    });
    expect(usTraceRequestUpdateBodySchema.parse({ expectedRevision: 1, ...times })).toEqual({
      expectedRevision: 1,
      ...times,
    });
  });

  it("preserves a shell and validates selectors without adding defaults", () => {
    expect(usTraceRequestCreateBodySchema.parse(base)).toEqual(base);
    expect(usTraceRequestScopeV1Schema.parse({ eventDateFrom: "2026-10-02" })).toEqual({
      eventDateFrom: "2026-10-02",
    });
    issue(usTraceRequestScopeV1Schema, {}, []);
    issue(usTraceRequestScopeV1Schema, { productId: undefined }, []);
    issue(
      usTraceRequestScopeV1Schema,
      { productId: "not-a-uuid" },
      ["productId"],
      "invalid_format",
    );
  });
  it.each([
    [{ tlcs: [] }, ["tlcs"], "too_small"],
    [{ tlcs: Array.from({ length: 51 }, (_, i) => `LOT-${i}`) }, ["tlcs"], "too_big"],
    [{ tlcs: ["LOT-A", "LOT-A"] }, ["tlcs"], "custom"],
    [{ tlcs: [" LOT-A"] }, ["tlcs", 0], "custom"],
    [{ locationIds: [] }, ["locationIds"], "too_small"],
    [{ locationIds: [uuid, uuid] }, ["locationIds"], "custom"],
    [{ locationIds: Array(51).fill(uuid) }, ["locationIds"], "too_big"],
    [{ tlcFrom: "Z", tlcTo: "A" }, ["tlcTo"], "custom"],
    [{ tlcFrom: "𐀀", tlcTo: "" }, ["tlcTo"], "custom"],
    [{ eventDateFrom: "2026-10-02", eventDateTo: "2026-10-01" }, ["eventDateTo"], "custom"],
    [{ eventDateFrom: "2026-02-30" }, ["eventDateFrom"], "custom"],
    [{ productText: "Apple\nLot" }, ["productText"], "custom"],
    [{ productText: " Apple" }, ["productText"], "custom"],
    [{ productText: "\ud800" }, ["productText"], "custom"],
    [{ sourceReferenceValue: "javascript:alert(1)" }, ["sourceReferenceValue"], "custom"],
  ])("rejects invalid scope %j at its exact field", (value, path, code) => {
    issue(usTraceRequestScopeV1Schema, value, path, code);
  });
  it("uses UTF-8 order and preserves valid selector text", () => {
    const scope = {
      tlcFrom: "",
      tlcTo: "𐀀",
      sourceReferenceValue: "https://example.com/source",
      tlcs: ["LOT-A", "LOT-B"],
      locationIds: [uuid],
    };
    expect(usTraceRequestScopeV1Schema.parse(scope)).toEqual(scope);
    expect(usTraceRequestScopeV1Schema.parse({ tlcFrom: "LOT-A", tlcTo: "LOT-A" })).toEqual({
      tlcFrom: "LOT-A",
      tlcTo: "LOT-A",
    });
  });
  it.each(["tenantId", "actorId", "provenance", "eventPins", "cursor", "limit"])(
    "rejects client-owned %s across strict boundaries",
    (key) => {
      issue(
        usTraceRequestScopeV1Schema,
        { tlc: "LOT-A", [key]: "forbidden" },
        [],
        "unrecognized_keys",
      );
      issue(
        usTraceRequestCreateBodySchema,
        { ...base, [key]: "forbidden" },
        [],
        "unrecognized_keys",
      );
      issue(
        usTraceRequestUpdateBodySchema,
        { expectedRevision: 1, requesterName: "Name", [key]: "forbidden" },
        [],
        "unrecognized_keys",
      );
      issue(
        usTraceRequestCloseBodySchema,
        { expectedRevision: 1, [key]: "forbidden" },
        [],
        "unrecognized_keys",
      );
      issue(
        usTraceRequestPrepareBodySchema,
        { mode: "export_ready", idempotencyKey: uuid, [key]: "forbidden" },
        [],
        "unrecognized_keys",
      );
    },
  );
  it.each(["", " ", " REQ", "REQ ", "REQ\t", "\ud800", "x".repeat(81)])(
    "rejects noncanonical request numbers %j",
    (requestNumber) => {
      const parsed = usTraceRequestCreateBodySchema.safeParse({ ...base, requestNumber });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.map((value) => value.path)).toContainEqual(["requestNumber"]);
    },
  );
  it("allows bounded values and leaves deadline policy to the command boundary", () => {
    expect(
      usTraceRequestCreateBodySchema.parse({
        ...base,
        requestNumber: "x".repeat(80),
        dueAt: "2026-09-16T16:00:00+03:00",
        alternateDeadlineReason: null,
      }).dueAt,
    ).toBe("2026-09-16T16:00:00+03:00");
    issue(
      usTraceRequestCreateBodySchema,
      { ...base, receivedAt: "2026-09-17" },
      ["receivedAt"],
      "invalid_format",
    );
    issue(
      usTraceRequestCreateBodySchema,
      { ...base, requesterContact: "x".repeat(501) },
      ["requesterContact"],
      "too_big",
    );
    issue(
      usTraceRequestCreateBodySchema,
      { ...base, alternateDeadlineReason: "x".repeat(2001) },
      ["alternateDeadlineReason"],
      "too_big",
    );
  });
  it("requires a changed update field and positive revision", () => {
    issue(usTraceRequestUpdateBodySchema, { expectedRevision: 2 }, []);
    issue(
      usTraceRequestUpdateBodySchema,
      { expectedRevision: 0, scope: null },
      ["expectedRevision"],
      "too_small",
    );
    expect(usTraceRequestUpdateBodySchema.parse({ expectedRevision: 2, scope: null })).toEqual({
      expectedRevision: 2,
      scope: null,
    });
    expect(usTraceRequestCloseBodySchema.parse({ expectedRevision: 2 })).toEqual({
      expectedRevision: 2,
    });
  });
  it("accepts only the two preparation modes with UUID idempotency", () => {
    for (const mode of ["export_ready", "available_records_incomplete"])
      expect(usTraceRequestPrepareBodySchema.parse({ mode, idempotencyKey: uuid })).toEqual({
        mode,
        idempotencyKey: uuid,
      });
    issue(
      usTraceRequestPrepareBodySchema,
      { mode: "complete", idempotencyKey: uuid },
      ["mode"],
      "invalid_value",
    );
    issue(
      usTraceRequestPrepareBodySchema,
      { mode: "export_ready", idempotencyKey: "bad" },
      ["idempotencyKey"],
      "invalid_format",
    );
  });
});
