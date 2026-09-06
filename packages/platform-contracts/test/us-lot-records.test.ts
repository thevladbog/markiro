import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
const productId = "00000000-0000-4000-8000-000000000118";
const locationId = "00000000-0000-4000-8000-000000000119";
const reference = {
  kind: "reference",
  referenceKind: "web_url",
  referenceValue: "https://supplier.example.test/Source/A",
  resolvedLocationId: locationId,
};
const record = {
  id: productId,
  productId,
  tlc: "A-1",
  source: reference,
  sourceLockedAt: null,
  assignmentBasis: "imported",
  status: "active",
  revision: 1,
  createdBy: "historical-actor",
  updatedBy: "historical-actor",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
describe("lot record boundaries", () => {
  it("accepts only source, reason and revision for source corrections", () => {
    const body = { source: reference, reason: "  Correct supplier site  ", expectedRevision: 1 };
    expect(contracts.patchLotSourceSchema.parse(body)).toEqual({
      ...body,
      reason: "Correct supplier site",
    });
    expect(contracts.patchLotSourceSchema.parse({ ...body, source: null }).source).toBeNull();
    for (const extra of [
      { productId },
      { tlc: "NEW" },
      { assignmentBasis: "transformation" },
      { sourceLockedAt: null },
      { tenantId: "forged" },
      { reason: " " },
      { expectedRevision: undefined },
      { expectedRevision: 0 },
      { source: undefined },
    ])
      expect(contracts.patchLotSourceSchema.safeParse({ ...body, ...extra }).success).toBe(false);
  });
  it("requires an explicit persisted source lock state and preserves its timestamp", () => {
    const locked = { ...record, sourceLockedAt: "2026-09-06T00:00:00.000Z" };
    expect(contracts.traceabilityLotSchema.parse(locked)).toEqual(locked);
    expect(
      contracts.traceabilityLotSchema.safeParse({ ...record, sourceLockedAt: undefined }).success,
    ).toBe(false);
    expect(
      contracts.traceabilityLotSchema.safeParse({ ...record, sourceLockedAt: "bad" }).success,
    ).toBe(false);
  });
  it("preserves the exact reference including a mixed-case HTTP scheme", () => {
    const source = { ...reference, referenceValue: "HtTpS://Supplier.example.test/Source/A" };
    expect(
      contracts.createTraceabilityLotSchema.parse({ productId, tlc: "A-1", source }).source,
    ).toEqual(source);
    expect(contracts.traceabilityLotSchema.parse({ ...record, source }).source).toEqual(source);
  });
  it.each([null, { kind: "location", locationId }, reference])(
    "accepts an explicit source shape without claiming completeness %j",
    (source) => {
      expect(
        contracts.createTraceabilityLotSchema.parse({ productId, tlc: " =APPLE-01 ", source }),
      ).toEqual({ productId, tlc: "=APPLE-01", source, assignmentBasis: "imported" });
    },
  );
  it.each([
    {},
    { kind: "location", locationId: "bad" },
    { kind: "reference", referenceValue: "free text" },
    { ...reference, referenceKind: "gln" },
    { ...reference, resolvedLocationId: null },
    { ...reference, locationId },
    { ...reference, referenceValue: "https://user:pass@example.test" },
  ])("rejects ambiguous or invalid source %j", (source) => {
    expect(
      contracts.createTraceabilityLotSchema.safeParse({ productId, tlc: "A", source }).success,
    ).toBe(false);
  });
  it.each([
    { tenantId: "forged" },
    { createdBy: "forged" },
    { status: "active" },
    { originEventId: productId },
    { revision: 1 },
  ])("refuses forged create metadata %j", (extra) => {
    expect(
      contracts.createTraceabilityLotSchema.safeParse({
        productId,
        tlc: "A",
        source: null,
        ...extra,
      }).success,
    ).toBe(false);
  });
  it("keeps persisted records lossless and rejects invalid revisions/metadata", () => {
    expect(contracts.traceabilityLotSchema.parse(record)).toEqual(record);
    for (const patch of [
      { tlc: " A-1 " },
      { revision: 0 },
      { revision: 2147483648 },
      { createdBy: " " },
      { createdAt: "bad" },
      { status: "draft" },
      { tenantId: "forged" },
    ]) {
      expect(contracts.traceabilityLotSchema.safeParse({ ...record, ...patch }).success).toBe(
        false,
      );
    }
  });
  it("requires a revision for status writes and refuses system context", () => {
    const body = { status: "recalled", reason: "QA reviewed", expectedRevision: 1 };
    expect(contracts.postLotStatusSchema.parse(body)).toEqual(body);
    for (const patch of [
      { expectedRevision: undefined },
      { expectedRevision: 0 },
      { expectedRevision: 2147483647 },
      { context: "system:shipping_recalculation" },
    ])
      expect(contracts.postLotStatusSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
  it("validates bounded filters and list output without implicit coercion or truncation", () => {
    expect(
      contracts.listTraceabilityLotsQuerySchema.parse({
        tlc: "A-1",
        limit: "1",
        offset: "0",
        sourceLocationId: locationId,
      }),
    ).toEqual({ tlc: "A-1", limit: 1, offset: 0, sourceLocationId: locationId });
    for (const query of [
      { limit: "01" },
      { limit: 101 },
      { offset: -1 },
      { productId: "bad" },
      { status: "draft" },
      { tenantId: "forged" },
    ])
      expect(contracts.listTraceabilityLotsQuerySchema.safeParse(query).success).toBe(false);
    expect(
      contracts.traceabilityLotListSchema.safeParse({
        items: [record, record],
        limit: 1,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});
