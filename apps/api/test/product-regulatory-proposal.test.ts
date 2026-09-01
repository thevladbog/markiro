import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalProposalSelection,
  nationalCatalogSnapshotSourceRef,
  parsePersistedProposalDiff,
} from "../src/modules/product-regulatory/proposal-schema";
import {
  applyRegulatoryProposalSchema,
  categoryChangePreviewSchema,
  productReadinessOpenApiSchema,
  regulatoryProposalOpenApiSchema,
  regulatoryProposalPreviewOpenApiSchema,
} from "../src/modules/product-regulatory/dto";

const schemaVersionId = "00000000-0000-4000-8000-000000030001";
const snapshotId = "00000000-0000-4000-8000-000000030002";
const randomSnapshotId = "00000000-0000-4000-8000-000000030099";
const mappingId = "00000000-0000-4000-8000-000000030003";
const entryA = "00000000-0000-4000-8000-000000030011";
const entryB = "00000000-0000-4000-8000-000000030012";

const target = {
  schemaVersionId,
  categoryId: "beer",
  categoryName: "Пиво",
  tnVedCode: "2203000100",
  okpd2Code: "11.05.10",
};

const attributeEntry = {
  entryId: entryA,
  target: "attribute" as const,
  targetSchemaVersionId: schemaVersionId,
  targetAttributeId: "alcoholStrength",
  disposition: "transferable" as const,
  currentValue: { type: "decimal" as const, value: "4.7", unit: "%" },
  proposedValue: { type: "decimal" as const, value: "4.7", unit: "%" },
};

function context(
  overrides: Partial<{
    kind: "category_binding" | "category_change" | "national_catalog_import";
    source: "manual" | "1c" | "national_catalog" | "migration";
    snapshotId: string | null;
    sourceRef: string | null;
  }> = {},
) {
  return {
    kind: "category_change" as const,
    source: "manual" as const,
    snapshotId: null,
    sourceRef: null,
    ...overrides,
  };
}

describe("persisted regulatory proposal contract", () => {
  it("accepts closed binding and category-change diffs", () => {
    expect(
      parsePersistedProposalDiff(
        { version: 1, kind: "category_binding", target, entries: [attributeEntry] },
        context({ kind: "category_binding" }),
      ),
    ).toMatchObject({ version: 1, kind: "category_binding", entries: [attributeEntry] });

    expect(
      parsePersistedProposalDiff(
        { version: 1, kind: "category_change", target, entries: [attributeEntry] },
        context(),
      ),
    ).toMatchObject({ version: 1, kind: "category_change", target });
  });

  it("accepts a source-pinned National Catalog import with all closed entry targets", () => {
    const diff = {
      version: 1,
      kind: "national_catalog_import",
      entries: [
        attributeEntry,
        {
          entryId: entryB,
          target: "egais_codes",
          current: { codes: [], primaryCode: null },
          proposed: {
            codes: ["1234567890123456789", "9876543210987654321"],
            primaryCode: "1234567890123456789",
          },
        },
        {
          entryId: "00000000-0000-4000-8000-000000030013",
          target: "stable_field",
          targetField: "print_name",
          mappingId,
          mappingVersion: 2,
          conversion: { kind: "string_trim" },
          currentValue: null,
          proposedValue: "Пиво светлое",
        },
      ],
    };

    expect(
      parsePersistedProposalDiff(
        diff,
        context({
          kind: "national_catalog_import",
          source: "national_catalog",
          snapshotId,
          sourceRef: nationalCatalogSnapshotSourceRef(snapshotId),
        }),
      ),
    ).toEqual(diff);
  });

  it.each([
    [{ ...attributeEntry, providerField: "leak" }, "unknown entry key"],
    [{ ...attributeEntry, currentValue: { type: "boolean", value: "yes" } }, "typed value"],
    [{ ...attributeEntry, proposedValue: null }, "missing transferable value"],
  ])("rejects %s", (entry, _label) => {
    expect(() =>
      parsePersistedProposalDiff(
        { version: 1, kind: "category_change", target, entries: [entry] },
        context(),
      ),
    ).toThrow();
  });

  it.each([
    { version: 2, kind: "category_change", target, entries: [] },
    { version: 1, kind: "unknown", target, entries: [] },
    { version: 1, kind: "category_change", target, entries: [], providerPayload: {} },
  ])("rejects unknown version, kind, or top-level key", (diff) => {
    expect(() => parsePersistedProposalDiff(diff, context())).toThrow();
  });

  it("rejects duplicate proposal entry IDs", () => {
    expect(() =>
      parsePersistedProposalDiff(
        {
          version: 1,
          kind: "category_change",
          target,
          entries: [attributeEntry, { ...attributeEntry }],
        },
        context(),
      ),
    ).toThrow(/duplicate/i);
  });

  it("rejects duplicate EGAIS codes and a primary outside the collection", () => {
    const importContext = context({
      kind: "national_catalog_import",
      source: "national_catalog",
      snapshotId,
      sourceRef: nationalCatalogSnapshotSourceRef(snapshotId),
    });
    const base = {
      version: 1,
      kind: "national_catalog_import",
      entries: [
        {
          entryId: entryA,
          target: "egais_codes",
          current: { codes: [], primaryCode: null },
          proposed: { codes: ["1234567890123456789"], primaryCode: "1234567890123456789" },
        },
      ],
    };

    expect(() =>
      parsePersistedProposalDiff(
        {
          ...base,
          entries: [
            {
              ...base.entries[0],
              proposed: {
                codes: ["1234567890123456789", "1234567890123456789"],
                primaryCode: "1234567890123456789",
              },
            },
          ],
        },
        importContext,
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      parsePersistedProposalDiff(
        {
          ...base,
          entries: [
            {
              ...base.entries[0],
              proposed: {
                codes: ["1234567890123456789"],
                primaryCode: "9876543210987654321",
              },
            },
          ],
        },
        importContext,
      ),
    ).toThrow(/primary/i);
  });

  it("rejects an unsafe stable field and a mapping without exact identity", () => {
    const importContext = context({
      kind: "national_catalog_import",
      source: "national_catalog",
      snapshotId,
      sourceRef: nationalCatalogSnapshotSourceRef(snapshotId),
    });
    const stable = {
      entryId: entryA,
      target: "stable_field",
      targetField: "print_name",
      mappingId,
      mappingVersion: 1,
      conversion: { kind: "identity" },
      currentValue: null,
      proposedValue: "Пиво",
    };

    expect(() =>
      parsePersistedProposalDiff(
        {
          version: 1,
          kind: "national_catalog_import",
          entries: [{ ...stable, targetField: "unit_price" }],
        },
        importContext,
      ),
    ).toThrow();
    expect(() =>
      parsePersistedProposalDiff(
        {
          version: 1,
          kind: "national_catalog_import",
          entries: [{ ...stable, mappingId: undefined }],
        },
        importContext,
      ),
    ).toThrow();
  });

  it("requires the immutable source reference to identify the exact snapshot", () => {
    expect(() =>
      parsePersistedProposalDiff(
        { version: 1, kind: "national_catalog_import", entries: [] },
        context({
          kind: "national_catalog_import",
          source: "national_catalog",
          snapshotId,
          sourceRef: nationalCatalogSnapshotSourceRef(randomSnapshotId),
        }),
      ),
    ).toThrow(/source reference/i);
  });

  it("rejects source/kind mismatches and unpinned National Catalog imports", () => {
    const importDiff = { version: 1, kind: "national_catalog_import", entries: [] };
    expect(() =>
      parsePersistedProposalDiff(
        importDiff,
        context({ kind: "national_catalog_import", source: "manual" }),
      ),
    ).toThrow(/source/i);
    expect(() =>
      parsePersistedProposalDiff(
        importDiff,
        context({ kind: "national_catalog_import", source: "national_catalog" }),
      ),
    ).toThrow(/snapshot/i);
    expect(() =>
      parsePersistedProposalDiff(
        { version: 1, kind: "category_change", target, entries: [] },
        context({ source: "national_catalog" }),
      ),
    ).toThrow(/source/i);
  });

  it("normalizes only the exact legacy category-change shape", () => {
    const legacy = {
      target,
      values: [
        {
          entryId: entryA,
          attributeId: "alcoholStrength",
          disposition: "transferable",
          currentValue: { type: "decimal", value: "4.7", unit: "%" },
        },
      ],
    };
    expect(parsePersistedProposalDiff(legacy, context())).toEqual({
      version: 1,
      kind: "category_change",
      target,
      entries: [attributeEntry],
    });
    expect(() =>
      parsePersistedProposalDiff({ ...legacy, sourceRef: "invented" }, context()),
    ).toThrow();
  });
});

describe("canonical proposal selection", () => {
  it("sorts unique UUIDs and hashes the exact canonical JSON", () => {
    const expectedIds = [entryA, entryB];
    expect(canonicalProposalSelection([entryB, entryA])).toEqual({
      acceptedEntryIds: expectedIds,
      hash: createHash("sha256").update(JSON.stringify(expectedIds)).digest("hex"),
    });
  });

  it("rejects duplicate accepted IDs instead of silently deduplicating them", () => {
    expect(() => canonicalProposalSelection([entryA, entryA])).toThrow(/duplicate/i);
  });
});

describe("proposal DTO and OpenAPI boundaries", () => {
  it("rejects duplicate accepted IDs at the request boundary", () => {
    expect(
      applyRegulatoryProposalSchema.safeParse({ acceptedEntryIds: [entryA, entryA] }).success,
    ).toBe(false);
  });

  it("allows revision zero for the service to validate as an initial binding", () => {
    expect(
      categoryChangePreviewSchema.safeParse({
        baseRevision: 0,
        targetSchemaVersionId: schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
        mappingConfirmed: false,
      }).success,
    ).toBe(true);
  });

  it("documents recommendations and keeps proposal responses closed", () => {
    const dimensions = productReadinessOpenApiSchema.properties?.dimensions;
    const dimensionItems = dimensions && "items" in dimensions ? dimensions.items : undefined;
    expect(dimensionItems).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["recommendations"]),
      properties: {
        recommendations: { type: "array" },
      },
    });
    expect(regulatoryProposalPreviewOpenApiSchema).toMatchObject({
      additionalProperties: false,
      required: ["proposalId", "baseRevision", "diff"],
    });
    expect(regulatoryProposalOpenApiSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["id", "kind", "source", "status", "diff"]),
    });
  });
});
