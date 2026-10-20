import { at, locationDescription, snapshotV1 } from "./us-receiving-lifecycle-fixture.js";

const line = at(snapshotV1.items, 0);
export const transformationV1 = {
  snapshotVersion: 1 as const,
  eventId: "00000000-0000-4000-8000-000000000001",
  eventNumber: "TRN-26-0001",
  revision: 1,
  eventDate: "2026-09-07",
  timeZone: "America/Chicago",
  processor: { id: snapshotV1.locationId, description: "  Captured processor | opaque  " },
  reason: "repacking" as const,
  reasonNote: null,
  notes: null,
  inputs: [
    {
      kind: "ftl_lot" as const,
      lineNo: 1,
      lotId: line.lotId,
      product: {
        id: line.productId,
        description: "  Captured apples | opaque  ",
        coverage: line.coverage,
      },
      tlc: "IN",
      source: {
        kind: "reference" as const,
        id: snapshotV1.previousSourceLocationId,
        description: "  Captured grower | opaque  ",
        referenceKind: "web_url" as const,
        referenceValue: "https://supplier.example.test/source/Ä?lot=001",
      },
      quantity: "5.000",
      unitOfMeasure: "lb" as const,
    },
  ],
  outputs: [
    {
      lineNo: 1,
      lotId: "00000000-0000-4000-8000-000000000002",
      product: {
        id: line.productId,
        description: "  Captured apples | opaque  ",
        coverage: line.coverage,
      },
      tlc: "OUT",
      source: {
        kind: "location" as const,
        id: snapshotV1.locationId,
        description: "  Captured processor | opaque  ",
      },
      quantity: "2",
      unitOfMeasure: "case" as const,
    },
  ],
  documents: [{ id: "00000000-0000-4000-8000-000000000003", type: "bol", number: "BOL-1" }],
  finalizedBy: "qa",
  finalizedAt: "2026-09-07T10:00:00.000Z",
};

export const transformationV2 = {
  ...transformationV1,
  snapshotVersion: 2 as const,
  processor: { ...transformationV1.processor, kdes: snapshotV1.locationDescription },
  inputs: transformationV1.inputs.map((input) => ({
    ...input,
    product: { ...input.product, kdes: line.productDescription },
    source: { ...input.source, kdes: locationDescription(input.source.id, "Captured supplier") },
  })),
  outputs: transformationV1.outputs.map((output) => ({
    ...output,
    product: { ...output.product, kdes: line.productDescription },
    source: { ...output.source, kdes: snapshotV1.locationDescription },
  })),
};
