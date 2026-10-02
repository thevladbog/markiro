# US-07 — Frozen-event XLSX export core

**Status:** Owner-approved design boundary and English-only P0 workbook, 2026-10-02. Design only; no implementation or export-readiness claim.

**Decision boundary:** The owner approved US-07 as the export core before US-08 Plan and US-09 request/package orchestration. It must remain in the isolated U.S. instance and must not publish, deploy, or alter RU behavior. The shared [MVP contract](../../us/mvp-contract.md), [development clarifications](../../us/development-clarifications.md), and [requirements](../../us/requirements.md) take precedence over the older [US-07 draft](2026-09-03-us-07-xlsx-export-adapter-design.md) where they conflict.

## Purpose and source boundary

Generate an FDA-aligned, sortable XLSX from explicitly selected U.S. traceability records while preserving exact source values, revision identity, and visible gaps. The FDA's [electronic sortable spreadsheet page](https://www.fda.gov/food/food-safety-modernization-act-fsma/fsma-final-rule-requirements-additional-traceability-records-certain-foods#ElectronicSortableSpreadsheet), checked 2026-10-02, calls its template illustrative rather than mandatory and describes separate relevant CTE tabs and split composite KDEs. The [FDA English template PDF](https://www.fda.gov/media/179616/download) is the mapping reference. A mapping review must inspect the corresponding FDA XLSX before freezing registry v1. This is a product design reference, not legal acceptance or a claim that an output was submitted to FDA.

The current `UsCurrentTraceResult` is a bounded presentation projection: it gives graph nodes, line links, quantities, dates and current-event identity, but not every frozen Location/Product Description or document KDE. It is neither a request snapshot nor the source for export cells. The authoritative records are the versioned `traceability_events.finalization_snapshot` payloads and explicitly captured available-record content. US-07 must not rehydrate historical cells from mutable catalog, lot-card display text, or client graph nodes.

## Approaches considered

1. **Chosen: pinned-source adapter.** An internal tenant-scoped reader resolves explicit event IDs and revisions in one consistent database snapshot; a pure mapper builds versioned rows and findings; a replaceable XLSX writer renders those rows. US-09 later freezes the input and persists the run. This keeps identity, mapping and rendering independently testable.
2. Render the current trace HTTP graph directly. Rejected: its bounded projection omits required frozen KDEs and can be truncated; filling gaps from current master data would rewrite history.
3. Build request persistence, plan attachment, worker, download, UI and XLSX together. Deferred to US-08/09: the cross-slice transaction and artifact lifecycle need their own design and review, and would make US-07 hard to verify in isolation.

## Components and data flow

```text
explicit tenant + event revision pins + mode + frozen context
  → authorized, repeatable-read source reader (internal only)
  → validated ExportInputV1 (actual snapshots and lifecycle states)
  → registry-v1 row mapper + validation findings + workbook model
  → selected XLSX writer + safety/semantic verifier
  → typed bytes, hashes, row counts and source-linked diagnostics
  → US-09 immutable run and package (later)
```

- The reader accepts only explicit, bounded pins `{ eventId, revision }` and a tenant ID provided by the server. It checks same-tenant ownership, matching revision and lifecycle, snapshot version and related row integrity. No direct route, arbitrary query scope, storage write, queue or database migration belongs to US-07. It never uses a cabinet-supplied tenant or role. The eventual US-09 command owns fresh capability checks, scope selection, run revision, idempotency and the durable transaction.
- `ExportInputV1` is a strict, serializable internal contract carrying the chosen event snapshots/content, exact event/line/document identifiers, lifecycle state, lot/source/coverage content, existing readiness findings, mode, registry/baseline/build versions, timezone and an injected generation instant. It excludes live object references and mutable display-only labels. A canonical digest must be independent of input order. US-09 will store this content and digest before rendering; a worker must not repeat a live search.
- For `export_ready`, every included CTE record is a current finalized revision with valid frozen data, complete traversal and no blocking finding. US-07 can return candidate validation, but it cannot declare a request export-ready without the effective Plan and US-09 request gates. For `available_records_incomplete`, source rows retain draft/void/amended identity and captured values with explicit lifecycle labels and source-linked gaps. They are never silently finalized or called current. An incomplete workbook is visibly labelled and cannot satisfy the export-ready outcome.
- A missing or corrupt pinned revision, wrong-tenant reference, unsupported snapshot version or reader timeout is an execution failure, not a successful incomplete export. Missing KDEs within an otherwise readable record become exact field/source findings. Unsupported profile or missing permission is never bypassed by selecting incomplete mode.

## Registry and row model

- `@markiro/domain` owns immutable `FDA_SORTABLE_REGISTRY_V1`: stable field keys, English headers, CTE/tab, KDE definition, source section/URL, requiredness, type and frozen source path. One registry generates the data dictionary, row mapping, Validation references and semantic golden expectations. A changed mapping creates a new registry version; it never silently rewrites an old package. The registry hash is pinned by a test and a reviewer note is required to change it.
- Tabs are Metadata, Definitions, Receiving, Transformation, Shipping and Validation. CTE tabs are emitted only when relevant to the selected scope, with headers even when an in-scope tab has no rows. No other CTE, generic-profile FDA-labelled export or multi-CTE CSV/JSON package is P0.
- Receiving and Shipping have one record row per saved item line. Transformation has distinct **input** and **output** line rows, joined by event ID/revision with `line_role`, `line_no` and source IDs. An input quantity and an output quantity each occur once; no input×output join, inferred allocation or hidden sum. Outputs with no FTL input remain visible. Repeated event/document fields are labelled non-additive.
- Preserve TLCs, SSCCs, document numbers, phone extensions and source references as text. ISO civil dates are typed sortable dates without timezone conversion. Exact decimal and UOM values remain separate; an unsafe numeric precision becomes text with a finding, never rounded. Text starting with `=`, `+`, `-` or `@` is an explicit string cell, not a formula. Required values are not truncated or silently removed. A cell that cannot be represented safely blocks that workbook artifact; US-09 may later attach a lossless safe companion, but US-07 cannot call the workbook complete.
- Validation rows contain severity, code, CTE/tab, field key, event ID/revision, line ID, lot ID where present and a source-record reference. Excluded revisions and incomplete scope are explained separately from current finalized rows. Metadata carries scope/mode, tenant profile, timezone, frozen generation time, regulatory baseline, registry ID/version/hash and immutable software build identity. No claim of FDA approval, submission or legal compliance appears in cells.

## Writer, integrity and error behavior

The writer consumes a library-independent `WorkbookModel` and returns XLSX bytes. Before selecting a dependency, run a bounded compatibility/security spike against repository pinning and license policy, formula/string behavior, freeze/filter support, deterministic output, macro/external-link absence and LibreOffice/Excel reading. The older draft's suggestion of a hand-written OOXML writer is not an approved implementation choice. No runtime FDA, GS1, CDN or external-template fetch is allowed.

The adapter returns typed `{ workbook?, validation, rowCounts, registryVersion, registryHash, inputDigest, sha256?, failures[] }`. Validation findings and execution/artifact failures are separate. An XLSX ZIP-part scan rejects macros, formulas, external links and connections; semantic verification compares headers, row IDs and exact cell values, not only that the archive opens. A deterministic clock and build ID make identical frozen inputs reproducible. US-09 owns artifact publication, manifest, SHA256SUMS, ZIP, audit and downloads under the shared contract's acyclic hash order.

## Verification and acceptance boundary

1. Test-first domain contracts: unique registry fields, source reference for every KDE, version/hash drift and generated dictionary; precise receiving/shipping rows; Transformation 2→1, 2→2 and no-FTL-input→1 without duplication; date, decimal, UOM, Unicode, formula-leading text and cell limits.
2. Reader tests on owned disposable U.S. PostgreSQL: exact revision pins, mixed snapshot versions, current versus historical lifecycle, cross-tenant denial, malformed/corrupt source failure and repeatable-read consistency under concurrent amendments. Build the changed shared packages before API consumers.
3. Writer golden tests compare readable semantic cell dumps and bytes/hashes. Fixture modes cover clean export-ready candidate and missing-KDE/unknown-coverage available-records response; every authorized source line is accounted for, and blocking findings survive rendering. Golden updates require an explicit mapping diff and reviewer note, never blind regeneration.
4. Scan XLSX parts for forbidden content and open the P0 fixture in LibreOffice. Excel opening is a required later MVP release evidence gate, not a claim from CI. Measure the fixed synthetic fixture against the documented <60 s target. Package/test/build/lint/typecheck, US isolation and RU regression gates remain separate. No browser, hosted, storage, Excel or regulatory acceptance is implied by domain tests.

## Dependencies, exclusions and next review

The current code has versioned Receiving, Transformation and Shipping snapshots, US-06 search/trace/readiness contracts and repeatable-read transaction precedent. It does **not** yet expose the immutable build-metadata helper promised by the shared contract; add that small US-00-owned prerequisite as an explicit first implementation task, or keep rendering blocked until it exists. Do not replace it with a mutable local package read or silently omit the metadata.

US-08 owns Plan versions/PDF. US-09 owns request scope and deadlines, digest freeze, export-run persistence, worker, incomplete/ready decision, package artifacts, audit, download and office action. Station, scanner/printing, deployment, push, release and direct FDA submission are outside this design.

**Language decision:** P0 registry, KDE headers and workbook definitions are English-only. Cabinet copy remains EN/ES. A future Spanish workbook needs its own reviewed mapping/version rather than silently translating the pinned v1 registry.
