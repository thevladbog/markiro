import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("receiving CSV preview schema", () => {
  it("exposes independent preview storage", () => {
    expect(schema).toHaveProperty("receivingCsvPreviews");
  });

  it("anchors preview identity to its tenant without creating a business reference", () => {
    const config = getTableConfig(schema.receivingCsvPreviews);
    expect(
      config.uniqueConstraints.map((key) => key.columns.map((column) => column.name)),
    ).toContainEqual(["tenant_id", "id"]);
    expect(config.foreignKeys.map((key) => key.reference().foreignTable)).toEqual([
      schema.organization,
    ]);
    expect(config.indexes.some((index) => index.config.unique)).toBe(false);
  });

  it("retains original bytes and untrusted JSON without erasing invalid previews", () => {
    const table = schema.receivingCsvPreviews;
    expect(table.fileBytes.getSQLType()).toBe("bytea");
    for (const column of [table.originalHeader, table.findings, table.proposedDraft])
      expect(column.getSQLType()).toBe("jsonb");
    expect(table.fileBytes.notNull).toBe(true);
    expect(table.originalHeader.notNull).toBe(true);
    expect(table.findings.notNull).toBe(true);
    expect(table.proposedDraft.notNull).toBe(false);
    expect(table.previewDigest.notNull).toBe(false);
    expect(table.createdAt.getSQLType()).toBe("timestamp with time zone");
    expect(table.expiresAt.getSQLType()).toBe("timestamp with time zone");
  });
});
