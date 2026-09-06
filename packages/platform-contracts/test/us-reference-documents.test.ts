import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const input = {
  type: "bol",
  typeOtherLabel: null,
  number: "=0001",
  partyId: null,
  issuedOn: "2026-09-14",
  notes: "Line one\nLine two",
};
const row = {
  ...input,
  id: "00000000-0000-4000-8000-000000000001",
  archivedAt: null,
  createdBy: "historical-user",
  createdAt: "2026-09-06T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
};

describe("reference document persistence boundary", () => {
  it("preserves a stored record without input transformations", () => {
    const stored = { ...row, number: " =0001 ", notes: "  Original\ntext  " };
    expect(contracts.referenceDocumentSchema.parse(stored)).toEqual(stored);
  });
  it.each([
    { id: "bad" },
    { createdBy: "" },
    { createdAt: "2026-09-06" },
    { archivedAt: "bad" },
    { issuedOn: "2026-02-29" },
    { type: "other" },
    { typeOtherLabel: "unexpected" },
    { tenantId: "foreign" },
    { attachmentObjectKey: "private" },
    { snapshotVersion: 1 },
  ])("rejects malformed or overbroad records %j", (patch) => {
    expect(contracts.referenceDocumentSchema.safeParse({ ...row, ...patch }).success).toBe(false);
  });
  it("uses bounded filters and rejects forged query scope", () => {
    expect(contracts.listReferenceDocumentsQuerySchema.parse({})).toEqual({
      archived: "false",
      limit: 50,
      offset: 0,
    });
    expect(
      contracts.listReferenceDocumentsQuerySchema.parse({
        search: " =0001 ",
        type: "bol",
        partyId: row.id,
        archived: "all",
        limit: "2",
        offset: "1",
      }),
    ).toEqual({
      search: "=0001",
      type: "bol",
      partyId: row.id,
      archived: "all",
      limit: 2,
      offset: 1,
    });
    for (const query of [
      { limit: "101" },
      { offset: "100001" },
      { partyId: "bad" },
      { type: "unknown" },
      { tenantId: "foreign" },
      { search: "x".repeat(201) },
    ])
      expect(contracts.listReferenceDocumentsQuerySchema.safeParse(query).success).toBe(false);
  });
  it("rejects truncated or inconsistent page metadata", () => {
    expect(
      contracts.referenceDocumentListSchema.parse({ items: [row], limit: 1, offset: 0 }).items,
    ).toEqual([row]);
    expect(
      contracts.referenceDocumentListSchema.safeParse({ items: [row, row], limit: 1, offset: 0 })
        .success,
    ).toBe(false);
    expect(
      contracts.referenceDocumentListSchema.safeParse({
        items: [],
        limit: 1,
        offset: 0,
        tenantId: "foreign",
      }).success,
    ).toBe(false);
  });
  it.each(["x\u0000y", "x\ud800y", "x\udfffy"])(
    "rejects search text PostgreSQL cannot preserve %j",
    (search) => {
      expect(contracts.listReferenceDocumentsQuerySchema.safeParse({ search }).success).toBe(false);
    },
  );
  it.each(["x\u0000y", "x\ud800y", "x\udfffy"])(
    "rejects notes PostgreSQL cannot preserve %j",
    (notes) => {
      expect(contracts.referenceDocumentInputSchema.safeParse({ ...input, notes }).success).toBe(
        false,
      );
      expect(
        contracts.referenceDocumentSnapshotSchema.safeParse({
          ...input,
          notes,
          snapshotVersion: 1,
          documentId: row.id,
        }).success,
      ).toBe(false);
    },
  );
});
