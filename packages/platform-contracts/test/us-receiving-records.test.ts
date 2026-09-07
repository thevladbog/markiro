import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const id = "abcdefab-0000-4000-8000-000000000001";
const draft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};
const record = {
  id,
  eventNumber: "REC-26-0001",
  status: "draft",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:00:00.000Z",
  draft,
};
const summary = {
  id,
  eventNumber: "REC-26-0001",
  status: "draft",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:00:00.000Z",
  dateReceived: "2026-09-06",
  locationId: null,
  previousSourceLocationId: null,
  lineCount: 1,
  documentCount: 1,
};

describe("receiving persistence contracts", () => {
  it("requires explicit operation keys and independent optimistic draft versions", () => {
    expect(
      contracts.createReceivingDraftSchema.parse({ operationKey: id.toUpperCase(), draft }),
    ).toEqual({ operationKey: id, draft });
    expect(
      contracts.saveReceivingDraftSchema.parse({
        operationKey: id,
        expectedDraftVersion: 1,
        draft,
      }),
    ).toEqual({ operationKey: id, expectedDraftVersion: 1, draft });
    for (const input of [
      { draft },
      { operationKey: "bad", draft },
      { operationKey: id, draft, tenantId: "forged" },
    ]) {
      expect(contracts.createReceivingDraftSchema.safeParse(input).success).toBe(false);
    }
    for (const expectedDraftVersion of [undefined, 0, -1, 1.5, "1", 2147483647]) {
      expect(
        contracts.saveReceivingDraftSchema.safeParse({
          operationKey: id,
          draft,
          expectedDraftVersion,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only draft lifecycle and separates record revision from saves", () => {
    expect(contracts.receivingDraftRecordSchema.parse(record)).toEqual(record);
    for (const change of [
      { status: "finalized" },
      { revision: 2 },
      { draftVersion: 0 },
      { timeZone: "+03:00" },
      { tenantId: "forged" },
    ]) {
      expect(contracts.receivingDraftRecordSchema.safeParse({ ...record, ...change }).success).toBe(
        false,
      );
    }
  });

  it("does not silently trim or normalize persisted identifiers and text", () => {
    const saved = {
      ...record,
      draft: { ...draft, notes: "  historical note  ", locationId: id.toUpperCase() },
    };
    expect(contracts.receivingDraftRecordSchema.parse(saved)).toEqual(saved);
    expect(
      contracts.receivingDraftRecordSchema.safeParse({
        ...record,
        draft: { ...draft, notes: "bad\u0000value" },
      }).success,
    ).toBe(false);
  });

  it.each(["bad\u0000value", "bad\ud800value"])(
    "rejects text PostgreSQL cannot preserve: %j",
    (notes) => {
      expect(
        contracts.createReceivingDraftSchema.safeParse({
          operationKey: id,
          draft: { ...draft, notes },
        }).success,
      ).toBe(false);
    },
  );

  it("normalizes only canonical receiving-list query values", () => {
    expect(contracts.listReceivingDraftsQuerySchema.parse({})).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(
      contracts.listReceivingDraftsQuerySchema.parse({
        search: "  REC-26-00%_  ",
        limit: "100",
        offset: "100000",
      }),
    ).toEqual({ search: "REC-26-00%_", limit: 100, offset: 100000 });
    for (const query of [
      { unknown: "value" },
      { search: `REC-${"x".repeat(197)}` },
      { search: "bad\u0000value" },
      { search: "bad\ud800value" },
      { limit: "01" },
      { limit: "+1" },
      { limit: "1.0" },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 100001 },
    ]) {
      expect(contracts.listReceivingDraftsQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("exposes bounded draft summaries without full draft contents", () => {
    expect(contracts.receivingDraftSummarySchema.parse(summary)).toEqual(summary);
    expect(
      contracts.receivingDraftListSchema.parse({ items: [summary], limit: 1, offset: 0 }),
    ).toEqual({ items: [summary], limit: 1, offset: 0 });
    for (const invalidSummary of [
      { ...summary, notes: "must stay private" },
      { ...summary, lineCount: -1 },
      { ...summary, lineCount: 101 },
      { ...summary, documentCount: 101 },
      { ...summary, status: "finalized" },
      { ...summary, revision: 2 },
    ]) {
      expect(contracts.receivingDraftSummarySchema.safeParse(invalidSummary).success).toBe(false);
    }
    expect(
      contracts.receivingDraftListSchema.safeParse({
        items: [summary, { ...summary, id: "abcdefab-0000-4000-8000-000000000002" }],
        limit: 1,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});
