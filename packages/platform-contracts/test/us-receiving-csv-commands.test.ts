import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const header = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
const preview = { templateVersion: "markiro-receiving-v1", fileBase64: "Zg==", header };
const apply = {
  operationKey: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  expectedPreviewDigest: "ab".repeat(32),
};

describe("Receiving CSV command inputs", () => {
  it("exports strict preview and confirmation boundaries", () => {
    expect(contracts).toHaveProperty("receivingCsvPreviewInputSchema");
    expect(contracts).toHaveProperty("receivingCsvApplyInputSchema");
  });
  it.each(["", "Zg==", "Zm8=", "Zm9v", "AAAA", "+/8="])(
    "accepts canonical base64 %j",
    (fileBase64) => {
      expect(contracts.receivingCsvPreviewInputSchema.parse({ ...preview, fileBase64 })).toEqual({
        ...preview,
        fileBase64,
      });
    },
  );
  it.each([
    "Zg",
    "Zg=",
    "Zg===",
    "Zh==",
    "Zm8",
    "Zm9=",
    "AA=A",
    "=AAA",
    "AAAA=",
    "AAAA====",
    "Zg==\n",
    " Zg==",
    "Z g==",
    "____",
    "----",
    "data:text/csv;base64,Zg==",
    "éAAA",
  ])("rejects noncanonical base64 %j", (fileBase64) => {
    expect(
      contracts.receivingCsvPreviewInputSchema.safeParse({ ...preview, fileBase64 }).success,
    ).toBe(false);
  });
  it("bounds decoded bytes, including same encoded length at the boundary", () => {
    const exact = Buffer.alloc(262144).toString("base64");
    expect(
      contracts.receivingCsvPreviewInputSchema.safeParse({ ...preview, fileBase64: exact }).success,
    ).toBe(true);
    for (const size of [262145, 262146, 262147]) {
      const fileBase64 = Buffer.alloc(size).toString("base64");
      expect(
        contracts.receivingCsvPreviewInputSchema.safeParse({ ...preview, fileBase64 }).success,
      ).toBe(false);
    }
  });
  it.each([
    { templateVersion: "v2" },
    { fileBase64: null },
    { fileBase64: 42 },
    { header: null },
    { actor: "owner" },
    { tenantId: "foreign" },
    { operationKey: apply.operationKey },
  ])("rejects malformed/injected preview input %j", (patch) => {
    expect(
      contracts.receivingCsvPreviewInputSchema.safeParse({ ...preview, ...patch }).success,
    ).toBe(false);
  });
  it.each(["templateVersion", "fileBase64", "header"])("requires %s", (key) => {
    const value: Record<string, unknown> = { ...preview };
    delete value[key];
    expect(contracts.receivingCsvPreviewInputSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { items: [] },
    { status: "finalized" },
    { tenantId: "other" },
    { dateReceived: "2026-02-30" },
    { documentIds: [apply.operationKey, apply.operationKey.toLowerCase()] },
  ])("reuses strict header rules %j", (patch) => {
    expect(
      contracts.receivingCsvPreviewInputSchema.safeParse({
        ...preview,
        header: { ...header, ...patch },
      }).success,
    ).toBe(false);
  });
  it("keeps nullable fields and existing header normalization", () => {
    expect(
      contracts.receivingCsvPreviewInputSchema.parse({
        ...preview,
        fileName: "supplier.csv",
        header: { ...header, notes: " note ", locationId: apply.operationKey },
      }),
    ).toMatchObject({
      header: {
        notes: "note",
        locationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dateReceived: null,
      },
      fileName: "supplier.csv",
    });
  });
  it.each(["", "x".repeat(201), "a\0.csv", "a\n.csv", "a\ud800.csv"])(
    "rejects unsafe filename metadata %j",
    (fileName) => {
      expect(
        contracts.receivingCsvPreviewInputSchema.safeParse({ ...preview, fileName }).success,
      ).toBe(false);
    },
  );
  it("normalizes the operation UUID without altering digest", () => {
    expect(contracts.receivingCsvApplyInputSchema.parse(apply)).toEqual({
      ...apply,
      operationKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });
  it.each([
    { operationKey: "bad" },
    { expectedPreviewDigest: "AB".repeat(32) },
    { expectedPreviewDigest: "a".repeat(63) },
    { expectedPreviewDigest: "g".repeat(64) },
    { previewId: apply.operationKey },
    { draft: {} },
    { tenantId: "other" },
    { actor: "owner" },
  ])("rejects invalid or server-owned apply data %j", (patch) => {
    expect(contracts.receivingCsvApplyInputSchema.safeParse({ ...apply, ...patch }).success).toBe(
      false,
    );
  });
  it.each(["operationKey", "expectedPreviewDigest"])("requires apply %s", (key) => {
    const value: Record<string, unknown> = { ...apply };
    delete value[key];
    expect(contracts.receivingCsvApplyInputSchema.safeParse(value).success).toBe(false);
  });
});
