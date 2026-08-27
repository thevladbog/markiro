import { describe, expect, it } from "vitest";

import {
  inventoryDocumentArtifactOpenApiSchema,
  inventoryDocumentArtifactResponseSchema,
} from "../src/modules/inventories/dto";

const artifact = {
  id: "50000000-0000-4000-8000-000000000001",
  formatId: "inventory_txt_write_off",
  formatVersion: 1,
  partNumber: 1,
  filename: "inventory-INV-1-write-off.txt",
  mimeType: "text/plain; charset=utf-8",
  rowCount: 0,
  codeCount: 0,
  boxCount: 0,
  byteSize: 0,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  downloadedAt: null,
  invalidatedAt: null,
};

describe("inventory document artifact byte-size contract", () => {
  it("documents and parses zero bytes while rejecting negative sizes", () => {
    const byteSize = inventoryDocumentArtifactOpenApiSchema.properties?.byteSize;
    if (!byteSize || "$ref" in byteSize) throw new Error("Missing inline byteSize schema");

    expect(byteSize.minimum).toBe(0);
    expect(inventoryDocumentArtifactResponseSchema.parse(artifact).byteSize).toBe(0);
    expect(() =>
      inventoryDocumentArtifactResponseSchema.parse({ ...artifact, byteSize: -1 }),
    ).toThrow();
  });
});
