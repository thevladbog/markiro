# US-07 — FDA-aligned XLSX export adapter and field registry — Design Spec

**Date:** 2026-09-03

**Status:** Draft for review (not implemented)

**Slice:** US-07 from docs/us/implementation-plan.md; depends on US-06 (trace query result, completeness findings) and US-03…US-05 (finalized snapshots of the three CTEs); consumed by US-09 (export runs, package ZIP) and US-11 (evidence)

**Requirements:** EXP-001, EXP-002, EXP-003, EXP-004, EXP-005, EXP-006, EXP-007, EXP-008, EXP-009 (P1), EXP-010, EXP-011, EXP-012; touches NFR-008, NFR-009, NFR-010, REG-001 (baseline printed in exports)

**Related:**

- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR; conflict 4 ("no XLSX writer dependency exists; US-07 selects a macro-free library").
- `docs/superpowers/specs/2026-09-03-us-06-trace-search-completeness-design.md` — `TraceResult`, `CompletenessFinding`, provenance.
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — baseline ID `US-REG-2026-09-03`, `traceability.export.read`, `RequireTraceabilityProfile` guard.
- `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md` — `ProductDescriptionSnapshot`, `UOM_CODES_V1`, `EXPORT_BLOCKING_COVERAGE`.
- `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md` — `traceability_events` revisions, `location_snapshot`, `traceability_event_documents.document_number_snapshot`; `2026-09-03-us-04-transformation-design.md`, `2026-09-03-us-05-shipping-design.md`.
- `docs/superpowers/specs/2026-09-03-us-08-traceability-plan-design.md` — plan PDF sibling artifact (`pdf_sha256`, `pdf_renderer_version`, `config_digest`).
- `docs/superpowers/specs/2026-09-03-us-09-trace-request-design.md` — `trace_export_runs`, `trace_export_artifacts`, package ZIP, download endpoint.
- `docs/us/data-dictionary.md` §7 (KDE dictionary, "Field registry" note), `docs/us/regulatory-basis.md` ("Electronic sortable spreadsheet", sources FDA-03, FDA-05), `docs/us/acceptance.md` §1, §2.5, §4, rows C-011, C-014, `docs/us/limitations.md` (allowed wording), `docs/us/demo-scenario.md` §5.

## Problem

The trace request package (RQ-006) needs an FDA-aligned electronic sortable spreadsheet built from finalized snapshots, reproducible from a request revision, free of macros and external links, and honest about gaps. Today every export in the repository is a shift code list (`txt`/`csv`/`xml`) and nothing writes XLSX. R-06 in the implementation plan ("export diverges from FDA template") is mitigated only if headers, KDE mapping, validation rules and the data dictionary come from one versioned registry rather than from UI code, and if golden fixtures are reviewed instead of regenerated.

## Key facts of the codebase

- Export pipeline precedent: `apps/api/src/modules/shift-exports/` — `shift-exports.service.ts` creates a `shift_exports` row inside a transaction with an idempotency key (`shift_exports_tenant_idempotency_uq` on `(tenant_id, created_by_user_id, idempotency_key)`), writes `tenant_audit_events` (`shift_export.created|retried|failed|downloaded`, `targetType: "shift_export"`, `after` with tenant/actor/format/outcome), then enqueues through `PgBossService.enqueueShiftExport` (`apps/api/src/jobs/jobs.module.ts`, queue `BUILD_SHIFT_EXPORT_QUEUE = "build-shift-export"`, startup reconciliation of `queued` rows). `shift-export-runner.service.ts` claims the row with an attempt-count fence and a 20 s lease, renders through the domain, uploads each part with `ObjectStorageService.putVerified` (SHA-256 checked against the body and the stored `Metadata.sha256`), inserts `shift_export_artifacts` (`filename, mimeType, byteSize, sha256, objectKey`, `sha256 ~ '^[0-9a-f]{64}$'` check in `packages/db/src/schema/shift-exports.ts`), and maps domain errors to a safe code list (`SHIFT_EXPORT_SAFE_ERROR_CODES`). Download is a 300 s presigned URL (`presignRead`, `ResponseContentDisposition` with RFC 5987 filename).
- Format adapter pattern: `packages/domain/src/shift-exports.ts` — frozen `SHIFT_EXPORT_FORMATS` descriptors `{ id, version, label, extension, mimeType, boxMode }`, `LEGACY_SHIFT_EXPORT_FORMATS` kept so old versions re-render byte-identically, `getShiftExportFormat(id, version)`, `renderShiftExport(input) → ShiftExportPart[]` returning `bytes: Uint8Array`, `ShiftExportDomainError` with a literal `code` union, `sanitizeShiftExportFilenameSegment`. Encoding helpers in `packages/domain/src/document-text-encoding.ts`: `encodeSemicolonCsv` (semicolon, CRLF, UTF-8 BOM — the Russian Excel convention), `encodeLfText`, `createUtf8ByteComparator`.
- Object storage: `apps/api/src/modules/storage/object-storage.service.ts` — `assertSafeKey` accepts only `users/…`, `tenants/…` and billing keys; `get()` caps private reads at `MAX_PRIVATE_OBJECT_BYTES = 5 MiB` unless `maxBytes` is passed; `putVerified` returns `{ byteSize, sha256 }`.
- Deterministic ZIP precedent: `apps/api/src/modules/inventories/inventory-document-runner.service.ts` builds a package with `fflate` `zipSync(entries, { level: 9, mtime: ZIP_MTIME })`, `ZIP_MTIME = new Date(2000, 0, 1)`, and a `manifest.json` of `{ schemaVersion, runId, resultRevision, artifacts: [{ name, mimeType, bytes, sha256, rowCount, … }] }`. `fflate 0.8.3` is already a dependency of `apps/api` and `packages/legal-documents`.
- Manifest and verification precedents: `packages/legal-documents/src/cli/generate-artifacts.ts` writes `artifacts.json` via `canonicalArtifactManifest` with `{ code, revision, locale, kind, fileName, bytes, sha256, mediaType, generator }` entries (`PublishedLegalArtifact` in `verify-artifacts.ts`), verified by `verify-artifacts.ts` (`--out-dir`, size caps, SHA regex, exact-key checks) and pinned in `deploy/production/legal-artifacts-attestation.json` (`manifestSha256` + per-PDF sha256). `tools/evidence-package/` (`seal.mjs`, `verify.mjs`, `evidence-package.mjs`) hashes every regular file into `manifest.json` artifacts `{ path, category, byteSize, sha256, capturedAt, actor, … }` with `MAX_MANIFEST_BYTES` and canonical key ordering.
- No XLSX dependency exists: `grep` over every `package.json` (excluding `node_modules`) for `xlsx`, `exceljs`, `sheetjs`, `write-excel-file`, `xlsx-populate` finds nothing; `pnpm-lock.yaml` has no such importer. XML is already hand-rendered in `packages/domain/src/gismt-aggregation.ts` (`renderGismtAggregationXml`) and parsed with `fast-xml-parser` in `apps/api`.
- Golden-test precedents: `packages/domain/test/shift-exports.test.ts` asserts exact bytes and filenames; `packages/legal-documents/test/artifact-manifest.test.ts` builds fixtures with computed `sha256`; label stock templates are drift-tested against `packages/domain/src/labels/defaults.ts`.
- Dependency policy (`AGENTS.md`): exact versions, `pnpm check:deps` baseline, release-age guard, no hand-edited lockfile; LibreOffice `26.2.5` and veraPDF are used via Docker for legal PDFs (`verify-artifacts.ts`).
- Tenant timezone lives in `org_profiles.time_zone` with a `Europe/Moscow` fallback in `dashboard.repository.ts`; the U.S. profile (US-00, OQ-US00-2) requires an explicit IANA zone.
- From the sibling specs (parallel drafts, verify before implementation): US-00 adds `traceability.export.read` and the `RequireTraceabilityProfile` guard (403 `traceability_profile_required`), but defines no software-version helper (see OQ-US07-10). US-02 defines `ProductDescriptionSnapshot` (`productName, brandName, commodity, variety, packagingSize { value, uom }, packagingStyle, gtin, snapshotVersion: 1`), `UOM_CODES_V1` without conversions and `EXPORT_BLOCKING_COVERAGE = ["unknown", "exemption_review_required"]`. US-03 gives every event `revision`, `root_event_id`, `superseded_by_event_id`, `amendment_reason`, `void_reason`, `location_snapshot` and per-link `document_type_snapshot`/`document_number_snapshot`, and leaves the CTE date column placement open (OQ-US03-1). US-08 stores `pdf_sha256` and `pdf_renderer_version` on plan versions, the naming the manifest entries follow.

## Design

### Data model

US-07 owns no table. It produces artifacts that US-09 stores in `trace_export_artifacts` (assumed columns mirror `shift_export_artifacts`: `filename, media_type, byte_size, sha256, object_key`, plus US-09's `trace_export_artifact_kind` enum `xlsx|csv_zip|canonical_json|validation_report|plan_pdf|request_report|manifest|package_zip` and `trace_export_runs.field_registry_version`). The only persistent data owned here is code: the registry, fixtures and generated documentation. Object keys follow `tenants/<tenantId>/traceability/exports/<runId>/attempt-<n>/<filename>` so `assertSafeKey` accepts them.

### Domain rules

`packages/domain/src/traceability/export-registry/` (pure, exported from `@markiro/domain`):

- `registry.v1.ts` — `TRACE_EXPORT_REGISTRY_V1` (frozen):

```ts
interface ExportFieldDef {
  key: string; // stable snake_case id, e.g. "receiving_location_city"
  header: string; // column header as printed
  sheet: "receiving" | "transformation" | "shipping";
  kdeGroup: string; // data-dictionary §7.3–7.5 group, e.g. "Receiving location"
  kdeName: string; // official KDE wording
  sourceRef: { section: "FDA-03" | "FDA-05"; note: string }; // EXP-004
  type: "text" | "date" | "decimal" | "integer" | "uom" | "boolean" | "identifier";
  required: "yes" | "if_applicable" | "no"; // data-dictionary P0 column
  path: string; // accessor into the canonical row model
  definition: string; // Definitions tab and generated data dictionary
  width: number;
}
interface TraceExportRegistry {
  id: "fda_sortable_xlsx";
  version: 1;
  baselineVersion: "US-REG-2026-09-03";
  sheets: { key; title; cte; fields: ExportFieldDef[] }[];
  metadataFields: MetadataFieldDef[]; // EXP-007 list
  validationColumns: ExportFieldDef[]; // EXP-006 list
}
```

`registryHash()` = SHA-256 of the canonical JSON of the registry (sorted keys, `@noble/hashes` already in domain). The hash is printed in Metadata and pinned by a test; changing any header, mapping or rule changes the hash and forces the EXP-012 review (see Testing).

- Composite descriptions are split per data-dictionary §7.1/§7.2 (EXP-003): each Location Description yields `*_business_name, *_phone_number, *_address_type (street|coordinates), *_street_address_or_coordinates, *_city, *_state_or_region, *_zip_or_postal_code, *_country, *_gln, *_ffrn, *_source_reference_url`; each Product Description yields `*_product_name, *_brand_name, *_commodity, *_variety, *_packaging_size_value, *_packaging_size_uom, *_packaging_style, *_gtin`. Quantities are two columns `quantity` (decimal) + `unit_of_measure` (uom) with no conversion (NFR-009).
- `rows/*.ts` — `buildReceivingRows`, `buildTransformationRows`, `buildShippingRows` map current-revision finalized/amended snapshots (input type = US-06 `TraceResult` events plus the event item snapshots loaded by the caller) to `CanonicalRow` objects keyed by registry `path`s. Row order is deterministic: `(event_date asc, event_id asc, item_sequence asc)`; for transformation one row per genealogy edge (input lot × output lot) carrying both input and output columns plus `transformation_completed_date` and references (OQ-US07-3). Every row carries `event_id`, `event_revision`, `source_record` (`<table>:<uuid>`) and `lot_id` as the last columns of each CTE tab, so TRC-009 provenance is in the workbook itself.
- Normalization (EXP-005, NFR-008): stored ISO values are written as typed date cells (`yyyy-mm-dd` number format, serial computed from the ISO date, no time zone shift because event dates are civil dates); timestamps (only in Metadata) print as ISO-8601 UTC plus the tenant local time with its IANA zone. Decimals are written as numeric cells when they fit 15 significant digits, otherwise as text with a `DECIMAL_AS_TEXT` info finding. Text is NFC-normalized, trimmed, control characters removed; nothing else is rewritten (phone extensions preserved per §7.1).
- `validation/*.ts` — the Validation tab rows come from (1) US-06 `runReadinessSweep` findings restricted to the export scope and (2) export-time findings owned here: `ROW_EXCLUDED_VOID`, `ROW_EXCLUDED_DRAFT`, `ROW_SUPERSEDED_BY_AMENDMENT`, `DECIMAL_AS_TEXT`, `FIELD_TRUNCATED_32767` (Excel cell limit), `EMPTY_TAB_IN_SCOPE`. Nothing is dropped silently: an excluded record still produces a Validation row with its `source_record` (EXP-006). Columns: `row_ref` (`Receiving!7`), `sheet`, `record_type`, `event_id`, `event_revision`, `lot_id`, `field`, `severity` (`error|warning|info`), `code`, `message`, `source_record`.
- `metadata.ts` — EXP-007 fields: `tenant_name` (or demo name), `profile_code`, `regulatory_baseline_id`, `sources_last_checked_at`, `request_id`, `request_revision`, `request_scope` (product, date range, TLC list, locations as one JSON string plus one line each), `time_zone`, `generated_at_utc`, `generated_at_local`, `software_version` (git SHA + `@markiro/api` version from US-00's version exposure), `registry_id`, `registry_version`, `registry_hash`, `row_count_<tab>`, `errors_count`, `warnings_count`, `infos_count`, `disclaimer` (allowed wording only, so the US-00 content test passes without negation parsing: "Designed to support applicable FSMA 204 recordkeeping requirements. Traceability readiness demonstrator. Prepared locally; not submitted to FDA. Coverage and exemption status are manual, reviewed classifications."), `prepared_by` (actor display name only, NFR-002).
- `workbook-model.ts` — `buildTraceWorkbookModel(source, registry, clock)` returns a library-independent `WorkbookModel` (`sheets: { name, columns, rows: Cell[][], freezeHeader: true, autoFilter: true }`); tab order Metadata, Definitions, Receiving, Transformation, Shipping, Validation (EXP-002; CTE tabs are those enabled by the profile, an in-scope empty tab is kept with its header and an `EMPTY_TAB_IN_SCOPE` info row).
- `canonical-json.ts` (EXP-009) — `encodeCanonicalTraceExport(model)`: sorted keys, `\n`, ISO strings, same row ids as the workbook. The `validation_report` artifact (`validation.json`, RQ-006) is the Validation tab rows in the same canonical encoding, so the report and the tab can never disagree. `csv.ts` — `encodeCommaCsvRows` (RFC 4180, comma, CRLF, UTF-8 without BOM; OQ-US07-5), one file per tab, zipped by the caller.
- `manifest.ts` (EXP-008) — `buildTraceExportManifest(entries)` → `{ schemaVersion: 1, packageId, requestId, requestRevision, exportRunId, generatedAt, inputDigest, softwareVersion, registry: { id, version, hash }, regulatoryBaseline, artifacts: [{ name, kind, byteSize, mediaType, sha256 }] }` (keys `inputDigest`/`softwareVersion` per US-09 OQ-US09-20) with the same artifact field names as the evidence tooling; `verifyTraceExportManifest(manifest, files)` returns `{ ok, mismatches[] }` and is pure so both the API job and a CLI can use it.
- `data-dictionary.ts` — `renderExportDataDictionaryMarkdown(registry)` produces the table that is committed as `docs/us/export-data-dictionary.md` (EXP-004 acceptance: source section + adapter version per column).
- Errors: `TraceExportDomainError` codes `REGISTRY_NOT_FOUND`, `SCOPE_EMPTY`, `SNAPSHOT_NOT_FINALIZED`, `UNSUPPORTED_PROFILE`, `CELL_LIMIT_EXCEEDED`.

### Contracts and API

- `packages/platform-contracts/src/traceability/export.ts` — `traceExportManifestSchema`, `traceExportCanonicalSchema`, `traceExportValidationRowSchema`, `traceExportMetadataSchema`, `traceExportArtifactKindSchema` (all `.strict()`), reused by US-09's run/artifact DTOs and by the verify CLI.
- No new HTTP endpoint in US-07. `apps/api/src/modules/traceability/export/` provides `TraceExportAdapterService.render(input): Promise<RenderedTraceExport>` where `RenderedTraceExport = { artifacts: { kind, filename, mediaType, bytes, sha256, byteSize }[], findings, manifestEntries, timings }` and the XLSX byte writer `xlsx-writer.ts` (see library choice). US-09's runner (modeled on `ShiftExportRunnerService`: claim, lease, `putVerified`, artifact rows, safe error codes, audit `trace_export_run.completed|failed` with `registryVersion`, `registryHash`, `errorsCount`, `warningsCount`) calls this service inside its pg-boss job; the adapter itself is synchronous and deterministic given `clock` and `softwareVersion`.
- Ad-hoc CLI (developer/evidence, not a tenant feature): `pnpm --filter @markiro/api traceability:export-fixture --fixture <name> --out <dir>` renders the golden inputs, and `pnpm --filter @markiro/api traceability:verify-package <dir-or-zip>` runs `verifyTraceExportManifest` and the safety scan (below). Both live in `apps/api/src/modules/traceability/export/cli/` beside the module they test, like `packages/legal-documents/src/cli/`.
- File names: `markiro-trace_<tenant-slug>_<request-number>_rev<n>_<yyyymmdd>.xlsx` through a sanitizer equivalent to `sanitizeShiftExportFilenameSegment` (ASCII-only for U.S. tenants). Media type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; CSV ZIP `application/zip`; canonical JSON `application/json`; manifest `application/json`.
- Safety (NFR-010, EXP-001): the writer never emits `vbaProject.bin`, `externalLinks/`, hyperlinks, data connections or formulas; `scanWorkbookParts(bytes)` lists ZIP entries with `fflate.unzipSync` and fails on any forbidden part; the same scan runs in the verify CLI.

### Library choice (OQ-US07-1)

| Option                                      | License                | Deterministic bytes                                                                          | Fit with repo policy                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exceljs` 4.x                               | MIT                    | Needs `created/modified` pinned and ZIP mtimes controlled; heavy CJS + streams               | Mature styling/dates; slow release cadence; adds ~1 MB and transitive deps; Node-only, cannot live in `@markiro/domain` without breaking admin/station builds                                                                              |
| SheetJS CE `xlsx`                           | Apache-2.0             | Yes with `bookSST` off and fixed props                                                       | npm registry version is stale and has known advisories; maintained builds are off-registry, conflicting with exact-pin/lockfile policy; styles are Pro-only                                                                                |
| `write-excel-file`                          | MIT                    | Mostly (ZIP via jszip)                                                                       | Small API, limited control over number formats/autoFilter/freeze                                                                                                                                                                           |
| Minimal in-house OOXML writer over `fflate` | none (already present) | Yes by construction (`zipSync` fixed mtime, fixed `docProps/core.xml` dates, inline strings) | ~400 lines: `[Content_Types].xml`, `_rels`, `docProps`, `workbook.xml`, `styles.xml` (date/decimal/text formats), `sheetN.xml` with `autoFilter`, frozen pane, column widths; no macros possible; validated by LibreOffice/Excel open test |

Recommendation: the minimal writer in `apps/api/src/modules/traceability/export/xlsx-writer.ts` (Node-only placement keeps `@markiro/domain` free of Node/ZIP concerns; the domain owns the model, the writer owns bytes). Fallback if reviewers want richer formatting: `exceljs` with the same `WorkbookModel` input, so the choice is isolated behind one function.

### Admin UI

No new pages. US-09's run detail page lists the artifacts by `kind` with size, SHA-256 (mono, copyable) and a "Verify" hint; the validation summary (`errors_count`, `warnings_count`) is shown through the US-09 DTO. i18n keys for artifact kinds `pages.traceability.exports.kind.{xlsx,csvZip,canonicalJson,manifest}` in `en.json`/`ru.json`.

### Station

Not touched.

### Profile gating and RU_CHZ safety

The adapter throws `UNSUPPORTED_PROFILE` for `RU_CHZ` and the CLI/US-09 routes sit behind `RequireTraceabilityProfile` (403 `traceability_profile_required`); `US_GENERIC_LOT_TRACEABILITY` renders the same workbook with the Metadata disclaimer extended by "Product(s) not classified as FTR-covered; general lot traceability record" (demo-scenario §4) and without the FTL coverage columns (OQ-US07-6). No existing module is modified: `shift-exports`, `inventories` and `legal-documents` code stays untouched; only `fflate` is reused.

## Testing

- Domain unit (`packages/domain/test/traceability-export-*.test.ts`): registry invariants (unique keys, every field has `sourceRef`, required matches data-dictionary P0 column, `registryHash` pinned as a literal with a comment "update only with an EXP-012 review note"); row builders on the seed chain produce 2 receiving rows, 2 transformation rows (2 edges), 1 shipping row with exact cell values; deterministic ordering under shuffled input; date/decimal/text normalization incl. 15-digit boundary and phone extension preservation; Validation rows for void/draft/amended records; Metadata field completeness against `metadataFields`; canonical JSON and CSV contain the same row ids as the workbook; manifest build/verify round trip and each mismatch kind; data-dictionary markdown drift test against `docs/us/export-data-dictionary.md`.
- Writer (`apps/api/test/traceability-xlsx-writer.test.ts`): parts list is exactly the expected set (no forbidden parts), XML is well-formed (`fast-xml-parser`), shared/inline strings escaped, two renders with the same clock are byte-identical, different `generated_at` changes only `docProps` and Metadata cells.
- Golden fixtures (EXP-012): `apps/api/test/fixtures/traceability-export/<fixture>/{input.json, expected-cells.json, expected-hashes.json}`; the test compares the semantic cell dump first (readable diff) and then SHA-256 of `xlsx`, `csv.zip`, `canonical.json`; regenerating requires `TRACE_EXPORT_UPDATE_GOLDEN=1` and the PR template asks for a reviewer note naming the mapping change.
- Performance (EXP-010, C-014): timed test renders the P0 seed package and a scaled fixture (10,000 receiving rows) and asserts < 60 s; the measured time is written to the verification report.
- API e2e (with US-09 runner stub): adapter output uploaded with `putVerified`, artifact rows carry the manifest SHA-256, cross-tenant snapshot ids rejected, `RU_CHZ` tenant → `UNSUPPORTED_PROFILE`.
- Negative cases from acceptance §2.4: covered product with `unknown` status → `error` finding and US-09 blocks export-ready; master data edited after finalization → identical workbook bytes for the same request revision; duplicate export retry → same hashes, no duplicate artifacts.
- Open test: CI job (gated on Docker availability like the legal PDFs) runs LibreOffice headless `--convert-to csv` on the generated workbook and compares row counts; Excel open is a manual check recorded in the browser/external section.

## Evidence

- Generated `xlsx`, `csv.zip`, `canonical.json`, `validation` rows and `manifest.json` for `REQ-2026-APPLE-001` with SHA-256 (C-011, EVD-006).
- Verify command output and the LibreOffice open screenshot; Excel screenshot when available (acceptance §2.5 step 3).
- Timed run < 60 s (C-014).
- `docs/us/export-data-dictionary.md` generated from the registry; `docs/us/requirements-traceability.md` rows EXP-001…EXP-012 updated.

## Out of scope

Package ZIP assembly, export run persistence and download endpoint (US-09); Traceability Plan PDF (US-08); EPCIS/CBV, EDI or partner-specific templates; import of XLSX; formulas, charts or styling beyond header emphasis, widths, freeze and autoFilter; other CTE tabs; any FDA submission.

## Open questions

| ID         | Question                                                                | Options                                                                                                                            | Recommendation                                                                                             | Blocking? |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US07-1  | XLSX writer                                                             | (a) minimal in-house OOXML writer over `fflate`; (b) `exceljs`; (c) SheetJS CE; (d) `write-excel-file`                             | (a); (b) as fallback behind the same `WorkbookModel`; (c) rejected on registry/advisory grounds            | yes       |
| OQ-US07-2  | Where does the byte writer live?                                        | (a) `apps/api/src/modules/traceability/export/`; (b) new Node-only package `packages/traceability-export`                          | (a) for P0; extract later if `tools/us-demo` needs it outside the API                                      | no        |
| OQ-US07-3  | Transformation tab row shape                                            | (a) one row per input→output edge with both descriptions; (b) input rows and output rows with a `role` column                      | (a): mirrors "for each input lot … for each output lot" while keeping one sortable row per genealogy link  | no        |
| OQ-US07-4  | Date cell format                                                        | (a) typed date, `yyyy-mm-dd`; (b) typed date, `mm/dd/yyyy`; (c) ISO text                                                           | (a): unambiguous and sortable; U.S. display can be switched per tenant later without changing the registry | no        |
| OQ-US07-5  | CSV dialect for EXP-009                                                 | (a) comma, CRLF, no BOM; (b) reuse `encodeSemicolonCsv` (semicolon + BOM)                                                          | (a): U.S. integrations expect RFC 4180; the existing helper encodes the RU Excel convention                | no        |
| OQ-US07-6  | Workbook under `US_GENERIC_LOT_TRACEABILITY`                            | (a) same layout + extended disclaimer, FTL columns omitted; (b) no XLSX for generic; (c) separate registry                         | (a)                                                                                                        | no        |
| OQ-US07-7  | Byte-stable vs semantically stable goldens                              | (a) byte-stable with injected clock; (b) cell-dump only                                                                            | both: cell dump for readable diffs, bytes for EXP-005 evidence                                             | no        |
| OQ-US07-8  | Cell limit handling (32,767 chars)                                      | (a) truncate + finding; (b) fail the run                                                                                           | (a): FDA data never approaches the limit; failing would block a request over an attachment note            | no        |
| OQ-US07-9  | Should a "Definitions" row cite the FDA URL from `regulatory-basis.md`? | (a) section id only; (b) id + URL                                                                                                  | (b), URLs are documentation, not runtime dependencies (INT-007)                                            | no        |
| OQ-US07-10 | Software version source                                                 | (a) US-00 adds a `{ version, gitSha }` helper (its current draft has none); (b) read `package.json` + `GIT_SHA` env in the adapter | (a); block until US-00 names the helper or (b) is accepted; same question as US-09 OQ-US09-17              | yes       |
| OQ-US07-11 | Golden regeneration gate                                                | (a) env flag + PR note; (b) attestation file like `legal-artifacts-attestation.json`                                               | (a) now; (b) when US-11 seals the release bundle                                                           | no        |
