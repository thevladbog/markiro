import { describe, expect, it } from "vitest";

import { inventoryDocumentFormatOpenApiSchema } from "../src/modules/inventories/inventory-document-formats.dto";

describe("inventory document formats OpenAPI MIME contract", () => {
  it("documents exactly the MIME values accepted by the strict domain descriptor", () => {
    const mimeType = inventoryDocumentFormatOpenApiSchema.properties?.mimeType;
    if (!mimeType || "$ref" in mimeType) throw new Error("Missing inline MIME schema");

    expect(mimeType.pattern).toBe("^[^\\s/;]+\\/[^\\s/;]+(?:; charset=[a-z0-9-]+)?$");

    const documented = new RegExp(mimeType.pattern!);
    expect(documented.test("text/csv; charset=utf-8")).toBe(true);
    expect(documented.test("application/xml")).toBe(true);
    expect(documented.test("text")).toBe(false);
    expect(documented.test("text/csv; boundary=unsafe")).toBe(false);
    expect(documented.test("text/csv\napplication/xml")).toBe(false);
  });
});
