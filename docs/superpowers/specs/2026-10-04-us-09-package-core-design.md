# US-09 — Frozen Request Report and Package Core

Status: owner-approved written specification, 2026-10-04. The owner approved this specification after the internal package-core direction and report timing correction. The separate implementation plan still requires owner review; approval of this document alone is not implementation or release evidence.

This supplements the [current US-09 design](2026-10-04-us-09-trace-request-current-design.md), [frozen-origin and pinned-Plan design](2026-10-04-us-09-frozen-provenance-pinned-plan-design.md), [shared MVP contract](../../us/mvp-contract.md#7-xlsx-pdfs-and-hashes) and [Plan/request brief](../../design-briefs/us/05-plan-and-trace-request.md). It follows the accepted local [origin/Plan checkpoint](../plans/2026-10-04-us-09-frozen-provenance-pinned-plan.md#accepted-local-implementation-checkpoint--2026-10-04). Current code and tests determine implementation status; US-09 remains In progress.

## Intent and scope

An authorized processor workflow needs a reproducible response package from an already-frozen request revision. This increment supplies its internal English report PDF, manifest, checksums, ZIP and local verification. It does not reread current business records, change readiness, fulfil a request or send files to a requester.

Work remains in `codex/us-mvp`, using synthetic fixtures and owned disposable US test databases. Preserve existing dirty work and release locks. No commit, push, PR, merge, deployment, storage provisioning or cleanup is authorized. RU runtime, primary environment and shared databases are outside scope.

No worker, leases, queue reconciliation, package-storage adapter, artifact/run writes, HTTP/OpenAPI, cabinet UI, production build-identity provider or schema migration is added here. Package bytes returned internally are not a published or downloadable response. These boundaries require later independently approved increments.

## Current foundations

- `requireUsRequestPackageEvidence` verifies saved identity/digests and permits only frozen v2 for full packages. Verified v1 still supports existing validation/XLSX replay, but package composition returns `us_request_package_refreeze_required` before rendering or I/O. Never backfill or upgrade an old run.
- `renderUsRequestPayloads` builds exact canonical `validation.json` and optional `records.xlsx` through the actual US-07 adapter. It binds run/revision/mode/digests and distinguishes empty selection, unrepresentable workbook and typed writer failure. Preserve that accepted taxonomy; do not introduce a new omission on arbitrary exceptions.
- `UsRequestPlanReader` returns exact historical effective/superseded PDF bytes for the frozen Plan pin, or `plan_absent` only when the incomplete run never pinned a Plan. A damaged, missing or unreadable pinned Plan fails both modes. Existing private reads retain the 8,000,000-byte and 15-second limits.
- Frozen v2 includes tenant-origin evidence. `trusted_synthetic` attests reserved demo tenant provisioning, not every event's factual origin. `not_attested` is not verified operational data.
- Existing API dependencies include pinned React PDF and fflate; US-08 bundles IBM Plex Sans. No dependency, lockfile or shared Plan renderer change is needed for this proposal.

## Components and trust boundary

Keep three focused responsibilities in the US request module:

1. A report-model builder binds a verified v2 run, its trusted existing payload result, its trusted pinned-Plan result and explicit timing context. It recomputes actual byte lengths/hashes, checks identities and produces a bounded, versioned model.
2. A request-report renderer accepts that model and emits PDF bytes, SHA256, size and `us-request-report-pdf-v1` identity. It does not query a database, storage or current configuration.
3. A package composer builds the manifest, sums and canonical ZIP, then verifies the result against its expected file set before returning caller-owned bytes and metadata.

The caller obtains inputs through the existing payload renderer and Plan reader; these are not client-uploaded structures. The composer accepts these results to avoid duplicate XLSX rendering and private reads. Validate their run/revision/mode/digest bindings and copy buffers before asynchronous rendering. In particular, validation bytes must equal the canonical verified frozen envelope, the Plan ID/hash must equal its pin, and absence/presence must agree with the accepted omission result. A self-consistent hash of arbitrary caller-provided workbook bytes is not proof they came from US-07: source authority remains the internal renderer call.

Saved evidence verification and this composition grant no authorization. A later user-facing or worker caller must supply an authorized tenant-scoped run and recheck access at its own protected boundary. No service is registered in the runtime here and no user-download audit is fabricated for an internal Plan read.

## Honest timing and reproduction

The owner-approved correction replaces PDF render completion inside the PDF with **Report data prepared at**. Use a strict versioned internal context containing `workerStartedAt` (canonical UTC milliseconds or null) and `reportDataPreparedAt` (canonical UTC milliseconds). The trusted caller captures the latter after upstream payload/Plan inputs have been obtained, before building/rendering the report. It is not taken from a requester or inferred from a completed run.

Require `reportDataPreparedAt >= frozen.generatedAt`; when worker start is known, require `frozen.generatedAt <= workerStartedAt <= reportDataPreparedAt`. Reject malformed timestamps, unsupported versions or negative intervals. Unknown worker timing is explicitly unavailable. The immutable run's `startedAt`/`generatedAt` is the server preparation-start boundary; it is not separately measured physical click time.

The PDF shows receipt/due, preparation started, worker started when known, report data prepared, and **Elapsed to report data preparation**. It does not show session age reconstructed from today's request row, active human effort, actual PDF-render completion or publication completion. Those last two belong to later run detail/audit. Neither the report nor manifest claims the package is published.

The model/composer never calls the wall clock or reads Git/package files. Same verified run, upstream bytes, timing context and renderer/library versions must produce identical report, manifest, sums and ZIP bytes. An explicit context supplied by synthetic tests exercises this contract; it does not establish a measured real worker duration.

Persistence of this timing context and renderer identity before retryable rendering is a prerequisite for the later durable worker design. It is deliberately not implemented by mutating the frozen run or repurposing `reportRenderedAt` here. This increment proves same-input byte determinism, not crash-safe reproduction or compatibility across future library upgrades.

## Request report PDF

Use English, US Letter pages, bundled fonts, readable wrapping and page numbering. Follow the existing Plan's typographic direction without changing its renderer, downloading fonts or introducing a replacement logo. A text-only Markiro attribution is acceptable; do not invent a mark.

The report includes:

- request ID/number and saved request revision; run ID/revision and explicit mode;
- frozen requester name/organization/contact, scope and alternate-deadline reason;
- receipt/due displayed with tenant timezone/offset and UTC; the timing boundary above;
- preparing actor ID, not an inferred reviewer name/title or P1 QA sign-off;
- selected revision counts by event type/lifecycle and frozen validation error/warning counts;
- separately identified XLSX-render findings, including source identities; no merger that erases their origin;
- named scoped-content and workbook-input digests, baseline/registry/build stamps;
- exact pinned Plan identity when present, available pre-report file sizes/hashes, or explicit absent-file reasons;
- visible provenance: `Synthetic demo — not an operational record` for trusted demo origin, otherwise `Tenant origin not attested` with no verified-real-data claim;
- distinct `Export-ready` or `Available records — incomplete` heading and the supported-recordkeeping/no-direct-submission disclaimer;
- the brief's fixed sentence: “Package prepared in the U.S. instance; delivery to the requester is performed by the covered entity”. This identifies the US product workflow, not hosted residency or evidence of delivery; local synthetic evidence cannot establish either.

The PDF is a summary, not a silently shortened replacement for records/findings. It explicitly directs the reader to the lossless `validation.json` for full frozen findings, source revisions, lifecycle and genealogy. Summary counts cover the entire saved set; do not cap records to produce a success. If the model or output exceeds a bound, fail instead of truncating text or generating an empty report.

It cannot list its own hash or later manifest/sums/ZIP hashes. Freeze PDF creation/modification dates from the report context, use versioned producer metadata and no random identifiers. Demonstrate repeat-render equality with the real default renderer. Do not expose requester contact in PDF metadata, routine logs or error messages.

## Files and acyclic hashes

The ZIP uses only fixed ASCII basenames in this exact order, omitting optional absent files:

1. `records.xlsx` — optional, existing workbook bytes unchanged;
2. `plan.pdf` — optional, exact pinned approved PDF bytes unchanged;
3. `validation.json` — required, existing canonical frozen v2 envelope unchanged;
4. `request-report.pdf` — required;
5. `manifest.json` — required;
6. `SHA256SUMS` — required, inside ZIP only.

The returned outer artifact is `package.zip`. No request text enters a filename, path or object key. No directories, source-document attachments, CSV/extra JSON export, preview PDF, URLs or storage keys are included.

The strict version-1 manifest records tenant/request/run IDs, request/run revisions, mode, frozen preparation instant, timing context, both named digests, frozen origin evidence, profile/timezone, baseline/registry/build identity, package/report renderer versions, validation/render-finding summaries and exact Plan pin or absence. Its ordered payload entries contain name, media type, byte size and lowercase SHA256 for the available workbook, Plan, validation and request report. It also lists the optional missing names with finite reason codes.

Manifest entries exclude the manifest itself, sums and ZIP. They contain no fabricated hash/size for absent files. Full frozen findings remain in validation JSON; the manifest's render findings must preserve the complete bounded upstream list, not only a count. Manifest JSON uses the existing strict lossless canonical serializer.

`SHA256SUMS` contains lowercase hash, two spaces, fixed filename and LF per line, with a final LF. It covers available payloads followed by `manifest.json`, in archive order. It excludes itself and ZIP. ZIP SHA256 and size are returned externally. No hash cycle, self-hash placeholder or post-render patch is permitted.

In export-ready mode both workbook and pinned Plan must be present and the existing ready checks remain satisfied. In incomplete mode workbook omissions retain the accepted `empty_selection`, `workbook_unrepresentable` or `workbook_writer_failed` code; an originally absent Plan uses `plan_absent`. Incomplete stays incomplete even if both files happen to exist. Never turn corruption, mismatched identity, permission denial, private-read failure, report failure or package-limit failure into an omission or empty successful package.

## Bounded canonical ZIP and verifier

Approved explicit limits, in addition to the unchanged 500-revision/full-snapshot limits:

| Item                               | Maximum                            |
| ---------------------------------- | ---------------------------------- |
| Each validation JSON / workbook    | 16 MiB, existing bound             |
| Pinned Plan PDF                    | 8,000,000 bytes, existing bound    |
| Canonical report model             | 1 MiB                              |
| Request report PDF                 | 4 MiB                              |
| Manifest JSON                      | 1 MiB                              |
| SHA256SUMS                         | 16 KiB                             |
| Total uncompressed ZIP entry bytes | 48 MiB                             |
| ZIP bytes                          | 64 MiB                             |
| ZIP entries                        | 6, with exactly 4 required entries |

MiB/KiB mean powers of 1024; the Plan limit remains decimal bytes. Check actual sizes before expensive rendering/archive allocation and again after output. Bounds are explicit failures, never permission to truncate. Timing/performance acceptance still requires a later measured full flow.

Use existing fflate with stored outer entries (compression level 0), fixed DOS epoch mtime `1980-01-01`, fixed order and pinned archive settings. The workbook remains its existing internally compressed XLSX; do not recompress or alter it. The larger outer archive is an intentional tradeoff for a simple bounded format and deterministic verification. No ZIP64, encryption, links, archive comments or platform-dependent timestamps.

The verifier is internal and checks this canonical format against a trusted expected identity/file set, not an arbitrary upload/import API. Validate the compressed size bound before parsing, exact basenames/order/presence, duplicate names, local/central header agreement, stored method, declared and actual entry lengths, bounds and no trailing or hidden entries. Never allocate from an unchecked declared length or inflate an unbounded stream. Unexpected compression/flags/paths fail closed.

Recompute hashes from extracted actual bytes, validate strict canonical manifest/sums and exact expected file contents/bindings, and ensure every required or available optional file has exactly one coverage entry. Reject added/dropped/swapped files, wrong run/tenant/revision/mode, altered Plan, stale checksums, self/cyclic entries or extraneous bytes. A later download verifier additionally anchors ZIP SHA256 in trusted persisted metadata; internal checksums alone do not authenticate an archive against an attacker who replaces all files and hashes.

Return no result before verification passes. Return independent caller-owned file/ZIP buffers and actual lengths/hashes; mutation of inputs or one returned view must not silently alter another artifact. Do not write temporary package files or publish objects from this composer.

## Failures and future integration

Preserve the existing saved-evidence/version and pinned-reader failure codes at their boundaries. New model/context, report-render, size-limit and archive-verification failures use finite sanitized request-layer codes with no low-level cause, requester contact, object key or URL. Detailed validation remains in the authorized package, not exception text.

Later worker/storage work must freeze the render context, enforce fresh initiator access, claim with fences, persist/upload attempt-scoped bytes, verify private objects, and atomically publish artifact rows/status/audit. It must distinguish report-data preparation from actual render and publication timestamps. This spec does not authorize that work or claim storage-unavailable runtime behavior has already changed.

## Verification and implementation handoff

The implementation plan should split independently reviewed tasks into report model/bindings/timing; real deterministic PDF; manifest/sums/ZIP/verifier; and synthetic integration plus check-only CI ownership. Retain the owner's separate implementer and independent-review method. Write focused failing tests before implementation.

Required evidence includes:

- wrong tenant, damaged v2 and v1 rejection before rendering; unchanged v1 validation/XLSX regressions;
- exact default US-07 workbook and US-08 historical PDF integrated into a ready package;
- incomplete with findings/files, explicit empty selection and originally absent Plan, plus failed pinned reads in both modes;
- unchanged frozen requester/scope/origin and historical Plan after later request/source/Plan edits;
- strict timing chronology, null worker timing, exact timezone/UTC and no invented human/session/render/publication measurements;
- real PDF repeat-byte equality, extracted text for mode/provenance/digests/timings/omissions, wrapping/page render inspection using long synthetic text;
- golden archive order, mtime, manifest and sums; repeat-byte equality; file/metadata tamper, duplicate/path/header/compression/length/extra-entry cases;
- exact/beyond-limit tests before allocation, no partial result and buffer ownership;
- no new run/artifact/status/audit writes, no upload/delete/runtime registration, and unchanged US operational locks;
- selected disposable-PostgreSQL regressions without skips, API typecheck/lint/build, formatting/diff and isolation checks; serial check-only CI ownership for new suites.

Keep package-wide API results distinct from selected suites: the prior accepted checkpoint has unchanged primary-environment setup failures, not a green full API. Automated synthetic bytes/text and local rendered-page inspection are not browser workflow, Excel interoperability, hosted non-RF infrastructure, recovery, physical operation or regulatory acceptance. Remote CI, full-flow performance and these external gates remain explicitly unverified unless separately exercised.
