import { expect, it } from "vitest";
import { transformationDraftSchema } from "../src/index.js";

const draft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [{ kind: "ftl_lot", lotId: null, quantity: null, unitOfMeasure: null }],
  outputs: [{ productId: null, tlc: null, quantity: null, unitOfMeasure: null }],
  documentIds: [],
};
it("accepts explicit incomplete fields and rejects numeric quantities and hidden output IDs", () => {
  expect(transformationDraftSchema.safeParse(draft).success).toBe(true);
  expect(
    transformationDraftSchema.safeParse({ ...draft, inputs: [{ ...draft.inputs[0], quantity: 1 }] })
      .success,
  ).toBe(false);
  expect(
    transformationDraftSchema.safeParse({
      ...draft,
      outputs: [{ ...draft.outputs[0], lotId: null }],
    }).success,
  ).toBe(false);
});
it("rejects duplicate non-null lot and document IDs but permits repeated null lots", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(
    transformationDraftSchema.safeParse({ ...draft, inputs: [draft.inputs[0], draft.inputs[0]] })
      .success,
  ).toBe(true);
  expect(
    transformationDraftSchema.safeParse({
      ...draft,
      inputs: [
        { ...draft.inputs[0], lotId: id },
        { ...draft.inputs[0], lotId: id },
      ],
    }).success,
  ).toBe(false);
  expect(transformationDraftSchema.safeParse({ ...draft, documentIds: [id, id] }).success).toBe(
    false,
  );
});
it("preserves opaque TLC characters", () => {
  expect(
    transformationDraftSchema.parse({
      ...draft,
      outputs: [{ ...draft.outputs[0], tlc: "À/lot:9" }],
    }).outputs[0]?.tlc,
  ).toBe("À/lot:9");
});
