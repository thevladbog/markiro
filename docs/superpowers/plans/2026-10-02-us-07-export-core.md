# US-07 Frozen-Event XLSX Export Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a safe, versioned, source-faithful FDA-aligned XLSX from explicit U.S. event revision pins, with honest incomplete-record findings and no request/publication workflow.

**Architecture:** A U.S.-only, tenant-scoped repeatable-read reader returns exact saved revision content. Strict input contracts, a pure field registry and row mapper build a library-independent workbook model; a Node writer renders and verifies XLSX bytes. US-09 will later freeze that input and publish immutable artifacts.

**Tech Stack:** Node 24, TypeScript, Zod, Drizzle/PostgreSQL, Vitest, `@markiro/domain`, `@markiro/platform-contracts`, `@markiro/api`; candidate writer `write-excel-file@4.1.1` behind an adapter, subject to Task 6's compatibility gate.

**Spec:** [2026-10-02-us-07-export-core-design.md](../specs/2026-10-02-us-07-export-core-design.md)

## Global Constraints

- Work in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit` on `codex/us-mvp`; preserve the existing dirty US-06 work and do not touch the primary RU checkout.
- Export data comes from explicit event/revision pins and saved snapshots, never from the bounded HTTP graph or mutable display labels.
- P0 XLSX headers/definitions are English; cabinet language remains EN/ES. The workbook says FDA-aligned, never FDA-approved, submitted or compliant.
- Complete and `available_records_incomplete` are different outcomes. Missing/corrupt source, wrong tenant, unsupported snapshot or infrastructure failure is an execution failure, not a successful incomplete export.
- No new HTTP endpoint, office button, request row, queue, storage publication, download, migration, Station behavior or deployment in US-07. US-09 owns the durable request/package lifecycle.
- All text/identifier cells are explicit strings; never truncate a required cell, calculate a formula, silently discard a row or infer a 2×2 quantity allocation.
- Pin exact dependency versions with Corepack pnpm, use no runtime external FDA/GS1/CDN fetch, and keep any added writer behind `WorkbookModel`.
- Each task uses red/green tests and an independent review gate. No commit, push, PR, merge or release is authorized by this plan approval.

## Review Focus

1. Equal TLCs from different sources: Task 2 pins distinct lot/event IDs and Task 4 keeps both rows; never collapse by TLC text.
2. A 2-input/2-output Transformation: Task 4 asserts exactly two input and two output quantity-bearing rows, not four allocated pairs.
3. A finalized event amended after source capture: Task 2/7 prove a pinned prior revision re-renders unchanged and cannot read later catalog values.
4. Formula-leading or oversized TLC/reference: Task 5/6 prove explicit string cells or typed artifact failure with exact source, never formula/truncation.
5. Incomplete export with an unreadable event: Task 2/5 prove corruption fails the operation while readable missing KDEs remain source-linked findings, never a false success.

---

## File map and interfaces

- `packages/platform-contracts/src/traceability/export-core.ts` and package index: strict source/input/build-identity schemas shared with future US-09; no public route DTO.
- `packages/domain/src/traceability/export/{registry-v1,canonical,rows,validation,workbook}.ts` and domain index: immutable registry, digest/ordering, exact CTE rows, findings and library-independent cells.
- `apps/api/src/modules/traceability/export/{source-reader,adapter,xlsx-writer,xlsx-verify}.ts`: authorized explicit-pin reader, adapter composition, candidate writer and archive/semantic safety check. Do not expand `us-development.module.ts` or proxy allowlists to expose a route.
- `docs/us/export-data-dictionary.md`: versioned output generated and drift-tested from the registry; `docs/us/requirements-traceability.md`: dated local evidence only, with EXP-008 package manifest remaining dependent on US-09.
- `packages/platform-contracts/test/us-export-core.test.ts`, `packages/domain/test/us-export-*.test.ts`, `apps/api/test/us-export-*.test.ts`: one focused red/green suite per independent deliverable; API tests use owned disposable U.S. child databases.

The following interfaces are fixed for task handoffs; names may change only with a reviewed plan amendment:

```ts
type ExportMode = "export_ready_candidate" | "available_records_incomplete";
type EventPin = { eventId: string; revision: number };
type ExportFinding = {
  code: string;
  severity: "error" | "warning" | "info";
  sourceRecord: string;
  eventId?: string;
  revision?: number;
  lineNo?: number;
  fieldKey?: string;
  message: string;
};
type ExportArtifactFailure = {
  code: "CELL_LIMIT_EXCEEDED" | "CELL_VALUE_UNREPRESENTABLE" | "XLSX_RENDER_FAILED";
  sourceRecord: string;
  fieldKey: string;
};
type ExportMetadataV1 = {
  profile: "US_FSMA204_PROCESSOR";
  scopeLabel: string;
  timeZone: string;
  generatedAt: string;
  baselineId: string;
  registryId: "fda_sortable_xlsx";
  registryVersion: 1;
  registryHash: string;
  build: { apiVersion: string; gitSha: string; dirty: boolean };
};
type ExportSourceRecord =
  | {
      type: "receiving";
      eventId: string;
      revision: number;
      lifecycle: "current_finalized" | "historical_finalized" | "draft" | "void";
      payload:
        | {
            kind: "frozen";
            snapshot:
              | ReceivingFinalizationSnapshotV1
              | ReceivingFinalizationSnapshotV2
              | ReceivingFinalizationSnapshotV3;
          }
        | { kind: "saved_draft"; draft: ReceivingDraft };
    }
  | {
      type: "transformation";
      eventId: string;
      revision: number;
      lifecycle: "current_finalized" | "historical_finalized" | "draft" | "void";
      payload:
        | { kind: "frozen"; snapshot: TransformationFinalizationSnapshotV1 }
        | { kind: "saved_draft"; draft: TransformationDraft };
    }
  | {
      type: "shipping";
      eventId: string;
      revision: number;
      lifecycle: "current_finalized" | "historical_finalized" | "draft" | "void";
      payload:
        | { kind: "frozen"; snapshot: ShippingFinalizationSnapshotV1 }
        | { kind: "saved_draft"; draft: ShippingDraft };
    };
type ExportInputV1 = {
  schemaVersion: 1;
  mode: ExportMode;
  tenantId: string;
  events: readonly ExportSourceRecord[];
  findings: readonly ExportFinding[];
  metadata: ExportMetadataV1;
};
type CanonicalExportRow = {
  sheet: "receiving" | "transformation" | "shipping";
  eventId: string;
  revision: number;
  eventDate: string;
  lineRole: "item" | "input" | "output";
  lineNo: number;
  lotId: string | null;
  sourceRecord: string;
  documentId: string | null;
  values: Readonly<Record<string, string | null>>;
};
type WorkbookCell =
  | { kind: "text"; value: string }
  | { kind: "date"; value: string }
  | { kind: "number"; value: number; sourceValue: string }
  | { kind: "blank"; value: null };
type WorkbookModel = {
  mode: ExportMode;
  sheets: readonly {
    name: string;
    columns: readonly { key: string; header: string }[];
    rows: readonly { sourceRecord: string; cells: readonly WorkbookCell[] }[];
    freezeHeader: true;
    autoFilter: boolean;
  }[];
};
```

**Task 5 handoff amendment (2026-10-02).** The richer, library-independent model above is the reviewed Task 5→6→7 contract. `sourceRecord` keeps artifact and cell verification tied to the frozen source; `number.sourceValue` retains the decimal lexeme so a writer can reject or render it as text if XLSX numeric serialization would lose it. A safe but noncanonical numeric lexeme such as `5.00` must become exact text with a source-linked informational finding in Task 5, so the sorting tradeoff is visible; canonical `5` stays numeric. Task 5 produces only `CELL_LIMIT_EXCEEDED` and `CELL_VALUE_UNREPRESENTABLE`; Task 6 may add `XLSX_RENDER_FAILED` with an exact source/field when rendering or verification fails. A workbook-level failure uses a stable synthetic source/field such as `workbook/render`. Task 6 must not infer date instants, omit row provenance, or silently round a numeric cell. Existing concrete Task 5 types are the source of truth for the writer, not the older illustrative `headers`/array-row snippet below.

### Task 1: Strict frozen-input and build-identity contract

**Files:** Create `packages/platform-contracts/src/traceability/export-core.ts` and `packages/platform-contracts/test/us-export-core.test.ts`; modify `packages/platform-contracts/src/index.ts`. Add the small US-00-owned immutable build-identity validator in the same contract file; actual build-time injection stays a US-09 integration prerequisite.

**Interfaces:** Produce `usExportInputV1Schema`, `usExportBuildIdentitySchema`, `ExportInputV1`, `ExportSourceRecord`, `ExportFinding` and `EventPin`. Reuse existing receiving v1/v2/v3, transformation v1 and shipping v1 frozen-snapshot schemas. Draft variants reuse their existing saved-draft schemas and carry an explicit non-final lifecycle tag; no arbitrary `unknown` payload escapes the schema.

- [ ] **Step 1: Write failing contract tests.** Construct one finalized Receiving v3 and one draft variant from existing test builders. Assert strict parsing, exact event ID/revision equality, status/mode separation, nonempty unique event identities, required baseline/registry/build fields and a 40-character Git SHA. Add a negative case with cross-event snapshot ID, invalid timezone and extra keys.

```ts
expect(usExportInputV1Schema.safeParse({ ...validInput, extra: true }).success).toBe(false);
expect(
  usExportBuildIdentitySchema.parse({ apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: true })
    .dirty,
).toBe(true);
expect(usExportInputV1Schema.safeParse({ ...validInput, events: [sameEventTwice] }).success).toBe(
  false,
);
```

- [ ] **Step 2: Verify red.** Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-export-core.test.ts`; expect missing exports.
- [ ] **Step 3: Implement the minimal strict schemas.** Discriminate `type` and `status`, validate existing payload schemas, compare every frozen payload `eventId` and `revision` to its envelope, and reject duplicate `{eventId,revision}`. `ExportMetadataV1` includes mode, tenant profile, request-scope label, IANA timezone, injected ISO instant, baseline ID, registry ID/version/hash and `{ apiVersion, gitSha, dirty }`. Do not resolve a SHA from runtime `.git` or leave a mutable default.

```ts
const buildIdentity = z
  .object({
    apiVersion: z.string().min(1),
    gitSha: z.string().regex(/^[0-9a-f]{40}$/),
    dirty: z.boolean(),
  })
  .strict();
const pin = z.object({ eventId: platformUuidSchema, revision: z.number().int().min(1) }).strict();
// The event union uses the existing v1/v2/v3 frozen and saved-draft schemas;
// its superRefine rejects an envelope that disagrees with a frozen payload.
```

- [ ] **Step 4: Verify green.** Run the focused test, contract package test/typecheck/lint/build, then `git diff --check`. Review strict parsing against existing old snapshot versions and no RU contract mutation.

### Task 2: Authorized explicit-pin source reader

**Files:** Create `apps/api/src/modules/traceability/export/source-reader.ts` and `apps/api/test/us-export-source-reader.e2e.test.ts`. Reuse `readReceivingLiveRecord` (not the original-draft reader), `readTransformationRecord`, `readShippingRecord`, `authorizeUsMasterData` and the existing repeatable-read transaction helper; do not copy their lifecycle parsers.

**Interfaces:** Produce `readUsExportSources(db, tenantId, actorUserId, pins, mode): Promise<readonly ExportSourceRecord[]>` and its local `resolvePinnedEvents(tx, tenantId, orderedPins, mode)` dispatcher. The caller owns scope selection; the reader only resolves explicitly bounded pins and fresh actor authorization with `US_CAPABILITY.EXPORT_READ` and the processor profile.

- [ ] **Step 1: Write failing database tests.** In an owned disposable U.S. child database, create distinct equal-TLC origins, current and superseded finalized revisions, a draft and a foreign-tenant event. Assert exact pins and snapshot bytes, stable order regardless of input order, 403 on revoked export capability/profile, 404 or typed failure for foreign/missing pins and a typed unavailable failure for a corrupt snapshot. Interleave an amendment between two reads and assert one repeatable-read result cannot mix old and new root state.

```ts
await expect(
  readUsExportSources(
    db,
    tenantA,
    actorA,
    [{ eventId: foreignId, revision: 1 }],
    "available_records_incomplete",
  ),
).rejects.toMatchObject({ response: { code: "us_export_source_not_found" } });
expect(result.map(({ eventId, revision }) => [eventId, revision])).toEqual(expectedSortedPins);
```

- [ ] **Step 2: Verify red.** Build DB and contracts first, then run `corepack pnpm --filter @markiro/api exec vitest run test/us-export-source-reader.e2e.test.ts`; expect missing reader. Never run against the shared/base development database.
- [ ] **Step 3: Implement the reader.** Validate/bound 1–500 pins before SQL. Run one repeatable-read transaction with fresh membership/profile/capability checks. Read exact tenant/type/revision through existing readers, confirm root/current state for `export_ready_candidate`, retain saved non-final content only in incomplete mode, and reject corrupt/unknown versions instead of fabricating blank rows. Return deterministically sorted, strict contract-parsed records.

```ts
return transformationTransaction(db, async (tx) => {
  const profile = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
  if (profile !== "US_FSMA204_PROCESSOR")
    throw new ForbiddenException({ code: "traceability_profile_required" });
  const ordered = [...pins].sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || a.revision - b.revision,
  );
  return resolvePinnedEvents(tx, tenantId, ordered, mode); // local dispatcher: Receiving live, Transformation, Shipping
});
```

- [ ] **Step 4: Verify green.** Re-run the focused suite plus US trace/receiving/transformation/shipping history regressions; run API typecheck/lint/build. Review the SQL for every tenant predicate and no request/storage writes.

### Task 3: English versioned KDE registry and generated dictionary

**Files:** Create `packages/domain/src/traceability/export/registry-v1.ts`, `canonical.ts`, `packages/domain/test/us-export-registry.test.ts` and `docs/us/export-data-dictionary.md`; modify `packages/domain/src/index.ts`.

**Interfaces:** Produce `FDA_SORTABLE_REGISTRY_V1`, `traceExportRegistryHash()`, `renderUsExportDictionary()`, `canonicalExportDigest(input)`. Local `receivingSheet`, `transformationSheet` and `shippingSheet` descriptors enumerate the v1 CTE fields. Registry entries have `{ key, header, sheet, kdeGroup, sourceSection, sourceUrl, required, type, snapshotPath }` and unique keys per CTE.

- [ ] **Step 1: Write failing registry tests.** Cover all field groups in `docs/us/data-dictionary.md` §7.1–7.5: TLC/source, quantity/UOM, split Product/Location Description, dates, documents and provenance IDs. Assert every entry has a stable key, English header, source reference and version; headers/requiredness and dictionary text derive from the same registry. Pin a reviewed literal hash and reject duplicate keys or source paths. Inspect the official FDA workbook/PDF mapping before freezing expected cells.

```ts
expect(FDA_SORTABLE_REGISTRY_V1.sheets.map((sheet) => sheet.key)).toEqual([
  "receiving",
  "transformation",
  "shipping",
]);
expect(
  new Set(
    FDA_SORTABLE_REGISTRY_V1.sheets.flatMap((sheet) =>
      sheet.fields.map((field) => `${sheet.key}:${field.key}`),
    ),
  ).size,
).toBe(FDA_SORTABLE_REGISTRY_V1.sheets.reduce((sum, sheet) => sum + sheet.fields.length, 0));
expect(renderUsExportDictionary()).toBe(readFileSync(dictionaryPath, "utf8"));
```

- [ ] **Step 2: Verify red.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-export-registry.test.ts`; expect missing registry/dictionary.
- [ ] **Step 3: Implement registry and dictionary.** Freeze v1; expand common description blocks through shared field factories (not handwritten copies); use existing `@noble/hashes` to hash canonical sorted-key JSON. Generate the tracked dictionary with explicit FDA section/URL and adapter version per column. Keep external URLs as documentation only, never runtime fetches.

```ts
const locationFields = (
  prefix: string,
  sheet: "receiving" | "shipping",
  kdeGroup: string,
  sourceSection: string,
  sourceUrl: string,
) => {
  const field = (key: string, header: string, path: string) => ({
    key: `${prefix}_${key}`,
    header,
    sheet,
    kdeGroup,
    sourceSection,
    sourceUrl,
    required: "yes" as const,
    type: "text" as const,
    snapshotPath: `${prefix}.${path}`,
  });
  return [
    field("business_name", "Business name", "businessName"),
    field("phone_number", "Phone number", "phoneNumber"),
    field("address_kind", "Address type", "address.kind"),
    field("street_address_or_coordinates", "Street address or coordinates", "address"),
    field("city", "City", "city"),
    field("state_or_region", "State or region", "stateOrRegion"),
    field("zip_or_postal_code", "ZIP or postal code", "zipOrPostalCode"),
    field("country", "Country", "countryCode"),
  ];
};
export const FDA_SORTABLE_REGISTRY_V1 = Object.freeze({
  id: "fda_sortable_xlsx",
  version: 1,
  sheets: [receivingSheet, transformationSheet, shippingSheet],
});
```

- [ ] **Step 4: Verify green.** Run focused/full domain tests, typecheck/lint/build and dictionary drift test. Inspect the literal-hash diff and record the mapping rationale in this plan's execution note before any future golden regeneration.

### Task 4: Exact source-row projection

**Files:** Create `packages/domain/src/traceability/export/rows.ts` and `packages/domain/test/us-export-rows.test.ts`.

**Interfaces:** Produce `buildUsExportRows(input: ExportInputV1): readonly CanonicalExportRow[]`, where each row has `sheet`, `eventId`, `revision`, `lineRole`, `lineNo`, `lotId`, `sourceRecord` and keyed registry values. Its private `projectLine(event, sheet, role, line)` projects one saved line; `compareExportRowIdentity` sorts by `(eventDate,eventId,lineRole,lineNo,documentId)`. Task 5 consumes these rows.

- [ ] **Step 1: Write failing rows tests.** Assert 2 Receiving, 2 Transformation input + 2 Transformation output and 1 Shipping rows for a branching fixture; each quantity appears once on its own line. Add no-FTL-input→1, same-TLC/different-source, shuffled pins, multiple documents and later catalog rename. Compare exact frozen product/location fields and event/line IDs, not just counts.

```ts
const rows = buildUsExportRows(branchingFixture);
expect(
  rows.filter((row) => row.sheet === "transformation" && row.lineRole === "input"),
).toHaveLength(2);
expect(
  rows.filter((row) => row.sheet === "transformation" && row.lineRole === "output"),
).toHaveLength(2);
expect(
  rows.filter((row) => row.sheet === "transformation").map((row) => row.values.quantity),
).toEqual(["40", "60", "25", "75"]);
```

- [ ] **Step 2: Verify red.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-export-rows.test.ts`; expect missing mapper.
- [ ] **Step 3: Implement one row per saved item/input/output.** Derive columns from registry source paths; sort by `(eventDate,eventId,lineRole,lineNo,documentId)` with byte-stable comparison. Keep non-FTL inputs as their own rows, absent lot IDs as explicit blanks, output source as saved processor, and repeated document/header values marked non-additive. For incomplete saved drafts, preserve recorded IDs/values, label lifecycle and leave unavailable descriptions blank with source-linked findings; do not hydrate mutable master data as if it were frozen. Never create a pairwise input→output quantity.

```ts
for (const inputLine of snapshot.inputs)
  rows.push(projectLine(event, "transformation", "input", inputLine));
for (const outputLine of snapshot.outputs)
  rows.push(projectLine(event, "transformation", "output", outputLine));
return rows.sort(compareExportRowIdentity); // eventDate, eventId, role, lineNo, documentId
```

- [ ] **Step 4: Verify green.** Run focused/full domain tests, typecheck/lint/build. Review every `values` path against snapshot v1/v2/v3 fixtures.

### Task 5: Findings and library-independent workbook model

**Files:** Create `packages/domain/src/traceability/export/{validation,workbook}.ts` and `packages/domain/test/us-export-workbook.test.ts`; append the narrow workbook runtime/type exports to `packages/domain/src/index.ts` before Task 6, preserving unrelated exports.

**Interfaces:** Produce `buildUsExportWorkbook(input): { model: WorkbookModel | null; findings: readonly ExportFinding[]; failure: ExportArtifactFailure | null }`. Validation distinguishes source findings from artifact inability; Task 6 receives only a non-null model.

- [ ] **Step 1: Write failing tests.** Clean finalized input yields Metadata/Definitions/relevant CTE/Validation tabs with complete English headers. A missing KDE/unknown coverage fixture preserves every readable row, exact `eventId/revision/lineNo/field` findings and `available_records_incomplete` label, but never returns a complete verdict. A corrupt source or unsupported profile fails before model construction. Assert civil dates as date cells, decimal precision fallback as text/info, leading `=+-@` as text, and a 32,768-character value as typed artifact failure with no truncated cell.

```ts
const result = buildUsExportWorkbook(incompleteFixture);
expect(
  result.model?.sheets.find((sheet) => sheet.name === "Validation")?.rows.length,
).toBeGreaterThan(0);
expect(result.findings).toContainEqual(
  expect.objectContaining({ code: "REQUIRED_KDE_MISSING", eventId, lineNo: 2 }),
);
expect(result.findings.some((finding) => finding.severity === "error")).toBe(true);
```

- [ ] **Step 2: Verify red.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-export-workbook.test.ts`; expect missing builder.
- [ ] **Step 3: Implement pure model/validation.** Use registry field definitions and Task 4 rows, not a second column list. Keep existing readiness findings, add row/cell findings, compare required fields without inventing values, and let an unsafe/unrepresentable cell fail only the workbook artifact. For Transformation, apply the input and output KDE groups to their respective row roles: TLC-source and processor/location/reference-document requirements belong to output, while input product/TLC/quantity requirements apply only to FTL inputs. Preserve non-FTL input rows and their captured values without fabricating FDA-required gaps for inapplicable fields. Metadata includes all frozen versions and visible incomplete mode. Do not create a manifest or claim effective Plan here.

```ts
if (typeof value === "string" && value.length > 32767)
  return {
    model: null,
    findings,
    failure: { code: "CELL_LIMIT_EXCEEDED", sourceRecord, fieldKey },
  };
const cell: WorkbookCell = { kind: "text", value: String(value) }; // formula-leading text stays text
```

- [ ] **Step 4: Verify green.** Run focused/full domain tests, typecheck/lint/build and golden semantic dump comparison. Inspect first failing source identifier in every negative case.

### Task 6: Writer compatibility, XLSX rendering and safety gate

**Files:** Modify `apps/api/package.json` and pnpm-generated `pnpm-lock.yaml` only after a bounded test; create `apps/api/src/modules/traceability/export/{xlsx-writer,xlsx-verify}.ts` and `apps/api/test/us-export-xlsx-writer.test.ts`.

**Interfaces:** Produce `renderUsExportXlsx(model: WorkbookModel): Promise<{ bytes: Uint8Array; sha256: string }>` and `verifyUsExportXlsx(bytes, model): void`. Private `toWriterCells` maps explicit model kinds to writer cell types without formulas or rounding. Private `verifiedAutoFilterFeature` adds only a range for each CTE sheet and is accepted only after ZIP/LibreOffice tests prove it safe.

- [ ] **Step 1: Write a failing compatibility test for candidate `write-excel-file@4.1.1`.** The same model/clock renders semantically identical rows and stable bytes; text starting `=+-@` stays an explicit string; no `<f>`, `vbaProject.bin`, `externalLinks/`, connections or outside relationship exists; the header remains frozen and each CTE sheet has an AutoFilter range spanning its data columns. If the selected writer cannot pass the safety/compatibility contract without fragile XML surgery, stop and amend this plan before installing a different writer.

```ts
const first = await renderUsExportXlsx(goldenModel);
const second = await renderUsExportXlsx(goldenModel);
expect(first.sha256).toBe(second.sha256);
expect(() => verifyUsExportXlsx(first.bytes, goldenModel)).not.toThrow();
expect(new TextDecoder().decode(unzipSync(first.bytes)["xl/worksheets/sheet1.xml"])).not.toMatch(
  /<f(?:\s|>)/,
);
expect(new TextDecoder().decode(unzipSync(first.bytes)["xl/worksheets/sheet3.xml"])).toMatch(
  /<autoFilter ref="[A-Z]+1:[A-Z]+[0-9]+"\s*\/>/,
);
```

- [ ] **Step 2: Verify red and dependency policy.** Run the focused test before implementation; expect missing writer. Check `pnpm config list`, package license/engine/release age/advisories and existing overrides; then use `corepack pnpm --filter @markiro/api add write-excel-file@4.1.1 --save-exact`. Review the generated importer and transitive lockfile changes; do not hand-edit the lockfile or bypass the release-age guard.
- [ ] **Step 3: Implement writer behind the model.** Use `write-excel-file/node`'s multi-sheet `toBuffer()`, `type: String` for all text/identifiers and `stickyRowsCount: 1`. Its official `features` extension may add a tested AutoFilter range; reject the candidate if this requires brittle sheet-XML patching. Validate unsupported controls before handing cells to the library. Scan ZIP parts with existing `fflate` and XML with existing `fast-xml-parser`; compare row IDs and values to the model. Confirm sorting/filtering by opening the result in LibreOffice. If deterministic bytes require canonical ZIP metadata normalization, perform it only through a tested final-byte pass, not by mutating source values.

```ts
const sheets = model.sheets.map((sheet) => ({
  sheet: sheet.name,
  data: [
    sheet.columns.map(({ header }) => ({ value: header, type: String })),
    ...sheet.rows.map((row) => toWriterCells(row.cells)),
  ],
  stickyRowsCount: 1,
}));
const bytes = new Uint8Array(
  await writeExcelFile(sheets, { features: [verifiedAutoFilterFeature] }).toBuffer(),
);
verifyUsExportXlsx(bytes, model);
```

- [ ] **Step 4: Verify green.** Run the focused writer test, `corepack pnpm check:deps`, API test/typecheck/lint/build and a headless LibreOffice open/CSV row-count check when available. Record Excel as untested until its separate manual acceptance gate; do not equate ZIP integrity with Excel compatibility.

### Task 7: Internal adapter, performance and acceptance reconciliation

**Files:** Create `apps/api/src/modules/traceability/export/adapter.ts` and `apps/api/test/us-export-adapter.test.ts`; update `docs/us/requirements-traceability.md`, `docs/us/implementation-plan.md` and `.github/workflows/us-development.yml` only where ownership requires it.

**Interfaces:** Produce `renderUsExportCore(input: ExportInputV1): Promise<{ workbook: Uint8Array | null; workbookSha256: string | null; registryVersion: 1; registryHash: string; inputDigest: string; rowCounts: Record<string, number>; findings: readonly ExportFinding[]; failure: ExportArtifactFailure | null }>` for future US-09. Private `countExportRows(model)` counts data rows by sheet and `UsExportError` is a typed adapter error for registry/input mismatch. It does not persist, audit, download or claim request readiness.

- [ ] **Step 1: Write failing adapter tests.** Clean and incomplete fixtures preserve identical source row IDs in the model and rendered workbook; later amendment/catalog changes do not affect frozen-input bytes; same input and build identity produce the same digest/hash; an input registry version/hash mismatch rejects rendering; unsafe cell returns an explicit workbook failure with findings. Time the controlled synthetic P0 fixture and assert <60 s on the documented local baseline.

```ts
const output = await renderUsExportCore(p0Fixture);
expect(output.workbook).not.toBeNull();
expect(output.rowCounts.transformation).toBe(4);
expect(output.inputDigest).toMatch(/^[0-9a-f]{64}$/);
expect(output.findings.some((finding) => finding.severity === "error")).toBe(false);
```

- [ ] **Step 2: Verify red.** Build domain/contracts and run `corepack pnpm --filter @markiro/api exec vitest run test/us-export-adapter.test.ts`; expect missing adapter.
- [ ] **Step 3: Compose existing parts without new exposure.** Validate input, compute canonical digest, build rows/model, render and verify bytes, return typed result. Update the traceability matrix with dated local checks only: EXP-001–007/010–012 may advance to `in progress` as evidenced; EXP-008 remains dependent on US-09 manifest/package; EXP-009 remains P1. Inspect `tools/ci/affected.mjs` and the US-only check workflow so new suites actually run without enabling release jobs.

```ts
const frozen = usExportInputV1Schema.parse(input);
if (frozen.metadata.registryHash !== traceExportRegistryHash())
  throw new UsExportError("REGISTRY_MISMATCH");
const { model, findings, failure } = buildUsExportWorkbook(frozen);
const workbook = model === null ? null : await renderUsExportXlsx(model);
return {
  workbook: workbook?.bytes ?? null,
  workbookSha256: workbook?.sha256 ?? null,
  registryVersion: 1,
  registryHash: traceExportRegistryHash(),
  inputDigest: canonicalExportDigest(frozen),
  rowCounts: countExportRows(model),
  findings,
  failure,
};
```

- [ ] **Step 4: Verify green and handoff.** Run focused API suites on owned databases, full touched package test/typecheck/lint/build, US isolation/CI contracts, `corepack pnpm format:check` and `git diff --check`. Review the complete US-only diff for tenant leakage, public routes, package changes and dirty pre-existing US-06 files. Report automation, LibreOffice, Excel, browser, storage, hosted CI and regulatory review as separate evidence categories; do not mark the slice Done solely on local tests.

## Execution handoff

Use the previously selected **separate executor plus independent review per task** method. The plan is ready for owner review, not implementation. On approval, execute Tasks 1–7 sequentially with a fresh implementer/reviewer gate and a final cross-task review. A failed writer compatibility or missing external test prerequisite is a reportable gate, not permission to weaken the contract. Commit/push/PR and deployment remain separate user-authorized actions.
