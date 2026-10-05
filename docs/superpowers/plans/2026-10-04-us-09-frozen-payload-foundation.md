# US-09 Frozen Validation and XLSX Payload Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Preserve the owner's chosen execution method: a separate implementer and independent reviewer for each task, followed by a final integration review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Owner-approved and locally implemented on 2026-10-04; both task reviews and final integration review accepted. Internal foundation only; stage 3 and US-09 remain in progress.

**Goal:** Verify a saved US-09 run through one shared evidence boundary and derive bounded validation JSON and optional XLSX bytes from that exact frozen evidence, without publication or a ready-state update.

**Architecture:** Extract the existing frozen-run verifier from Prepare without changing accepted replay behavior. A new internal payload renderer consumes the verified run, serializes its saved envelope canonically and invokes the actual US-07 adapter only when the run contains an export input. It never reselects scope or reads current request, event, catalog, Plan or build values.

**Tech Stack:** Existing TypeScript/NestJS, Drizzle PostgreSQL fixtures, Zod, Node SHA-256, US-07 XLSX adapter and Vitest; no new dependencies.

**Spec:** The [owner-approved US-09 design](../specs/2026-10-04-us-09-trace-request-current-design.md), especially Immutable run and source freeze, Package and publication, and independently reviewed stage 3; the [selection/freeze supplement](../specs/2026-10-04-us-09-selection-freeze-design.md) and [completed local checkpoint](2026-10-04-us-09-selection-validation-freeze.md#local-implementation-checkpoint--2026-10-04) define the persisted evidence being consumed.

## Global Constraints

- Reuse `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve all existing dirty foundation, service, schema, documentation and CI work. No staging, commit, push, PR, merge, release, deployment or scratch cleanup is authorized.
- Read root instructions and any applicable scoped guide before editing. No local Graphify graph currently exists. Do not modify RU entrypoints, runtime registration, Station, migrations, shared jobs, package manifests, lockfile, `.env`, cloud configuration or real data.
- This is the first internal subincrement of stage 3, not a response package or a user-facing export. Plan PDF retrieval, request report PDF, manifest, SHA256SUMS, ZIP, private package storage, worker leases/fences, immutable production build provider, HTTP, retry/download endpoints and cabinet UI are outside this plan.
- Shared evidence verification is not authorization. The caller supplies a server-resolved expected tenant. Preserve Prepare's fresh QA/export authorization, actor-bound key lookup, exact creation/replay/rejection audits and repeatable-read transaction boundaries. A future worker needs its own trusted execution boundary; do not invent one here.
- Keep the exact persisted envelope schema, mode meanings, generation instant, build stamp, scoped-content digest and full-input digest. Accept object-key reordering, but reject parser-induced content normalization and saved-array reordering that changes content/digests. Do not reinterpret corruption as an incomplete result.
- Complete selection remains bounded at 500 event revisions and the saved envelope at 16 MiB. Serialize the same validated envelope for `validation.json`, not a newly enlarged wrapper. Do not truncate fields or fabricate a record for an empty result.
- Proposed operational guard for this internal renderer: XLSX bytes must be nonempty and no larger than **16 MiB**. Exceeding that guard is a hard payload failure in both modes, not permission to drop a large workbook into a successful incomplete outcome. This is not an estimate or promise about final ZIP size; the later package plan must define aggregate/archive bounds separately.
- Only a typed US-07 workbook representability/writer failure may produce an explicitly unavailable XLSX in `available_records_incomplete`. Technical exceptions, invalid saved evidence, digest/registry mismatch and hard size violations fail both modes. Ready mode requires an actual nonempty verified workbook and no blocking rendering finding.
- No wall-clock, runtime Git, mutable package identity, current request/catalog/Plan lookup or source re-capture in evidence verification or payload rendering. Use saved generation time and saved build identity. Production identity injection remains a prerequisite of later publication, not implemented by this plan.
- Read-only byte composition writes no run, artifact or audit rows and changes no status. `exportReady` stays false for queued input. Return no public/private object key, signed URL, FDA submission claim or complete-package verdict.
- Requester contact remains private frozen content. Never copy it or source/parser/library details into routine logs or error payloads. Return finite machine codes; keep the frozen and rendering findings separate rather than editing prior evidence.
- Use focused failing tests before implementation and owned disposable `US_TEST_DATABASE_URL` fixtures for DB scenarios. Zero DB skips are required for acceptance. Build affected shared dependencies with Corepack before consumer checks; do not silently use stale dist output.

## Review Focus

1. Shared-verifier extraction must retain every existing replay integrity assertion, including normalization-only corruption and successful replay after closure/source drift (Task 1).
2. A valid failed/processing/ready run may retain the same evidence as a queued run; worker lifecycle columns and the current caller's identity are not part of frozen evidence, while the frozen preparer must still match the saved creator (Task 1).
3. Empty incomplete selection must produce validation bytes without calling the one-event-minimum US-07 adapter; an invalid/corrupt nonempty input cannot be mislabeled empty (Task 2).
4. Same saved run must retain byte-identical validation/XLSX across current source changes and a later injected build version; the renderer must neither import capture nor refresh mutable facts (Task 2).
5. A typed workbook failure, technical exception, wrong registry/input hash, falsified workbook hash and output-size violation must have distinct fail-closed outcomes; no partial success or ready flag (Task 2).

---

## File map

| Unit               | Files                                                                                                                                                                                                               | Responsibility                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Saved evidence     | Create `apps/api/src/modules/traceability/requests/us-request-run-evidence.ts`; modify `us-request-prepare.ts`; create `apps/api/test/us-request-run-evidence.e2e.test.ts`; retain `us-request-prepare.e2e.test.ts` | One strict verifier used by replay and subsequent rendering.                                      |
| Payload rendering  | Create `apps/api/src/modules/traceability/requests/us-request-payloads.ts`; create `apps/api/test/us-request-payloads.e2e.test.ts`                                                                                  | Canonical validation bytes and exact US-07 XLSX invocation with bounded verified result.          |
| Test fixture       | Create `apps/api/test/support/us-request-payload-fixture.ts` only if the new suites share setup                                                                                                                     | Owned DB and real create/validate/prepare fixtures; no change to runtime data or unrelated tests. |
| Ownership/evidence | Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, and `docs/us/implementation-plan.md`                                                                                 | Unconditional US-only CI ownership and a dated local checkpoint with limits.                      |

Read `us-request-prepare.ts`, `us-request-snapshot.ts`, all four existing request suites, `export/adapter.ts`, `export/xlsx-writer.ts`, `export/xlsx-verify.ts`, `test/support/us-profile-database.ts` and `test/support/us-receiving-fixture.ts` before changing boundaries. Use the real request stores and existing fixture patterns; do not import one Vitest test file from another.

### Task 1: Shared frozen-run evidence verifier

**Files:** Create the evidence module and its focused e2e suite; modify only the extraction/import/call sites in Prepare. A narrowly scoped support fixture may serve both new suites.

**Interfaces:** Produce:

```ts
export type UsTraceExportRunRow = typeof schema.traceExportRuns.$inferSelect;
export type UsRequestFrozenRun = z.infer<typeof frozenSchema>;

export function verifyUsRequestRunEvidence(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): UsRequestFrozenRun;
```

The `frozenSchema` remains internal to the evidence module. Move `selectionSchema`, `snapshotSchema`, `frozenSchema`, the existing saved-run assertions and the `currentChain`/`selectsEvents` helpers needed for source-content binding to that module. Prepare still consumes both current-chain helpers; retain their existing signatures. Export `parseUsRequestFrozenRun(value: unknown): UsRequestFrozenRun | null` for Prepare's existing new-envelope schema check, so it does not duplicate or expose the schema. This parser checks shape only; only `verifyUsRequestRunEvidence` checks row bindings and digests. Keep Prepare's eligibility, provenance-cycle guard, capture, lock order, database writes and audits in Prepare. Do not introduce a second independent verifier or schema.

- [x] **Step 1: RED shared-entry test.** In the owned disposable DB create a real incomplete run through `UsRequestStore.create`, `UsRequestValidationStore.validate` and `UsRequestPrepareStore.prepare`, with the existing synthetic build `{ apiVersion: "test-us09-payload", gitSha: "a".repeat(40), dirty: false }`. Import the new verifier before it exists. Test the returned envelope, expected tenant, corrupted saved JSON/hash/bindings and unchanged run/audit rows. Use `createUsProfileTestDatabase` and `seedCompleteReceiving`; copy only the necessary setup from the existing Prepare suite into the new support fixture. Keep the full 24-case Prepare regression unchanged except imports needed by extraction.

```ts
const request = await new UsRequestStore(f.db).create(c.tenant, c.actor, {
  requestNumber: randomUUID(),
  requesterName: "Synthetic payload requester",
  requesterOrganization: null,
  requesterContact: "private@example.test",
  receivedAt: "2026-10-04T00:00:00Z",
  scope: { tlcs: ["NO-MATCH-PAYLOAD-FIXTURE"] },
});
await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
const run = await new UsRequestPrepareStore(f.db).prepare(
  c.tenant,
  c.actor,
  request.id,
  { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
  build,
);
expect(verifyUsRequestRunEvidence(run, c.tenant)).toMatchObject({
  selectionKind: "empty",
  exportInput: null,
  preparedBy: c.actor,
});
expect(() => verifyUsRequestRunEvidence(run, randomUUID())).toThrow();
```

In this snippet `f` is the owned DB fixture, `c` is the existing complete-Receiving seed and `build` is the explicit synthetic constant above. Add real nonempty-run verification through the same Receiving save/readiness/finalize calls used by the existing Prepare suite, not a hand-authored export snapshot.

- [x] **Step 2: Observe RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-run-evidence.e2e.test.ts --maxWorkers=1` with the owned loopback `US_TEST_DATABASE_URL`. Expect the missing evidence-module import to fail; a skipped DB suite is not RED evidence.
- [x] **Step 3: Minimal extraction.** Have the verifier return the strictly parsed envelope only after raw stable serialization equals parsed serialization and all current digest, tenant, creator, request/mode, generation, Plan/registry, acknowledgement, source-set, empty/input and metadata/content checks pass. Keep the existing sanitized `us_request_run_stored_invalid` technical error. The verifier compares frozen preparer with `run.createdBy`, not with a later reader/worker identity. Replay retains its actor check before calling the shared verifier:

```ts
if (stored.createdBy !== actorUserId) {
  throw new ServiceUnavailableException({ code: "us_request_run_stored_invalid" });
}
verifyUsRequestRunEvidence(stored, tenantId);
// Existing command comparison and exact replay audit remain inside this transaction.
```

Retain the current order: integrity verification precedes reporting a different-command idempotency conflict. Object-key order remains immaterial; parsed normalization cannot conceal changed saved bytes. The shared module reads no DB or clock and does not grant capability access.

- [x] **Step 4: GREEN and regression.** Run the new evidence suite and all four request suites together, plus the pinned source-reader regression, serially on disposable US PostgreSQL. Explicitly test worker-owned status/attempt/time changes without frozen-content change, frozen-preparer corruption, null/empty consistency, current-chain binding, object-key order and normalization-only mutation. Assert exact preservation of rows/audits during direct verification; preserve exact replay audits in Prepare.
- [x] **Step 5: Gates and independent review.** API typecheck, lint and build; scoped Prettier and `git diff --check`. Reviewer compares the extracted assertions line-for-line with the previous implementation, checks dependency cycles and actor/tenant boundaries, and confirms that no runtime/provider registration or persisted shape changed. Record results without committing. Accept Task 1 before Task 2.

### Task 2: Frozen validation/XLSX payload renderer and CI ownership

**Files:** Create the payload module and its owned-DB test suite; extend only the new support fixture as necessary. Add the two new suites to the existing US check-only workflow and isolation test. Update the roadmap/checkpoint after verification, without marking US-09 complete.

**Consumes:** Task 1 verifier and returned frozen envelope; `renderUsExportCore(input: ExportInputV1): Promise<UsExportCoreResult>`; `stableStringify` and the existing 16 MiB snapshot guard. No database/service-authority injection is needed by production rendering.

**Produces:** An internal, non-published result; neither name nor type may imply a complete package:

```ts
export interface UsRequestBytePayload {
  readonly name: "validation.json" | "records.xlsx";
  readonly contentType:
    "application/json" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteSize: number;
}

export type UsRequestMissingWorkbook =
  | { readonly code: "empty_selection" }
  | { readonly code: "workbook_unrepresentable" }
  | { readonly code: "workbook_writer_failed" };

export interface UsRequestPayloadResult {
  readonly runId: string;
  readonly revision: number;
  readonly mode: "export_ready" | "available_records_incomplete";
  readonly scopedContentDigest: string;
  readonly inputDigest: string | null;
  readonly validation: UsRequestBytePayload;
  readonly workbook: UsRequestBytePayload | null;
  readonly missingWorkbook: UsRequestMissingWorkbook | null;
  readonly renderFindings: readonly ExportFinding[];
}

export function renderUsRequestPayloads(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): Promise<UsRequestPayloadResult>;
```

Keep these types internal to the US API; do not extend public contracts or return them over HTTP in this plan. They describe only two payloads and cannot be used as publication evidence. Map actual US-07 `CELL_LIMIT_EXCEEDED`/`CELL_VALUE_UNREPRESENTABLE` to `workbook_unrepresentable`, and `XLSX_RENDER_FAILED` to `workbook_writer_failed`; reject an unrecognized runtime failure code instead of trusting a TypeScript cast. Preserve representability versus writer failures without exposing arbitrary library text.

- [x] **Step 1: RED payload scenarios.** Import the new renderer before it exists. With real saved runs, assert canonical validation bytes/hash/byte size, exact saved XLSX input, actual workbook rendering/verification, and two byte-identical calls. A zero-match incomplete run must return no workbook and must not call the US-07 adapter:

```ts
const adapter = vi.spyOn(exportAdapter, "renderUsExportCore");
const output = await renderUsRequestPayloads(run, c.tenant);
expect(output.validation.name).toBe("validation.json");
expect(output.validation.bytes).toEqual(Buffer.from(stableStringify(run.inputSnapshot), "utf8"));
expect(output.validation.sha256).toBe(
  createHash("sha256").update(output.validation.bytes).digest("hex"),
);
expect(output.workbook).toBeNull();
expect(output.missingWorkbook).toEqual({ code: "empty_selection" });
expect(adapter).not.toHaveBeenCalled();
```

`exportAdapter` is a namespace import of the actual `../src/modules/traceability/export/adapter`; `run` is the real empty fixture created by Task 1's setup. Add a nonempty real Receiving run with packaging style/value/UOM populated as in the existing Prepare fixture; render with the unmocked actual adapter for happy-path evidence. Model/writer fault doubles are for otherwise hard-to-reach failure branches only.

- [x] **Step 2: Observe RED.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-payloads.e2e.test.ts --maxWorkers=1` against owned disposable US PostgreSQL. Expect missing renderer import before implementation. Do not weaken the real-byte assertions to stub-only tests.
- [x] **Step 3: Minimal rendering.** Call the shared verifier first. Serialize its unchanged complete envelope as `validation.json` and compute SHA-256 over those exact UTF-8 bytes. If `exportInput` is null, return the explicit empty-selection outcome without calling the adapter. Otherwise call the actual adapter with only that frozen input; compare returned input digest, registry version/hash and actual workbook SHA-256 with saved/run identities. Require consistent workbook/failure/null pairs and nonempty bounded byte output. Ready-mode output with any error finding or absent workbook is a hard failure. Preserve available typed model/writer failure only in explicit incomplete mode, with a finite missing-workbook code and separate render findings.

```ts
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const technical = () =>
  new ServiceUnavailableException({ code: "us_request_payload_evidence_mismatch" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_payload_size_limit" });
const unavailable = () =>
  new ServiceUnavailableException({ code: "us_request_payload_workbook_unavailable" });

export async function renderUsRequestPayloads(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): Promise<UsRequestPayloadResult> {
  const frozen = verifyUsRequestRunEvidence(run, expectedTenantId);
  const validationBytes = Buffer.from(stableStringify(frozen), "utf8");
  if (validationBytes.length > US_REQUEST_SNAPSHOT_LIMIT) throw sizeLimit();
  const base = {
    runId: run.id,
    revision: run.revision,
    mode: frozen.mode,
    scopedContentDigest: run.scopedContentDigest,
    inputDigest: run.inputDigest,
    validation: {
      name: "validation.json" as const,
      contentType: "application/json" as const,
      bytes: validationBytes,
      sha256: sha256(validationBytes),
      byteSize: validationBytes.length,
    },
  };
  if (frozen.exportInput === null) {
    return {
      ...base,
      workbook: null,
      missingWorkbook: { code: "empty_selection" },
      renderFindings: [],
    };
  }
  let rendered: UsExportCoreResult;
  try {
    rendered = await renderUsExportCore(frozen.exportInput);
  } catch {
    throw new ServiceUnavailableException({ code: "us_request_payload_render_failed" });
  }
  if (
    rendered.inputDigest !== run.inputDigest ||
    rendered.registryVersion !== run.registryVersion ||
    rendered.registryHash !== run.registryHash
  )
    throw technical();
  if (rendered.workbook === null) {
    if (rendered.workbookSha256 !== null || rendered.failure === null) throw technical();
    const code = rendered.failure?.code;
    const missingWorkbook: UsRequestMissingWorkbook =
      code === "CELL_LIMIT_EXCEEDED" || code === "CELL_VALUE_UNREPRESENTABLE"
        ? { code: "workbook_unrepresentable" }
        : code === "XLSX_RENDER_FAILED"
          ? { code: "workbook_writer_failed" }
          : (() => {
              throw technical();
            })();
    if (frozen.mode === "export_ready") throw unavailable();
    return { ...base, workbook: null, missingWorkbook, renderFindings: rendered.findings };
  }
  if (rendered.failure !== null || !(rendered.workbook instanceof Uint8Array)) throw technical();
  if (rendered.workbook.byteLength === 0) throw technical();
  if (rendered.workbook.byteLength > US_REQUEST_SNAPSHOT_LIMIT) throw sizeLimit();
  const bytes = Buffer.from(rendered.workbook);
  const hash = sha256(bytes);
  if (hash !== rendered.workbookSha256) throw technical();
  if (frozen.mode === "export_ready" && rendered.findings.some((f) => f.severity === "error"))
    throw unavailable();
  return {
    ...base,
    workbook: {
      name: "records.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes,
      sha256: hash,
      byteSize: bytes.length,
    },
    missingWorkbook: null,
    renderFindings: rendered.findings,
  };
}
```

Implement `us_request_payload_size_limit` for the 16 MiB XLSX guard and saved validation-byte guard; `us_request_payload_workbook_unavailable` for ready-mode unavailability; sanitized technical evidence/failure errors for inconsistent adapter responses. Import `UsExportCoreResult` as a type from the actual adapter. Arbitrary adapter exceptions become technical `us_request_payload_render_failed` with no original message, payload or cause exposed; they never become an incomplete success. Never return a partial result after a thrown failure. All output buffers are caller-owned copies; mutation of a returned buffer cannot alter the input run or a later result.

- [x] **Step 4: Boundary and drift coverage.** Test exact 16 MiB acceptance and one-byte-over denial with narrow adapter doubles, recomputing SHA-256 so the test reaches the size guard rather than hash mismatch. Test falsified hash, wrong registry/full-input digest, malformed stored run and wrong expected tenant. Typed representability/writer failures may omit XLSX only in incomplete mode; unexpected exceptions and hard limits fail both modes. Inject an adapter exception containing private requester/source text and assert the exact sanitized technical code with none of that text/cause exposed. Run actual Receiving amendment/void/request close after preparing a run, then render the original again and compare validation/XLSX bytes and hashes. Assert unchanged run/artifact/audit rows before/after composition. Restore spies between cases.
- [x] **Step 5: Own CI and final gates.** First extend `tools/us-development/test/isolation.test.mjs` to require both new suites unconditionally after dependency builds, with `US_TEST_DATABASE_URL`, no general `DATABASE_URL`, no `continue-on-error`/conditional skips and `--maxWorkers=1`; observe it fail before changing the workflow. Add the two suites to the serial check-only US request step or a neighboring dedicated step. Existing affected-package ownership already covers API changes; leave `tools/ci/affected.mjs` unchanged unless a concrete missing owner is proven.

Run serially on disposable US PostgreSQL:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/us-request-run-evidence.e2e.test.ts test/us-request-payloads.e2e.test.ts test/us-request-prepare.e2e.test.ts test/us-request-validation.e2e.test.ts test/us-request-store.e2e.test.ts test/us-request-selection.e2e.test.ts test/us-export-source-reader.e2e.test.ts test/us-export-adapter.test.ts test/us-export-xlsx-writer.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
node --test tools/us-development/test/*.test.mjs
node tools/us-development/check-isolation.mjs
corepack pnpm format:check
git diff --check
```

Supply the established synthetic loopback `US_TEST_DATABASE_URL` without sourcing `.env` or logging credentials. Record test counts and zero DB skips. The existing broad API RU/auth setup failures remain a separate non-green gate; do not claim full API health from the affected command. If repeating a broad gate, disclose failures/skips rather than borrowing an old result.

- [x] **Step 6: Independent task and final integration review.** Inspect the complete uncommitted task/stage diff, not only the last tracked file. Verify extraction/replay compatibility, no live recapture, byte integrity, mode-specific failures, empty selection, bounded buffers, private diagnostics and CI ownership. After accepted review, add a dated checkpoint to this plan and the roadmap. Preserve scratch reports while uncommitted; no automatic branch integration or cleanup.

## Self-review and handoff boundary

This plan implements only the shared frozen-evidence boundary and the first two byte payloads of approved stage 3. It does not claim full stage-3 or US-09 completion. Task 1 produces the exact verifier/types/current-chain helper consumed by Prepare and Task 2; Task 2 owns size/outcome/drift tests and CI. All five Review Focus conditions are assigned explicit tests above.

Next independently planned increments must implement exact pinned historical Plan PDF reads, frozen server-derived synthetic provenance suitable for report/package marking, deterministic report and archive composition, immutable build identity injection, private storage and durable worker fencing before exposing HTTP preparation. No saved operational/synthetic classification may be guessed from requester text or attached PDF wording, and no later plan may silently rewrite already accepted run evidence to add it. Compatibility for earlier frozen runs is a design decision for that increment.

The owner approved this written plan on 2026-10-04. Execution method is already chosen; do not ask the owner to select it again. Dated implementation checkpoints, not plan creation or approval, establish executed verification. No external validation, push or release is authorized.

## Local implementer checkpoint — 2026-10-04

The shared frozen-evidence boundary and internal `validation.json` / `records.xlsx` composition are implemented locally. Both tasks have accepted independent spec/quality review; the final integration review is accepted with no Critical or Important findings. This is the first internal subincrement of stage 3; US-09 remains in progress.

The renderer verifies the original saved envelope before composition, hashes exact caller-owned bytes, uses only saved XLSX input and limits both payloads to 16 MiB. Empty selections omit XLSX explicitly. Only typed representability/writer failures may omit XLSX in incomplete mode; ready mode, technical exceptions, inconsistent identities and hard limits fail with finite codes. Unexpected core exceptions expose no original message or cause. Real Receiving amendment/finalize/void and request close leave the original validation/XLSX bytes unchanged, and composition writes no run, artifact or audit rows.

Implementer verification: the nine affected API suites pass 157/157 with zero DB skips on fixture-owned disposable synthetic US PostgreSQL, with general `DATABASE_URL` unset. API typecheck, lint and build pass; US development tests pass 37/37 with zero skips and the isolation checker passes. Both new suites have unconditional serial check-only CI ownership after dependency builds. Full repository formatting and diff checks pass. Controller independently verified evidence + Prepare (50/50), evidence + payloads (44/44), each with zero skips, and Node isolation contracts (37/37); the accepted Task 1 package is byte-identical after Task 2. The existing Vite native-config warning remains a consolidated deferred tooling item, and previously recorded broad API RU/auth setup failures remain separate non-green limits; this checkpoint does not establish full API health or remote CI.

The existing US-07 writer/semantic-verifier boundary converts its errors to typed `XLSX_RENDER_FAILED`. This increment preserves that taxonomy: incomplete mode may explicitly omit the workbook, ready mode fails, and failed verification never returns workbook bytes. Exceptions escaping the core fail with sanitized technical codes. This is not proof that every underlying writer exception is independently classified; any later package must preserve the omission and cannot call it complete publication. Current-code byte determinism is proven, not byte reproduction across future renderer/library/registry releases or validation of an external replaceable adapter protocol.

No HTTP, worker, private storage, historical Plan PDF retrieval, report/manifest/ZIP composition, production build provider, UI, publication or release capability is added. Browser/Excel/hosted/hardware/regulatory acceptance is unverified. All changes remain uncommitted in the approved dirty worktree; no push, deployment or cleanup occurred.
