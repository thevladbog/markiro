import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("reference document tenant anchors", () => {
  it("anchors the issuer to the same tenant and supports future event links", () => {
    const config = getTableConfig(schema.referenceDocuments);
    const reference = config.foreignKeys
      .find((key) => key.getName() === "reference_documents_party_fk")
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual(["tenant_id", "party_id"]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    expect(reference?.foreignTable).toBe(schema.traceabilityParties);
    expect(
      config.uniqueConstraints.some(
        (key) => key.columns.map((column) => column.name).join(",") === "tenant_id,id",
      ),
    ).toBe(true);
    expect(schema.referenceDocuments.partyId.notNull).toBe(false);
    expect(schema.referenceDocuments.issuedOn.getSQLType()).toBe("date");
  });
});
