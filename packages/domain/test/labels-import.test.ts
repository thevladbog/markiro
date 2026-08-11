import { describe, expect, it } from "vitest";

import { LABEL_FIELDS, MAX_LABEL_CODE_BYTES } from "../src/index.js";
import {
  assertImportInputLimits,
  importedElementId,
  parseTemplatePayload,
} from "../src/labels/import.js";

describe("label code import contract", () => {
  it("exports one canonical ordered label-field inventory", () => {
    expect(LABEL_FIELDS).toEqual([
      "product.name",
      "product.gtin",
      "km.code",
      "sscc",
      "shift.no",
      "date",
      "qty",
      "operator",
      "counterparty.name",
    ]);
  });

  it("rejects source larger than 256 KiB before language parsing", () => {
    expect(() => assertImportInputLimits("X".repeat(MAX_LABEL_CODE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "LABEL_CODE_TOO_LARGE" }),
    );
  });

  it("recognizes only an exact known field placeholder", () => {
    expect(parseTemplatePayload("{{product.name}}", 7)).toEqual({
      kind: "field",
      field: "product.name",
    });
    expect(parseTemplatePayload("Партия", 8)).toEqual({ kind: "literal", value: "Партия" });
  });

  it("rejects unknown and mixed placeholders with a source location", () => {
    expect(() => parseTemplatePayload("{{warehouse.bin}}", 12)).toThrow(
      expect.objectContaining({ code: "LABEL_CODE_INVALID", cause: { line: 12, source: "{{warehouse.bin}}" } }),
    );
    expect(() => parseTemplatePayload("Товар: {{product.name}}", 13)).toThrow(
      expect.objectContaining({ code: "LABEL_CODE_INVALID", cause: { line: 13, source: "Товар: {{product.name}}" } }),
    );
  });

  it("creates stable ids from language and element order", () => {
    expect(importedElementId("zpl", 1)).toBe("import-zpl-1");
    expect(importedElementId("tspl", 2)).toBe("import-tspl-2");
  });
});
