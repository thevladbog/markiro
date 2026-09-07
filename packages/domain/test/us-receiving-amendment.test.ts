import { describe, expect, it } from "vitest";
import {
  classifyReceivingAmendment,
  type ReceivingMaterialLine,
  type ReceivingMaterialRevision,
} from "../src/index.js";

function line(patch: Partial<ReceivingMaterialLine> = {}): ReceivingMaterialLine {
  return {
    lineNo: 1,
    previousLineNo: null,
    productId: "apple",
    lotId: "lot-a",
    lotLinkMode: "create_on_finalize",
    effectiveTlc: "=Case/Ä-001",
    source: {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Case/A",
      resolvedLocationId: "source",
    },
    receiptHandling: "ordinary",
    quantity: "500.000",
    unitOfMeasure: "lb",
    ...patch,
  };
}
function revision(lines: ReceivingMaterialLine[]): ReceivingMaterialRevision {
  return {
    dateReceived: "2026-09-07",
    locationId: "dock",
    previousSourceLocationId: "supplier",
    lines,
  };
}
const documentary = {
  kind: "documentary",
  affectedLotIds: [],
  removedPreviousLineNos: [],
  identityLockedLineNos: [],
  invalidBindingLineNos: [],
};

describe("Receiving amendment effects", () => {
  it.each(["ordinary", "exempt_existing_tlc", "exempt_assigned_tlc"] as const)(
    "preserves %s identity through reordering and source property order",
    (receiptHandling) => {
      const first = line({ receiptHandling });
      const second = line({
        lineNo: 2,
        lotId: "lot-b",
        effectiveTlc: "B",
        lotLinkMode: "link_existing",
      });
      const original = revision([first, second]);
      const candidate = revision([
        { ...second, lineNo: 1, previousLineNo: 2 },
        {
          ...first,
          lineNo: 2,
          previousLineNo: 1,
          source: {
            resolvedLocationId: "source",
            referenceValue: "https://supplier.example.test/Case/A",
            referenceKind: "web_url",
            kind: "reference",
          },
        },
      ]);
      const before = structuredClone({ original, candidate });
      expect(classifyReceivingAmendment(original, candidate)).toEqual(documentary);
      expect({ original, candidate }).toEqual(before);
    },
  );

  it.each([
    { lotId: "lot-b" },
    { productId: "pear" },
    { effectiveTlc: "=case/Ä-001" },
    { lotLinkMode: "link_existing" },
    { receiptHandling: "exempt_existing_tlc" },
    { source: null },
    { source: { kind: "location", locationId: "source" } },
    {
      source: {
        kind: "reference",
        referenceKind: "web_url",
        referenceValue: "https://supplier.example.test/case/A",
        resolvedLocationId: "source",
      },
    },
    {
      source: {
        kind: "reference",
        referenceKind: "web_url",
        referenceValue: "https://supplier.example.test/Case/A",
        resolvedLocationId: "other",
      },
    },
  ] satisfies Partial<ReceivingMaterialLine>[])(
    "locks bound identity even without downstream consumers %#",
    (patch) => {
      expect(
        classifyReceivingAmendment(
          revision([line()]),
          revision([line({ previousLineNo: 1, ...patch })]),
        ),
      ).toEqual({
        ...documentary,
        kind: "material",
        affectedLotIds: patch.lotId === "lot-b" ? ["lot-a", "lot-b"] : ["lot-a"],
        identityLockedLineNos: [1],
      });
    },
  );

  it("does not convert retained own assignment to preserved supplier TLC with the same identity", () => {
    expect(
      classifyReceivingAmendment(
        revision([line({ receiptHandling: "exempt_assigned_tlc" })]),
        revision([line({ previousLineNo: 1, receiptHandling: "exempt_existing_tlc" })]),
      ).identityLockedLineNos,
    ).toEqual([1]);
  });

  it.each([
    { quantity: "500" },
    { quantity: "499.999" },
    { unitOfMeasure: "kg" },
    { quantity: null },
  ] satisfies Partial<ReceivingMaterialLine>[])(
    "treats exact quantity/UOM changes as material without rounding %#",
    (patch) => {
      const second = line({ lineNo: 2, lotId: "lot-b" });
      expect(
        classifyReceivingAmendment(
          revision([line(), second]),
          revision([line({ previousLineNo: 1, ...patch }), { ...second, previousLineNo: 2 }]),
        ),
      ).toEqual({ ...documentary, kind: "material", affectedLotIds: ["lot-a"] });
    },
  );

  it.each([
    { dateReceived: "2026-09-06" },
    { locationId: "dock-2" },
    { previousSourceLocationId: null },
  ])("affects all old/new lots on a header change %#", (patch) => {
    expect(
      classifyReceivingAmendment(revision([line()]), {
        ...revision([line({ previousLineNo: 1 }), line({ lineNo: 2, lotId: "lot-b" })]),
        ...patch,
      }),
    ).toEqual({ ...documentary, kind: "material", affectedLotIds: ["lot-a", "lot-b"] });
  });

  it("reports added and removed lots once, preserving separate old line identities", () => {
    expect(
      classifyReceivingAmendment(
        revision([line(), line({ lineNo: 2 }), line({ lineNo: 3, lotId: "lot-z" })]),
        revision([line({ previousLineNo: 2 }), line({ lineNo: 2, lotId: "lot-b" })]),
      ),
    ).toEqual({
      ...documentary,
      kind: "material",
      affectedLotIds: ["lot-a", "lot-b", "lot-z"],
      removedPreviousLineNos: [1, 3],
    });
  });

  it("classifies a new incomplete create line as material even before it has a lot ID", () => {
    expect(
      classifyReceivingAmendment(
        revision([line()]),
        revision([
          line({ previousLineNo: 1 }),
          line({
            lineNo: 2,
            productId: null,
            lotId: null,
            effectiveTlc: null,
            source: null,
            quantity: null,
            unitOfMeasure: null,
          }),
        ]),
      ),
    ).toEqual({ ...documentary, kind: "material" });
  });

  it("uses immediate predecessor line numbers, not its older binding or the array position", () => {
    expect(
      classifyReceivingAmendment(
        revision([line({ previousLineNo: 9 }), line({ lineNo: 2, previousLineNo: 8 })]),
        revision([line({ previousLineNo: 2 }), line({ lineNo: 2, previousLineNo: 1 })]),
      ),
    ).toEqual(documentary);
  });

  it.each([0, -1, 1.5, 3, 101])(
    "fails closed for nonexistent/invalid predecessor binding %s",
    (previousLineNo) => {
      const result = classifyReceivingAmendment(
        revision([line()]),
        revision([line({ previousLineNo })]),
      );
      expect(result).toEqual({
        ...documentary,
        kind: "material",
        affectedLotIds: ["lot-a"],
        removedPreviousLineNos: [1],
        invalidBindingLineNos: [1],
      });
    },
  );

  it("marks every duplicate binding rather than silently accepting the first", () => {
    expect(
      classifyReceivingAmendment(
        revision([line()]),
        revision([line({ previousLineNo: 1 }), line({ lineNo: 2, previousLineNo: 1 })]),
      ),
    ).toEqual({
      ...documentary,
      kind: "material",
      affectedLotIds: ["lot-a"],
      invalidBindingLineNos: [1, 2],
    });
  });

  it("distinguishes location sources and does not normalize a retained reference", () => {
    expect(
      classifyReceivingAmendment(
        revision([line({ source: { kind: "location", locationId: "dock" } })]),
        revision([line({ previousLineNo: 1, source: { kind: "location", locationId: "other" } })]),
      ).identityLockedLineNos,
    ).toEqual([1]);
  });
});
