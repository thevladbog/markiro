# Inventory Operational Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the proven shift-compatible aggregation XML and six deterministic TXT/CSV inventory reports to the existing tenant-admin document package.

**Architecture:** Extract one low-level GISMT aggregation serializer and text encoders in `@markiro/domain`, while shift and inventory retain separate source-selection adapters. Version the inventory registry by `(id, version)`, keep aggregation v1 executable but hidden, publish aggregation v2 plus the tabular formats, and preserve the existing atomic runner and deterministic ZIP v1 contract.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, NestJS 11, Drizzle/PostgreSQL, React 19, TanStack Query, i18next, fflate, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-27-inventory-operational-documents-design.md`

## Global Constraints

- `MOVING_BY_UD` is protected and must not enter any operational output.
- Aggregation v2 must be byte-identical to `shift_xml_gismt_aggregation@1` for identical ordered boxes and INN.
- Aggregation v1 stays hidden but executable for stored runs; disaggregation remains v1.
- TXT is UTF-8 without BOM and LF-terminated when non-empty; an empty TXT is zero bytes.
- CSV is UTF-8 BOM, semicolon-delimited, CRLF-terminated, and header-only when empty.
- TXT/CSV code values retain the full canonical KM, including GS `0x1D` and the crypto tail.
- Final box outputs contain only closed, printed, non-empty boxes whose active items are all verified and have the box production date.
- Balances group only verified codes by observed production date and eligible boxes by box production date; a missing verified date fails closed.
- Selected XML with no applicable operation fails the whole run; an empty selected TXT/CSV succeeds.
- The ZIP and `manifest.json` remain internal `schemaVersion: 1`, deterministic, unsigned, and unencrypted.
- Preserve tenant-scoped queries, frozen `resultRevision`, retry/idempotency semantics, and sanitized errors.
- Do not rewrite an applied migration; add a forward-only migration for zero-byte artifacts.
- No Chestny ZNAK submission/API polling, XLSX, kiosk enforcement, or standalone repacking is included.

## File Structure

### Create

- `packages/domain/src/gismt-aggregation.ts` — the single GISMT aggregation XML serializer and SSCC/CIS validation.
- `packages/domain/src/document-text-encoding.ts` — deterministic TXT and semicolon CSV byte encoding.
- `packages/domain/src/inventory/document-selection.ts` — current final-box eligibility shared by new inventory formats.
- `packages/domain/src/inventory/tabular-document-generators.ts` — six TXT/CSV inventory generators.
- `packages/domain/test/gismt-aggregation.test.ts` — exact serializer bytes and validation.
- `packages/domain/test/document-text-encoding.test.ts` — BOM, CRLF/LF, escaping, GS, and empty encodings.
- `packages/domain/test/inventory-tabular-document-generators.test.ts` — exact bytes and metrics for six new formats.
- `packages/db/migrations/0084_inventory_document_artifact_empty_files.sql` — replace the positive byte-size check with a non-negative check.
- `packages/db/migrations/meta/0084_snapshot.json` — Drizzle snapshot generated from the schema change.
- `packages/db/test/inventory-document-artifact-empty-file-migration.test.ts` — connected forward-migration proof.
- `apps/api/test/inventory-documents-openapi.test.ts` — zero-byte artifact response contract.

### Modify

- `packages/domain/src/shift-exports.ts` — delegate final aggregation bytes to the shared serializer without changing shift behavior.
- `packages/domain/src/inventory/documents.ts` — eight advertised descriptors, hidden aggregation v1, and version-aware resolution.
- `packages/domain/src/inventory/document-generators.ts` — preserve aggregation v1, add v2, and consume shared final-box selection.
- `packages/domain/src/inventory/index.ts` and `packages/domain/src/index.ts` — export the new public inventory generator contracts.
- `packages/domain/test/shift-exports.test.ts` — prove extraction preserves all shift bytes and splitting.
- `packages/domain/test/inventory-documents.test.ts` — prove catalog and legacy-version registry behavior.
- `packages/domain/test/inventory-document-generators.test.ts` — prove v1 freeze, v2 parity, and disaggregation selection.
- `packages/db/src/schema/inventory.ts` — declare the non-negative artifact byte-size check.
- `packages/db/migrations/meta/_journal.json` — register migration 0084.
- `packages/db/test/inventory-schema.test.ts` — assert the new named check and packaged migration.
- `apps/api/src/modules/inventories/inventory-document-runner.service.ts` — exact-version generator registry, nine registered generators, zero-byte validation, and safe missing-date error.
- `apps/api/src/modules/inventories/inventory-documents.service.ts` — use selection-only resolution for new runs.
- `apps/api/src/modules/inventories/dto.ts` — accept and document non-negative artifact byte sizes.
- `apps/api/test/inventory-document-runner.test.ts` — exact-version execution, zero-byte ZIP, atomic failure, and production registry.
- `apps/api/test/inventory-document-formats.e2e.test.ts` — exact eight-format tenant catalog.
- `apps/api/test/inventory-document-formats-openapi.test.ts` — keep the strict descriptor schema aligned.
- `apps/api/test/inventory-documents.e2e.test.ts` — production all-format journey, hidden v1 retry, empty reports, package, and tenant proof.
- `apps/admin/src/pages/inventory/schemas.ts` — parse `byteSize: 0`.
- `apps/admin/src/pages/inventory/InventoryDocuments.tsx` — localize the missing-production-date run failure.
- `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json` — actionable missing-date copy.
- `apps/admin/test/inventory-documents.test.tsx` — dynamic catalog, exact selections, zero-byte artifact, and localized failure.

---

### Task 1: Extract the proven aggregation and text byte primitives

**Files:**

- Create: `packages/domain/src/gismt-aggregation.ts`
- Create: `packages/domain/src/document-text-encoding.ts`
- Create: `packages/domain/test/gismt-aggregation.test.ts`
- Create: `packages/domain/test/document-text-encoding.test.ts`
- Modify: `packages/domain/src/shift-exports.ts`
- Modify: `packages/domain/test/shift-exports.test.ts`

**Interfaces:**

- Produces: `renderGismtAggregationXml(input): GismtAggregationRenderResult`
- Produces: `gismtAggregationBoxLineCount(box): number`
- Produces: `GISMT_AGGREGATION_OVERHEAD_LINE_COUNT: number`
- Produces: `GismtAggregationError` with `ORG_INN_MISSING`, `INVALID_SSCC`, or `INVALID_CIS`.
- Produces: `encodeLfText(lines): Uint8Array` and `encodeSemicolonCsv(header, rows): Uint8Array`
- Preserves: every existing `renderShiftExport` input, output, filename, split, and error identity.

- [ ] **Step 1: Write exact failing primitive tests**

Create tests with the real KM separator and a valid SSCC:

```ts
const km = "010468008990001721SERIAL-A\u001d93crypto";
const rendered = renderGismtAggregationXml({
  organizationInn: "9705119097",
  boxes: [{ sscc: "046800899000256001", codes: [km] }],
});

expect(new TextDecoder().decode(rendered.bytes)).toBe(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<unit_pack>\n" +
    "    <Document>\n" +
    "        <organisation>\n" +
    "            <id_info>\n" +
    '                <LP_info LP_TIN="9705119097" />\n' +
    "            </id_info>\n" +
    "        </organisation>\n" +
    "        <pack_content>\n" +
    "            <pack_code>00046800899000256001</pack_code>\n" +
    "            <cis>010468008990001721SERIAL-A</cis>\n" +
    "        </pack_content>\n" +
    "    </Document>\n" +
    "</unit_pack>\n",
);
expect(rendered).toMatchObject({ physicalLineCount: 14, codeCount: 1, boxCount: 1 });
```

Add validation cases for missing INN, invalid SSCC, invalid KM, XML-illegal CIS characters, and
attribute escaping. Add encoder assertions:

```ts
expect([...encodeLfText([])]).toEqual([]);
expect(new TextDecoder().decode(encodeLfText(["A\u001dB"]))).toBe("A\u001dB\n");
const csv = encodeSemicolonCsv(["box_sscc", "code"], [["00...", '01A;B"C']]);
expect([...csv.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
expect(new TextDecoder().decode(csv.slice(3))).toBe(
  'box_sscc;code\r\n00...;"01A;B""C"\r\n',
);
```

- [ ] **Step 2: Run the new tests and confirm the missing modules fail**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run \
  test/gismt-aggregation.test.ts \
  test/document-text-encoding.test.ts
```

Expected: FAIL because the two modules and exports do not exist.

- [ ] **Step 3: Implement the minimal deterministic primitives**

Use these exact public shapes:

```ts
export interface GismtAggregationBox {
  sscc: string;
  codes: readonly string[];
}

export interface GismtAggregationRenderResult {
  bytes: Uint8Array;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
}

export const GISMT_AGGREGATION_OVERHEAD_LINE_COUNT = 10;

export type GismtAggregationErrorCode =
  | "ORG_INN_MISSING"
  | "INVALID_SSCC"
  | "INVALID_CIS";

export class GismtAggregationError extends Error {
  constructor(readonly code: GismtAggregationErrorCode) {
    super(code);
    this.name = "GismtAggregationError";
  }
}

export function gismtAggregationBoxLineCount(box: GismtAggregationBox): number {
  return 3 + box.codes.length;
}

export function renderGismtAggregationXml(input: {
  organizationInn: string;
  boxes: readonly GismtAggregationBox[];
}): GismtAggregationRenderResult;

export function encodeLfText(lines: readonly string[]): Uint8Array;
export function encodeSemicolonCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Uint8Array;
```

Move the current SSCC formatting, KM-to-CIS reduction, XML escaping, prohibited-character guard,
CSV field escaping, UTF-8 BOM, and final-newline behavior into these modules. Keep domain-specific
errors translated at each adapter boundary rather than exposing a plain `DomainError`.

- [ ] **Step 4: Make shift XML use the common final serializer**

Keep split decisions in `shift-exports.ts`. For each XML part, pass that part's boxes to
`renderGismtAggregationXml`; take `physicalLineCount`, `codeCount`, `boxCount`, and `bytes` from the
shared result. TXT/CSV may call the new encoders, but all existing shift format versions and
filenames remain unchanged.

Add a regression assertion that rendering the same XML twice yields identical bytes and retain
the existing line-limit tests, especially the XML overhead and indivisible-box cases.

- [ ] **Step 5: Run focused and full domain tests**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run \
  test/gismt-aggregation.test.ts \
  test/document-text-encoding.test.ts \
  test/shift-exports.test.ts
pnpm --filter @markiro/domain test
```

Expected: PASS with all existing shift golden bytes unchanged.

- [ ] **Step 6: Commit the extraction**

```bash
git add packages/domain/src/gismt-aggregation.ts \
  packages/domain/src/document-text-encoding.ts \
  packages/domain/src/shift-exports.ts \
  packages/domain/test/gismt-aggregation.test.ts \
  packages/domain/test/document-text-encoding.test.ts \
  packages/domain/test/shift-exports.test.ts
git commit -m "refactor(domain): share GISMT document encoding"
```

### Task 2: Version the inventory format registry and publish the catalog

**Files:**

- Modify: `packages/domain/src/inventory/documents.ts`
- Modify: `packages/domain/src/inventory/index.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/inventory-documents.test.ts`

**Interfaces:**

- Produces: `InventoryDocumentRegistry.resolve(id, version)` for new selections only.
- Produces: `InventoryDocumentRegistry.resolveRegistered(id, version)` for stored runs.
- Produces: `getRegisteredInventoryDocumentFormat(id, version)` for the API generator registry.
- Produces: eight advertised descriptors and hidden `inventory_xml_gismt_aggregation@1`.

- [ ] **Step 1: Replace the current duplicate-id tests with version-aware failing tests**

Add these registry expectations:

```ts
const legacy = { ...availableDescriptor, version: 1, availability: "unavailable" } as const;
const current = { ...availableDescriptor, version: 2, availability: "available" } as const;
const registry = createInventoryDocumentRegistry([legacy, current]);

expect(registry.listAvailable()).toEqual([current]);
expect(registry.resolve(current.id, 2)).toEqual(current);
expect(() => registry.resolve(current.id, 1)).toThrowError(
  expect.objectContaining({ code: "FORMAT_SUPERSEDED" }),
);
expect(registry.resolveRegistered(current.id, 1)).toEqual(legacy);
expect(() => createInventoryDocumentRegistry([legacy, { ...legacy }])).toThrowError(
  expect.objectContaining({ code: "DUPLICATE_FORMAT_VERSION" }),
);
expect(() =>
  createInventoryDocumentRegistry([current, { ...current, version: 3 }]),
).toThrowError(expect.objectContaining({ code: "DUPLICATE_FORMAT_ID" }));
```

Assert `INVENTORY_DOCUMENT_FORMATS` has exactly the eight rows from the spec, with aggregation v2
and disaggregation v1 in the first two positions.

- [ ] **Step 2: Run the registry test and verify the old id-only map fails**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/inventory-documents.test.ts
```

Expected: FAIL on duplicate versions, missing `resolveRegistered`, and the two-row catalog.

- [ ] **Step 3: Implement exact-version storage and current-version selection**

Use a composite key and a current descriptor map:

```ts
function formatKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export interface InventoryDocumentRegistry {
  listAvailable(): readonly InventoryDocumentFormatDescriptor[];
  resolve(id: string, version: number): InventoryDocumentFormatDescriptor;
  resolveRegistered(id: string, version: number): InventoryDocumentFormatDescriptor;
}
```

Add `DUPLICATE_FORMAT_VERSION` to the stable registry errors. Keep unavailable-only ids returning
`FORMAT_UNAVAILABLE`, but return `FORMAT_SUPERSEDED` when the id has an advertised current version
and a different version was requested.

Define the hidden legacy descriptor separately and build `inventoryDocumentRegistry` from
`[legacyAggregationV1, ...INVENTORY_DOCUMENT_FORMATS]`. Export only the eight current descriptors
through `INVENTORY_DOCUMENT_FORMATS`.

- [ ] **Step 4: Run domain registry checks**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/inventory-documents.test.ts
pnpm --filter @markiro/domain typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the versioned catalog**

```bash
git add packages/domain/src/inventory/documents.ts \
  packages/domain/src/inventory/index.ts \
  packages/domain/src/index.ts \
  packages/domain/test/inventory-documents.test.ts
git commit -m "feat(domain): version inventory document catalog"
```

### Task 3: Add current final-box selection and aggregation v2

**Files:**

- Create: `packages/domain/src/inventory/document-selection.ts`
- Modify: `packages/domain/src/inventory/document-generators.ts`
- Modify: `packages/domain/src/inventory/index.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/inventory-document-generators.test.ts`

**Interfaces:**

- Consumes: `renderGismtAggregationXml` from Task 1.
- Produces: `selectEligibleInventoryFinalBoxes(source): EligibleInventoryFinalBox[]`.
- Produces: `generateInventoryAggregationXmlV2(source, metadata)`.
- Preserves: `generateInventoryAggregationXml` as the frozen metadata-rich v1 generator.

- [ ] **Step 1: Expand the source fixture and write failing eligibility tests**

Extend `InventoryDocumentGenerationSource` so each verified code has
`observedProductionDate: string | null` and each new box has `productionDate: string`.

Build fixtures covering closed/printed valid boxes plus open, empty, invalidated, pending, failed,
protected-member, missing-member, duplicate-member, missing-date, and date-mismatch boxes. Assert:

```ts
expect(selectEligibleInventoryFinalBoxes(source).map((box) => box.sscc)).toEqual([
  "046800899000256001",
]);
expect(selectEligibleInventoryFinalBoxes(source)[0]?.codes.map((code) => code.canonicalRaw)).toEqual(
  [km("SERIAL-A"), km("SERIAL-B")],
);
```

Add a v2 parity test that builds the same boxes through `renderShiftExport` and compares bytes:

```ts
const [inventoryPart] = generateInventoryAggregationXmlV2(source(), metadata);
const [shiftPart] = renderShiftExport({
  formatId: "shift_xml_gismt_aggregation",
  formatVersion: 1,
  productName: "ignored-for-bytes",
  shiftDate: "2026-08-27",
  maxLines: null,
  organizationInn: metadata.organizationInn,
  source: { mode: "boxes", boxes: eligibleBoxesAsShiftSource },
});
expect(inventoryPart?.bytes).toEqual(shiftPart?.bytes);
```

Keep the existing aggregation v1 golden assertion unchanged.

- [ ] **Step 2: Run the generator test and verify the new symbols fail**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run test/inventory-document-generators.test.ts
```

Expected: FAIL because source dates, the selector, and v2 generator do not exist.

- [ ] **Step 3: Implement the selector and v2 adapter**

Use these result shapes:

```ts
export interface EligibleInventoryFinalBox {
  sscc: string;
  oldSsccContext: string | null;
  productionDate: string;
  codes: readonly {
    codeHash: string;
    canonicalRaw: string;
    observedProductionDate: string;
  }[];
}
```

Sort boxes by normalized 18-digit stored SSCC and codes by `canonicalRaw`. Exclude the whole box
when any eligibility rule fails, but do not remove its independently verified codes from the
source. V2 passes eligible boxes to the common serializer and returns the existing inventory
filename with the shared metrics.

Keep aggregation v1 on its frozen helper and byte contract. Change disaggregation only to consume
eligible old contexts; its XML structure and existing golden bytes remain unchanged.

- [ ] **Step 4: Run generator and shift parity tests**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run \
  test/inventory-document-generators.test.ts \
  test/shift-exports.test.ts \
  test/gismt-aggregation.test.ts
```

Expected: PASS; aggregation v1 golden, aggregation v2 parity, and disaggregation v1 golden all hold.

- [ ] **Step 5: Commit current box selection and aggregation v2**

```bash
git add packages/domain/src/inventory/document-selection.ts \
  packages/domain/src/inventory/document-generators.ts \
  packages/domain/src/inventory/index.ts \
  packages/domain/src/index.ts \
  packages/domain/test/inventory-document-generators.test.ts
git commit -m "feat(domain): add inventory aggregation v2"
```

### Task 4: Implement all six tabular inventory generators

**Files:**

- Create: `packages/domain/src/inventory/tabular-document-generators.ts`
- Create: `packages/domain/test/inventory-tabular-document-generators.test.ts`
- Modify: `packages/domain/src/inventory/document-generators.ts`
- Modify: `packages/domain/src/inventory/index.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: `encodeLfText`, `encodeSemicolonCsv`, and `selectEligibleInventoryFinalBoxes`.
- Produces: `generateInventoryWriteOffTxt`, `generateInventoryWriteOffCsv`,
  `generateInventoryCurrentStockCsv`, `generateInventoryFinalBoxContentsCsv`,
  `generateInventoryFinalBoxesTxt`, and `generateInventoryBalancesByProductionDateCsv`.
- Produces: `inventoryDocumentFilenamePrefix(inventoryNumber): string` from
  `document-generators.ts` for every inventory artifact adapter.
- Expands: `InventoryDocumentGeneratedPart.mimeType` to the three declared MIME types.

- [ ] **Step 1: Write exact-byte failing tests for every format**

Use unsorted full canonical KMs containing `\u001d93crypto`. Assert the exact outputs:

```ts
expect(decode(generateInventoryWriteOffTxt(source, metadata)[0]!.bytes)).toBe(
  `${km("MISSING-A")}\n${km("MISSING-B")}\n`,
);
expect(decodeCsv(generateInventoryCurrentStockCsv(source, metadata)[0]!.bytes)).toBe(
  `code\r\n${km("VERIFIED-A")}\r\n${km("VERIFIED-B")}\r\n`,
);
expect(decodeCsv(generateInventoryFinalBoxContentsCsv(source, metadata)[0]!.bytes)).toBe(
  `box_sscc;code\r\n00046800899000256001;${km("VERIFIED-A")}\r\n`,
);
expect(decode(generateInventoryFinalBoxesTxt(source, metadata)[0]!.bytes)).toBe(
  "00046800899000256001\n",
);
expect(decodeCsv(generateInventoryBalancesByProductionDateCsv(source, metadata)[0]!.bytes)).toBe(
  "production_date;code_count;box_count\r\n2026-08-08;1;1\r\n2026-08-09;1;0\r\n",
);
```

For empty sources, assert TXT byte length `0`, CSV BOM plus header, and exact row/code/box counts.
Assert that protected, ineligible, unknown, voided, and ineligible-box rows never appear. Assert a
verified code with `observedProductionDate: null` throws
`InventoryDocumentGenerationError("VERIFIED_PRODUCTION_DATE_MISSING")`.

- [ ] **Step 2: Run the tabular test and verify missing generators fail**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run \
  test/inventory-tabular-document-generators.test.ts
```

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement deterministic generators and metrics**

Each generator returns one part with this exact contract:

| Function | Filename suffix | Header | Empty bytes |
| --- | --- | --- | --- |
| `generateInventoryWriteOffTxt` | `-write-off.txt` | none | zero bytes |
| `generateInventoryWriteOffCsv` | `-write-off.csv` | `code` | BOM plus `code\r\n` |
| `generateInventoryCurrentStockCsv` | `-current-stock.csv` | `code` | BOM plus `code\r\n` |
| `generateInventoryFinalBoxContentsCsv` | `-final-box-contents.csv` | `box_sscc;code` | BOM plus `box_sscc;code\r\n` |
| `generateInventoryFinalBoxesTxt` | `-final-boxes.txt` | none | zero bytes |
| `generateInventoryBalancesByProductionDateCsv` | `-balances-by-production-date.csv` | `production_date;code_count;box_count` | BOM plus header and CRLF |

Rename and export the existing private filename helper as:

```ts
export function inventoryDocumentFilenamePrefix(inventoryNumber: string): string;
```

Prefix each suffix with that sanitized `inventory-<number>` value. Import shared generation types,
errors, metadata, and this filename helper from `document-generators.ts` using type-only imports
where applicable. Metrics are:

```ts
// code list CSV
{ rowCount: 1 + codes.length, codeCount: codes.length, boxCount: 0 }
// final box contents CSV
{ rowCount: 1 + rows.length, codeCount: rows.length, boxCount: boxes.length }
// final boxes TXT
{ rowCount: boxes.length, codeCount: 0, boxCount: boxes.length }
// balances CSV
{
  rowCount: 1 + dates.length,
  codeCount: sum(code_count),
  boxCount: sum(box_count),
}
```

Validate production dates with `^\d{4}-\d{2}-\d{2}$`, then group `source.verified` directly. Do not
read `observedDateGroups`.

- [ ] **Step 4: Run the complete inventory domain suite**

Run:

```bash
pnpm --filter @markiro/domain exec vitest run \
  test/inventory-tabular-document-generators.test.ts \
  test/inventory-document-generators.test.ts \
  test/inventory-documents.test.ts
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: PASS.

- [ ] **Step 5: Commit the tabular generators**

```bash
git add packages/domain/src/inventory/tabular-document-generators.ts \
  packages/domain/src/inventory/document-generators.ts \
  packages/domain/src/inventory/index.ts \
  packages/domain/src/index.ts \
  packages/domain/test/inventory-tabular-document-generators.test.ts
git commit -m "feat(domain): generate inventory operational reports"
```

### Task 5: Permit zero-byte TXT artifacts in PostgreSQL

**Files:**

- Modify: `packages/db/src/schema/inventory.ts`
- Create: `packages/db/migrations/0084_inventory_document_artifact_empty_files.sql`
- Create: `packages/db/migrations/meta/0084_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/inventory-schema.test.ts`
- Create: `packages/db/test/inventory-document-artifact-empty-file-migration.test.ts`

**Interfaces:**

- Produces: database invariant `inventory_document_artifacts.byte_size >= 0`.
- Preserves: every other artifact constraint, FK, unique key, and existing positive row.

- [ ] **Step 1: Write failing schema and connected migration tests**

Change the schema test to require the named constraint
`inventory_document_artifacts_byte_size_nonnegative_check`.

The connected test must copy migrations through index 83, migrate the scratch database, verify the
old positive constraint, apply all migrations, and then probe the new check without weakening FKs:

```ts
await pool.query(`
  CREATE TEMP TABLE artifact_size_probe
  (LIKE inventory_document_artifacts INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
`);
await pool.query(`
  INSERT INTO artifact_size_probe
    (id, tenant_id, run_id, format_id, format_version, part_number, filename, mime_type,
     row_count, code_count, box_count, byte_size, sha256, object_key)
  VALUES
    ('00000000-0000-4000-8000-000000000001', 'probe',
     '00000000-0000-4000-8000-000000000002', 'inventory_txt_write_off', 1, 1, 'empty.txt',
     'text/plain; charset=utf-8', 0, 0, 0, 0, repeat('0', 64), 'probe/empty')
`);
await expect(
  pool.query(`UPDATE artifact_size_probe SET byte_size = -1`),
).rejects.toMatchObject({ code: "23514" });
```

- [ ] **Step 2: Run the focused DB tests and verify they fail**

Run:

```bash
pnpm --filter @markiro/db exec vitest run \
  test/inventory-schema.test.ts \
  test/inventory-document-artifact-empty-file-migration.test.ts
```

Expected: schema test FAIL; connected test either FAIL before migration exists or explicitly SKIP if
`DATABASE_URL` is absent. A skip is not acceptance.

- [ ] **Step 3: Change the Drizzle check and generate migration 0084**

Change only:

```ts
check(
  "inventory_document_artifacts_byte_size_nonnegative_check",
  sql`${table.byteSize} >= 0`,
),
```

Generate the migration rather than hand-editing metadata:

```bash
pnpm --filter @markiro/db db:generate --name inventory_document_artifact_empty_files
```

Inspect the SQL and retain only the expected forward change:

```sql
ALTER TABLE "inventory_document_artifacts"
  DROP CONSTRAINT "inventory_document_artifacts_byte_size_positive_check";
ALTER TABLE "inventory_document_artifacts"
  ADD CONSTRAINT "inventory_document_artifacts_byte_size_nonnegative_check"
  CHECK ("inventory_document_artifacts"."byte_size" >= 0);
```

- [ ] **Step 4: Run DB verification against a disposable Postgres**

Load the local test environment without overwriting `.env`, point `DATABASE_URL` at a disposable
database, then run:

```bash
pnpm --filter @markiro/db exec vitest run \
  test/inventory-schema.test.ts \
  test/inventory-document-artifact-empty-file-migration.test.ts
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

Expected: PASS with no database-backed skips in the focused migration test.

- [ ] **Step 5: Commit the forward migration**

```bash
git add packages/db/src/schema/inventory.ts \
  packages/db/migrations/0084_inventory_document_artifact_empty_files.sql \
  packages/db/migrations/meta/0084_snapshot.json \
  packages/db/migrations/meta/_journal.json \
  packages/db/test/inventory-schema.test.ts \
  packages/db/test/inventory-document-artifact-empty-file-migration.test.ts
git commit -m "feat(db): allow empty inventory TXT artifacts"
```

### Task 6: Register exact generator versions and validate empty artifacts in the API runner

**Files:**

- Modify: `apps/api/src/modules/inventories/inventory-document-runner.service.ts`
- Modify: `apps/api/src/modules/inventories/inventory-documents.service.ts`
- Modify: `apps/api/src/modules/inventories/dto.ts`
- Modify: `apps/api/test/inventory-document-runner.test.ts`
- Create: `apps/api/test/inventory-documents-openapi.test.ts`

**Interfaces:**

- Consumes: all domain descriptors and generators from Tasks 2–4.
- Produces: `InventoryDocumentGeneratorRegistry.resolveForSelection` and
  `resolveForExecution` keyed by id/version.
- Produces: explicit `allowsZeroByteArtifact?: true` only for the two TXT generators.
- Produces: safe run error `VERIFIED_PRODUCTION_DATE_MISSING`.

- [ ] **Step 1: Write failing runner and contract tests**

Add assertions that production `listAvailable()` returns eight formats, new selection rejects
aggregation v1, and execution resolves both aggregation versions:

```ts
expect(registry.resolveForSelection("inventory_xml_gismt_aggregation", 2)).toBeDefined();
expect(() => registry.resolveForSelection("inventory_xml_gismt_aggregation", 1)).toThrowError(
  expect.objectContaining({ code: "FORMAT_SUPERSEDED" }),
);
expect(registry.resolveForExecution("inventory_xml_gismt_aggregation", 1)).toBeDefined();
```

Add one valid zero-byte synthetic TXT generator:

```ts
{
  descriptor: txtDescriptor,
  allowsZeroByteArtifact: true,
  generate: async () => [{
    partNumber: 1,
    filename: "empty.txt",
    mimeType: "text/plain; charset=utf-8",
    bytes: new Uint8Array(),
    rowCount: 0,
    codeCount: 0,
    boxCount: 0,
  }],
}
```

Assert the runner publishes it, while zero bytes without the flag or with non-zero metrics fails
before storage. Add an empty artifact to the ZIP test and assert its manifest SHA-256 is
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Add a generator that throws
`InventoryDocumentGenerationError("VERIFIED_PRODUCTION_DATE_MISSING")`; assert the runner stores
that exact safe error code on the failed run and uploads nothing.

In the OpenAPI test, assert `inventoryDocumentArtifactOpenApiSchema.properties.byteSize.minimum`
is `0`; in DTO parsing, accept `0` and reject `-1`.

- [ ] **Step 2: Run focused API unit tests and confirm failures**

Run after rebuilding DB and domain:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/domain build
pnpm --filter @markiro/api exec vitest run \
  test/inventory-document-runner.test.ts \
  test/inventory-documents-openapi.test.ts
```

Expected: FAIL on id-only resolution, missing production generators, zero-byte rejection, and
OpenAPI minimum 1.

- [ ] **Step 3: Implement exact registry resolution and production registration**

Key generators by:

```ts
const generatorKey = (id: string, version: number) => `${id}@${version}`;
```

Register nine executable generators: hidden aggregation v1, advertised aggregation v2,
disaggregation v1, and six tabular v1 generators. `listAvailable()` returns only the eight current
descriptors. `InventoryDocumentsService.create()` calls `resolveForSelection`; the runner calls
`resolveForExecution` for the already stored selection.

Change generated-part validation to allow `bytes.byteLength === 0` only when
`allowsZeroByteArtifact === true`, MIME is `text/plain; charset=utf-8`, and all three counts are
zero. Keep filename, MIME, part, collision, and non-negative metric validation unchanged.

Map only `InventoryDocumentGenerationError("VERIFIED_PRODUCTION_DATE_MISSING")` to the matching
safe run error. All other generator validation faults stay `GENERATION_FAILED`.

- [ ] **Step 4: Align API artifact DTO and OpenAPI**

Change both boundaries from minimum 1 to minimum 0:

```ts
byteSize: z.number().int().min(0)
// OpenAPI
byteSize: { type: "integer", minimum: 0 }
```

- [ ] **Step 5: Run focused runner checks**

```bash
pnpm --filter @markiro/api exec vitest run \
  test/inventory-document-runner.test.ts \
  test/inventory-documents-openapi.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit runner integration**

```bash
git add apps/api/src/modules/inventories/inventory-document-runner.service.ts \
  apps/api/src/modules/inventories/inventory-documents.service.ts \
  apps/api/src/modules/inventories/dto.ts \
  apps/api/test/inventory-document-runner.test.ts \
  apps/api/test/inventory-documents-openapi.test.ts
git commit -m "feat(api): run versioned inventory document generators"
```

### Task 7: Prove the catalog and all-format production journey

**Files:**

- Modify: `apps/api/test/inventory-document-formats.e2e.test.ts`
- Modify: `apps/api/test/inventory-document-formats-openapi.test.ts`
- Modify: `apps/api/test/inventory-documents.e2e.test.ts`

**Interfaces:**

- Consumes: the production registry and frozen result source.
- Proves: eight-format catalog, hidden v1 execution, all selected artifacts, ZIP v1, exclusions,
  empty reports, retries, revisions, and tenant boundaries.

- [ ] **Step 1: Update the exact catalog e2e fixture**

Replace the two-item fixture with all eight descriptors in production order. Keep the strict
OpenAPI property list and tenant capability tests. Add:

```ts
await agent
  .post(`/inventories/${closedInventoryId}/document-runs`)
  .send({
    selectedFormats: [{ id: "inventory_xml_gismt_aggregation", version: 1 }],
    idempotencyKey: randomUUID(),
  })
  .expect(400, { code: "INVENTORY_DOCUMENT_FORMAT_SUPERSEDED" });
```

- [ ] **Step 2: Expand the production acceptance selection and exact assertions**

Make `productionBody()` select the eight current versions. The existing journey already produces
two eligible verified codes on `2026-08-08` and `2026-08-09`, two eligible new boxes on those
dates, one protected `MOVING_BY_UD` code, and one missing expected loose code.

Assert the new run publishes exactly eight artifacts, with exact bodies:

```ts
expect(text("inventory_txt_write_off")).toBe(`${expectedLooseRaw}\n`);
expect(csv("inventory_csv_write_off")).toBe(`code\r\n${expectedLooseRaw}\r\n`);
expect(csv("inventory_csv_current_stock")).toBe(
  `code\r\n${cleanEligibleRaw}\r\n${sharedEligibleRaw}\r\n`,
);
expect(csv("inventory_csv_balances_by_production_date")).toBe(
  "production_date;code_count;box_count\r\n2026-08-08;1;1\r\n2026-08-09;1;1\r\n",
);
```

Assert box contents and box-number TXT contain both `00`-prefixed new SSCCs, aggregation is rooted
at plain `<unit_pack>` with only `LP_TIN`, disaggregation contains only the clean old SSCC, and no
artifact contains the protected serial.

Update ZIP assertions to compare all eight artifact entries, exact versions, hashes, metrics, and
bytes under `schemaVersion: 1`.

- [ ] **Step 3: Add hidden-v1 and empty-tabular scenarios**

Insert a frozen closed-revision run row selecting aggregation v1 directly in the test database,
execute it through the runner, and compare its artifact bytes to the checked-in v1 golden. This
proves history/retry execution without allowing new v1 creation.

Seed a failed current-revision run with `VERIFIED_PRODUCTION_DATE_MISSING` and assert
`POST /inventory-document-runs/:runId/retry` returns
`409 INVENTORY_DOCUMENT_RUN_NOT_RETRYABLE`.

Create a closed inventory with no verified codes, write-off candidates, or final boxes; select all
six tabular formats, execute the run, and assert:

```ts
expect(emptyTxt.byteSize).toBe(0);
expect(objects.get(emptyTxt.objectKey)).toEqual(Buffer.alloc(0));
expect(stripBom(objects.get(emptyWriteOffCsv.objectKey)!)).toBe("code\r\n");
expect(stripBom(objects.get(emptyCurrentStockCsv.objectKey)!)).toBe("code\r\n");
expect(stripBom(objects.get(emptyBoxContentsCsv.objectKey)!)).toBe("box_sscc;code\r\n");
expect(stripBom(objects.get(emptyBalancesCsv.objectKey)!)).toBe(
  "production_date;code_count;box_count\r\n",
);
expect(run.status).toBe("ready");
```

Separately select aggregation XML together with current-stock CSV on that same result and assert
the run becomes `failed` with no artifact rows or stored partial files. Retain existing
cross-tenant download denial.

- [ ] **Step 4: Run connected API acceptance**

Point `DATABASE_URL` and `INVENTORY_TEST_DATABASE_URL` at the disposable migrated Postgres and load
the existing auth/object-storage test variables, then run:

```bash
pnpm --filter @markiro/api exec vitest run \
  test/inventory-document-formats-openapi.test.ts \
  test/inventory-document-formats.e2e.test.ts \
  test/inventory-document-runner.test.ts \
  test/inventory-result-source.test.ts \
  test/inventory-documents.e2e.test.ts
```

Expected: PASS with no database-backed skips in the three connected inventory suites.

- [ ] **Step 5: Commit API acceptance**

```bash
git add apps/api/test/inventory-document-formats.e2e.test.ts \
  apps/api/test/inventory-document-formats-openapi.test.ts \
  apps/api/test/inventory-documents.e2e.test.ts
git commit -m "test(api): prove inventory operational document package"
```

### Task 8: Finish the catalog-driven Admin contract

**Files:**

- Modify: `apps/admin/src/pages/inventory/schemas.ts`
- Modify: `apps/admin/src/pages/inventory/InventoryDocuments.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/inventory-documents.test.tsx`

**Interfaces:**

- Consumes: the server-provided format label/id/version/MIME and non-negative artifact size.
- Produces: localized explanation for `VERIFIED_PRODUCTION_DATE_MISSING`.
- Preserves: generic dynamic checkboxes, individual/ZIP download, retry, history, and completion.

- [ ] **Step 1: Write failing Admin contract tests**

Return multiple new server descriptors from the test fetch mock and assert their labels render
without a client-side id list. Select two and assert the POST keeps exact versions:

```ts
expect(body.selectedFormats).toEqual([
  { id: "inventory_csv_current_stock", version: 1 },
  { id: "inventory_csv_balances_by_production_date", version: 1 },
]);
```

Return a ready zero-byte TXT artifact and assert the page displays `0 байт` and keeps both download
buttons available. Return a failed run with `errorCode: "VERIFIED_PRODUCTION_DATE_MISSING"` and
assert the Russian actionable message:

```text
У проверенных кодов не указана дата производства. Возобновите инвентаризацию, исправьте даты и сформируйте документы заново.
```

- [ ] **Step 2: Run the Admin test and confirm schema/message failures**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/inventory-documents.test.tsx
```

Expected: FAIL because `byteSize: 0` is rejected and the run error is not localized.

- [ ] **Step 3: Accept zero bytes and localize the safe run error**

Change the Admin artifact parser to:

```ts
byteSize: z.number().int().min(0)
```

Add a pure mapping used by the failed-run alert:

```ts
function runFailureMessage(code: string | null, t: TFunction): string {
  if (code === "VERIFIED_PRODUCTION_DATE_MISSING") {
    return t("pages.inventory.documents.errors.verifiedProductionDateMissing");
  }
  return t("pages.inventory.documents.failed", { code: code ?? "UNKNOWN" });
}
```

Add equivalent Russian and English translation keys. Do not add format ids, labels, or special
checkbox branches to Admin.

- [ ] **Step 4: Run Admin package gates**

```bash
pnpm --filter @markiro/admin exec vitest run test/inventory-documents.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: PASS.

- [ ] **Step 5: Commit the Admin contract**

```bash
git add apps/admin/src/pages/inventory/schemas.ts \
  apps/admin/src/pages/inventory/InventoryDocuments.tsx \
  apps/admin/src/i18n/ru.json \
  apps/admin/src/i18n/en.json \
  apps/admin/test/inventory-documents.test.tsx
git commit -m "feat(admin): expose inventory operational documents"
```

## Final Verification

- [ ] Rebuild shared consumers before broad checks:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/domain build
```

- [ ] Run affected package gates:

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

- [ ] Run repository integrity checks:

```bash
git diff --check
pnpm format:check
```

- [ ] If `graphify-out/graph.json` exists in the execution checkout, update the local graph and
verify the new dependency path:

```bash
graphify update .
graphify path "InventoryDocuments" "renderGismtAggregationXml"
```

- [ ] Review the final diff against the spec and record external limits explicitly: no live
Chestny ZNAK upload, production S3, Windows Station, scanner, or printer acceptance was performed.

- [ ] Confirm the final gates did not modify tracked source. If a formatter changes a file, return
to the task that owns that exact file, inspect the change, rerun that task's checks, and amend that
task's scoped commit. Do not create an empty verification commit.
