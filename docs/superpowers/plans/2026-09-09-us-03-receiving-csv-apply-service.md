# Receiving CSV Atomic Apply Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. Execute inline sequentially under the owner's selected workflow. No commit or push.

**Goal:** Apply a saved CSV preview as one original draft with a durable result and exact atomic audit.

**Architecture:** Reuse migration0128. Extract the existing transaction-level original-draft writer, preserving legacy/versioned endpoints. An internal CSV command authorizes, serializes the operation key, locks and validates saved preview evidence, replays a validated historical result or revalidates current references before creating a draft. Receipt, preview binding and both business audits commit with the draft.

**Tech Stack:** Node24, pinned pnpm, TypeScript, Nest exceptions, Drizzle, PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-us-03-receiving-csv-import-design.md` (approved).

## Global constraints

- Existing isolated `codex/us-mvp` worktree only; release remains locked.
- Fixed v1 template, 256 KiB original bytes, 1–100 rows, 24-hour first-apply expiry.
- Tenant and actor come from trusted service context. Reload Receiving-write membership/profile even on replay.
- No partial draft, finalization, lot assignment, reference creation, URL fetching or automatic retry in a browser.
- No new migration, dependency, route, module registration, body-limit change or hosted infrastructure.
- Use owned disposable US test databases; never load ordinary `DATABASE_URL` or migrate the base DB.

## Task 1: Real atomic command tests and implementation

**Files:** Create `apps/api/test/us-receiving-csv-apply.e2e.test.ts`, `apps/api/src/modules/traceability/receiving/us-receiving-csv-apply.ts`, `us-receiving-csv-receipt.ts`, `us-receiving-draft-create.ts`. Modify adjacent `us-receiving-draft-commands.ts`, `us-receiving-operations.ts` and `us-receiving-csv-store.ts`.

**Interfaces:** `UsReceivingCsvStore.applyPreview(tenantId: string, actorUserId: string, id: unknown, input: unknown, requestId: string)` delegates to an internal command. The internal canonical receipt has `receiptVersion: 1`, literal `command: "receiving.csv.apply"`, original `operationKey`, `inputDigest`, `importId`, `eventId`, and original `record: ReceivingLiveRecord`. Its record must be an original draft at draft/lifecycle version1, with a nonempty draft, matching event ID. Strict parsing must not normalize persisted evidence.

The returned receipt is always the original receipt, including when another key
targets an already-applied preview. It is not an acknowledgement that the new key
created a new operation, nor a claim that today's record is still a draft. Public
transport correlation and current-record recovery will be specified together in
the subsequent HTTP/client checkpoint; do not widen existing receipt unions.

- [x] Write failing real-service tests for creation and exact root/header/children/operation/binding/audits. Observe the missing `applyPreview` behavior before implementation.

```ts
const result = await store.applyPreview(
  c.tenant,
  c.actor,
  preview.id,
  { operationKey, expectedPreviewDigest: preview.previewDigest },
  "csv-apply",
);
expect(result.record).toMatchObject({ status: "draft", revision: 1, draftVersion: 1 });
expect(result.record.content).toEqual({ kind: "draft", draft: preview.proposedDraft });
```

- [x] Add denial, rollback, identity and replay cases: invalid/expired preview, digest mismatch, changed GTIN resolution, archived references, foreign tenant, revoked roles/profile, malformed body; same-key same-content, same-key changed-content, applied-preview different-key, new delivery with equal bytes, replay after edits/finalization/expiry, corrupt receipt and rollback at either audit/receipt/binding insert. Assert exact persisted state before/after every rejection.
- [x] Extract `insertReceivingDraft(tx, tenantId, actorUserId, draft, requestId, format)` from the old creation command: reference checks, captured timezone/year, counter, UUID/root/header/children, appropriate record read, exact draft-created audit. Keep the existing create command's transaction/authorization/replay/digest/receipt behavior unchanged.
- [x] Implement strict private receipt parsing with saved-record identity checks and sanitized `receiving_csv_apply_unavailable` failures. Replays verify the canonical receipt's originating preview/binding and content; never rebuild a receipt from today's event.
- [x] Implement the command sequence: authorize; parse path/body; operation advisory lock; tenant-scoped preview `FOR UPDATE`; validate saved evidence and expected digest; inspect binding and stored operation. Same-key replay may bind another equal-content preview to the original operation without a new business audit. An already-bound preview returns its original receipt; if the supplied key already identifies a different result, reject conflict rather than return contradictory identities.
- [x] For first application only, reject absent proposal or expired preview, resolve references under locks, and require deep equality of normalized proposal and resolution. Then create draft, insert canonical receipt, insert preview binding and exact `traceability.receiving.csv_applied` audit in the same transaction.

```ts
after: {
  (importId, eventId, fileSha256, templateVersion, rowCount, inputDigest);
}
```

## Task 2: Concurrent proof and regression

**Files:** Create `apps/api/test/us-receiving-csv-apply-concurrency.e2e.test.ts`; update check-only US workflow, isolation documentation and this plan.

- [x] Add real PostgreSQL barriers and wait for `pg_blocking_pids`: same key, different keys on one preview, same key across equal previews, archive/reference change and membership revocation. Verify one draft/receipt/audit pair and no losing partial state. Current authorization must be reloaded on transaction restart.
- [x] Extend the existing bounded retry helper only for the exact application primary-key23505 race. A waiting repeatable-read transaction can retain a snapshot predating a newly inserted binding even after obtaining the preview lock; restarting is required, not suppressing the error or overwriting the binding.
- [x] Run focused CSV plus old draft-command/lifecycle/bridge suites after DB build; run API typecheck, lint, build. Record the known ordinary API environment setup limitation separately if full package execution is not repeated.
- [x] Add the new service tests to the existing check-only US database step. Verify19 isolation/browser-entry contracts, formatting and `git diff --check`. Verify fixture cleanup and base DB unchanged.
- [x] Record service-only completion and remaining HTTP/MFA/client/export scope. No publication or independent-review claim.

## Self-review

The command uses content identity rather than filename, preview ID or raw object
property order. Saved evidence is still checked on replay, but expiry and current
business references cannot invalidate a previously committed result. Reusing an
already-applied preview never creates another delivery. Preview-binding aliases
prevent a successfully acknowledged same-content retry from later creating a
duplicate under another key. Existing historical receipts remain untouched.

## Local checkpoint — 2026-09-09

Implemented internal `applyPreview`, the strict private canonical receipt reader
and transaction-level draft helper. The ordinary create command delegates only
its original draft-writing steps; original command authorization, replay,
operation digests and legacy/versioned return contracts remain unchanged.
Current authority and saved-evidence checks precede either replay or first apply.
First apply commits all business rows, operation, binding and both audits together.
Same-content retries never repeat the business audits or create another draft.

TDD first failed because `applyPreview` did not exist. The initial39-case suite
passed38; the finalization replay fixture correctly failed `lot_source_mismatch`
on its second row. The test now makes an explicit valid draft edit before QA
finalization, retaining an assertion that readiness has no issues; no product
rule was relaxed. Its subsequent complete run passed.

Real lock-barrier tests exposed expiry during a wait and the invisible alias
binding race. The first now rolls back at a final expiry check before returning
from the transaction; retries of previously committed results bypass first-apply
expiry checks. The second initially failed with the exact application PK23505;
the existing retry helper now recognizes only that table/constraint pair in
addition to its previous cases. A persistent synthetic collision proves the
three-attempt bound, while an unrelated23505 is not retried. Lock observation uses
the recursive `pg_blocking_pids` chain: a second row-lock waiter may queue behind
the first waiter rather than directly behind the fixture's held lock.

Final regression:252/252 tests across12 API files, no skips (38.09 seconds),
including48 new apply cases and8 real concurrency cases. It covers exact
actor/tenant/target/audit metadata, both source forms and ordered documents,
draft-only missing values, no lot mutation, independent equal-file deliveries,
canonical retries after edit/finalization/expiry/archive, current role/profile
denial, GTIN retarget rejection, corrupt receipts, and rollback at each audit,
operation and binding insert. Existing preview, original/lifecycle commands,
command bridges and lifecycle races remain green. DB was rebuilt before this
consumer run; no DB source or migration changed in this checkpoint.

API source/test typecheck, full lint and Nest build passed. The existing Vite
config-loader warning remains unsuppressed. The full ordinary API suite was not
rerun: its documented environment/setup failures remain open in the
[preview-service checkpoint](2026-09-08-us-03-receiving-csv-preview-service.md#wider-verification-and-limits).
No ordinary environment or primary database was loaded to bypass that limitation.
The release checker and19 isolation/browser-entry contracts passed. Final scoped
formatting corrected two newly added files; the subsequent repository-wide
format check and final `git diff --check` passed.

Read-only cleanup found zero disposable `markiro_us_profile_*` databases; both
CSV tables remain absent from base `markiro_us_dev`. Source inspection confirms
the CSV store is not registered in a controller/module. No CSV HTTP/session/MFA,
browser, spreadsheet or hosted acceptance was exercised. INT-002 remains in
progress. All changes remain local and unstaged in `codex/us-mvp`, with no commit,
push, PR, release, primary-checkout edit or hosted operation.

Next: define the strict public preview/result envelopes and captured-request
correlation for canonical replay, then connect the US-only HTTP/MFA boundary.
Browser confirmation/recovery and the separately specified CSV output follow;
this service increment does not complete CSV delivery or MVP acceptance.
