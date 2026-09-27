import { describe, expect, it } from "vitest";
import { classifyTransformationChange, sameTransformationOutputIdentity } from "../src/index.js";
import type { TransformationDraftValue } from "../src/index.js";

const prior: TransformationDraftValue = {
  eventDate: "2026-09-26",
  processorLocationId: "processor",
  reason: "repacking",
  reasonNote: null,
  notes: null,
  inputs: [{ kind: "ftl_lot", lotId: "input-a", quantity: "5", unitOfMeasure: "lb" }],
  outputs: [{ productId: "product-a", tlc: "TLC-A", quantity: "2", unitOfMeasure: "case" }],
  documentIds: ["document-a"],
};

describe("Transformation revision comparison", () => {
  it("classifies reason, note, and document corrections as documentary", () => {
    expect(classifyTransformationChange(prior, { ...prior, reason: "processing" })).toBe(
      "documentary",
    );
    expect(classifyTransformationChange(prior, { ...prior, notes: "corrected" })).toBe(
      "documentary",
    );
    expect(classifyTransformationChange(prior, { ...prior, documentIds: ["document-b"] })).toBe(
      "documentary",
    );
  });

  it.each([
    ["event date", { eventDate: "2026-09-27" }],
    ["processor", { processorLocationId: "other-processor" }],
    [
      "input lot",
      {
        inputs: [
          {
            kind: "ftl_lot" as const,
            lotId: "input-b",
            quantity: "5",
            unitOfMeasure: "lb" as const,
          },
        ],
      },
    ],
    [
      "input quantity",
      {
        inputs: [
          {
            kind: "ftl_lot" as const,
            lotId: "input-a",
            quantity: "6",
            unitOfMeasure: "lb" as const,
          },
        ],
      },
    ],
    [
      "input unit",
      {
        inputs: [
          {
            kind: "ftl_lot" as const,
            lotId: "input-a",
            quantity: "5",
            unitOfMeasure: "kg" as const,
          },
        ],
      },
    ],
    ["output quantity", { outputs: [{ ...prior.outputs[0]!, quantity: "3" }] }],
    ["output unit", { outputs: [{ ...prior.outputs[0]!, unitOfMeasure: "each" as const }] }],
  ])("classifies %s edits as material", (_name, change) => {
    expect(classifyTransformationChange(prior, { ...prior, ...change })).toBe("material");
  });

  it("compares output identity by stable line number", () => {
    const two = [
      { ...prior.outputs[0]!, productId: "product-a", tlc: "TLC-A" },
      { ...prior.outputs[0]!, productId: "product-b", tlc: "TLC-B" },
    ];
    expect(sameTransformationOutputIdentity(two, [two[1]!, two[0]!])).toBe(false);
    expect(sameTransformationOutputIdentity(two, [two[0]!])).toBe(false);
    expect(
      sameTransformationOutputIdentity(
        two,
        two.map((line) => ({ ...line, quantity: "9" })),
      ),
    ).toBe(true);
    expect(sameTransformationOutputIdentity([two[0]!, two[0]!], [two[0]!, two[0]!])).toBe(true);
  });
});
