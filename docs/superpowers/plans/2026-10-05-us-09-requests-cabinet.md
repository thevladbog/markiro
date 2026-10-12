# US-09 Requests Cabinet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved EN/ES Requests workflow in the existing isolated US cabinet using the accepted HTTP API, with bounded transport and an owned synthetic browser acceptance test.

**Architecture:** Compose a Requests subclient into the existing browser client and add one cabinet section with independently owned list, editor, validation, command and run state. Preserve immutable server evidence, exact command replay and current server authority. Exercise real HTTP preparation and a separately started worker using existing trusted fixture seams; do not change production server contracts.

**Tech Stack:** Node 24+, repository-declared Corepack pnpm, React/Vite, TypeScript strict mode, existing Zod contracts and `@markiro/domain`, `@markiro/ui`, Vitest/Testing Library, existing separately pinned Playwright 1.62.0, disposable PostgreSQL.

**Spec:** [Owner-approved Requests cabinet design](../specs/2026-10-05-us-09-requests-cabinet-design.md). Read the entire spec and root `AGENTS.md` before executing any task.

**Status:** Owner-approved plan, 2026-10-06; execution started. Execution method: a separate executor and independent specification/code review for each stage, followed by whole-increment review. No commit, push or release is authorized.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`, HEAD `f06aaef2b923a7ae902c0fabacfd0c4712c127c3`. Preserve accepted dirty HTTP/worker work and unrelated files. No commit, push, PR, merge, release, deployment, provider provisioning, real data or cleanup of old databases.
- EN/ES only (`en-US`, `es-US`), English fallback; existing `UsBrandMark`, bundled typography, tokens, light/dark themes and guarded in-cabinet navigation. No router, RU entry, separate theme, CDN, new product dependency or local installation.
- Processor profile `US_FSMA204_PROCESSOR` and `traceability.read` for reads; QA for CRUD; QA plus export for validation/acknowledgement/preparation/retry; export for downloads. Server authorization remains authoritative. A failed capability refresh blocks actions.
- Exact thirteen HTTP operations. Local `/api/us` is stripped by the existing browser proxy, not a server alias. Canonical lowercase UUID paths; strict query keys and no duplicates, encoded aliases, trailing slashes, HEAD, Range or arbitrary artifact keys.
- JSON deadline 15 seconds; create/PATCH body 256 KiB, commands 16 KiB, actual UTF-8 bytes. Download deadline 30 seconds covering headers and body.
- List default 25, maximum 50, offset 0–10000, server ordering and `hasMore`; exact-number/status filters only. No N+1 list enrichment or global-count inference.
- Default deadline exactly 86,400,000 milliseconds after receipt; tenant IANA timezone, explicit DST-fold offset, gaps rejected. Civil event dates are not instants. TLC/location lists maximum 50; AND between selectors, OR within lists.
- Complete scope maximum 500 revisions and 16 MiB snapshot; never truncate or reinterpret technical failure as incomplete. Saved validation is `not_rechecked`; only a matching fresh validation enables local preparation prechecks.
- Prepare/retry operation keys and frozen bodies are memory-only. Ambiguous replay uses the identical key/body; no automatic CRUD resubmission, durable-key promise or inference from an unrelated latest run.
- Selected queued/processing run polls every two seconds, no overlap, visible/mounted only; stop after three consecutive transient failures or five minutes per continuous window, on terminal state or identity/session change. Manual refresh/resume is explicit.
- Six fixed artifacts: workbook 16 MiB; Plan 8,000,000 bytes; validation 16 MiB; request report 4 MiB; manifest 1 MiB; ZIP 64 MiB. Status 200, fixed filename/MIME, exact descriptor length/SHA256, no-store/nosniff, bounded stream, cancellation/released readers/revoked Blob URLs. One active download per view.
- No PII in lists, notices, diagnostics, analytics or persistent browser storage. Frozen run requester/scope are not live editor facts. No external submission or compliance/approval claim.
- No actual dirty descriptor rewrite or fake clean production build. Use only existing owned clean build/storage fixture seams. Actual compiled bytes must remain unchanged while the browser/worker fixture is alive.
- Disposable CI may bootstrap the already-pinned separate browser tool with its frozen lockfile and Chromium using the existing repository pattern. No local install, new dependency or policy/lockfile change is included.
- Every stage has RED → GREEN evidence and independent reviews before the next stage. Replace routine commit steps with a reviewed, uncommitted checkpoint. Record failed/skipped gates; do not claim full API, remote CI, hosted recovery or operational readiness.

## Review Focus

1. A→B selection, tenant switch or authority loss while a response/hash resolves must never overwrite the new card or open old bytes: Tasks 2, 4, 7 deferred-response and post-await release tests.
2. Lost Prepare/retry receipt, double-click and changed source digest must not allocate a second operation; ambiguous CRUD must not resubmit: Tasks 5–7 exact body/key and transport call-count tests.
3. Browser timezone differs from tenant, DST gap/fold, leap day and subsecond receipt must not move stored instants or default 24 hours: Task 3 round-trip and policy tests.
4. Successful HTTP with malformed schema, wrong artifact headers/hash/size, or valid zero-match selection must not appear Export-ready: Tasks 1, 2, 6 strict response, streaming and zero-match tests.
5. Invisible/idle worker, polling budget, partially acquired fixture or failed diagnostic must not leak resources, silently skip CI or imply completion: Tasks 7–8 fake-timer, cleanup-fault and exact configured-CI ownership tests.

---

## Source orientation and file ownership

Paths below are relative to the isolated worktree. Read current code before editing; line numbers can drift. There is no local Graphify graph, so no graph generation/update is required.

| Existing source                                                                                                | Responsibility and preservation requirement                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/platform-contracts/src/traceability/requests.ts`, `requests-http.ts`                                 | Strict bodies, queries, summaries, detail, receipts, run/attempt/artifact evidence; consume without extending. Use `UsRequestDetailResponse`, `runId`, and `run.request`, not invented field names. |
| `apps/admin/src/us/client.ts`                                                                                  | Injected fetch, safe `UsClientError`, session/access; add only subclient composition and error-code union. Avoid runtime circular imports.                                                          |
| `apps/admin/vite.us.config.ts`                                                                                 | Local edition/Host/Origin/proxy boundary; add a narrow Requests branch, preserve all existing routes.                                                                                               |
| `apps/admin/src/us/master-data/workspace.tsx`                                                                  | Capability refresh, navigation/return frames, dirty/pending guards and mark; add Requests integration without restructuring unrelated sections.                                                     |
| `apps/admin/src/us/plans/`                                                                                     | Reusable pattern references, not a place for Requests transport or storage availability.                                                                                                            |
| `packages/domain/src/traceability/requests/deadline.ts`                                                        | `resolveUsRequestDeadline(receivedAt, dueAt?, reason?)`; reuse default/alternative policy.                                                                                                          |
| `apps/api/test/support/us-request-worker-process-fixture.ts`                                                   | Real child worker, copied checked compiled roots, owned DB/object map. Reuse without modifying its seed/read APIs.                                                                                  |
| `apps/api/test/support/us-receiving-fixture.ts`, `us-request-payload-fixture.ts`, `us-request-plan-fixture.ts` | Real synthetic Receiving/Plan facts; all new browser seeds use one context in the same owned DB.                                                                                                    |
| `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`                         | Check-only serial CI and exact ownership; retain every existing gate, including configured lifecycle/HTTP regressions.                                                                              |

New modules live in `apps/admin/src/us/requests/`: contracts/error decoding/JSON client; binary reader; time/scope/form policy; list/card/editor; validation/command intent; run/poll/download. Do not create a second session store or generic app-wide data framework.

The test fixture file `apps/admin/test/us-requests-fixtures.tsx` owns strict typed test data, provider wrappers and deferred responses. It is test-only and never imported by production modules. All test records are synthetic; build objects through the current schemas rather than broad casts.

## Task 1: Strict JSON subclient and exact proxy

**Files:**

- Create: `apps/admin/src/us/requests/client.ts`, `error-codes.ts`, `types.ts`.
- Modify: `apps/admin/src/us/client.ts`, `apps/admin/vite.us.config.ts`.
- Create tests: `apps/admin/test/us-requests-client.test.ts`, `tools/us-development/test/requests-proxy.test.mjs`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `UsRequestsClientErrorCode`: union of actual recognized Requests operation codes and common safe codes `invalid_input`, `invalid_response`, `session_required`, `forbidden`, `conflict`, `rate_limited`, `unavailable`, `request_rejected`.
- `UsRequestListInput = z.input<typeof usRequestListQuerySchema>`; `UsRequestHistoryInput = z.input<typeof usRequestHistoryQuerySchema>`.
- `UsRequestArtifact = UsRequestRunDetail["artifacts"][number]`; `VerifiedUsRequestDownload = { bytes: Uint8Array; filename: string; sha256: string }`.
- `createUsRequestsClient(send: typeof fetch, makeError: (code: UsRequestsClientErrorCode) => Error)` returns `UsRequestsClient`; parent exports `requests: createUsRequestsClient(send, code => new UsClientError(code))` and adds the code union to `UsClientErrorCode`. Child modules never runtime-import the parent error class.
- Each JSON method takes optional final `signal?: AbortSignal`; inputs use exported body types with runtime parsing. `list(query?: UsRequestListInput)`, `get(requestId)`, `create(body)`, `update(requestId, body)`, `close(requestId, body)`, `validate(requestId, body)`, `acknowledgeWarnings(requestId, body)`, `prepare(requestId, body)`, `listRuns(requestId, query?: UsRequestHistoryInput)`, `getRun(runId)`, `listAttempts(runId, query?: UsRequestHistoryInput)`, `retry(runId, body)`. Return the corresponding contract inferred type, never `any`. Task 2 adds `download(runId, descriptor, signal?)`.

| Method | Browser path suffix under `/api/us/traceability` | Input / success schema                                                      |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| GET    | `/requests`                                      | `usRequestListQuerySchema` / `usRequestListResponseSchema`                  |
| POST   | `/requests`                                      | `usTraceRequestCreateBodySchema` / `usRequestCommandResponseSchema`         |
| GET    | `/requests/:id`                                  | no query / `usRequestDetailResponseSchema`                                  |
| PATCH  | `/requests/:id`                                  | `usTraceRequestUpdateBodySchema` / command response                         |
| POST   | `/requests/:id/close`                            | `usTraceRequestCloseBodySchema` / command response                          |
| POST   | `/requests/:id/validate`                         | `usRequestValidateHttpBodySchema` / `usRequestValidationHttpResponseSchema` |
| POST   | `/requests/:id/acknowledge-warnings`             | `usRequestWarningAckHttpBodySchema` / command response                      |
| POST   | `/requests/:id/prepare`                          | `usRequestPrepareHttpBodySchema` / `usRequestPrepareResponseSchema`         |
| GET    | `/requests/:id/runs`                             | history query / `usRequestRunListResponseSchema`                            |
| GET    | `/export-runs/:id`                               | no query / `usRequestRunDetailSchema`                                       |
| GET    | `/export-runs/:id/attempts`                      | history query / `usRequestAttemptListResponseSchema`                        |
| POST   | `/export-runs/:id/retry`                         | `usRequestRetryHttpBodySchema` / `usRequestRetryResponseSchema`             |
| GET    | `/export-runs/:id/artifacts/:kind`               | fixed kind, no query / Task 2 verified bytes                                |

- [ ] Add focused RED serialization/strictness tests, including this actual query contract regression:

```ts
it("uses string query inputs and never enriches list rows", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ items: [], limit: 25, offset: 0, hasMore: false }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const client = createUsBrowserClient(send);
  await client.requests.list({ limit: "25", offset: "0", status: "open" });
  expect(String(send.mock.calls[0]?.[0])).toBe(
    "/api/us/traceability/requests?status=open&limit=25&offset=0",
  );
  expect(send).toHaveBeenCalledTimes(1);
});
```

Use deterministic serialization order `requestNumber`, `status`, `limit`, `offset`; history `limit`, `offset`. Add table tests for all twelve JSON operations, request/run/receipt identity matching and unknown successful properties. Check prepare echoed key/mode/revision and retry echoed key/run before accepting. Reject wrong IDs, uppercase/encoded path IDs, numeric query input, malformed JSON, 204-as-JSON, wrong MIME, unsupported redirects and oversize multibyte bodies before sending. Check 15-second deadline, forwarded cancellation, credentials/cache/redirect and cleanup of timers/listeners.

- [ ] Add proxy RED tests for all thirteen allowed method/path pairs plus denial matrix: wrong method/HEAD, Range, trailing slash, encoded slash/UUID, uppercase UUID, `/api/us/traceability/requestsXYZ`, unknown child, duplicate decoded query keys including `%6cimit`, unknown query keys, page `01`/`51`/offset `10001`, arbitrary artifact kind/key, no query allowed on commands/item/artifact. Exercise middleware denial before an upstream hit; a regex string inspection alone is insufficient. Retain existing Host/Origin/RU denial tests.
- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-client.test.ts` and `node --test tools/us-development/test/requests-proxy.test.mjs`. Expect missing Requests client/route failures, not dependency-resolution failures. Build affected existing shared dependencies first if absent.
- [ ] Implement strict schema parsing, safe codes and one JSON helper. Core byte/deadline rules:

```ts
const serialized = body === undefined ? undefined : JSON.stringify(body);
if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > maxBytes)
  throw makeError("invalid_input");
const controller = new AbortController();
const forwardAbort = () => controller.abort();
signal?.addEventListener("abort", forwardAbort, { once: true });
if (signal?.aborted) controller.abort();
const timer = setTimeout(() => controller.abort(), 15_000);
try {
  const response = await send(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: controller.signal,
    ...(serialized === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: serialized,
        }),
  });
  return await decode(response);
} finally {
  clearTimeout(timer);
  signal?.removeEventListener("abort", forwardAbort);
}
```

`decode` is the helper's passed `(response: Response) => Promise<T>` function: require 201 for create and 200 for every other JSON operation, parse its strict output schema, otherwise bounded-read the error and map only verified status/code pairs from current stores/controllers. Do not treat arbitrary `message` arrays as safe UI copy. Include every emitted known code by reading the current Requests files, group corrupt/build/storage/provider codes into safe translated categories, and verify unknown code/status falls back safely. Do not leak error response text. Current auth errors map 401/403 before operation errors.

Implement a focused `allowsUsRequestsProxy(method: string, rawUrl: string, hasRange: boolean): boolean` export in `vite.us.config.ts`, used only for raw paths starting either Requests family. Validate the raw path with lowercase UUID/fixed kind grammar before `URLSearchParams`; validate decoded key duplicates and parsed strict query values. A matching proxy route alone must not authorize a wrong method. Existing proxy rewrites strip `/api/us` exactly once. No server code changes.

- [ ] Add serial CI command `pnpm --filter @markiro/admin exec vitest run test/us-requests-client.test.ts --maxWorkers=1` after current admin dependency build. The new Node proxy suite is owned by the existing unconditional `node --test tools/us-development/test/*.test.mjs`. Extend parsed-YAML isolation assertions for exact command/order/unconditional ownership, without replacing older suites.
- [ ] Run both focused tests, existing `test/us-client.test.ts`, Node browser-entry/isolation tests, changed-file Prettier and `git diff --check`. Review both the client and effective proxy boundary; freeze the accepted uncommitted checkpoint after independent spec/code review.

## Task 2: Bounded descriptor-verified downloads

**Files:**

- Create: `apps/admin/src/us/requests/artifact-transport.ts`.
- Modify: `apps/admin/src/us/requests/client.ts`, `apps/admin/src/us/requests/types.ts` (add the download member to the explicit client interface).
- Create tests: `apps/admin/test/us-requests-download-client.test.ts`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- Consumes Task 1 `UsRequestArtifact`, `VerifiedUsRequestDownload`, injected `send` and `makeError`.
- Produces `readUsRequestArtifactResponse(response: Response, descriptor: UsRequestArtifact, options: { signal: AbortSignal; makeError: (code: UsRequestsClientErrorCode) => Error }): Promise<VerifiedUsRequestDownload>`.
- Adds `requests.download(runId: string, descriptor: UsRequestArtifact, signal?: AbortSignal): Promise<VerifiedUsRequestDownload>`. Parse the descriptor with `usRequestRunDetailSchema.shape.artifacts.element.parse(descriptor)`, not an unchecked caller filename/kind. No unauthenticated viewer or provider URL.

- [ ] Write RED stream/hash tests with real `ReadableStream`, WebCrypto and typed descriptors. Fixed kind table:

```ts
const artifactCaps = {
  xlsx: 16 * 1024 * 1024,
  plan_pdf: 8_000_000,
  validation_report: 16 * 1024 * 1024,
  request_report: 4 * 1024 * 1024,
  manifest: 1024 * 1024,
  package_zip: 64 * 1024 * 1024,
} as const;
```

For every kind, use current fixed filename/MIME from `requests-http.ts`; accepted bytes/hash, exact cap and cap+1, wrong length, truncated body, wrong digest, wrong filename/disposition, missing/malformed Content-Length, content-type parameters, missing no-store/nosniff, status206 and opaque/redirected response. JSON permits only base MIME or `; charset=utf-8`; reject other parameters. Test one-byte chunks and overflow before concatenation, stalled body deadline, cancel rejection and released reader lock. A cancelled or superseded hash must reject before release.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-download-client.test.ts`; expect missing reader/download failures.
- [ ] Implement header checks before reading, bound descriptor and actual stream, then verify digest. Core loop, with `chunks`, `total`, `cap`, `reader`, `descriptor` and `options` locally defined by the reader:

```ts
try {
  for (;;) {
    if (options.signal.aborted) throw options.makeError("unavailable");
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > cap || total > descriptor.byteSize) throw options.makeError("invalid_response");
    chunks.push(next.value);
  }
  if (total !== descriptor.byteSize) throw options.makeError("invalid_response");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
  if (options.signal.aborted || sha256 !== descriptor.sha256)
    throw options.makeError("invalid_response");
  return { bytes, filename: descriptor.name, sha256 };
} catch (error) {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    /* Cancellation must not hide or indefinitely delay the safe failure. */
  }
  throw error;
} finally {
  reader.releaseLock();
}
```

Also initiate cancellation from the abort listener so a hung `read()` settles; remove that listener in `finally`. Never wait without a bound for cancellation itself, including rejection before acquiring a reader; a never-settling underlying cancellation must not block the safe failure or owned-lock release. This reconciles the example with the binding deadline (Task2 review I1, execution ledger). Client's 30-second timer spans `send` and the entire reader/hash operation; check cancellation again after hash. Convert raw read/network/crypto failures to safe client errors, without raw causes. Headers/body use same-origin credentials/no-store/redirect:error; no HEAD or Range. Task 7 alone opens a verified download after its separate view identity/authority check.

- [ ] Add exact serial CI owner `pnpm --filter @markiro/admin exec vitest run test/us-requests-download-client.test.ts --maxWorkers=1` and parsed-YAML assertion after Task 1.
- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-download-client.test.ts test/us-requests-client.test.ts test/us-plans-pdf-client.test.ts test/us-plans-download.test.tsx`. Expect PASS for all configured unit cases. Run format/diff gates and independent reviews; keep uncommitted.

## Task 3: Time, scope and pure form policy

**Files:**

- Create: `apps/admin/src/us/requests/time.ts`, `scope.ts`, `form.ts`, `copy.ts`.
- Create tests: `apps/admin/test/us-requests-time.test.ts`, `us-requests-form.test.ts`, `us-requests-copy.test.ts`.
- Create test support: `apps/admin/test/us-requests-fixtures.tsx`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `resolveRequestWallTime(wall: string, timeZone: string): { kind: "invalid" | "gap" } | { kind: "unique" | "fold"; candidates: readonly { instant: string; offsetSeconds: number }[] }`. Wall syntax is exact `YYYY-MM-DDTHH:mm:ss.SSS`; folds return both ordered UTC candidates, selection is explicit.
- `requestCountdown(dueAt: string, closedAt: string | null, nowMs: number): { kind: "neutral" | "attention" | "overdue" | "closed"; milliseconds: number }`; thresholds match spec. `formatRequestInstant(instant: string, timeZone: string, language: "en-US" | "es-US"): string` includes tenant zone; evidence also presents exact UTC.
- `RequestScopeFields = Record<keyof UsTraceRequestScopeV1, string>`; controlled UI retains raw text for all twelve selectors. `parseRequestScope(fields: RequestScopeFields): ReturnType<typeof usTraceRequestScopeV1Schema.safeParse>` splits TLC/location lists by newline (no trimming opaque TLCs), omits truly empty fields and uses the shared schema. `scopeToFields(scope: UsTraceRequestScopeV1 | null): RequestScopeFields` initializes every key without losing advanced selectors.
- `RequestTimingFields = { requestNumber: string; requesterName: string; requesterOrganization: string; requesterContact: string; receivedWall: string; receivedOffsetSeconds: number | null; duePolicy: "default" | "alternative"; dueWall: string; dueOffsetSeconds: number | null; alternateDeadlineReason: string }`.
- `parseRequestTiming(fields: RequestTimingFields, timeZone: string): { ok: true; body: Omit<UsTraceRequestCreateBody, "scope"> } | { ok: false; fields: Readonly<Record<string, string>> }`. Only empty optional fields become null; preserve invalid whitespace as an error. Reuse `resolveUsRequestDeadline`, then strict create schema with `scope:null`.
- `requestCopy` is two exact-key dictionaries; `getRequestCopy(language: string)` selects Spanish only for `es-US`, English otherwise. User-visible strings use this existing localized-module pattern, not untranslated server messages.
- Test support exports `requestSummary(overrides?: Partial<UsRequestSummary>): UsRequestSummary`, `requestDetail(overrides?: Partial<UsRequestDetailResponse>): UsRequestDetailResponse`, `requestRun(overrides?: Partial<UsRequestRunDetail>): UsRequestRunDetail`, `deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }`, and `renderRequests(props: RequestsViewProps)` once the view exists in Task 4. Schema-parse final fixture objects.

- [ ] Add RED tests for tenant/browser mismatch, gap/fold and exact default:

```ts
it("rejects a gap and retains both tenant fold offsets", () => {
  expect(resolveRequestWallTime("2026-03-08T02:30:00.000", "America/Los_Angeles")).toEqual({
    kind: "gap",
  });
  const fold = resolveRequestWallTime("2026-11-01T01:30:00.123", "America/Los_Angeles");
  expect(fold).toEqual({
    kind: "fold",
    candidates: [
      { instant: "2026-11-01T08:30:00.123Z", offsetSeconds: -25_200 },
      { instant: "2026-11-01T09:30:00.123Z", offsetSeconds: -28_800 },
    ],
  });
});
it("uses elapsed 24 hours across a DST change", () => {
  expect(resolveUsRequestDeadline("2026-03-08T08:30:00.123Z").dueAt).toBe(
    "2026-03-09T08:30:00.123Z",
  );
});
```

Add leap day, invalid overflow/zone, year 0099/9999 bounds, impossible dates, fold without selection, default→alternative policy, receipt change while alternative remains, due before receipt, reason 2/3/2000/2001 and optional null/whitespace. Check countdown exactly 4h/0/negative/closed. Scope round-trips every supported key, 50/51 and duplicate lists, reversed ranges, accepted combined single/list/range selectors with AND semantics, civil-date order, AND/OR explanatory copy, invalid source URL with no fetch, leading-zero TLC and non-Latin text unchanged. Locale key parity and literal approval/send/compliance claims are forbidden; translator review remains external.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-time.test.ts test/us-requests-form.test.ts test/us-requests-copy.test.ts --maxWorkers=1`; expect missing modules/policy failures. This same exact command without the `corepack` prefix is the stage's CI owner; rerun after implementation and expect PASS, no skipped unit cases.
- [ ] Implement a bounded Intl round-trip resolver, never browser implicit `new Date(wall)`. Parse exact wall syntax and validate the civil date with `Date.parse(wall + "Z")` plus ISO round-trip, including years below 100. Sample possible zone offsets over a ±36-hour window at hourly increments; round-trip each distinct candidate through `Intl.DateTimeFormat` with `hourCycle:"h23"`, `fractionalSecondDigits:3`, Gregorian/Latin numeric parts. Do not assume whole-hour offsets. Return gap when no round-trip, ordered unique/fold candidates otherwise. Invalid IANA zones return invalid, not browser fallback. Reject out-of-domain instant bounds through the shared deadline contract.

Scope conversion's complete key list is explicit:

```ts
export const requestScopeKeys = [
  "productId",
  "productText",
  "tlc",
  "tlcs",
  "tlcFrom",
  "tlcTo",
  "lotId",
  "locationIds",
  "sourceReferenceValue",
  "documentNumber",
  "eventDateFrom",
  "eventDateTo",
] as const satisfies readonly (keyof UsTraceRequestScopeV1)[];
```

The schema currently has twelve keys; use this exact list rather than adding a thirteenth selector. Build `RequestScopeFields` from it. Newlines are a presentation delimiter only, never normalize identifier values. Add `getRequestCopy` and typed key parity. Seed no persistent browser store.

- [ ] Add exact serial CI command for the three filenames after dependencies and assert ownership. Run existing `test/us-master-data-forms.test.ts`, new suites, admin typecheck, format/diff, independent reviews. Keep the helper file test-only.

## Task 4: Read-only Requests list/card and cabinet navigation

**Files:**

- Create: `apps/admin/src/us/requests/view.tsx`, `list.tsx`, `card.tsx`, `async-ownership.ts`, `requests.css`.
- Modify: `apps/admin/src/us/master-data/workspace.tsx`, `apps/admin/src/us/master-data/copy.ts`, Requests copy and test fixtures.
- Create tests: `apps/admin/test/us-requests-navigation.test.tsx`, `us-requests-view.test.tsx`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `RequestEntry = { requestId?: string; runId?: string }`.
- `RequestsViewProps = { client: UsBrowserClient; organizationId: string; profile: Awaited<ReturnType<UsBrowserClient["profile"]>>; canRead: boolean; canManageQa: boolean; canExport: boolean; authorityPending: boolean; entry: RequestEntry; onEntryChange?: (entry: RequestEntry) => void; onForbidden: () => Promise<void>; onSessionLost: () => void; onDirtyChange: (dirty: boolean) => void; onMutationPendingChange: (pending: boolean) => void; onOpenSource: (target: ReadinessEventTarget) => void; onOpenLot: (lotId: string) => void }`.
- `RequestsView(props: RequestsViewProps)` owns selection/list/detail and later child controllers. Workspace mounts with key including organization ID/view generation. Obtain retry actor from generation-checked `client.session()` in this view; require `session.activeOrganizationId === organizationId`, no guessed actor or authorization inferred from it.
- `RequestListProps = { rows: readonly UsRequestSummary[]; stale: boolean; timeZone: string; onSelect: (id: string) => void }`; list owns presentation only.
- `RequestCardProps = { detail: UsRequestDetailResponse; timeZone: string; children?: ReactNode }`; shows saved header/four DataTabs and read-only facts; later task inserts controlled content, not a second card state store.
- `createRequestFence()` returns `{ issue(identity: string): { generation: number; identity: string }; owns(token: { generation: number; identity: string }): boolean; invalidate(): void }`. Each of list/card/session/validation/command/run/download owns a different fence. Requests UI also checks captured selected IDs/revision after awaits; the fence is not authorization.

- [ ] RED tests: processor+read navigation, unsupported/read-denied state, auditors no mutation controls; create list only uses summary fields. Default page/reset/hasMore/order, empty versus no match, last-success stale refresh, not-found card. Deferred list A→B/filter and card A→B responses do not write late data; tenant switch/unmount discards state. A 401 invokes session loss once and stops activity; 403 invokes access refresh and clears only when read actually lost; failed refresh disables actions. QA/export loss preserves still-readable input in later stages. Keyboard heading/tab focus and return stack preserve selected request/run entry; existing Plan/Search/Trace navigation and logo remain unchanged.

```ts
it("never commits an older selection response", () => {
  const fence = createRequestFence();
  const first = fence.issue("request-a:1");
  const second = fence.issue("request-b:1");
  expect(fence.owns(first)).toBe(false);
  expect(fence.owns(second)).toBe(true);
  fence.invalidate();
  expect(fence.owns(second)).toBe(false);
});
```

Pair this unit case with rendered deferred client responses, not only fence assertions. A failed old response must not show an error on the new card either.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-navigation.test.tsx test/us-requests-view.test.tsx --maxWorkers=1`; expect missing view/nav/fence failures. This same exact command without the `corepack` prefix is the stage's CI owner; rerun after implementation and expect PASS, no skipped unit cases.
- [ ] Implement Requests navigation and read-only view with separate list/card/session ownership. Add `"requests"` to View and `{kind:"requests"; entry:RequestEntry}` to Entry/return frames. Use existing guarded navigation before leaving; Requests uses existing main focus/return targets. Import `requestCopy` into `master-data/copy.ts` as `usRequest: requestCopy["en-US"]` and `usRequest: requestCopy["es-US"]`, then use `t("usRequest.title")` for the nav label. Reuse mark and UI tables/tabs/status tokens. Use one list call and one selected card call, no row detail enrichment.

```ts
export function createRequestFence() {
  let generation = 0;
  let identity = "";
  return {
    issue(next: string) {
      identity = next;
      return { generation: ++generation, identity };
    },
    owns(token: { generation: number; identity: string }) {
      return token.generation === generation && token.identity === identity;
    },
    invalidate() {
      generation += 1;
      identity = "";
    },
  };
}
```

Do not disable read by equating QA/export capability to read. Distinguish access refresh pending from confirmed read loss; stop action/byte release immediately on rejection while preserving authorized text. Countdown minute scheduling cleans up on unmount; use text/icon and an announcement at most once/minute. Detail UTC and tenant zone are explicit. Local-development/non-operational notice is persistent even before a run exists.

- [ ] Add exact serial CI command for navigation/view suites; assertions follow Task 3. Run new suites, existing Plan/Search/Trace navigation and US-app/master-data UI suites, admin typecheck/lint, format/diff and independent reviews.

## Task 5: Requester/scope editing and definite versus ambiguous CRUD

**Files:**

- Create: `apps/admin/src/us/requests/editor.tsx`, `scope-editor.tsx`, `lot-picker.tsx`.
- Modify: Requests view/card/form/copy and fixtures.
- Create tests: `apps/admin/test/us-requests-editor.test.tsx`, `us-requests-scope.test.tsx`, `us-requests-crud.test.tsx`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `RequestEditorProps = { detail: UsRequestDetailResponse | null; timeZone: string; disabled: boolean; onSave: (body: UsTraceRequestCreateBody | UsTraceRequestUpdateBody) => Promise<void>; onDirtyChange: (dirty: boolean) => void }`.
- `RequestScopeEditorProps = { value: RequestScopeFields; disabled: boolean; onChange: (value: RequestScopeFields) => void; client: UsBrowserClient; onForbidden: () => Promise<void>; onSessionLost: () => void }`; editor owns raw fields, not a fetched scope count. Forward the two authority callbacks to its lot picker.
- `RequestLotPickerProps = { client: UsBrowserClient; value: string; disabled: boolean; onChange: (id: string) => void; onForbidden: () => Promise<void>; onSessionLost: () => void }`. Reuse paginated reference-picker UX, but use existing `client.listLots`/`getLot` and their current query schemas. No promise that the product/location picker supports lots.
- View's saved-detail refresh takes receipt identity/revision and marks commands unresolved until a successful canonical read; it never synthesizes a detail record from the receipt. Create uses `scope:null`; update uses exact `expectedRevision` and changed fields. Close uses the current expected revision.

- [ ] RED tests cover complete controlled timing/scope fields, default receipt policy, explicit fold choice, field errors, optional nulls, no mutation by locale change. Product/location ID fields can use existing pickers; selected lot uses bounded paginated lot picker. Invalid lists/range/date/URL remain in input, no URL fetch. Dirty navigation prompts/cancel, pending navigation guard, close confirmation explains no fulfilment/cancellation. Closed/read-only auditor controls absent. QA loss keeps readable draft; read loss clears it. Revision conflict preserves text until explicit discard/reload.

Add deferred ambiguous create/update/close tests: one POST/PATCH only, no automatically new key or duplicate mutation; create recovery performs exact-number list then selected detail, with safe unresolved/no-match display. A definite receipt followed by failed canonical GET is “accepted, refresh required”, not successfully current. No requester/contact is interpolated into notices or console/persisted stores.

```ts
it("does not turn a rejected create into a second POST", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
  const client = createUsBrowserClient(send);
  await expect(
    client.requests.create({
      requestNumber: "SYNTHETIC-001",
      requesterName: "Synthetic requester",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: "2026-10-05T12:00:00.123Z",
      scope: null,
    }),
  ).rejects.toBeInstanceOf(UsClientError);
  expect(send).toHaveBeenCalledTimes(1);
});
```

Rendered tests must also click Save twice while pending and exercise explicit recovery; this client assertion alone is insufficient.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-editor.test.tsx test/us-requests-scope.test.tsx test/us-requests-crud.test.tsx --maxWorkers=1`; expect missing editors/recovery behavior. This same exact command without the `corepack` prefix is the stage's CI owner; rerun after implementation and expect PASS, no skipped unit cases.
- [ ] Implement controlled fields using Task 3 parsing and exact expected revisions. In a saved request's editor retain a captured baseline revision and raw fields until explicitly resolved. Submission uses one guarded promise; finally decrements pending ownership only for its owner. Definite create receipt selects the receipt's request ID and reads canonical card/list. Ambiguous create exposes “Check saved request” with exact request number; no-match permits only explicit user choice, not automatic POST. Ambiguous update/close exposes refresh and original input. Save/close invalidate fresh validation immediately; losing a draft requires explicit confirmation.

```ts
const savedScope = parseRequestScope(scopeFields);
if (!savedScope.success) return;
const body = {
  expectedRevision: detail.revision,
  scope: savedScope.data,
} satisfies UsTraceRequestUpdateBody;
await client.requests.update(detail.id, body);
```

Here `scopeFields`, `detail` and `client` are the controlled editor/view values from the declared props; the async handler checks captured card fence/ID/revision before any subsequent state write. Empty scope is allowed only for the initial shell/explicit scope:null save, not silently converted from invalid selectors. Keep no persisted query/editor state.

- [ ] Add exact serial CI command for the three suites, run earlier Requests tests, existing workspace dirty-navigation/master-data form tests, admin typecheck/lint, format/diff and independent reviews.

## Task 6: Fresh validation, warning acknowledgement and stable preparation

Ack refresh clarification: successful acknowledgement-only canonical refresh may retain an already captured real fresh response only with exact request ID/revision/digest/validatedAt and canonical acknowledgement digest/reason plus unchanged authority/session/generation. Never fabricate freshness from saved evidence. Failed Ack/read, independent/manual refresh, edit and authority changes invalidate freshness. Every successful new Validate clears local acknowledgement to mirror server behavior; Prepare still performs its authoritative server recheck.

Fix scope clarification: include existing master-data workspace/copy and Requests navigation test for a Requests-specific dirty-exit confirmation that warns of memory-only replay-state loss in EN/ES. Preserve unrelated guards without a new callback or persistence contract. Prepare selection/snapshot ceilings retain precise existing limit messages.

**Files:**

- Create: `apps/admin/src/us/requests/validation.tsx`, `command-intent.ts`, `preparation.tsx`, `source.ts`.
- Modify: Requests view/card/copy and fixtures.
- Create tests: `apps/admin/test/us-requests-validation.test.tsx`, `us-requests-prepare.test.tsx`, `us-requests-source.test.ts`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `RequestPrepareIntent = { requestId: string; body: Readonly<UsRequestPrepareHttpBody>; status: "pending" | "ambiguous" | "accepted" }`; `makeRequestPrepareIntent(requestId: string, revision: number, digest: string, mode: UsRequestPrepareHttpBody["mode"], key: string): RequestPrepareIntent` strictly parses/freezes the exact body. UUID allocated by explicit UI command using `crypto.randomUUID()`, not by replay.
- `RequestFreshValidation = { requestId: string; revision: number; response: UsRequestValidationHttpResponse }`; usable only while matching captured card and no invalidating refresh/edit/error. Saved evidence is separate.
- `RequestValidationProps = { detail: UsRequestDetailResponse; fresh: RequestFreshValidation | null; canAct: boolean; pending: boolean; onValidate: () => Promise<void>; onAcknowledge: (reason: string) => Promise<void>; onOpenSource: (target: ReadinessEventTarget) => void }`.
- `RequestPreparationProps = { detail: UsRequestDetailResponse; fresh: RequestFreshValidation | null; intent: RequestPrepareIntent | null; canAct: boolean; pending: boolean; onPrepare: (mode: UsRequestPrepareHttpBody["mode"]) => Promise<void>; onReplay: () => Promise<void>; onNewResponse: () => void }`.
- Extend `RequestCardProps` in the existing card module with optional `validationContent?: ReactNode` and `packageContent?: ReactNode` slots. Render supplied content inside its existing selected tab panel; otherwise keep the saved read-only fallback. `children` remains common actions outside the panel. The card retains the single tab-state owner.
- `requestFindingTarget(finding: ExportFinding): ReadinessEventTarget | null` recognizes only the canonical exported row source grammar from `packages/domain/src/traceability/export/rows.ts` and registry. Match source event UUID/revision/line against optional finding fields; map receiving/shipping item and transformation input/output roles. Unknown/metadata/request sources remain readable text, not guessed links. A scope lot ID may be a separate exact lot button through `onOpenLot`; finding schema has no arbitrary lot/CTE field.

- [ ] RED tests: historical `not_rechecked` never ready; fresh response must match ID/revision/digest. Build missing/invalid/unknown blocks Validate/Prepare, unconfigured storage still allows Validate, warnings acknowledgement doesn't require build, storage gate comes from request not Plan. Group errors/warnings/info with exact code/source/revision/field. Errors not waived. Ack reason 3–2000, exact saved digest/revision; ack refresh cannot fabricate a fresh Validate. Zero-match valid findings explicitly incomplete; technical exception stays failed. Test 500/16MiB server errors visible, no trimming. Source grammar tests reject inconsistent IDs/revisions/roles/unknown sources and return exact event revision/line.

```ts
it("freezes the original prepare body for ambiguous replay", () => {
  const intent = makeRequestPrepareIntent(
    "10000000-0000-4000-8000-000000000001",
    3,
    "a".repeat(64),
    "available_records_incomplete",
    "20000000-0000-4000-8000-000000000002",
  );
  expect(intent.body).toEqual({
    mode: "available_records_incomplete",
    expectedRevision: 3,
    validationDigest: "a".repeat(64),
    idempotencyKey: "20000000-0000-4000-8000-000000000002",
  });
  expect(Object.isFrozen(intent.body)).toBe(true);
});
```

Rendered prepare tests double-click, timeout/ambiguous5xx/invalid-success receipt, edited live digest, closure and source changes. Exact same body/key replays; new response requires explicit confirmation/new key. Successful replay selects returned run ID, never latest history inference. Conflict doesn't mutate/revalidate automatically. No automatic prepare after validation or acknowledgement. User may inspect history before abandoning an unresolved key; navigation guard warns state is not durable.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-validation.test.tsx test/us-requests-prepare.test.tsx test/us-requests-source.test.ts --maxWorkers=1`; expect missing intent/validation/action behavior. This same exact command without the `corepack` prefix is the stage's CI owner; rerun after implementation and expect PASS, no skipped unit cases.
- [ ] Implement the intent factory and explicit command controller. Minimal body construction:

```ts
export function makeRequestPrepareIntent(
  requestId: string,
  revision: number,
  digest: string,
  mode: UsRequestPrepareHttpBody["mode"],
  key: string,
): RequestPrepareIntent {
  const body = usRequestPrepareHttpBodySchema.parse({
    mode,
    expectedRevision: revision,
    validationDigest: digest,
    idempotencyKey: key,
  });
  return { requestId, body: Object.freeze(body), status: "pending" };
}
```

Replay calls `client.requests.prepare(intent.requestId, intent.body)` unchanged, even if live record changed; current authority/build/storage still gates it. Guard pending double-click before UUID allocation. Preserve unresolved intent on ambiguous failure; exact accepted receipt must be reconciled through authorized canonical run read. Error mapping chooses safe copy, not raw server messages. Fresh validation is invalidated on card change/revision/edit/failed refresh. Render separate “Prepare Export-ready response” and “Prepare incomplete response”, with server recheck disclaimer. Incomplete is not technical-error recovery.

Wire source navigation into existing workspace return frames, including request/run identity. Use existing dirty guard before leaving; unsaved drafts are never silently replaced by source-return refresh. No router/deep links or API lookup extension.

- [ ] Add exact serial CI owner for all three suites. Run the full Requests unit slice, existing event/source navigation tests, admin typecheck/lint, format/diff and independent reviews.

## Task 7: Frozen run history, bounded polling, retry and download UI

Scope clarification: existing master-data copy extends the conditional EN/ES Requests dirty-exit warning to preparation and retry original keys/bodies. Preserve raw-draft and possible unknown-outcome wording; cover actual outer navigation in the retry suite without changing the workspace callback/guard.

**Files:**

- Create: `apps/admin/src/us/requests/runs.tsx`, `run-detail.tsx`, `polling.ts`, `download.tsx`.
- Modify: Requests view/copy/command-intent and fixtures.
- Create tests: `apps/admin/test/us-requests-runs.test.tsx`, `us-requests-polling.test.ts`, `us-requests-retry.test.tsx`, `us-requests-download.test.tsx`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`.

**Interfaces:**

- `RequestRetryIntent = { runId: string; body: Readonly<UsRequestRetryHttpBody>; status: "pending" | "ambiguous" | "accepted" }`; `makeRequestRetryIntent(runId: string, lifecycleVersion: number, reason: string, key: string): RequestRetryIntent` freezes strict parsed retry body.
- `RequestRunDetailProps = { run: UsRequestRunDetail; timeZone: string; actorId: string | null; canAct: boolean; canDownload: boolean; storageAvailable: boolean; onRetry: (reason: string) => Promise<void>; onDownload: (artifact: UsRequestArtifact) => Promise<void> }`. Current actor is only an initiator UI hint; current server capability/initiator/lifecycle gates remain final.
- `startRequestPolling(options: { read: () => Promise<UsRequestRunDetail>; onValue: (run: UsRequestRunDetail) => void; onPause: (reason: "budget" | "errors" | "hidden" | "terminal" | "authority") => void; onError: (error: unknown) => "transient" | "stop"; owns: () => boolean; isVisible: () => boolean; now: () => number }): { stop(): void }`. Hook/view owns visibility listeners and explicit resume, never poll all history rows.
- `RequestDownloadButtonProps = { artifact: UsRequestArtifact; disabled: boolean; active: boolean; onDownload: () => void }`; view owns the one active controller, download fence and Blob URL registry. Download component owns presentation only.

- [ ] RED run tests: descending paged history/attempts, frozen request after live requester edit, exact requestRevision/runRevision/digests/cycles, nullable unavailable timing, no invented report-data instant/human effort, missing files/reasons and trusted_synthetic versus not_verified. Closed request retains permitted history/download but no new response. Failed run initiator/caps/lifecycle/reason stable-key retry, wrongactor/noQA/noexport unavailable; accepted retry intent ≠Ready/newrun. Ambiguous retry preserves original lifecycle/body/key; stale history row cannot replace current selection.

Polling tests use isolated fake timers: 2-second interval, deferred in-flight read no overlap, hidden/unmounted/selection/tenant/session stop, terminal stop, transient counter resets on success, exactly third consecutive failure stop, 5-minute budget, manual resume/new visible window and late read ignored after stop. No fake browser MFA clock.

```ts
it("rejects a late response after stop", async () => {
  vi.useFakeTimers();
  const pending = deferred<UsRequestRunDetail>();
  const onValue = vi.fn();
  const poll = startRequestPolling({
    read: () => pending.promise,
    onValue,
    onPause: vi.fn(),
    onError: () => "transient",
    owns: () => true,
    isVisible: () => true,
    now: () => Date.now(),
  });
  await vi.advanceTimersByTimeAsync(2_000);
  poll.stop();
  pending.resolve(requestRun());
  await Promise.resolve();
  expect(onValue).not.toHaveBeenCalled();
  vi.useRealTimers();
});
```

Download UI tests defer send/hash completion across run/tenant/revision/auth changes; no Blob creation/click from stale/aborted/forbidden result. One concurrent download, six fixed buttons, no arbitrary filename/URL, error cleanup and every created URL revoked. Block downloads without published artifact/ready/storage/export; auditors with export can download without QA. Privacy assertions reject contacts in list/notices/log output/persistent stores.

- [ ] Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-requests-runs.test.tsx test/us-requests-polling.test.ts test/us-requests-retry.test.tsx test/us-requests-download.test.tsx --maxWorkers=1`; expect missing run/poll/retry/download behavior. This same exact command without the `corepack` prefix is the stage's CI owner; rerun after implementation and expect PASS, no skipped unit cases.
- [ ] Implement recursive `setTimeout` scheduling after each completed read, not `setInterval`. Check active/owns/visible/budget before read and again after each await; stop terminal, mapped authority error or third transient failure. Paused poll is view state, not server failed status. UI displays last successful update and explicit resume. A queued run never proves worker alive.

Retry body creation mirrors the declared factory exactly:

```ts
const body = usRequestRetryHttpBodySchema.parse({
  expectedLifecycleVersion: lifecycleVersion,
  reason,
  idempotencyKey: key,
});
return { runId, body: Object.freeze(body), status: "pending" };
```

Use captured selected run and exact body for replay; no new-response shortcut. Read run after a receipt and distinguish retry accepted from publication.

Download release handler must recheck captured fence, run ID, descriptor digest, organization and current authority after the verified reader returns and immediately before the synthetic anchor click. Create Blob only after checks; register/revoke URL in `finally` and on unmount; abort any active controller on selection/auth/tenant change. On 403 block release before awaiting `onForbidden`. Do not display binary data or provider keys. Render fixed safe kind names and descriptor hash/bytes as evidence, not proof of user review.

- [ ] Add exact serial CI command for all four suites and parsed-YAML ownership assertion. Run Requests unit slice, existing Plan/download/nav suites, admin typecheck/lint, format/diff, independent reviews. Review ownership across every post-await callback, not AbortController alone.

## Task 8: Owned real-browser acceptance, CI and factual handoff

Cleanup fix scope: the existing worker-process fixture helper must attempt owned database close if owned build disposal rejects. Verify through an actual configured cleanup-fault case with exact owned DB absence and explicit final cleanup of any intentionally retained owned test build. No production or unrelated-resource cleanup.

Browser-confirmed scope amendment: existing Requests CSS allows opaque monospace card values to wrap without altering content. A real 390px Spanish run exposed 499px intrinsic SHA-256 spans forcing global overflow. Preserve shared tokens and local table scrolling; keep the browser overflow assertion unchanged, without hiding or clipping content.

Visual clarification: top-level Requests timestamp columns have a 15rem minimum width with measured browser assertions and local keyboard scrolling, without altering nested attempts tables. Use an actual-clock past synthetic receipt, tenant-zone/fold resolution and nonnegative receipt-to-preparation assertion; no fake MFA clock or product time-rule change.

**Files:**

- Create: `apps/api/test/support/us-request-cabinet-browser-fixture.ts`, `apps/api/test/us-request-cabinet-browser-fixture.test.ts`, `apps/api/test/us-request-cabinet-browser.e2e.test.ts`.
- Modify: `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `apps/admin/src/us/app.tsx`, `apps/admin/test/us-app.test.tsx`, `docs/design-briefs/us/05-plan-and-trace-request.md`, `docs/us/implementation-plan.md`, `docs/us/development-isolation.md`.
- Modify this plan only to record actual stage evidence/approval; do not erase unrun gates.

**Interfaces and concrete fixture composition:**

- `startRequestCabinetBrowserFixture(rawUrl: string, options?: { afterAcquire?: (stage: "process" | "seed" | "app" | "vite") => Promise<void> }): Promise<{ origin: string; email: string; password: string; tenantId: string; actorId: string; lotId: string; workerPid(): number | null; startWorker(): Promise<void>; approvePlan(): Promise<void>; close(): Promise<void> }>`.
- Use `createWorkerProcessFixture(rawUrl)` first: it owns random `markiro_us_profile_*` DB, copied compiled clean root and real child worker. Seed `const c = await seedCompleteReceiving(processFixture.database.db)`, then `finalizeUsRequestPayloadReceiving(db,c)`. Add synthetic credential account for `c.actor` with Better Auth `hashPassword`; return `${c.actor}@example.test` and random synthetic password only in transient test memory. No separate tenant/provisioned owner mismatch.
- Initially no effective Plan. `approvePlan()` uses `createUsRequestPlanFixture(db,c).approve("Synthetic browser Plan")`, and copies its PDFs to `processFixture.objects` keys `synthetic-request-plan-test/${key}`. Retain/dispose that plan fixture inside the same lifetime. Do not use the dummy-hash `seedUsRequestPayloadPlan` helper for a downloadable package.
- Parent HTTP transport is test-only S3 command handling over that same bucket-qualified map. Require exact allowed two buckets, valid key, abort signal, conditional put `IfNoneMatch:"*"`, no ACL and bounded bytes; Get returns real `Readable` with exact type/length, missing object uses established NoSuchKey, Head metadata and Delete are exact. Keep both package and Plan transport types checked. Track/destroy returned streams in cleanup. No network provider/no product fixture hooks added.
- API bootstraps with `createUsDevelopmentApplication(raw, connect, planTransport, { loadBuild: raw => loadUsRequestBuildDescriptor(raw, processFixture.build.roots), packageTransport })`. `connect` substitutes only the verified fixture-owned DB URL. `raw` comes from `localBuildEnv()` + `storageEnvironment()` + synthetic Plan storage env identical to existing process fixture. Fixed loopback API3100 and existing Vite5174 test-edition config match the current proxy/Host policy. Do not broaden dynamic-port product policy; occupied ports fail safely.
- Import fixture TS under existing API Vitest (Nest source requires its transform); load Playwright using `createRequire` rooted at `tools/production-browser/package.json`, not a new API dependency. Load Vite from admin package's installed runtime. API fixture test must mock/inject only acquisition fault callback, not fake product auth/HTTP publication.
- `startWorker()` calls existing `processFixture.spawn()` and retains PID. Browser-generated run IDs are not registered by `seedRun`, so do not use existing `waitForReady/readEvidence` methods for them. Observe readiness through the real browser HTTP card/history; optional SQL evidence uses exact newly returned tenant/request/run IDs in the owned DB.
- Cleanup is idempotent nested-finally: Vite → HTTP app → Plan transports/streams → process fixture (worker/build/ownedDB). Any acquisition or diagnostic failure must still attempt all acquired cleanup. Browser/context close is also nested-finally outside fixture close. Do not delete unrelated temp paths or old DB leftovers.

- [ ] Add RED fixture lifecycle tests: failure injected after each acquisition, cleanup attempted exactly once, process identity lookup/diagnostic failure never suppresses close, invalid/non-US URL rejects before I/O, no `DATABASE_URL` fallback. With absent explicit `US_TEST_DATABASE_URL`, DB tests explicitly skip; with a configured invalid URL they fail. Missing configured browser runtime/executable is a hard prerequisite failure, not skip. No console password/session/OTP/root/provider diagnostics.
- [ ] Add RED real-browser journey and actual assertions. Reuse current browser-flow sign-in/MFA enrollment algorithm and private Better Auth OTP runtime; never trace/screenshot credentials or enrollment. Use selectors by role/label with English/Spanish key coverage, not arbitrary sleeps or forced clicks. Core expected actions:

```ts
await page.getByRole("button", { name: "Requests", exact: true }).click();
await page.getByRole("button", { name: "New request", exact: true }).click();
await page.getByLabel("Request number", { exact: true }).fill("SYNTHETIC-BROWSER-001");
await page.getByLabel("Requester name", { exact: true }).fill("Synthetic browser requester");
await page.getByRole("button", { name: "Save request", exact: true }).click();
await expect(page.getByRole("tab", { name: "Scope", exact: true })).toBeVisible();
```

The test supplies tenant-zone receipt/fold selection when needed, selects `fixture.lotId` through scope UI, saves, explicitly validates, and asserts missing-Plan findings. Prepare incomplete explicitly; before `startWorker()` assert queued/non-ready/no fabricated downloads. Start separate process once, assert real different PID, wait bounded for server Ready, download verified ZIP and compare saved-file bytes/SHA256 with current descriptor. Run remains incomplete/missing Plan after later `approvePlan()`. Refresh/fresh validate and explicitly prepare Export-ready new revision; assert new run revision, effective Plan artifact, immutable earlier run and exact downloaded descriptors. Edit live requester after preparation and assert earlier run remains frozen; close request and verify read-only history/download remains permitted. Inspect server audit/evidence using exact owned IDs, without raw PII logging.

Cover fresh validation, both explicit modes and one real verified download end-to-end; DOM suites retain exhaustive six-kind protocol/ambiguity/race coverage. No stubbing Requests HTTP or forcing ready/clean descriptor in the UI. Abort any outgoing origin other than fixture.origin and fail on unexpected page errors without logging payloads.

- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-request-cabinet-browser-fixture.test.ts test/us-request-cabinet-browser.e2e.test.ts --maxWorkers=1` with explicit safe `US_TEST_DATABASE_URL` and current pinned browser runtime, before adding implementation. Expected RED is missing fixture/UI workflow; prerequisite build/runtime failures must be resolved or reported separately, never treated as a product RED proof. Rerun after fixture/UI implementation; expect configured PASS with real browser/worker evidence, not infrastructure skips.
- [ ] Implement fixture with acquisition inside guarded lifetime and test harness around real session/MFA. Assert existing actual compiled root hashes before/after fixture, never rebuild while the worker fixture is alive. Synthetic Plan fixture bytes copied into shared object map are the bytes retrieved by both HTTP and worker, not a fake successful frontend publication.
- [ ] Capture only post-MFA synthetic Requests states at 1440 and 1024, plus narrow Spanish layout, in EN/ES light/dark. Check logo/bundled fonts, no accidental global horizontal overflow, long Spanish actions, keyboard tabs/focus, findings/table overflow contained locally. Review screenshots visually; record paths/evidence. No screenshot equals fluent-language/regulatory acceptance. No desktop app panel opening of `.pen` files.
- [ ] Add CI prerequisite steps using the existing pinned separate workspace:

```yaml
- name: Bootstrap pinned Requests browser verification tool
  run: pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile
- name: Bootstrap Chromium for isolated Requests verification
  run: pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium
- name: Verify owned Requests cabinet browser fixture
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: pnpm --filter @markiro/api exec vitest run test/us-request-cabinet-browser-fixture.test.ts --maxWorkers=1
- name: Verify Requests through real cabinet HTTP and separate worker
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: pnpm --filter @markiro/api exec vitest run test/us-request-cabinet-browser.e2e.test.ts --maxWorkers=1
```

Place both suites after domain/contracts/DB/API/UI builds and checked worker build, after admin unit checks; bootstrap before browser suite. Existing US workflow stays check-only `contents:read`, serial, 30-minute budget and existing loopback US Postgres; no release permission/secrets/new service. Add parsed-YAML tests for exact commands, env, unconditional execution, order and preserved old HTTP/lifecycle suites. Measure actual configured CI timing when push is separately authorized; do not raise budget from assumption. Do not install locally as part of execution; current pinned runtime and Chromium were available during planning. If missing later, report prerequisite rather than silently installing.

- [ ] Update brief 05 to current list/card/run facts (no old requester/N+1 list column, no live-preview API/global count, no external submit), existing app “unfinished” copy to accurately reflect implemented Requests while preserving non-operational boundaries, and docs to enumerate current evidence and external gaps. No server OpenAPI/DB/worker contract change. Never describe package generation as external delivery/compliance or checked synthetic build as actual clean production build.
- [ ] Run final proportionate gates after fixture teardown:

```bash
corepack pnpm turbo build --filter='@markiro/admin^...'
corepack pnpm --filter @markiro/admin test
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build:us
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
node --test tools/us-development/test/*.test.mjs
corepack pnpm format:check
git diff --check
```

Use explicit US edition/build environment as current scripts require; do not source primary `.env` or rewrite any env file. Run new configured fixture/browser tests with the explicit safe US URL once before final static rebuild, with dependencies and `build:us-request-worker` already built. Run `corepack pnpm --filter @markiro/api test` once without a primary `DATABASE_URL`, to record new test discovery/explicit skips and known primary-env failures separately; do not run a primary DB or claim green from absence of US URL. The earlier full API run is non-green; fixing its unrelated eight setup blockers is outside this plan. Record focused pass counts, real configured browser outcome, admin full results, API failures/skips and visual evidence separately. Run final independent whole-increment review, freeze uncommitted result and hand off without push/release.

## CI ownership matrix

All commands below are direct, unconditional serial steps in `us-development.yml`; Node suites are already covered by the existing wildcard owner. Each stage updates `isolation.test.mjs` to require its exact configured owner. No test file may be added to a prose list without an executable CI command.

| Stage | Added test files                                                                                                          | CI owner / prerequisites                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `us-requests-client.test.ts`                                                                                              | admin focused Vitest, `--maxWorkers=1`, after shared dependency builds                                                                             |
| 1     | `requests-proxy.test.mjs`                                                                                                 | existing Node wildcard; effective middleware behavior and isolation assertions                                                                     |
| 2     | `us-requests-download-client.test.ts`                                                                                     | admin focused Vitest, serial, browser-standard streams/crypto in test runtime                                                                      |
| 3     | `us-requests-time.test.ts`, `us-requests-form.test.ts`, `us-requests-copy.test.ts`                                        | admin focused Vitest, serial, domain/contracts built                                                                                               |
| 4     | `us-requests-navigation.test.tsx`, `us-requests-view.test.tsx`                                                            | admin focused Vitest, serial, UI built                                                                                                             |
| 5     | `us-requests-editor.test.tsx`, `us-requests-scope.test.tsx`, `us-requests-crud.test.tsx`                                  | admin focused Vitest, serial                                                                                                                       |
| 6     | `us-requests-validation.test.tsx`, `us-requests-prepare.test.tsx`, `us-requests-source.test.ts`                           | admin focused Vitest, serial                                                                                                                       |
| 7     | `us-requests-runs.test.tsx`, `us-requests-polling.test.ts`, `us-requests-retry.test.tsx`, `us-requests-download.test.tsx` | admin focused Vitest, serial                                                                                                                       |
| 8     | `us-request-cabinet-browser-fixture.test.ts`, `us-request-cabinet-browser.e2e.test.ts`                                    | exact separate API Vitest commands above, explicit US DB; browser e2e additionally pinned runtime/Chromium; all compiled worker dependencies first |
| 8     | changed `us-app.test.tsx`                                                                                                 | existing unconditional admin entry/UI owner; retain filename in its command                                                                        |
| 1–8   | changed `isolation.test.mjs`                                                                                              | existing Node wildcard, preserve configured lifecycle/HTTP ownership assertions                                                                    |

Test helper files have no standalone gate; their consuming suites and package typecheck own them. All previously accepted tests remain owned; adding these stages is not permission to delete or soften old tests.

## Plan self-review and handoff boundary

Coverage mapping: spec sections 1–3 → Tasks 4–8 and Global Constraints; section 4 → Tasks 1–2; section 5 → Tasks 4–5; section 6 → Tasks 3/5; section 7 → Task 6 plus Task 5 ambiguity; section 8 → Tasks 2/7; section 9 → Tasks 1–8/CI matrix; section 10 → approval/external boundary here. Review Focus five cases each have explicit owning tests above.

Before requesting approval, verify contract field names (`runId`, `request`, `requestRevision`, artifact `name`/`mediaType`, `expectedLifecycleVersion`, `savedValidation.freshness`), scope keys, method table, source-record grammar, fixture seam property names and CI prerequisites against current source; scan for undefined helper references or placeholder instructions. Run Prettier on this plan/spec and `git diff --check`. These are document checks only, not implementation acceptance.

After approval: use the preserved separate-executor/independent-review method. Each stage reports behavior/files, RED/GREEN commands/results, skipped infrastructure and unrun visual/external gates; no commit step. Do not resume old agents with an unrelated task without clear new boundaries. A reviewer rejection is fixed within the same stage and re-reviewed before continuing.

External gates remain unrun: hosted provider policy/health, actual production data residency, remote CI timing, backup/restore, process/OS reboot on hosted infrastructure, fluent Spanish review, assistive-device accessibility, customer/regulatory acceptance, deployment. Prior HTTP M1/M2/N1 and possible old DB leftovers remain separate, unchanged and not authorized for cleanup. Approval of this plan permits this scoped local implementation, not release or publication.

## Task 8 local execution evidence — 2026-10-06

The owned lifecycle and real cabinet HTTP/browser suites passed with explicit isolated `US_TEST_DATABASE_URL`: 2 files, 11 tests, no skips, 58.58 seconds. This exercised actual Better Auth MFA, missing-Plan incomplete preparation, queued-before-worker state, real separate worker publication, verified ZIP/PDF bytes, real Plan approval, fresh Export-ready preparation, immutable earlier run, live edit and closed history/download. Exact audit identities and owned database/build/process cleanup were asserted. Actual compiled API/DB/domain/contracts aggregate hashes were unchanged across fixture lifetimes; final builds ran after teardown.

Controller-approved Requests-only hash wrapping and top-level timing-column minimums resolved measured narrow overflow and timestamp-legibility failures without hiding exact evidence. Post-MFA synthetic EN/ES light/dark screenshots at 1440/1024 and narrow Spanish were captured; controller reviewed readable desktop/narrow states and accepted their scoped visual result. This is not fluent-language, hosted, assistive-device or regulatory acceptance.

Final local admin verification passed 173 files / 2441 tests with no skips, plus admin typecheck/lint/US build, API typecheck/lint/build and Node wildcard 52/52. The once-only default API run without either database variable remained non-green: 8 setup-failing files, 198 passed, 220 skipped; 2017 tests passed / 3362 skipped. Its existing primary-env failures and explicit infrastructure skips are separate from configured Requests acceptance and were not repaired. Both new suites were discovered in its result cache; absence of the US URL deliberately skips configured browser/lifecycle coverage.

CI now owns the two suites with unconditional serial exact commands after compiled prerequisites and admin checks. Pinned browser bootstrap is disposable-CI-only; remote CI timing/execution remains unverified. No commit, stage, push, deployment, provider operation, env rewrite, primary database use or unrelated cleanup occurred. Full commands, RED/GREEN details, hashes, screenshots, cleanup evidence and outstanding external gates are recorded in the ignored task-8 execution report. Independent whole-increment review remains the controller's gate.

Task8 fix round1 addressed the independently identified delegated teardown gap under Ruling16: the existing test-only process fixture now attempts later owned child/Plan/build/database cleanup through nested finally when an earlier cleanup rejects. A real configured disposal-fault regression first failed because database close was never called, then passed with exact owned database absence and explicit test-finally disposal of the intentionally retained build. Configured lifecycle11/browser1 plus existing process matrix11 passed together: 3 files /23 tests, no skips, 286.45 seconds, including unchanged real 120-second lease and 30-second drain. API typecheck/lint and scoped formatting passed; all four compiled aggregates were unchanged across these lifetimes, with no remaining API/Vite listeners. No product/runtime source changed. Earlier full admin/default API/Node results above are pre-fix evidence; those broad suites were not repeated for this cleanup-only correction. Controller re-review and the existing external gates remain separate.
