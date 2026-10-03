# US-08 Plan Cabinet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A separate implementer and independent reviewer handle each task; the primary agent accepts each review before the next task.

**Status:** owner-approved for implementation on 2026-10-03; no push, PR, merge or release authorized by this document alone.

**Goal:** Complete the US-only EN/ES Traceability Plan office flow, beginning with the missing prior-version PDF history, without changing RU or enabling a release.

**Architecture:** Correct the existing immutable PDF renderer and approval capture before exposing the Plan UI. Extend the existing `UsBrowserClient` with strict fixed-route Plan JSON/PDF operations, then add a Plan workspace under the current in-cabinet US navigation. Separate versions, editor, inspection/preview, approval and published-detail responsibilities; the server remains authoritative for capability, provenance, validation, time and publication.

**Tech Stack:** React/Vite, `@markiro/ui`, i18next EN/ES, existing Zod platform contracts, NestJS US API, Drizzle/PostgreSQL, React-PDF, Vitest and the check-only US development workflow. No new runtime dependency or router.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md` (owner-approved), `docs/design-briefs/us/05-plan-and-trace-request.md` (Plan section, corrected 2026-10-03), and the implemented HTTP contract in `docs/superpowers/plans/2026-10-03-us-08-plan-http-boundary.md`.

## Global constraints

- Work only on `codex/us-mvp` in its isolated worktree. No RU route, shared RU object store, PR, merge, release, deployment or real-data import.
- The Plan navigation item is visible only for `US_FSMA204_PROCESSOR` with current read access. QA mutations require `traceability.qa.manage`; preview and PDF require `traceability.export.read`. The server rechecks every request. Generic profile has no Plan UI.
- Use existing in-cabinet navigation and dirty-editor guard. Do not add a router or copyable direct URL in this P0 slice. Links to Profile, Locations and Products stay inside this cabinet.
- EN/ES are UI locales only. The PDF remains the exact English server artifact. No Russian copy or translation of historical PDF bytes.
- Always distinguish configured facts from operator statements and from trusted synthetic fixtures. A synthetic badge persists in versions, detail and preview; never offer a client-controlled demo toggle.
- Draft preview is a saved-revision, watermarked document. Approval uses an explicit fresh validation/confirmation step and a stable idempotency key for retries. Do not infer human confirmation from preview.
- Without private US artifact storage, list, create/save, validate and preview work. Approval and download are unavailable with an explicit explanation. Never fall back to another store or call an unguarded URL.
- Historical approved detail and downloaded bytes are frozen. Current-impact findings appear separately, not as edits to historical content. Show approver user ID and recorded time, not an invented name/title; point-of-contact name/title are separate operator statements.
- Annual reminders (PLN-009), request packages (US-09), farm maps, e-signature, DOCX, bilingual PDFs, signed URLs and public release remain out of scope. Do not claim legal compliance, FDA approval, verified backups or non-RF infrastructure from local tests.
- Every task begins with a focused failing test, follows red-green-refactor, runs focused gates and receives independent review. Use only disposable databases selected by `US_TEST_DATABASE_URL` for API e2e tests. Preserve unrelated changes.

## File and interface map

| Area                                                                                        | Responsibility                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/traceability/plans/us-plan-pdf.tsx`                                   | Render a bounded, deterministic prior-version history into newly published PDFs; never rewrite old bytes.        |
| `apps/api/src/modules/traceability/plans/us-plan-approval.ts`                               | Capture tenant-scoped prior published metadata in the same coherent approval read, then pass it to the renderer. |
| `apps/admin/src/us/client.ts` and `apps/admin/src/us/plans/pdf-transport.ts`                | Fixed-route strict JSON operations, bounded authenticated PDF reads, typed safe errors.                          |
| `apps/admin/src/us/plans/{copy,view,versions,editor,inspection,detail}.tsx` and `plans.css` | EN/ES cabinet list, section editor, saved preview, confirmation and frozen detail. Keep each unit focused.       |
| `apps/admin/src/us/master-data/{workspace,copy}.tsx`                                        | Processor-only Plan navigation, source links, dirty guard and locale wiring.                                     |
| Focused API/admin tests and `.github/workflows/us-development.yml`                          | TDD, isolation, regression and check-only CI evidence.                                                           |

The existing nine HTTP routes are the only Plan transport. The browser client consumes `usPlanListResponseSchema`, `usPlanDetailResponseSchema`, `usPlanDraftCommandResponseSchema`, `usPlanValidationResponseSchema` and `usPlanApprovalResponseSchema`. It sends the existing strict create/save/validate/preview/approve/discard bodies. No browser-supplied tenant, actor, provenance, PDF key or approval time is valid.

## Review focus

1. A typed but unsaved editor change must not appear in preview or be approved; show the saved revision explicitly and require save before either action (Tasks 4–6).
2. A stale save/validate/approve response must preserve local text, present the conflict and require an explicit reload; it must not silently overwrite a newer server revision (Tasks 2, 4–6).
3. Losing `qa.manage` or `export.read` after the workspace loads must not leave a working mutation/PDF path or show a false success; refresh access and honor the server denial (Tasks 2–6).
4. A missing private store must not prevent editing or preview, must never initiate approval/download, and must still handle a raced 503 with clear copy (Tasks 2, 5–6).
5. A v2 PDF must show v1 in its own frozen history, while v1's bytes/hash remain unchanged after v2 and later configuration changes (Task 1).

---

### Task 1: Correct prior-version history in newly published PDFs

**Files:** Modify `apps/api/src/modules/traceability/plans/us-plan-pdf.tsx`, `apps/api/src/modules/traceability/plans/us-plan-approval.ts`, `apps/api/test/us-plan-pdf.test.ts`, `apps/api/test/us-plan-approval.e2e.test.ts`. The old stored PDFs and migration files are untouched.

**Interfaces:** Add `priorVersions: readonly { versionNumber: number; approvedAt: string; approvedBy: string; changeSummary: string }[]` to `UsPlanPublishedPdfModel`. `UsPlanApprovalStore.approve` supplies this list from the same tenant-scoped repeatable-read capture, sorted by version number. The renderer displays it as prior history, using explicit UTC instants and user IDs; `US_PLAN_PDF_RENDERER_VERSION` becomes `us-plan-pdf-v2` only for newly rendered artifacts.

- [ ] **Step 1: Write red tests.** In `us-plan-pdf.test.ts`, render v1 with an empty history and v2 with a frozen v1 history entry. `pdftotext` must find v1's number, UTC approval instant, approver ID and change summary in v2 only. Render v2 twice and assert byte/hash equality; synthetic marker remains on each page. In `us-plan-approval.e2e.test.ts`, approve v1 then v2, read both stored PDFs, assert v1 bytes/hash unchanged and v2 includes exactly v1, then edit current location/contact and assert both downloads unchanged.

  ```ts
  const priorVersions = [
    {
      versionNumber: 1,
      approvedAt: "2026-10-02T12:00:00.000Z",
      approvedBy: "actor-1",
      changeSummary: "Initial plan",
    },
  ];
  const first = await renderUsPlanPdf({ ...model(), priorVersions });
  const second = await renderUsPlanPdf({ ...model(), priorVersions });
  expect(first.sha256).toBe(second.sha256);
  expect(extractedPages(first.bytes).join(" ")).toContain("actor-1");
  ```

- [ ] **Step 2: Run** `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev corepack pnpm --filter @markiro/api exec vitest run test/us-plan-pdf.test.ts test/us-plan-approval.e2e.test.ts --maxWorkers=1`. Expected RED: v2 lacks a prior-version row.
- [ ] **Step 3: Add the bounded model and renderer.** A prior entry has exactly the four fields above; validate version number, parseable ISO instant, nonempty actor ID and bounded summary before React-PDF layout. Ensure each prior number is lower than the current number, strictly ascending and unique. Render the history after the current plan sections, allowing a long table to flow across pages, with an explicit empty-history label for v1. Do not add a wall-clock generated-at line. Keep the current version's change summary in the existing header.

  ```ts
  export interface UsPlanPriorVersion {
    versionNumber: number;
    approvedAt: string;
    approvedBy: string;
    changeSummary: string;
  }
  export interface UsPlanPublishedPdfModel {
    versionNumber: number;
    approvedBy: string;
    approvedAt: string;
    changeSummary: string;
    evidence: UsPlanApprovedEvidence;
    priorVersions: readonly UsPlanPriorVersion[];
  }
  ```

- [ ] **Step 4: Capture tenant history.** In the approval capture transaction, select only this tenant's `effective`/`superseded` rows with `versionNumber < draft.versionNumber`; map their saved approval fields and pass them to `renderUsPlanPdf`. A retry of an already published idempotency key must return the saved result without re-rendering. The later publication lock/recheck remains unchanged. Compare the captured prior-version ID and hash set under the publication lock before committing so a changed history cannot be published from a stale capture.

  ```ts
  const priorRows = await tx
    .select({
      versionNumber: versions.versionNumber,
      approvedAt: versions.approvedAt,
      approvedBy: versions.approvedBy,
      changeSummary: versions.changeSummary,
    })
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, tenantId),
        inArray(versions.status, ["effective", "superseded"]),
        lt(versions.versionNumber, row.versionNumber),
      ),
    )
    .orderBy(asc(versions.versionNumber));
  const priorVersions = priorRows.map((prior) => {
    if (!prior.approvedAt || !prior.approvedBy)
      throw new ServiceUnavailableException({ code: "us_plan_stored_published_invalid" });
    return {
      versionNumber: prior.versionNumber,
      approvedAt: prior.approvedAt.toISOString(),
      approvedBy: prior.approvedBy,
      changeSummary: prior.changeSummary,
    };
  });
  ```

- [ ] **Step 5: Run the focused tests and API typecheck/lint/build**, inspect extracted PDF text and `git diff --check`, then commit only Task 1 files. The test must use an owned disposable database; a missing `US_TEST_DATABASE_URL` is a reported skip, not a pass.

### Task 2: Add a fixed-route, strict Plan browser client

**Files:** Modify `apps/admin/src/us/client.ts`; create `apps/admin/src/us/plans/pdf-transport.ts`, `apps/admin/test/us-plans-client.test.ts`, `apps/admin/test/us-plans-pdf-client.test.ts`.

**Interfaces:** Add `UsBrowserClient` methods `listPlans()`, `getPlan(id)`, `createPlan(input)`, `savePlan(id,input)`, `validatePlan(id,input)`, `previewPlanPdf(id,input)`, `approvePlan(id,input)`, `discardPlan(id,input)`, `downloadPlanPdf(id)`. The PDF methods return `{ bytes: Uint8Array; filename: string; draftRevision: number | null }`; all methods validate fixed UUID paths and strict request/response schemas. Add a typed `UsPlanValidationError` carrying only `{section,path,code}[]` for server validation conflicts.

- [ ] **Step 1: Write red client tests** for all nine routes, strict input rejection before `fetch`, same-origin credentials/no-store/redirect-error, exact safe error mapping, 204 discard, 409 validation issues, 409 stale revision, 403 capability change, 503 `us_plan_artifact_storage_unconfigured`, malformed success JSON and a forbidden client `versionId`/tenant field. Assert that `previewPlanPdf` sends `expectedRevision` only.

  ```ts
  const validList = { items: [], effectiveImpact: null, publicationAvailability: "available" };
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validList));
  expect(await createUsBrowserClient(send).listPlans()).toEqual(validList);
  expect(send.mock.calls[0]?.[0]).toBe("/api/us/traceability/plans");
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-client.test.ts test/us-plans-pdf-client.test.ts`; expected RED is missing client methods/transport.
- [ ] **Step 3: Implement JSON operations** using existing `request()` and the exported platform-contract schemas. Handle discard's exact HTTP 204 through a narrow no-content branch before `response.json()`; do not make other successful JSON responses silently optional. Parse only documented Plan error codes/issue arrays; otherwise use the existing safe generic error. A request still gets a timeout and never accepts a caller-provided URL.

  ```ts
  async listPlans() {
    return request("/api/us/traceability/plans", usPlanListResponseSchema);
  },
  async savePlan(id: unknown, input: unknown) {
    const versionId = checked(platformUuidSchema, id, "invalid_input");
    const body = checked(usPlanDraftSaveBodySchema, input, "invalid_input");
    return request(`/api/us/traceability/plans/${versionId}`, usPlanDraftCommandResponseSchema, "PUT", body);
  },
  ```

- [ ] **Step 4: Implement `readPlanPdfResponse`** with a maximum of 8,000,000 actual bytes, `application/pdf`, `%PDF-` signature, bounded `Content-Length`, fixed expected disposition, no redirect and a positive numeric `X-Plan-Draft-Revision` for preview. Use the same session/credential policy as JSON. Reject a malformed binary response as `invalid_response`; map 401/403/404/409/503 without showing raw server text. Do not fetch `S3_*` or signed links.

  ```ts
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.length < 5 ||
    bytes.length > 8_000_000 ||
    new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
  )
    throw new UsClientError("invalid_response");
  ```

- [ ] **Step 5: Run both focused files, admin typecheck/lint/build and diff check; commit only Task 2 files.**

### Task 3: Processor-only Plan navigation, versions and frozen detail

**Files:** Modify `apps/admin/src/us/master-data/workspace.tsx`, `apps/admin/src/us/master-data/copy.ts`; create `apps/admin/src/us/plans/copy.ts`, `view.tsx`, `versions.tsx`, `detail.tsx`, `plans.css`, `apps/admin/test/us-plans-navigation.test.tsx`, `apps/admin/test/us-plans-versions.test.tsx`.

**Interfaces:** `<PlanView client={client} canManageQa={...} canExport={...} profile={profile} onForbidden={onForbidden} onSessionLost={onSessionLost} onDirtyChange={setEditorDirty} onOpenProfile={...} onOpenLocations={...} onOpenProducts={...} />` owns its internal list/detail selection. The parent exposes a Plan nav button only when `profile.code === "US_FSMA204_PROCESSOR"` and the user has `traceability.read`; it reuses current in-cabinet focus and navigation behavior. `planCopy` contains complete EN/ES copy with no Russian fallback.

- [ ] **Step 1: Write red UI tests**: processor reader sees Plan, generic profile never does; revoked read capability hides/denies it; a QA manager sees New draft while a reader does not; list order/status/provenance/impact/retention are explicit; loading, empty, 403 and retry states do not masquerade as an empty plan. Detail shows frozen snapshot, attributed sources, approver ID/time, SHA-256 and a separate current-impact panel; it never relabels contact name/title as approver.

  ```tsx
  expect(screen.getByRole("button", { name: "Plan" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Plan" }));
  expect(await screen.findByText("Synthetic demo — not an operational record")).toBeVisible();
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-navigation.test.tsx test/us-plans-versions.test.tsx`; expected RED: Plan nav/view absent.
- [ ] **Step 3: Add Plan navigation and copy.** Extend the `View`/`Entry` union and render `PlanView` under the existing shell. Keep the profile/generic checks at both nav and view boundary, with the API remaining authoritative. Add exact `en-US` and `es-US` keys through `masterDataCopy`, and preserve keyboard focus on entry/return.

  ```tsx
  const showPlan = profile.code === "US_FSMA204_PROCESSOR" && canRead;
  {
    showPlan ? (
      <Button
        aria-current={view === "plans" ? "page" : undefined}
        onClick={() => navigate("plans")}
      >
        {t("usPlan.title")}
      </Button>
    ) : null;
  }
  ```

- [ ] **Step 4: Build read-only list/detail** from `UsPlanListResponse` and `UsPlanDetailResponse`. Do not fetch every detail just to fill list columns: list uses its public summary fields; selected detail shows `changeSummary`, approver ID/time and snapshot provenance. Render configuration drift from `effectiveImpact` separately from historical facts. Show `publicationAvailability` without implying that a successful draft is publishable. Use `@markiro/ui` status/table/card components and tokens.

  ```tsx
  {
    detail.status !== "draft" ? (
      <PlanPublishedDetail
        snapshot={detail.snapshot}
        approvedBy={detail.approvedBy}
        approvedAt={detail.approvedAt}
      />
    ) : null;
  }
  {
    list.effectiveImpact?.changedSections.length ? (
      <PlanCurrentImpact impact={list.effectiveImpact} />
    ) : null;
  }
  ```

- [ ] **Step 5: Run focused tests plus admin typecheck/lint/build and diff check; commit only Task 3 files.**

### Task 4: Saved draft editor and source navigation

**Files:** Create `apps/admin/src/us/plans/editor.tsx`, `apps/admin/src/us/plans/section-fields.tsx`, `apps/admin/test/us-plans-editor.test.tsx`; modify `plans/view.tsx`, `plans/copy.ts`, `plans.css`, and only the relevant source-navigation cases in `master-data/workspace.tsx`.

**Interfaces:** `<PlanEditor draft={UsPlanDetailResponse draft} onSave={...} onDirtyChange={...} onOpenProfile={...} onOpenLocations={...} onOpenProducts={...} />` edits `UsPlanSectionsBody` and `changeSummary`. `onSave` sends `expectedRevision` from the last server acknowledgement and updates it only after a successful command response. New draft clones `snapshot.sections` from the selected effective version when one exists; otherwise it uses an explicit empty `UsPlanSectionsBody` object with `farmActivity.status: "unknown"`, never an assumed non-farm answer.

- [ ] **Step 1: Write red tests** for all six sections, array add/remove limits, nullable email, change summary required for v2+, derived-versus-operator labels and source links, synthetic provenance, dirty-state navigation guard, new-draft prefill, create/save acknowledgement and stale save preserving local text. Test a 403 after a displayed QA capability by asserting controls disable and access refreshes.

  ```tsx
  await user.type(
    screen.getByLabelText("Record maintenance procedure"),
    "Operator-confirmed process",
  );
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  expect(savePlan).toHaveBeenCalledWith(
    draft.id,
    expect.objectContaining({ expectedRevision: draft.draftRevision }),
  );
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-editor.test.tsx`; expected RED: editor missing.
- [ ] **Step 3: Implement fields with `Input`, `Textarea`, `Select`/`RadioGroup` and `DataTabs`.** Keep stored narratives as plain text; array items remain distinct editable rows, not newline-split strings. Bind visible labels/help/error IDs to every control. Farm status `yes`/`unknown` is allowed in a draft but visibly blocks P0 approval; do not auto-select `no`.

  ```ts
  const emptySections: UsPlanSectionsBody = {
    recordMaintenance: {
      systemOfRecord: "",
      formats: [],
      recordLocations: [],
      responsibleRoles: [],
      backupAndRecovery: "",
      narrative: [],
    },
    ftlIdentification: { procedure: "", reviewCadence: "" },
    tlcAssignment: { procedure: "" },
    pointOfContact: { name: "", title: "", phone: "", email: null },
    farmActivity: { status: "unknown", explanation: "" },
    reviewAndUpdate: { procedure: "" },
  };
  ```

- [ ] **Step 4: Implement create/save and source links.** Show current profile/retention/timezone as configuration context and link to Profile; link TLC source locations and product coverage to their owning workspaces without claiming a live query is a frozen approval snapshot. Keep user text mounted after a conflict; offer an explicit reload/discard-local-edits action. Disable preview/approval while dirty or saving.

  ```ts
  const acknowledgement = await client.savePlan(draft.id, {
    expectedRevision: draft.draftRevision,
    sections: editedSections,
    changeSummary,
  });
  setDraftRevision(acknowledgement.draftRevision);
  onDirtyChange(false);
  ```

- [ ] **Step 5: Run focused editor/navigation tests, admin typecheck/lint/build, responsive DOM checks and diff check; commit only Task 4 files.**

### Task 5: Saved-revision validation and watermarked preview

**Files:** Create `apps/admin/src/us/plans/inspection.tsx`, `apps/admin/test/us-plans-inspection.test.tsx`; modify `plans/view.tsx`, `plans/editor.tsx`, `plans/copy.ts`, `plans.css`.

**Interfaces:** Validation sends `{expectedRevision, confirmations}` and returns the exact server issue list; preview sends `{expectedRevision}` and returns ephemeral PDF bytes plus captured `draftRevision`. `PlanInspection` manages a local object URL for the PDF and revokes it on close, replacement or unmount. A user-initiated link opens the PDF in a new tab; the UI also provides a clear saved-revision label and text issue summary.

- [ ] **Step 1: Write red tests** for issue-to-section focus, incomplete contact/location/farm scope/wording, explicit non-farm and real-tenant procedure confirmations, synthetic demo labelling, dirty-state preview block, watermarked saved-revision label, no-store preview availability, stale revision response and object-URL cleanup. No test should treat local validation as authority.

  ```tsx
  await user.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(previewPlanPdf).toHaveBeenCalledWith(draft.id, { expectedRevision: draft.draftRevision });
  expect(await screen.findByText("DRAFT — not effective")).toBeVisible();
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-inspection.test.tsx`; expected RED: inspection view missing.
- [ ] **Step 3: Render server issues as field/section-linked copy.** The allowed-wording warning may appear beside a native textarea while typing; do not promise substring underlining. It never replaces server validation or claims legal review. Keep the error list accessible with `role="alert"` only when new; link each issue to its section/tab. Negated wording such as `not FDA approved` must not be presented as an affirmative violation when the shared rule permits it.

  ```tsx
  {
    validation.issues.map((issue) => (
      <Button
        key={`${issue.section}:${issue.path}:${issue.code}`}
        onClick={() => setSection(issue.section)}
      >
        {planIssueCopy(locale, issue.code)}
      </Button>
    ));
  }
  ```

- [ ] **Step 4: Fetch preview for the last saved revision.** Display `DRAFT — not effective`, exact captured revision and synthetic marker when server provenance is trusted synthetic. Expose an explicit Open PDF link after fetch; do not auto-open a tab after an asynchronous request or persist the blob as an approved artifact. Revoke stale blob URLs.

  ```ts
  const pdf = await client.previewPlanPdf(draft.id, { expectedRevision: draft.draftRevision });
  const url = URL.createObjectURL(new Blob([pdf.bytes], { type: "application/pdf" }));
  setPreview({ url, revision: pdf.draftRevision });
  // Revoke the preceding URL on replacement and this URL on close/unmount.
  ```

- [ ] **Step 5: Run focused tests, admin typecheck/lint/build and diff check; commit only Task 5 files.**

### Task 6: Approval, discard and verified published download

**Files:** Create `apps/admin/src/us/plans/approval.tsx`, `apps/admin/test/us-plans-approval.test.tsx`, `apps/admin/test/us-plans-download.test.tsx`; modify `plans/view.tsx`, `plans/detail.tsx`, `plans/copy.ts`, `plans.css`.

**Interfaces:** `<PlanApproval draft={...} availability={...} onApproved={...} />` captures four explicit confirmation booleans and obtains fresh server validation before enabling Approve. It creates one `crypto.randomUUID()` idempotency key per approval intent and retains it across ambiguous network retry; a changed saved revision starts a new intent. Published download uses `downloadPlanPdf(id)` only, then an object URL with a versioned local filename.

- [ ] **Step 1: Write red tests** for real-tenant unchecked confirmation, synthetic provenance without a client demo toggle, self-approval actor notice, no-store disabled approval/download with explanation, raced 503, stale/config conflict, validation issues, one idempotency key across retry, duplicate-click suppression, successful list refresh and immutable detail. Assert discard is draft-only, revision-checked and requires confirmation; a failed discard preserves the draft.

  ```tsx
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await user.click(
    screen.getByRole("checkbox", { name: "I confirm the stated backup and recovery procedure" }),
  );
  expect(approvePlan).not.toHaveBeenCalled();
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-approval.test.tsx test/us-plans-download.test.tsx`; expected RED: approval/download controls absent.
- [ ] **Step 3: Build the confirmation dialog** with `@markiro/ui` `Modal`/`ConfirmDialog`, explicit operator assertions and server issue list. Say approval time is set by the server on success, not predicted in the dialog. If `publicationAvailability` is unconfigured, keep editing/validation/preview and explain why publish is unavailable. On 403 refresh access; on 409 preserve draft and show a retry/reload path, not success.

  ```ts
  const validation = await client.validatePlan(draft.id, {
    expectedRevision: draft.draftRevision,
    confirmations,
  });
  const ready =
    validation.issues.length === 0 && validation.publicationAvailability === "available";
  ```

- [ ] **Step 4: Wire approval, discard and download.** Use the safe approval receipt, then reload list/detail to show actual server status/time. Never synthesize effective state from a local click. For published versions, display SHA-256/renderer/byte size, retained status and approved-by ID/time; download exact stored bytes through the bounded authenticated client, never re-render or use a provider URL. Revoke download object URLs after use.

  ```ts
  const key = approvalIntentKey.current ?? crypto.randomUUID();
  approvalIntentKey.current = key;
  const receipt = await client.approvePlan(draft.id, {
    expectedRevision: draft.draftRevision,
    idempotencyKey: key,
    confirmations,
  });
  await reloadPlans();
  await openPlan(receipt.id);
  ```

- [ ] **Step 5: Run focused tests, admin typecheck/lint/build and diff check; commit only Task 6 files.**

### Task 7: Integrated EN/ES, accessibility and check-only verification

**Files:** Create `apps/admin/test/us-plans-flow.test.tsx`; modify `.github/workflows/us-development.yml` only to add the focused Plan client/UI/PDF-history tests to its existing check-only job. Modify `apps/admin/src/us/app.tsx` only to replace the now-stale blanket “Plan unfinished” copy with a precise local-development status; do not claim operational readiness.

**Interfaces:** The test uses an injected `UsBrowserClient`/synthetic transport and the actual `MasterDataWorkspace`; it covers empty → draft → save → preview → validate → approve → effective/detail/download, then v2/superseded history and no-store/revoked-role branches. No new navigation or server interface is introduced here.

- [ ] **Step 1: Write red integrated tests** in both `en-US` and `es-US`: no missing copy keys, section labels and status readable, language switch preserves draft text and saved revision, PDF remains English bytes, generic profile has no Plan, no-store mode still edits/previews, and stale/revoked responses never claim approval. Include keyboard entry/tab/dialog-close/focus return and dark/light semantic status checks.

  ```tsx
  for (const locale of ["en-US", "es-US"] as const) {
    it(`keeps the saved Plan revision and language-specific controls in ${locale}`, async () => {
      // The test fixture mounts the actual MasterDataWorkspace with an injected client.
      renderPlanCabinetWithClient(locale, syntheticPlanClient);
      expect(await screen.findByRole("heading", { name: planCopy[locale].title })).toBeVisible();
      expect(screen.getByText(/DRAFT|BORRADOR/u)).toBeVisible();
    });
  }
  ```

- [ ] **Step 2: Run** `corepack pnpm --filter @markiro/admin exec vitest run test/us-plans-flow.test.tsx`; expected RED: the integrated flow or stale copy/CI ownership is incomplete.
- [ ] **Step 3: Add only the new focused admin tests** to `.github/workflows/us-development.yml` and update the stale US app sentence. The existing workflow already runs the API PDF/approval tests; confirm Task 1's new assertions are covered there instead of duplicating the command. Keep the release-lock/isolation assertions green; do not add any deploy or artifact publication step.

  ```yaml
  - name: Verify US Plan cabinet contracts and EN/ES flow
    run: pnpm --filter @markiro/admin exec vitest run test/us-plans-client.test.ts test/us-plans-pdf-client.test.ts test/us-plans-navigation.test.tsx test/us-plans-versions.test.tsx test/us-plans-editor.test.tsx test/us-plans-inspection.test.tsx test/us-plans-approval.test.tsx test/us-plans-download.test.tsx test/us-plans-flow.test.tsx
  ```

- [ ] **Step 4: Run admin test/typecheck/lint/build, API focused PDF/approval/HTTP tests on disposable US DB, `corepack pnpm format:check`, isolation tests and `git diff --check`.** Record skipped and RU-environment-limited tests separately.
- [ ] **Step 5: Inspect rendered UI** at 1440 px, 1024 px and narrow mobile width in EN/ES and light/dark, including a real browser PDF preview/download from synthetic local transport. Capture source-faithful screenshots and keyboard behavior; a jsdom pass alone is not visual or accessibility acceptance. The `.pen` Plan frames require a separate Pencil MCP reconciliation when the file is available there; do not open the `.pen` file in a Codex panel or claim visual parity without that check.
- [ ] **Step 6: Commit only Task 7 files and run one independent whole-plan review** against this plan's start SHA. Preserve the US branch; no PR, merge, release or deployment is implied.

## Handoff boundary

After the owner accepts this plan, execute each task with a separate implementer and independent reviewer, then perform the whole-plan review. A local or GitHub check-only pass proves contracts and synthetic behavior, not live non-RF storage, backup/restore, regulatory applicability, Spanish-language regulatory review, customer operation, or a release. Those remain separate gates.
