import { describe, expect, it } from "vitest";

import { schema } from "../src/index.js";
import { productMirror } from "../src/sqlite/schema.js";

describe("shared catalog persistence for the US edition", () => {
  it("allows a catalog product to omit GTIN while tracking future updates", () => {
    expect(schema.products.gtin14.notNull).toBe(false);
    expect(schema.products.updatedAt).toMatchObject({ hasDefault: true, notNull: true });
  });

  it("keeps the offline Station product mirror GTIN mandatory", () => {
    expect(productMirror.gtin14.notNull).toBe(true);
  });
});
