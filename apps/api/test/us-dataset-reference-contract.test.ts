import { describe, expect, it } from "vitest";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";

const stamp = "2026-10-06T12:00:00.000Z";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function evidence() {
  const catalogue = makeUsSixMonthCatalogue();
  const parties = catalogue.parties.map(({ key }, index) => ({ key, id: uuid(index + 1) }));
  const locations = catalogue.locations.map(({ key }, index) => ({ key, id: uuid(index + 24) }));
  const products = catalogue.products.map(({ key }, index) => ({ key, id: uuid(index + 47) }));
  return {
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    bindings: { parties, locations, products },
    evidence: {
      parties: catalogue.parties.map(({ input }, index) => ({
        ...input,
        id: parties[index]?.id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      locations: catalogue.locations.map(({ input, partyKey }, index) => ({
        ...input,
        id: locations[index]?.id,
        partyId: parties.find(({ key }) => key === partyKey)?.id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
        descriptionStatus: { exportReady: true, issues: [] },
      })),
      products: catalogue.products.map(({ input }, index) => ({
        id: products[index]?.id,
        name: input.name,
        gtin14: null,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      profiles: catalogue.products.map(({ profile }, index) => {
        const { expectedRevision: _revision, ...editable } = profile;
        void _revision;
        return {
          ...editable,
          packagingSizeValue: `${profile.packagingSizeValue}.000`,
          productId: products[index]?.id,
          revision: 1,
          reviewedBy: uuid(99),
          reviewedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        };
      }),
    },
  };
}

describe("bounded six-month reference result codec", () => {
  it("round trips complete platform-valid evidence in catalogue order", () => {
    const raw = evidence();
    expect(parseUsDatasetReferenceResult(raw)).toEqual(raw);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(256 * 1024);
  });
  it.each([
    "forged key",
    "reordered evidence",
    "duplicate UUID",
    "wrong profile product",
    "extra field",
    "reordered keys",
    "missing evidence",
    "wrong digest",
  ])("rejects %s", (kind) => {
    const raw = evidence();
    if (kind === "forged key") raw.bindings.parties[0] = { key: "unknown", id: uuid(1) };
    if (kind === "reordered evidence") raw.evidence.parties.reverse();
    if (kind === "duplicate UUID")
      raw.bindings.locations[0] = { key: "previous_source", id: uuid(1) };
    if (kind === "wrong profile product" && raw.evidence.profiles[0])
      raw.evidence.profiles[0].productId = uuid(999);
    if (kind === "extra field") Object.assign(raw.evidence.products[0] ?? {}, { extra: true });
    if (kind === "reordered keys") raw.bindings.parties.reverse();
    if (kind === "missing evidence") raw.evidence.profiles.pop();
    if (kind === "wrong digest") raw.definitionDigest = "a".repeat(64);
    expect(() => parseUsDatasetReferenceResult(raw)).toThrow("us_dataset_reference_mismatch");
  });
  it("rejects schema normalization instead of certifying changed evidence", () => {
    const raw = evidence();
    if (!raw.evidence.parties[0]) throw new Error("missing fixture party");
    raw.evidence.parties[0].name = ` ${raw.evidence.parties[0].name} `;
    expect(() => parseUsDatasetReferenceResult(raw)).toThrow("us_dataset_reference_mismatch");
  });
  it("rejects oversized raw JSON before schema parsing", () => {
    expect(() => parseUsDatasetReferenceResult({ padding: "x".repeat(256 * 1024) })).toThrow(
      "us_dataset_reference_mismatch",
    );
  });
  it("rejects accessors without evaluating them", () => {
    let reads = 0;
    const raw = Object.defineProperty(evidence(), "version", {
      enumerable: true,
      get() {
        reads++;
        return usSixMonthDefinition.version;
      },
    });
    expect(() => parseUsDatasetReferenceResult(raw)).toThrow("us_dataset_reference_mismatch");
    expect(reads).toBe(0);
  });
});
