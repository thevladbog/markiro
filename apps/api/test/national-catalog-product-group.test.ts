import { describe, expect, it } from "vitest";
import { resolveCatalogProductGroup } from "../src/modules/national-catalog/national-catalog-product-group";

describe("provider category group resolution", () => {
  it("uses the single common group of broad and narrow categories", () => {
    expect(
      resolveCatalogProductGroup(
        [{ id: 1 }, { id: 2 }],
        [
          { id: 1, active: true, gismtCodes: [7, 23] },
          { id: 2, active: true, gismtCodes: [23] },
          { id: 3, active: true, gismtCodes: [999] },
        ],
      ),
    ).toEqual({ code: 23, reason: null });
  });
  it.each([
    [[{ id: 1 }], [{ id: 1, active: true, gismtCodes: [7, 23] }], "product_group_ambiguous"],
    [
      [{ id: 1 }, { id: 2 }],
      [
        { id: 1, active: true, gismtCodes: [7] },
        { id: 2, active: true, gismtCodes: [23] },
      ],
      "product_group_ambiguous",
    ],
    [
      [{ id: 1 }, { id: 2 }],
      [{ id: 1, active: true, gismtCodes: [23] }],
      "product_group_unavailable",
    ],
    [
      [{ id: 1 }],
      [
        { id: 1, active: true, gismtCodes: [23] },
        { id: 1, active: true, gismtCodes: [7] },
      ],
      "product_group_unavailable",
    ],
    [[{ id: 1 }], [{ id: 1, active: false, gismtCodes: [23] }], "product_group_unavailable"],
    [[{ id: "1" }], [{ id: 1, active: true, gismtCodes: [23] }], "product_group_unavailable"],
  ])(
    "leaves ambiguous, incomplete or invalid evidence unresolved (%j)",
    (source, evidence, reason) => {
      expect(resolveCatalogProductGroup(source, evidence)).toEqual({ code: null, reason });
    },
  );
});
