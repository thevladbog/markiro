import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parsePersistedProposalDiff,
  nationalCatalogSnapshotSourceRef,
} from "../src/modules/product-regulatory/proposal-schema";
describe("NC initial category provenance", () => {
  const snapshotId = randomUUID();
  const diff = {
    version: 1,
    kind: "category_binding",
    target: {
      schemaVersionId: randomUUID(),
      categoryId: "23",
      categoryName: "Напитки",
      tnVedCode: null,
      okpd2Code: null,
    },
    entries: [],
  };
  it("permits genuine snapshot provenance for initial binding only", () => {
    expect(
      parsePersistedProposalDiff(diff, {
        kind: "category_binding",
        source: "national_catalog",
        snapshotId,
        sourceRef: nationalCatalogSnapshotSourceRef(snapshotId),
      }),
    ).toEqual(diff);
    expect(() =>
      parsePersistedProposalDiff(
        { ...diff, kind: "category_change" },
        {
          kind: "category_change",
          source: "national_catalog",
          snapshotId,
          sourceRef: nationalCatalogSnapshotSourceRef(snapshotId),
        },
      ),
    ).toThrow();
  });
  it("denies missing/mismatched snapshot identity", () => {
    for (const context of [
      { snapshotId: null, sourceRef: null },
      { snapshotId, sourceRef: null },
      { snapshotId, sourceRef: nationalCatalogSnapshotSourceRef(randomUUID()) },
    ]) {
      expect(() =>
        parsePersistedProposalDiff(diff, {
          kind: "category_binding",
          source: "national_catalog",
          ...context,
        }),
      ).toThrow();
    }
  });
});

it("hashes meaningful candidate values without manual correction, IDs, source order or status", async () => {
  const { meaningfulCatalogHash } =
    await import("../src/modules/national-catalog/national-catalog-import-apply-state");
  const entry = {
    entryId: randomUUID(),
    target: "attribute" as const,
    targetSchemaVersionId: randomUUID(),
    targetAttributeId: "12",
    disposition: "convertible" as const,
    currentValue: { type: "string" as const, value: "same" },
    proposedValue: { type: "string" as const, value: "same" },
  };
  const input = { providerName: " Provider ", mappedEntries: [entry], imageChecksum: null };
  expect(meaningfulCatalogHash(input)).toBe(
    meaningfulCatalogHash({
      ...input,
      providerName: "Provider",
      mappedEntries: [{ ...entry, entryId: randomUUID(), currentValue: null }],
    }),
  );
  expect(meaningfulCatalogHash(input)).not.toBe(
    meaningfulCatalogHash({ ...input, mappedEntries: [] }),
  );
  expect(meaningfulCatalogHash(input)).not.toBe(
    meaningfulCatalogHash({ ...input, providerName: "Different" }),
  );
});

it("canonicalizes mapped values and accepted request ordering", async () => {
  const { meaningfulCatalogHash, canonicalImportDecisions } =
    await import("../src/modules/national-catalog/national-catalog-import-apply-state");
  const a = {
    entryId: randomUUID(),
    target: "stable_field" as const,
    targetField: "print_name" as const,
    mappingId: randomUUID(),
    mappingVersion: 1,
    conversion: { kind: "string_trim" as const },
    currentValue: null,
    proposedValue: "Печать",
  };
  const b = {
    ...a,
    entryId: randomUUID(),
    targetField: "shelf_life_days" as const,
    conversion: { kind: "positive_integer" as const },
    proposedValue: 30,
  };
  expect(
    meaningfulCatalogHash({ providerName: "Name", mappedEntries: [a, b], imageChecksum: null }),
  ).toBe(
    meaningfulCatalogHash({ providerName: "Name", mappedEntries: [b, a], imageChecksum: null }),
  );
  const requestId = randomUUID();
  const x = {
    previewId: randomUUID(),
    acceptedEntryIds: [a.entryId, b.entryId],
    linkAction: "attach" as const,
    photo: { kind: "keep" as const },
  };
  const y = { ...x, previewId: randomUUID() };
  expect(canonicalImportDecisions({ requestId, decisions: [x, y] }).hash).toBe(
    canonicalImportDecisions({
      requestId,
      decisions: [{ ...y, acceptedEntryIds: [...y.acceptedEntryIds].reverse() }, x],
    }).hash,
  );
});
