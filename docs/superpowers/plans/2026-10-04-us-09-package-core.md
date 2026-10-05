# US-09 Frozen Request Package Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Preserve the owner's chosen method: separate implementer and independent reviewer for each task, then final integration review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Local internal package-core component completed and accepted, 2026-10-04, after five separate independent task reviews and final integration review. US-09 remains In progress; this checkpoint does not authorize commit, push, merge, publication or release.

**Goal:** Compose and locally verify a deterministic US-09 request-report PDF, manifest, SHA256SUMS and ZIP from an existing frozen v2 run and its exact trusted payload/Plan bytes.

**Architecture:** Bind and defensively copy existing internal inputs, derive a strict bounded report model, render the PDF, then build canonical manifest/checksums and a bounded stored ZIP. Verification checks actual archive contents against trusted expected files; it grants no authorization and publishes nothing. Manifest/checksums and ZIP are separate review gates because either can be rejected independently.

**Tech Stack:** Existing strict TypeScript, NestJS errors, Zod, Node SHA256, React PDF 4.6.1, fflate 0.8.3, bundled IBM Plex Sans, Vitest and fixture-owned PostgreSQL. No new dependencies.

**Spec:** [Owner-approved package-core specification](../specs/2026-10-04-us-09-package-core-design.md). Also read the accepted [frozen-origin/Plan checkpoint](2026-10-04-us-09-frozen-provenance-pinned-plan.md#accepted-local-implementation-checkpoint--2026-10-04), current saved-evidence/payload/Plan code and adjacent tests; checkpoint evidence is not full API or hosted acceptance.

## Global Constraints

- Reuse `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve inherited dirty/untracked work. No staging, commit, push, PR, merge, release, provisioning, deployment or cleanup. The skill's ordinary commit steps are replaced by local review checkpoints.
- Read root/scoped instructions and `docs/us/development-isolation.md`. This worktree has no local Graphify graph at planning time; use current scoped source, not a graph rebuild. The current primary API guide supplements the older worktree root guide; never edit the primary checkout.
- Only synthetic data and owned disposable children from `createUsProfileTestDatabase`. Unset primary/alternate DB and live-service flags for checks. Never migrate or reset the base/shared database, use primary `.env` or weaken database immutability for production behavior.
- Preserve v1 JSON/XLSX replay. Full-package inputs require verified v2 and reject v1 with `us_request_package_refreeze_required` before rendering or I/O. No backfill, new migration or public-contract revision.
- Reuse `renderUsRequestPayloads` and `UsRequestPlanReader`. Do not render the Plan again, select today's Plan, recapture live sources/origin or trust client payloads. Preserve exact historical Plan bytes and its own markings.
- Context is version 1 with canonical UTC milliseconds: nullable `workerStartedAt`, required `reportDataPreparedAt`. Require preparation ≤ known worker start ≤ data preparation; unknown worker start stays unavailable. The PDF says **Report data prepared at** and **Elapsed to report data preparation**, never active human time, actual render/publication completion or reconstructed session age.
- PDF is English, US Letter, local bundled fonts; no new logo/CDN. Use actor ID, not inferred name/title or P1 reviewer. `trusted_synthetic` displays **Synthetic demo — not an operational record**; `not_attested` displays **Tenant origin not attested**, never verified real operation.
- Keep the exact ready/incomplete modes and accepted omission codes. Technical failures, corruption and failed pinned reads never become successful incompleteness. Incomplete mode remains incomplete even with all optional files present.
- Limits: 500 captured revisions; existing full snapshot, each validation JSON and workbook **16 MiB**; Plan **8,000,000 bytes** and **15-second** reads; report model **1 MiB**; report PDF **4 MiB**; manifest **1 MiB**; sums **16 KiB**; total entry bytes **48 MiB**; ZIP **64 MiB**; at most **6 entries**, exactly **4 required**. Powers of 1024 except the unchanged decimal Plan limit. Reject excess; do not truncate.
- Fixed archive order: optional `records.xlsx`, optional `plan.pdf`, required `validation.json`, `request-report.pdf`, `manifest.json`, `SHA256SUMS`. Outer artifact `package.zip`. Stored outer entries, compression level 0, DOS epoch 1980-01-01; no ZIP64, paths, comments, links, encryption or variable platform timestamps.
- Manifest lists payloads including report, excluding itself/sums/ZIP. Sums cover payloads plus manifest, excluding itself/ZIP. ZIP hash is external metadata. No self-hash, later-hash patch or cycles.
- No run/artifact/status/audit writes, uploads/deletes, runtime registration, worker/storage adapter, HTTP/OpenAPI, cabinet, production build provider, Station, RU changes or operational-lock changes. Internal returned bytes are not publication or a downloadable ready run.
- Determinism is same run/upstream bytes/context and supported renderer/library versions; future durable-worker context persistence and cross-upgrade reproduction are not delivered by this plan.
- New checks belong to the serial unconditional US-only check workflow after dependency builds. No main CI/release job widening. Missing required synthetic infrastructure must be reported, not counted as passed skipped tests.

## Review Focus

1. Caller mutates input buffers/objects while PDF rendering awaits: already-bound bytes/model and independent returned artifacts must not change (Tasks 1, 4).
2. A date crosses DST, an unknown worker time is replaced by a guessed timestamp, or elapsed milliseconds exceed safe integer precision: display exact timezone/UTC and reject invalid chronology without inventing timing (Tasks 1, 2).
3. Mixed lifecycle and repeated event/row grains produce misleading counts: report captured revision counts separately from actual workbook event count, retain finding origins, never sum quantities or claim all captured historical records are current (Tasks 1–3).
4. An attacker replaces all files, hashes and manifest together, or changes ZIP headers without changing extracted data: verifier must anchor against the trusted expected file/identity set and reject noncanonical headers, not trust self-consistent checksums (Tasks 3, 4).
5. Long unbroken identifiers/control text or oversized models exhaust PDF layout or hide private text in metadata/errors: reject unsupported controls/limits, wrap losslessly, inspect actual pages, and sanitize failures (Tasks 1, 2, 5).

---

## File map and interface ownership

All new production modules live under `apps/api/src/modules/traceability/requests/`:

| Task | Files                                                         | Responsibility                                                              |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | `us-request-package-types.ts`, `us-request-package-inputs.ts` | Internal types/limits, strict bindings, report model and copied input bytes |
| 2    | `us-request-report-pdf.tsx`                                   | Default real deterministic report PDF and bounded rendering                 |
| 3    | `us-request-package-manifest.ts`                              | Strict canonical manifest and acyclic checksum coverage                     |
| 4    | `us-request-package-zip.ts`, `us-request-package.ts`          | Canonical stored ZIP/verifier and asynchronous composition                  |
| 5    | Existing US workflow/isolation tests and roadmap/checkpoint   | Full real synthetic integration and check-only ownership                    |

New tests: `apps/api/test/us-request-package-inputs.e2e.test.ts`, `us-request-report-pdf.e2e.test.ts`, `us-request-package-manifest.e2e.test.ts`, `us-request-package-zip.test.ts`, `us-request-package.e2e.test.ts`. A shared fixture is `apps/api/test/support/us-request-package-fixture.ts`; it is synthetic setup, not a replacement production service.

Read existing `us-request-run-evidence.ts`, `us-request-payloads.ts`, `us-request-plan-reader.ts`, `us-request-snapshot.ts`, `us-request-prepare.ts`; real Plan renderer/artifact configuration and tests; `nest-cli.json`; workflow and its isolation test. Reuse `us-receiving-fixture.ts`, `us-profile-database.ts`, `us-request-plan-fixture.ts` and `finalizeUsRequestPayloadReceiving`. The metadata-only `seedUsRequestPayloadPlan` is not real PDF evidence.

### Task 1: Bound trusted inputs and truthful report model

**Create:** package types/input modules, shared fixture and `us-request-package-inputs.e2e.test.ts`. No existing saved-run or Plan behavior changes.

**Consumes:** `UsTraceExportRunRow`, `requireUsRequestPackageEvidence(run, expectedTenantId)`, `UsRequestPayloadResult`, `UsRequestPinnedPlanResult`, `stableStringify`, `UsRequestFrozenRunV2`, `UsRequestSnapshotV2`, `ExportFinding` and `ExportSourceRecord`.

**Produces:** the exact shared interfaces below; all later tasks import these rather than redeclaring shapes. Strict runtime schemas must mirror them. `UsRequestPackageByteFile` includes mutable buffers for transport, but binding/output ownership is enforced with independent copies.

```ts
export const US_REQUEST_PACKAGE_VERSION = "us-request-package-v1";
export const US_REQUEST_REPORT_PDF_VERSION = "us-request-report-pdf-v1";
export const US_REQUEST_PACKAGE_LIMITS = {
  validation: 16 * 1024 * 1024,
  workbook: 16 * 1024 * 1024,
  plan: 8_000_000,
  reportModel: 1024 * 1024,
  report: 4 * 1024 * 1024,
  manifest: 1024 * 1024,
  sums: 16 * 1024,
  entriesTotal: 48 * 1024 * 1024,
  zip: 64 * 1024 * 1024,
  entries: 6,
} as const;
export type UsRequestPackageName =
  | "records.xlsx"
  | "plan.pdf"
  | "validation.json"
  | "request-report.pdf"
  | "manifest.json"
  | "SHA256SUMS"
  | "package.zip";
export interface UsRequestFileDescriptor<N extends UsRequestPackageName = UsRequestPackageName> {
  name: N;
  mediaType: string;
  byteSize: number;
  sha256: string;
}
export interface UsRequestPackageByteFile<
  N extends UsRequestPackageName = UsRequestPackageName,
> extends UsRequestFileDescriptor<N> {
  bytes: Buffer;
}
export type UsRequestMissingFile =
  | { name: "records.xlsx"; code: UsRequestMissingWorkbook["code"] }
  | { name: "plan.pdf"; code: "plan_absent" };
export interface UsRequestReportContext {
  schemaVersion: 1;
  workerStartedAt: string | null;
  reportDataPreparedAt: string;
}
export interface UsRequestReportModel {
  schemaVersion: 1;
  identity: {
    tenantId: string;
    requestId: string;
    requestRevision: number;
    runId: string;
    runRevision: number;
    mode: UsRequestPayloadResult["mode"];
    preparedBy: string;
  };
  request: UsRequestFrozenRunV2["validationSnapshot"]["request"];
  scope: UsRequestFrozenRunV2["validationSnapshot"]["selection"]["scope"];
  timing: UsRequestReportContext & {
    preparationStartedAt: string;
    elapsedToReportDataPreparationMs: number;
  };
  tenantOrigin: UsRequestFrozenRunV2["validationSnapshot"]["tenantOrigin"];
  stamps: Pick<
    UsRequestSnapshotV2,
    | "profile"
    | "timeZone"
    | "baselineId"
    | "registryId"
    | "registryVersion"
    | "registryHash"
    | "build"
  >;
  selectionSummary: {
    capturedRevisionCount: number;
    workbookEventCount: number;
    byType: Record<ExportSourceRecord["type"], number>;
    byLifecycle: Record<ExportSourceRecord["lifecycle"], number>;
  };
  findingsSummary: {
    validation: Record<ExportFinding["severity"], number>;
    render: Record<ExportFinding["severity"], number>;
  };
  renderFindings: readonly ExportFinding[];
  warningAcknowledgement: UsRequestFrozenRunV2["warningAcknowledgement"];
  plan: UsRequestFrozenRunV2["validationSnapshot"]["plan"];
  digests: { scopedContentDigest: string; inputDigest: string | null };
  preReportFiles: readonly UsRequestFileDescriptor[];
  missingFiles: readonly UsRequestMissingFile[];
}
export interface UsRequestPackageInputs {
  model: UsRequestReportModel;
  preReportFiles: readonly UsRequestPackageByteFile[];
}
export function bindUsRequestPackageInputs(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
  payloads: UsRequestPayloadResult,
  plan: UsRequestPinnedPlanResult,
  context: UsRequestReportContext,
): UsRequestPackageInputs;
export function assertUsRequestReportModel(model: UsRequestReportModel): void;
```

- [x] **Step 1: Create the owned fixture and RED successful binding test.** `createUsRequestPackageFixture(db, {mode, empty?, withPlan?})` seeds a fresh receiving tenant, finalizes real Receiving when nonempty, optionally calls real `createUsRequestPlanFixture(...).approve`, creates/validates/prepares through existing stores, then calls real payload renderer/Plan reader. Return `{ tenantId, actorId, request, run, payloads, plan, context, planFixture, destroy }`; `destroy` only closes its own fixture transport. Context uses run `startedAt` plus explicit test offsets, not a machine-clock override.

```ts
const c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
const bound = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);
expect(bound.model.identity.runId).toBe(c.run.id);
expect(bound.model.selectionSummary.capturedRevisionCount).toBe(1);
expect(bound.model.selectionSummary.workbookEventCount).toBe(1);
expect(bound.model.timing.elapsedToReportDataPreparationMs).toBe(2_000);
expect(bound.preReportFiles.map((file) => file.name)).toEqual([
  "records.xlsx",
  "plan.pdf",
  "validation.json",
]);
const original = Buffer.from(bound.preReportFiles[0].bytes);
c.payloads.workbook.bytes.fill(0);
expect(bound.preReportFiles[0].bytes).toEqual(original);
```

Use explicit assertions narrowing optional array/workbook values before dereferencing; the compact examples do not authorize non-null assertions. Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-package-inputs.e2e.test.ts --maxWorkers=1` against the isolated US URL. Expect RED from missing bindings, not DB setup errors or skips.

The shared fixture's exact exported signature uses the existing store's validated request type:

```ts
export async function createUsRequestPackageFixture(
  db: Db,
  options: { mode: UsRequestPayloadResult["mode"]; empty?: boolean; withPlan?: boolean },
): Promise<{
  tenantId: string;
  actorId: string;
  request: Awaited<ReturnType<UsRequestStore["create"]>>;
  run: UsTraceExportRunRow;
  payloads: UsRequestPayloadResult;
  plan: UsRequestPinnedPlanResult;
  context: UsRequestReportContext;
  planFixture: ReturnType<typeof createUsRequestPlanFixture>;
  destroy(): void;
}>;
```

Default `empty` is false and `withPlan` is true. Set test `workerStartedAt` to run preparation + 1,000 ms and `reportDataPreparedAt` to + 2,000 ms. These are explicitly synthetic context values, not measured operation. Teardown calls `planFixture.destroy()`; the suite separately owns its disposable DB.

- [x] **Step 2: RED corruption/mode/context tests.** Parameterize wrong tenant/run/revision/mode/digest, noncanonical validation bytes, mismatched actual hashes/sizes, wrong Plan pin, ready absence, inconsistent missing code, extra context/model fields and unsupported versions. Keep valid v1 rejection at 409 before downstream work. Assert new binding/context errors at 503 with exact sanitized `{code}` only.

```ts
const invalidContexts = [
  { ...c.context, workerStartedAt: "2026-10-04T00:00:00+00:00" },
  { ...c.context, reportDataPreparedAt: new Date(c.run.startedAt.getTime() - 1).toISOString() },
  {
    ...c.context,
    workerStartedAt: new Date(Date.parse(c.context.reportDataPreparedAt) + 1).toISOString(),
  },
];
for (const context of invalidContexts) {
  expect(() => bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, context)).toThrow(
    expect.objectContaining({ response: { code: "us_request_package_context_invalid" } }),
  );
}
```

Also test nonzero sub-millisecond precision, unsafe elapsed arithmetic, null worker timing and exact/beyond report-model/input limits. Use coherent cloned evidence with recomputed digests only where testing a deeper binding; never edit an accepted run row. For `not_attested` keep the label distinct from a separately coherent trusted-demo model.

- [x] **Step 3: Implement strict schemas, bounds and copies.** Gate v2 first, then bind payload metadata to the run, validate canonical validation bytes, and match Plan/absence against the frozen pin. Validate render findings with the existing strict US-07 finding schema. Recompute actual hashes before accepting descriptors; copy byte buffers and JSON-derived model fields. Use `Number.isSafeInteger` for sizes/counts/elapsed and reject unsupported controls before layout. Unsupported PDF control text is a technical model failure, not repaired text. Finite codes: `us_request_package_inputs_invalid`, `us_request_package_context_invalid`, `us_request_package_model_invalid`, `us_request_package_size_limit`.

```ts
const counts = { receiving: 0, transformation: 0, shipping: 0 };
for (const source of frozen.validationSnapshot.sources) counts[source.type] += 1;
const capturedRevisionCount = frozen.validationSnapshot.sources.length;
const workbookEventCount = frozen.exportInput?.events.length ?? 0;
const elapsed = Date.parse(context.reportDataPreparedAt) - Date.parse(frozen.generatedAt);
if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw contextInvalid();
```

Define `contextInvalid()` in the same module as `new ServiceUnavailableException({code:"us_request_package_context_invalid"})`. Do not confuse snapshot capture counts with XLSX rows/quantities. `assertUsRequestReportModel` rejects duplicate/file-path names, missing/extra mandatory descriptors, contradictory mode/Plan/omission pairs, inconsistent summary totals, unsafe numbers and model bytes beyond 1 MiB; schema validation grants no origin attestation or authorization. Exact counts come from the verified frozen evidence in the binder, not from standalone model shape validation or a client-supplied summary.

- [x] **Step 4: GREEN and independently review.** Run inputs plus existing evidence/payload/versions/Plan-reader suites with zero US DB skips; API typecheck/lint. Reviewer checks copies before await, chronology, exact mode behavior and selected counts. Record scoped changes/test evidence without committing, then stop at this review gate.

### Task 2: Real deterministic request-report PDF

**Create:** `us-request-report-pdf.tsx`, `us-request-report-pdf.e2e.test.ts`. Consume the exact Task 1 model/assertion, constants/types and fixture. Keep existing Plan PDF/assets and `nest-cli.json` unchanged: resolve already-bundled assets through the sibling Plan assets path.

**Produces:**

```ts
export async function renderUsRequestReportPdf(
  model: UsRequestReportModel,
): Promise<UsRequestPackageByteFile<"request-report.pdf">>;
```

- [x] **Step 1: RED actual PDF byte/text tests.** Build the model via real fixture/binding. Render twice, assert `%PDF-`, equality and actual hash/size; extract text using the existing Poppler pattern. Fixture-owned temporary test files are allowed, not production composer disk writes. Close/remove only the exact generated temp directory after evidence has been inspected.

```ts
const a = await renderUsRequestReportPdf(bound.model);
const b = await renderUsRequestReportPdf(bound.model);
expect(a.bytes).toEqual(b.bytes);
expect(a.sha256).toBe(createHash("sha256").update(a.bytes).digest("hex"));
expect(a.byteSize).toBe(a.bytes.length);
expect(a.bytes.subarray(0, 5).toString()).toBe("%PDF-");
const text = extractUsRequestReportText(a.bytes);
expect(text).toContain("Report data prepared at");
expect(text).toContain("Elapsed to report data preparation");
expect(text).not.toContain("Publication completed");
expect(text).not.toContain(a.sha256);
```

Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-report-pdf.e2e.test.ts --maxWorkers=1`; expect missing-renderer RED, not absent Poppler counted as success.

Define the synchronous test-only extractor in that test using Node filesystem/child-process APIs, matching the established Plan PDF test pattern. Missing Poppler fails the gate instead of skipping assertions:

```ts
function extractUsRequestReportText(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "markiro-us-request-pdf-test-"));
  try {
    const path = join(dir, "request-report.pdf");
    writeFileSync(path, bytes);
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

This generated fixture directory is the exact cleanup target; never use a workspace, user directory, storage prefix or a previously existing temp path.

- [x] **Step 2: RED presentation/limits/error tests.** Cover ready/incomplete/empty, both origin results, null worker start, full hash and frozen requester/alternate deadline/scope, known actor ID, captured-vs-workbook counts, separate findings and missing-file reasons. Use coherent strictly validated models. DST tests compare explicit timezone/UTC with numeric offset on both sides of the repeated hour; do not assert ambiguous abbreviation alone. Long TLC/contact/build identifiers, multilingual requester text and printable punctuation must wrap/preserve text, or fail explicitly if unsupported by the font/rendering pipeline—never strip/truncate silently. Control characters and model excess reject before renderer allocation.

```ts
const context = { ...c.context, workerStartedAt: null };
const unknown = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, context);
const result = await renderUsRequestReportPdf(unknown.model);
const extractedText = extractUsRequestReportText(result.bytes);
expect(extractedText).toContain("Worker started: Unavailable");
expect(extractedText).toContain("Tenant origin not attested");
expect(extractedText).not.toContain("Verified operational");
```

No hardcoded surrogate PDF or mocked default renderer in these integration assertions. Force renderer exception/oversized output in separate narrow seam tests and assert `us_request_report_render_failed` / `us_request_package_size_limit`, without provider/private text or cause.

- [x] **Step 3: Implement bounded LETTER layout.** Call Task 1 assertion before allocating the layout tree. Register bundled fonts, use readable repeated heading/footer and `wrap` support, and fix PDF dates to context data-preparation time. Use `Intl.DateTimeFormat(...).formatToParts` with explicit `en-US`/tenant timezone and numeric offset; render UTC separately. Keep all pre-report descriptors and full render findings, full counts and explicit validation-JSON summary notice. Include all wording from the approved spec; no self/later hashes, contact metadata, current requester lookup or clock.

```tsx
<Document
  title="Markiro US trace request report"
  creator={US_REQUEST_REPORT_PDF_VERSION}
  producer={US_REQUEST_REPORT_PDF_VERSION}
  creationDate={new Date(model.timing.reportDataPreparedAt)}
  modificationDate={new Date(model.timing.reportDataPreparedAt)}
>
  <Page size="LETTER" wrap>
    <Text>
      {model.identity.mode === "export_ready" ? "Export-ready" : "Available records — incomplete"}
    </Text>
  </Page>
</Document>
```

This snippet pins metadata/mode, not a substitute for all required sections. Recompute actual PDF length/hash after rendering; enforce 4 MiB, no partial output and caller-owned bytes. Sanitize renderer errors without turning them into missing-report entries.

- [x] **Step 4: GREEN and visual inspection gate.** Run PDF/inputs and existing `us-plan-pdf.test.ts`, API typecheck/lint/build. Use local Poppler to render the exact ready/incomplete/long-text PDFs; inspect pages with `view_image`, retain a scoped evidence note with page counts/clipping/wrapping findings. Do not label text-only tests visual verification. Independent reviewer confirms real repeated bytes and no changed Plan renderer/assets.

### Task 3: Strict manifest and acyclic sums

**Create:** `us-request-package-manifest.ts`, `us-request-package-manifest.e2e.test.ts`. Consume Task 1 inputs and Task 2 real PDF. No ZIP parsing yet.

**Produces:**

```ts
export interface UsRequestManifestV1 extends Pick<
  UsRequestReportModel,
  | "identity"
  | "timing"
  | "tenantOrigin"
  | "stamps"
  | "selectionSummary"
  | "findingsSummary"
  | "renderFindings"
  | "plan"
  | "digests"
  | "warningAcknowledgement"
> {
  schemaVersion: 1;
  packageVersion: typeof US_REQUEST_PACKAGE_VERSION;
  reportRendererVersion: typeof US_REQUEST_REPORT_PDF_VERSION;
  files: readonly UsRequestFileDescriptor[];
  missingFiles: readonly UsRequestMissingFile[];
}
export interface UsRequestManifestBundle {
  model: UsRequestManifestV1;
  payloadFiles: readonly UsRequestPackageByteFile[];
  manifest: UsRequestPackageByteFile<"manifest.json">;
  sums: UsRequestPackageByteFile<"SHA256SUMS">;
}
export function buildUsRequestManifest(
  inputs: UsRequestPackageInputs,
  report: UsRequestPackageByteFile<"request-report.pdf">,
): UsRequestManifestBundle;
export function parseUsRequestManifest(value: unknown): UsRequestManifestV1;
```

- [x] **Step 1: RED golden coverage with real inputs/report.** Check exact file order, canonical bytes, hashes/lengths, full required metadata, correct mode/origin, and complete render findings separately from frozen finding counts. Do not put requester contact in manifest identity or copy the entire private report model unnecessarily.

```ts
const report = await renderUsRequestReportPdf(bound.model);
const bundle = buildUsRequestManifest(bound, report);
expect(bundle.model.files.map((file) => file.name)).toEqual([
  "records.xlsx",
  "plan.pdf",
  "validation.json",
  "request-report.pdf",
]);
expect(bundle.manifest.bytes.toString("utf8")).toBe(stableStringify(bundle.model));
expect(bundle.sums.bytes.toString("utf8")).toBe(
  [...bundle.payloadFiles, bundle.manifest]
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join(""),
);
expect(bundle.model.files.some((file) => file.name === "manifest.json")).toBe(false);
```

Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-package-manifest.e2e.test.ts --maxWorkers=1` and record RED.

- [x] **Step 2: RED omission/schema/tamper tests.** Empty incomplete has exactly validation+report payloads and explicit workbook/Plan reasons; incomplete with both optional files remains incomplete. Ready omissions, unknown reason codes, fabricated absent hashes/sizes, duplicate/path/self/sums/ZIP entries, extra fields, mismatched identity/pin, metadata-only substituted report hashes and stale pre-report descriptors fail. Rehash all tampered files and assert that trusted expected binding still rejects; a new hash cannot authorize changed identity. Test 1 MiB manifest and 16 KiB sums limits including exact-bound helpers.

```ts
const empty = await createUsRequestPackageFixture(f.db, {
  mode: "available_records_incomplete",
  empty: true,
  withPlan: false,
});
const input = bindUsRequestPackageInputs(
  empty.run,
  empty.tenantId,
  empty.payloads,
  empty.plan,
  empty.context,
);
const result = buildUsRequestManifest(input, await renderUsRequestReportPdf(input.model));
expect(result.model.missingFiles).toEqual([
  { name: "records.xlsx", code: "empty_selection" },
  { name: "plan.pdf", code: "plan_absent" },
]);
expect(result.model.identity.mode).toBe("available_records_incomplete");
```

- [x] **Step 3: Implement strict canonical manifest/sums.** Revalidate model/descriptors/byte hashes and report fixed name/type/size; derive manifest metadata from the validated copied model. Parse strict version/known fields, reject duplicate/extra/cyclic entries and contradictory omissions. Use lowercase SHA256, integer positive lengths and LF checksum records exactly once. Map invalid manifest/sum composition to `us_request_package_manifest_invalid`, retain size failures separately.

```ts
const manifestBytes = Buffer.from(stableStringify(manifestModel), "utf8");
const sumsBytes = Buffer.from(
  [...payloadFiles, manifestFile].map((file) => `${file.sha256}  ${file.name}\n`).join(""),
  "ascii",
);
```

Define `manifestModel`, `payloadFiles`, `manifestFile` as the strict parsed derived model, ordered copied payloads and hash descriptor for `manifestBytes` in the implementation. Never add a self-hash field and patch it afterward. Returned file buffers cannot alias input/report or each other.

- [x] **Step 4: GREEN and independent review.** Run manifest/PDF/inputs suites and typecheck/lint. Reviewer checks inclusion matrix, full finding provenance, identities and canonical hash order with tamper/rehashed-negative cases before Task 4.

### Task 4: Canonical stored ZIP, verifier and composer

**Create:** `us-request-package-zip.ts`, `us-request-package.ts`, `us-request-package-zip.test.ts`. Task 5 owns the separate package e2e file. Consume Task 1 bound inputs, Task 2 renderer and Task 3 manifest bundle/parser.

**Produces:**

```ts
export interface UsRequestPackageExpectation {
  manifest: UsRequestManifestV1;
  files: readonly UsRequestPackageByteFile[]; // payloads, manifest, sums, exact archive order
}
export function encodeUsRequestPackageArchive(
  files: readonly UsRequestPackageByteFile[],
): UsRequestPackageByteFile<"package.zip">;
export function verifyUsRequestPackageArchive(
  bytes: Uint8Array,
  expected: UsRequestPackageExpectation,
): void;
export interface UsRequestPackageResult {
  runId: string;
  revision: number;
  mode: UsRequestPayloadResult["mode"];
  files: readonly UsRequestPackageByteFile[]; // independently owned, includes sums
  manifest: UsRequestManifestV1;
  zip: UsRequestPackageByteFile<"package.zip">;
}
export async function assembleUsRequestPackage(
  inputs: UsRequestPackageInputs,
): Promise<UsRequestPackageResult>;
```

`assembleUsRequestPackage` is internal: its trusted caller binds after obtaining real upstream bytes. Revalidate/copy synchronously before the first await so Task 1 output object mutation during rendering cannot change manifest/archive inputs. It performs no DB or private reads itself; rejection before those reads belongs to the existing input boundary.

- [x] **Step 1: RED stored ZIP order/determinism/ownership tests.** Pure tests may construct known byte fixtures for the ZIP codec, clearly separate from real payload/Plan proof in Task 5. Use fixed names and real computed descriptors/strict minimal expected manifest. Assert method 0, exact mtime/local+central metadata, CRC/byte contents, four/six entry orders and no comments/trailing bytes, then verify against the trusted expectation.

```ts
const first = encodeUsRequestPackageArchive(expected.files);
const second = encodeUsRequestPackageArchive(expected.files);
expect(first.bytes).toEqual(second.bytes);
expect(first.sha256).toBe(createHash("sha256").update(first.bytes).digest("hex"));
expect(() => verifyUsRequestPackageArchive(first.bytes, expected)).not.toThrow();
const corrupted = Buffer.from(first.bytes);
corrupted[0] = corrupted[0] ^ 1;
expect(() => verifyUsRequestPackageArchive(corrupted, expected)).toThrow(
  expect.objectContaining({ response: { code: "us_request_package_archive_invalid" } }),
);
```

Narrow indexed bytes under strict TS before XOR. Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-package-zip.test.ts`; record behavior RED, not a skipped test.

- [x] **Step 2: RED bounded hostile-header and expected-anchor tests.** Test dropped/added/swapped files, duplicate names, `../`, absolute/backslash paths, link attrs, encryption/data-descriptor flags, ZIP64, compression method, local/central name/size/CRC disagreement, truncated offsets, comments/trailing data, huge declared lengths and total entry bytes. Replacing every file+manifest+sums coherently must still fail against original trusted expectation. Noncanonical JSON/LF/case/order and checksum coverage/cycles fail. Exact maximum helper checks pass and limit+1 rejects before archive/render allocation; keep these separate from semantic file validity.

```ts
const replacement = encodeUsRequestPackageArchive(replacementExpected.files);
expect(() => verifyUsRequestPackageArchive(replacement.bytes, expected)).toThrow(
  expect.objectContaining({ response: { code: "us_request_package_archive_invalid" } }),
);
```

Define `replacementExpected` from a different internally coherent known test manifest/payload set. Explicitly test shifted run/tenant/revision/mode, Plan bytes and render context. For stored entries, validate declared actual ranges before slicing/copying; no decompressor is needed and unsupported method fails before inflation. Spy on codec invocation to prove aggregate oversize rejection occurs before allocation.

- [x] **Step 3: Implement encoder and bounded verifier.** Preflight sizes, names/types/order/presence and actual descriptor hashes. Use existing fflate `zipSync`, fixed level and **local date components** for the DOS epoch, since fflate encodes ZIP local date fields. No `new Date("1980-01-01T00:00:00Z")` dependence on host timezone.

```ts
const entries = Object.fromEntries(
  files.map((file) => [
    file.name,
    [
      Buffer.from(file.bytes),
      {
        level: 0,
        mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
        os: 0,
        attrs: 0,
      },
    ],
  ]),
);
const bytes = Buffer.from(zipSync(entries, { level: 0 }));
```

Use fflate's exported input types to type the entries rather than an `any` or broad cast. Verify the emitted pinned header profile in tests, including UTF8/name flags required by that encoder; accept only those fixed values. Bounded parser validates EOCD/local/central offsets and lengths, entry count and stored slices, flags/attrs, CRC and exact canonical expected bytes/manifest/sums. Do not use `unzipSync` as a sufficient security preflight because duplicate keys can collapse and size declarations can trigger allocation. Reuse a focused local helper if current source has an equivalent; do not install a general parser framework.

- [x] **Step 4: Implement composer and deferred-await mutation tests.** Copy and assert inputs, render real report, build manifest/sums, encode and verify before returning any result. Allow a private renderer injection only if needed to deterministically hold the await in tests; default must stay the actual renderer and real integration must not replace it. Reject technical failures, never return partial files.

```ts
const report = await renderUsRequestReportPdf(copiedInputs.model);
const bundle = buildUsRequestManifest(copiedInputs, report);
const files = [...bundle.payloadFiles, bundle.manifest, bundle.sums];
const zip = encodeUsRequestPackageArchive(files);
verifyUsRequestPackageArchive(zip.bytes, { files, manifest: bundle.model });
```

`copiedInputs` is an asserted deep model copy plus independent bounded file buffers made before await. Copy final file buffers/manifest/ZIP for output independence. Use exact finite archive error above and `us_request_report_render_failed` for renderer exceptions; retain size/model/manifest error classes. Tests mutate original bound model/files during a held render and then mutate returned individual buffers to prove no cross-artifact aliases.

- [x] **Step 5: GREEN and independent review.** Run ZIP plus earlier task suites, API typecheck/lint/build and diff checks. Reviewer examines bounded header parsing and actual range arithmetic, checksum/expected anchor, ZIP determinism in separate UTC/non-UTC test processes, and async ownership. No publication/storage work is permitted as a convenience.

### Task 5: Real synthetic package integration and CI ownership

**Create:** `apps/api/test/us-request-package.e2e.test.ts`.

**Modify:** `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, this plan's eventual accepted checkpoint and `docs/us/implementation-plan.md`. No product module changes unless a reviewed integration defect is explicitly handed back to its owning implementer. Preserve all inherited workflow suites and unconditional operational locks.

**Consumes/produces:** consume `createUsRequestPackageFixture`, `bindUsRequestPackageInputs`, `assembleUsRequestPackage`, real Plan approval/private reader and US-07 renderer. Produce no new runtime API; produce measured integration evidence and required check-only suite ownership.

- [x] **Step 1: RED full package, saved drift and no-write assertions.** For both modes, approve a real Plan, prepare a real frozen run, bind and compose. Compare archive workbook/Plan/validation bytes exactly against upstream originals; verify report text and manifest/mode. Snapshot tenant-filtered run/artifact/Plan/audit rows and transport calls **after fixture creation**, before composition. Assemble twice with identical context; assert equal files/ZIP and unchanged rows; composer makes zero transport calls.

```ts
const bound = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);
const before = await persistedTenantRows(f.db, c.tenantId);
const first = await assembleUsRequestPackage(bound);
const second = await assembleUsRequestPackage(bound);
expect(first.zip.bytes).toEqual(second.zip.bytes);
expect(await persistedTenantRows(f.db, c.tenantId)).toEqual(before);
expect(first.mode).toBe(c.run.mode);
verifyUsRequestPackageArchive(first.zip.bytes, { files: first.files, manifest: first.manifest });
```

Define `persistedTenantRows(db, tenantId)` in this test using the existing Plan-reader test's tenant-scoped queries for runs/artifacts/Plan/audit ordered by IDs. Compare exact rows, not counts; do not print contact/private object keys. After source/request updates and real Plan supersession, rerun the existing saved run's payload/Plan readers, bind with the original context and assert identical package. Do not update an accepted run. For edits use the existing authorized store patterns/tests; keep the approved Plan object retained.

```ts
async function persistedTenantRows(db: Db, tenantId: string) {
  return {
    runs: await db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, tenantId))
      .orderBy(asc(schema.traceExportRuns.id)),
    artifacts: await db
      .select()
      .from(schema.traceExportArtifacts)
      .where(eq(schema.traceExportArtifacts.tenantId, tenantId))
      .orderBy(asc(schema.traceExportArtifacts.id)),
    plans: await db
      .select()
      .from(schema.traceabilityPlanVersions)
      .where(eq(schema.traceabilityPlanVersions.tenantId, tenantId))
      .orderBy(asc(schema.traceabilityPlanVersions.id)),
    audits: await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
      .orderBy(asc(schema.tenantAuditEvents.id)),
  };
}
```

- [x] **Step 2: RED explicit empty/absent, failed private read, legacy and provenance integration.** Test empty incomplete, nonempty incomplete with Plan absent, and both files present without an export-ready claim. Missing/corrupt/failed pinned read in both modes throws `us_request_plan_read_failed` before the composer; v1 gate preserves 409 before reader/render. Test `not_attested` and a real reserved-demo tenant provisioned only in an owned child (reuse owner fixture patterns rather than fabricating an audit). Both request report/package metadata and unchanged Plan marks must be checked without treating provisioning as proof of every event. Carry forward v1 JSON/XLSX replay regression, including unchanged original bytes/digests.

```ts
c.planFixture.transport.fault = "unavailable";
await expect(
  new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(c.run, c.tenantId),
).rejects.toMatchObject({ response: { code: "us_request_plan_read_failed" } });
```

For `withPlan:false`, keep `planFixture` available as fixture infrastructure but make no approval; its reader returns originally absent only where allowed. Narrow live object fault injection to the test-owned provider; never touch real storage.

- [x] **Step 3: RED CI ownership, then add the five suites.** Extend the existing `US-09 request rules, contracts, storage and freeze suites run unconditionally in isolated CI` tuple list, adding all five API filenames. Its existing command parser requires direct `pnpm --filter ... exec vitest run`, serial `--maxWorkers=1`, the isolated US DB URL and no conditions/ignored failures. Keep that format; do not weaken the test to accept arbitrary commands.

```js
["api", "us-request-package-inputs.e2e.test.ts"],
["api", "us-request-report-pdf.e2e.test.ts"],
["api", "us-request-package-manifest.e2e.test.ts"],
["api", "us-request-package-zip.test.ts"],
["api", "us-request-package.e2e.test.ts"],
```

Run `node --test tools/us-development/test/isolation.test.mjs` and record missing-suite RED. Then extend the existing serial request workflow step after dependency builds to run these tests with the same synthetic US URL; existing Poppler install already supports text/render tools. Pure ZIP suite may share that step's US env; it must not use the DB. Inspect `tools/ci/affected.mjs` for current API/test/workflow ownership; no widening change is needed unless a real missing owner is demonstrated and reviewed.

- [x] **Step 4: Run integrated gates and distinguish evidence.** Build affected dependencies through Corepack before consumers (domain, DB, platform-contracts, email, legal-documents as needed), then run all five new suites and the nine existing request suites serially. Run owner/Plan/export regressions and complete API gate once under the safe env, recording setup failures/skips distinctly. Execute API typecheck/lint/build, `git diff --check`, scoped and repository formatting, Node isolation tests and checker. Do not claim local Turbo orchestration/remote CI unless exercised; direct Corepack is the documented fallback for the existing global pnpm mismatch, not policy bypass.

```sh
env -u DATABASE_URL -u INVENTORY_TEST_DATABASE_URL -u LOCAL_INFRA_SMOKE -u NATIONAL_CATALOG_LIVE_GTIN -u NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev corepack pnpm --filter @markiro/api exec vitest run test/us-request-package-inputs.e2e.test.ts test/us-request-report-pdf.e2e.test.ts test/us-request-package-manifest.e2e.test.ts test/us-request-package-zip.test.ts test/us-request-package.e2e.test.ts test/us-request-selection.e2e.test.ts test/us-request-store.e2e.test.ts test/us-request-validation.e2e.test.ts test/us-request-prepare.e2e.test.ts test/us-request-run-evidence.e2e.test.ts test/us-request-payloads.e2e.test.ts test/us-request-tenant-origin.e2e.test.ts test/us-request-versions.e2e.test.ts test/us-request-plan-reader.e2e.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
node --test tools/us-development/test/*.test.mjs
node tools/us-development/check-isolation.mjs
corepack pnpm format:check
git diff --check
```

The URL is the declared synthetic loopback fixture, not an operational credential. DB creation/cleanup belongs to the fixture's validated child ownership. If sandbox denies loopback, request only the narrow synthetic test command escalation; do not switch to another database or load primary env. Test dependencies/missing Poppler/failed provider are explicit blockers to those gates, not permissions to rewrite manifests or weaken assertions.

- [x] **Step 5: Independent integration review and factual checkpoint.** Final reviewer sees the whole scoped working diff against this plan's saved baseline, not the unrelated primary branch diff or only the last file. Correct findings through the owning implementer; do not bundle unrelated existing failures. Only after reviews/gates are recorded, mark completed checkboxes and append a local checkpoint with counts, skips/failures, default renderer bytes/text, visual pages actually inspected, bounds/tamper/timezone/ownership evidence, exact unchanged release locks and external limits. Roadmap keeps US-09 In progress and notes remaining worker/private publication/build provider/HTTP/UI work. No commit/push/release automatically follows completion.

## Final acceptance boundary

The checked items record accepted local component evidence, including explicit broad-suite failures and external limits. They do not mark the US-09 slice Done or claim a green whole-API gate.

- [x] Every task has a separate accepted independent review; final integration review has no unresolved Critical/Important finding.
- [x] Default real XLSX/Plan/report pipeline and deterministic archive pass required selected tests with zero disposable-US-DB skips; exact file hashes/counts and unchanged saved rows are evidenced.
- [x] Model/input/output/archive limits, corrupted/rehash/header/ZIP path cases, strict timing, origin distinctions, async ownership and earlier v1 compatibility are exercised.
- [x] PDF text checks and actual visual-page inspection are recorded separately; byte/text equality alone does not prove rendering quality or Excel compatibility.
- [x] Complete API results are reported accurately, including inherited primary-environment setup failures/skips; affected typecheck/lint/build/format/diff/isolation checks have fresh evidence.
- [x] No publication, worker, HTTP/UI, production provider, source recapture, main/RU changes or release/push is claimed. Remote CI, hosted non-RF storage, recovery, browser journey, Excel, full-flow performance, hardware and regulatory acceptance remain unverified unless separately exercised.

## Controller self-review at plan creation

Coverage: input trust/bindings, v1/v2, mode/omission and timing/limits → Task 1; report content/default PDF/determinism/visual gates → Task 2; acyclic canonical metadata/sums/full render findings → Task 3; stored ZIP/expected anchors/hostile-header/ownership bounds → Task 4; real saved-drift/no-write/provenance integration and unconditional CI/checkpoints → Task 5. Five Review Focus items have owning tests above. All consumed/produced interfaces are defined here or named existing source exports. This planning review is not execution evidence.

## Task 5 implementer checkpoint — 2026-10-04

Historical interim evidence before the I1 witness-writer correction and final review. Its original 13-case/319-test counts and then-pending broad gate are retained as history; the accepted checkpoint below supersedes them for current status.

The real integration suite passes 13/13 with zero skips. Both modes use the default US-07 workbook, real approved/private historical Plan reader and default report composer; every archived upstream byte is checked against its original. Repeated files/ZIP are equal, and tenant-filtered run, artifact, Plan and audit rows are compared exactly through a boolean deep comparison that does not dump private values. Composition adds no transport calls. Real source amendment/finalization, request edits and Plan supersession preserve the original run/context/ZIP without updating the accepted run. One captured Receiving event has two worksheet business rows. Empty, workbook-only, Plan-only and both-file incomplete packages retain their mode. Missing/corrupt/unavailable pinned Plan objects fail both modes before composition/rendering. Full v1 packages fail at 409 before readers/rendering while original validation/XLSX bytes and digests replay unchanged. A separately owned disposable child provisions the actual reserved owner, approves a real synthetic Plan and verifies unchanged Plan marks plus the report/manifest origin designation; this attests provisioning, not event facts.

CI ownership RED was observed at 17/18 isolation cases with the missing package-inputs suite; adding the five names to the existing direct serial command produces 18/18, zero skips. All 37 Node isolation tests and the isolation checker pass. The test-only Plan fixture now accepts only the tenant/actor strings it actually consumes, allowing real reserved provisioning without fabricated Receiving context; its behavior is unchanged. No runtime module, schema, dependency, release lock, permission or main/RU/Station file is changed by Task 5.

The initial sandbox DB hook failed at loopback EPERM and skipped 13 cases; that is infrastructure evidence only. Narrow synthetic-test escalation executed all 13. Initial executed tests exposed test setup errors (Metadata instead of Receiving worksheet, XML attribute order assumption and missing TLC-source location for reserved Plan approval); those were corrected from source and existing approval patterns, with no product defect or runtime fix. Final selected gates pass 319/319 across all five new and nine existing request suites plus 146/146 across eight owner/Plan/export regressions, zero skips in both. Fresh affected dependency builds, API typecheck/lint/build, scoped/repository formatting and diff checks pass. Complete API remains controller-owned and pending; independent review/final acceptance remains pending.

Byte/text checks do not inspect new rendered pages. Controller visual acceptance applies only to the exact 14 frozen Task 2 pages named in `task-2-frozen-visual/witnesses.json`; no newly regenerated page is claimed inspected. Existing Vite native-loader warning remains. Remote CI, Turbo orchestration, hosted non-RF storage, package publication/recovery, browser journey, Excel interoperability, full-flow performance, hardware and regulatory acceptance are unverified. US-09 remains In progress; worker, private package publication, production build identity and HTTP/UI remain future work. No commit, push or release follows this checkpoint.

## Accepted local implementation checkpoint — 2026-10-04

All five tasks have separate accepted independent reviews, and final integration review is Approved with no unresolved Critical/Important finding (`final-review.md` in this plan's retained SDD workspace). Task 5 I1 is closed: the test-owned witness writer creates its parent, and a real initially absent nested directory produced ENOENT RED then exact-write/readback GREEN. Focused runs selected one case and deselected 13; those deselections are not DB coverage. The amended integration suite passes 14/14, zero skips, and the final serial selected aggregate passes 14 files / 320 tests, zero disposable-US-DB skips, in 141.09 seconds (`task-5-fix-1-selected.log`). This supersedes the overlapping 319 run rather than adding it. Eight unaffected owner/Plan/export files pass 146/146, zero skips; the two non-overlapping selected groups total 466 tests. Earlier 13-case integration evidence remains identified separately.

The real default workbook, actual approved effective/superseded historical Plan and default report composer are integrated in both modes. Archive upstream workbook/Plan/validation bytes, sizes and SHA256 equal their originals; repeated files/ZIP equal the same frozen input/context. Exact tenant-filtered run/artifact/Plan/audit rows and transport calls remain unchanged during composition. Real source amendment/finalization, requester/scope edits and Plan supersession retain the original saved ZIP without accepted-run mutation. One Receiving event contributes two worksheet data rows. Empty, workbook-only, Plan-only and both-present incomplete cases preserve their mode; failed pinned private reads fail both modes before composition. Full v1 packages reject at 409 before readers/rendering while existing v1 JSON/XLSX bytes/digests replay unchanged. Actual reserved-owner provisioning in an owned child supplies trusted-synthetic report/manifest origin and an unchanged, genuinely approved synthetic-marked Plan; normal tenants remain not attested. This attests provisioning, not event facts, and the direct integration audit assertion remains limited to action/count as disclosed below.

Affected shared packages were rebuilt through Corepack before consumer checks. API typecheck/lint/build, repository/scoped formatting, diff checks, all 37 isolation tests and the checker pass; after I1 the amended test source also has fresh typecheck/lint/scoped-format/diff evidence. The five new suites run in the existing direct, serial, unconditional check-only CI step with the declared synthetic US URL and dependency-build ordering. Existing suites, operational locks, permissions and main-target rejection are unchanged. The test-only Plan helper accepts the tenant/actor strings it consumes, without approval/renderer/provider behavior changes. Fixtures validate the synthetic base identity and create/migrate/drop only their successfully created random children; no primary environment or base/shared database is migrated or provisioned.

The controller completed one clean-environment full API gate (`controller-full-api-final.log`): exit 1; 399 files — 8 failed, 288 passed, 103 skipped; 3,445 tests passed and 1,411 skipped out of 4,856; no assertion failures; 1,048.95 seconds. The same eight files fail setup because primary configuration is intentionally unset: `billing-accounts.e2e.test.ts`, `exchange-credentials.e2e.test.ts`, `exchange-import.e2e.test.ts`, `exchange-orders.e2e.test.ts`, `exchange-protocol.e2e.test.ts`, `integrations-delete.e2e.test.ts`, `integrations.e2e.test.ts` and `subscription-route-inventory.test.ts`. Their `loadEnv` configuration failures have three exchange afterAll undefined-DB follow-on errors. No US failed suite or hook skip is reported. This remains a non-green complete API result, not permission to load primary credentials or repair RU setup. The broad run compiled the original 13-case integration source; the subsequent test-only parent creation/new 14th case is covered by amended 14/14 integration and fresh 320 selected tests, not claimed as a second full API run. The first sandbox broad attempt was aborted at exit 130 after loopback EPERM-driven hook skips; it is retained separately and is not counted as completed broad verification.

PDF byte equality and extracted text checks are distinct from actual pixels. Controller visual acceptance covers only the exact frozen inventory `task-2-frozen-visual/witnesses.json`: ready 4 pages, incomplete 4, long text 6, 14 pages total, with the three PDF and all PNG sizes/hashes independently verified. No regenerated page inherits that inspection. ZIP codec tests pass 84/84 in UTC and 84/84 in America/Los_Angeles with equal known-byte four-/six-entry golden archives; this proves codec timezone determinism, not real PDF/XLSX interoperability. Model/parser/output bounds, tamper/rehash/hostile-header cases and async ownership are exercised. Restored test-only threshold seams qualify structurally unreachable default maxima, including the finite 16 KiB checksum set and aggregate 48/64 MiB bounds; they are enforcement evidence, not valid maximum-size artifacts, Excel acceptance or performance measurements.

Four nonblocking observations carry forward: broader positive Transformation/Shipping/mixed-lifecycle binder/package fixtures; safe claimed-duration zero with an unsafe computed date delta to pin the subtraction guard directly; invocation-specific named-PDF witness hygiene (current acceptance is protected by the exact frozen copy); and explicit actor/tenant/target/result/metadata assertions for the reserved provisioning audit. The inherited Vite native-loader/CommonJS warning remains visible and deferred. No tests or runtime behavior are expanded merely to close these observations. The five existing rulings and their risks remain recorded in `progress.md` in this plan's SDD workspace: working-file review baselines, focused gates plus one completed broad run, pinned PDF `/ModificationDate`, trusted upstream input authority, and qualified default-limit seams. Final review accepts those dispositions; this checkpoint adds no new ruling.

Worker/context persistence, durable readiness, private package publication/download, production build identity and HTTP/UI remain future increments; US-09 stays In progress. Remote CI/GitHub protections, hosted non-RF geography, recovery, Excel interoperability, browser journeys, measured full-flow performance, hardware and regulatory acceptance were not exercised and remain outside this component acceptance. Internal returned bytes grant no authorization and are not published artifacts. No Git stage/commit/push/PR/merge, release or deployment occurred or follows acceptance, and no worktree, retained SDD workspace or Git cleanup was performed or is authorized by acceptance.
