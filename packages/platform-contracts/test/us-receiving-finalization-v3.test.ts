import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import {
  at,
  eventId,
  snapshotV1,
  snapshotV2,
  snapshotV3,
  review,
  receivingLocationId,
  sourceLocationId,
} from "./support/us-receiving-lifecycle-fixture.js";

const item = at(snapshotV3.items, 0);
const retained = { kind: "retained", previousEventId: eventId, previousLineNo: 2 };
const assigned = {
  ...snapshotV3,
  items: [
    {
      ...item,
      lotBinding: retained,
      source: { kind: "location", locationId: receivingLocationId },
      sourceDescription: snapshotV3.locationDescription,
      receiptBasis: { kind: "exempt_assigned_tlc", ...review, receivedTlc: null },
    },
  ],
  confirmation: { ...snapshotV3.confirmation, reviewedExemptLines: [1] },
};

describe("frozen Receiving v3", () => {
  it.each([
    { name: "created", value: snapshotV3 },
    {
      name: "linked",
      value: {
        ...snapshotV3,
        items: [{ ...item, lotLinkMode: "link_existing", lotBinding: { kind: "linked" } }],
      },
    },
    {
      name: "retained ordinary",
      value: { ...snapshotV3, items: [{ ...item, lotBinding: retained }] },
    },
    { name: "retained own assignment", value: assigned },
    {
      name: "retained supplier exemption",
      value: {
        ...assigned,
        items: [
          {
            ...item,
            lotBinding: retained,
            receiptBasis: { kind: "exempt_existing_tlc", ...review },
          },
        ],
      },
    },
  ])("keeps exact $name content without a new lot-insertion assumption", ({ value }) => {
    expect(contracts.receivingFinalizationSnapshotV3Schema.parse(value)).toEqual(value);
  });
  it("permits reordered bindings to two predecessor lines referencing the same lot", () => {
    const value = {
      ...snapshotV3,
      items: [
        { ...item, lotBinding: retained },
        {
          ...item,
          lineNo: 2,
          lotLinkMode: "link_existing",
          lotBinding: { ...retained, previousLineNo: 1 },
        },
      ],
    };
    expect(contracts.receivingFinalizationSnapshotV3Schema.parse(value)).toEqual(value);
  });
  it.each([
    { name: "unknown binding", lotBinding: { ...retained, forged: true } },
    { name: "created with predecessor", lotBinding: { kind: "created", previousEventId: eventId } },
    { name: "missing binding", lotBinding: undefined },
    { name: "invalid predecessor", lotBinding: { ...retained, previousEventId: "bad" } },
    { name: "fractional line", lotBinding: { ...retained, previousLineNo: 1.5 } },
    { name: "zero line", lotBinding: { ...retained, previousLineNo: 0 } },
    { name: "out of range line", lotBinding: { ...retained, previousLineNo: 101 } },
    { name: "linked in create mode", lotBinding: { kind: "linked" } },
  ])("rejects $name", ({ lotBinding }) => {
    expect(
      contracts.receivingFinalizationSnapshotV3Schema.safeParse({
        ...snapshotV3,
        items: [{ ...item, lotBinding }],
      }).success,
    ).toBe(false);
  });
  it("rejects created binding in link mode and duplicate predecessor references including UUID case", () => {
    expect(
      contracts.receivingFinalizationSnapshotV3Schema.safeParse({
        ...snapshotV3,
        items: [{ ...item, lotLinkMode: "link_existing" }],
      }).success,
    ).toBe(false);
    expect(
      contracts.receivingFinalizationSnapshotV3Schema.safeParse({
        ...snapshotV3,
        items: [
          { ...item, lotBinding: retained },
          {
            ...item,
            lineNo: 2,
            lotBinding: { ...retained, previousEventId: eventId.toLowerCase() },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    {
      name: "unreviewed retained assignment",
      value: { ...assigned, confirmation: snapshotV3.confirmation },
    },
    {
      name: "changed received TLC",
      value: {
        ...assigned,
        items: [
          {
            ...at(assigned.items, 0),
            receiptBasis: { ...at(assigned.items, 0).receiptBasis, receivedTlc: "other" },
          },
        ],
      },
    },
    {
      name: "invalid source description",
      value: {
        ...snapshotV3,
        items: [{ ...item, sourceDescription: snapshotV3.locationDescription }],
      },
    },
    { name: "malformed TLC", value: { ...snapshotV3, items: [{ ...item, tlc: "\ud800" }] } },
    { name: "missing document", value: { ...snapshotV3, documents: [] } },
    { name: "old confirmation", value: { ...snapshotV3, confirmation: snapshotV2.confirmation } },
  ])("retains shared validation: $name", ({ value }) => {
    expect(contracts.receivingFinalizationSnapshotV3Schema.safeParse(value).success).toBe(false);
  });
  it("leaves legacy v1/v2 parsers lossless and closed to v3 fields", () => {
    expect(contracts.receivingFinalizationSnapshotV1Schema.parse(snapshotV1)).toEqual(snapshotV1);
    expect(contracts.receivingFinalizationSnapshotV2Schema.parse(snapshotV2)).toEqual(snapshotV2);
    expect(contracts.receivingFinalizationSnapshotSchema.safeParse(snapshotV3).success).toBe(false);
    expect(
      contracts.receivingFinalizationSnapshotV1Schema.safeParse({
        ...snapshotV1,
        items: [{ ...at(snapshotV1.items, 0), lotBinding: retained }],
      }).success,
    ).toBe(false);
    expect(
      contracts.receivingFinalizationSnapshotV2Schema.safeParse({
        ...snapshotV2,
        items: [{ ...at(snapshotV2.items, 0), lotBinding: retained }],
      }).success,
    ).toBe(false);
  });
  it("keeps a retained assignment's historical source when correcting the receipt location", () => {
    const value = {
      ...assigned,
      locationId: sourceLocationId,
      locationDescription: snapshotV3.previousSourceDescription,
    };
    expect(contracts.receivingFinalizationSnapshotV3Schema.parse(value)).toEqual(value);
    expect(
      contracts.receivingFinalizationSnapshotV3Schema.safeParse({
        ...value,
        items: value.items.map((item) => ({ ...item, lotBinding: { kind: "created" } })),
      }).success,
    ).toBe(false);
  });
});
