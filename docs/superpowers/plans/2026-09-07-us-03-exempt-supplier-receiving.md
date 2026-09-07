# Exempt-supplier Receiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support receipt-specific QA review and conditional own-TLC assignment without changing an existing TLC or historical Receiving record.

**Architecture:** Add pure exemption-input assessment and explicit versioned frozen contracts, then additive storage and one extension of the existing finalization transaction. Activate the new request/readiness shapes only when their persistence and atomic finalization are connected. The existing Receiving interface gains per-line review; it never owns persisted approval or assignment.

**Tech Stack:** TypeScript, Zod 4, NestJS, Drizzle/PostgreSQL, React/Vite, Vitest and local Chromium; existing dependency versions only.

**Spec:** [Owner-approved specification](../specs/2026-09-07-us-03-exempt-supplier-receiving-design.md), approved 2026-09-07. Read it completely before execution.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Starting HEAD is `9789c7cd359ddebb58929c2a824adb6160267437`; the dirty baseline includes completed ordinary Receiving and documentation, not changes to discard or bundle into a commit.
- No primary-checkout change, staging, commit, push, merge, publication, hosted resource creation or release is authorized. This overrides the skills' routine commit steps.
- Existing TLCs and sources are retained. Only absence of an assigned TLC allows a separately entered proposal. Own assignment is create-on-finalize only, with the receiving location as physical source.
- QA reviews every exempt line of this saved receipt. The server requires current `traceability.qa.manage` and MFA, including successful replay. No supplier-wide approval, legal-classification engine or four-eyes requirement.
- `exemptReceipt` is optional/nullable; when non-null it has exactly three required keys: nullable `evidenceUrl`, nullable `tlcHandling`, nullable `proposedTlc`.
- Evidence URLs use credential-free HTTP(S), at most 1,024 UTF-8 bytes, and are never fetched. Full URL/IDNA semantics remain server-authoritative; SQL checks structure, bounds and exact relationships.
- TLC length remains 1–120 Unicode code points. Preserve case, Unicode and formula-leading text; never trim or repair a stored snapshot. Exact decimal strings, civil dates and recorded timezone remain unchanged.
- New readiness uses `receiving-readiness-v3`. New finalizations use snapshot version 2. Preserve version-1 snapshot validation, original receipts and command digests.
- Existing source latches are permanent. New own-assigned lots start active at revision 1 and are latched in the finalization transaction. Existing linked-lot audit/revision behavior is unchanged.
- No inventory effects, new endpoints, generalized proxy routes, new dependencies, generators, CSV, amendment/void, Transformation, Shipping, export, Station or `.pen` work.
- Reuse Markiro components/tokens and EN/ES. Do not redesign the logo or typography. No transient approvals or operation keys in browser storage.
- Operational workflow locks stay unconditional. `.github/workflows/us-development.yml` may gain test names only; no workflow dispatch or remote settings change.
- Use Node 24 and pnpm 11.22.0. For every `pnpm` command below use `env -u DATABASE_URL PATH=/opt/homebrew/opt/node@24/bin:$PATH node /Users/thevladbog/.cache/node/corepack/v1/pnpm/11.22.0/bin/pnpm.cjs` on this host.
- Database tests use only `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev` with `createUsProfileTestDatabase`. This creates its own disposable database. Never migrate/reset the base US database or load the primary environment. Request scoped loopback permission when needed.
- Keep per-task pre-edit baselines and red/green reports in ignored `.superpowers/sdd/2026-09-07-us-03-exempt-supplier-receiving/`. Do not overwrite the ordinary-finalization workspace. Do not claim a whole-feature diff against HEAD excludes earlier dirty work.

## File boundaries and activation sequence

Run tasks sequentially and review each independently testable deliverable before
its dependent task. No parallel implementations on shared files.

| Task | Deliverable                                               | Activation boundary                                                                                  |
| ---- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | Pure line assessment and strict exemption-input primitive | Existing request schemas, readiness v2 and finalizer remain active                                   |
| 2    | Additive column/guards and frozen-v2 validators           | V2 is tested explicitly; existing public readers/writers still use v1                                |
| 3    | Atomic API integration and compatibility                  | Switch live drafts/readiness/finalization together; existing UI can still finalize ordinary receipts |
| 4    | EN/ES review interface and real browser proof             | Exempt Receiving becomes usable through the existing interface                                       |

Existing orientation files: `packages/domain/src/traceability/receiving-readiness.ts`,
`packages/platform-contracts/src/traceability/receiving*.ts`,
`packages/db/src/schema/traceability-receiving.ts`,
`apps/api/src/modules/traceability/receiving/`, and
`apps/admin/src/us/receiving/`. No local Graphify graph exists at planning time;
verify current source rather than rebuilding a graph for this increment.

### Task 1: Pure exemption input assessment

**Files:**

- Create `packages/domain/src/traceability/receiving-exemption.ts` and `packages/domain/test/us-receiving-exemption.test.ts`.
- Create `packages/platform-contracts/src/traceability/receiving-exemption.ts` and `packages/platform-contracts/test/us-receiving-exemption.test.ts`.
- Modify the two package `src/index.ts` files for these new exports only.
- Read existing `receiving-readiness.ts`, `lots/source.ts`, `lots/tlc.ts`, `receiving.ts`, `receiving-records.ts` and `lots.ts`; do not activate new transport shapes yet.

**Interfaces:**

- Domain produces `ReceivingExemptReceiptInput`, `ReceivingExemptionLine`, `ReceivingExemptionIssue`, `ReceivingExemptionAssessment`, `assessReceivingExemptionLine(line, receivingLocationId)`.
- Contracts produces `receivingExemptReceiptSchema` for new input and `preservedReceivingExemptReceiptSchema` for stored input. Both objects are strict; neither supplies defaults for a missing object.
- Task 3 consumes the assessment's effective TLC and path for duplicate lookup, readiness and snapshot construction. Assessment does not authorize or persist anything.

- [x] **Write the first failing pure-rule test.** Use this full input and expect the received field to remain null; this is an assessment, not assignment.

```ts
import { describe, expect, it } from "vitest";
import { assessReceivingExemptionLine, type ReceivingExemptionLine } from "../src/index.js";

const line: ReceivingExemptionLine = {
  tlc: null,
  source: { kind: "location", locationId: "dock" },
  lotLinkMode: "create_on_finalize",
  lotId: null,
  exemptSupplier: true,
  exemptReason: "Synthetic supplier declaration reviewed for this receipt",
  exemptReceipt: {
    evidenceUrl: "https://supplier.example.test/declarations/2026-09",
    tlcHandling: "assign_if_missing",
    proposedTlc: "=Own/Ä-001",
  },
};

describe("exempt receiving assessment", () => {
  it("assesses an own-code proposal without assigning or changing input", () => {
    const before = structuredClone(line);
    expect(assessReceivingExemptionLine(line, "dock")).toEqual({
      path: "exempt_assigned_tlc",
      effectiveTlc: "=Own/Ä-001",
      requiresReview: true,
      issues: [],
    });
    expect(line).toEqual(before);
    expect(line.tlc).toBeNull();
  });
});
```

- [x] **Run RED:** `pnpm --filter @markiro/domain exec vitest run test/us-receiving-exemption.test.ts`. Record the absent export/function failure, not an unrelated setup failure.
- [x] **Implement the assessment interface and deterministic path selection.** The issue type has only the listed fields; Task 3 supplies severity/group/line metadata.

```ts
import type { ReceivingReadinessInput } from "./receiving-readiness.js";

export type ReceivingExemptReceiptInput = {
  evidenceUrl: string | null;
  tlcHandling: "preserve_existing" | "assign_if_missing" | null;
  proposedTlc: string | null;
};
export type ReceivingExemptionLine = Pick<
  ReceivingReadinessInput["draft"]["items"][number],
  "tlc" | "source" | "lotLinkMode" | "lotId" | "exemptSupplier" | "exemptReason"
> & { exemptReceipt?: ReceivingExemptReceiptInput | null };
export type ReceivingExemptionIssue = {
  field: "exemption" | "tlc" | "source" | "lot";
  code: "required" | "format" | "lot_link_inconsistent" | "tlc_assignment_required";
  detail: "exemptReason" | "evidenceUrl" | "tlcHandling" | "proposedTlc" | null;
};
export type ReceivingExemptionAssessment = {
  path: "ordinary" | "exempt_existing_tlc" | "exempt_assigned_tlc" | null;
  effectiveTlc: string | null;
  requiresReview: boolean;
  issues: ReceivingExemptionIssue[];
};
```

`assessReceivingExemptionLine(line: ReceivingExemptionLine,
receivingLocationId: string | null): ReceivingExemptionAssessment` returns
ordinary/path/input TLC/no issues/no review when the flag is false, even if
inactive data remains. For true, return `requiresReview: true` and apply this
complete local matrix without changing any input:

| Condition                                                                           | Finding / result                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Blank/null reason                                                                   | exemption / required / exemptReason                     |
| Missing URL                                                                         | exemption / required / evidenceUrl                      |
| URL fails `isTlcSourceReferenceUrl`                                                 | exemption / format / evidenceUrl                        |
| Absent/null handling                                                                | exemption / required / tlcHandling; path null           |
| Preserve existing                                                                   | path exempt_existing_tlc; effective TLC is received TLC |
| Preserve with non-null proposal                                                     | exemption / format / proposedTlc                        |
| Assign if missing                                                                   | path exempt_assigned_tlc; effective TLC is proposal     |
| Assign with received TLC present                                                    | tlc / format / null; never clear or replace it          |
| Assign with no proposal                                                             | tlc / tlc_assignment_required / proposedTlc             |
| Proposal not exactly `normalizeTlc(proposal)` or normalization throws `DomainError` | tlc / format / proposedTlc                              |
| Assign with source not an explicit location equal to receiving site                 | source / format / null                                  |
| Assign with linked mode or non-null lot ID                                          | lot / lot_link_inconsistent / null                      |

Existing readiness retains general TLC, source-description, product, quantity
and reference checks. Do not duplicate those full rules inside this helper.

- [x] **Expand failing tests for the matrix before each corresponding branch.** Include false-flag hidden proposal, missing extension, URL userinfo/backslash/control/byte limits and international hostnames, preserved Unicode TLC, wrong site/reference source, linked lot, empty proposal and simultaneous received/proposed TLC. Use `structuredClone` before each call and assert no mutation. The helper must have no persistence or random-code dependency.
- [x] **Add RED strict-contract tests, then implement the new primitives.** Reuse established TLC and URL boundaries; the stored schema uses `preservedTlcSchema` rather than the transforming entry schema.

```ts
import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { preservedTlcSchema, tlcSchema } from "./lots.js";

export const receivingExemptReceiptSchema = z
  .object({
    evidenceUrl: z.string().refine(isTlcSourceReferenceUrl).nullable(),
    tlcHandling: z.enum(["preserve_existing", "assign_if_missing"]).nullable(),
    proposedTlc: tlcSchema.nullable(),
  })
  .strict();
export const preservedReceivingExemptReceiptSchema = receivingExemptReceiptSchema
  .extend({
    proposedTlc: preservedTlcSchema.nullable(),
  })
  .strict();
```

Test required nullable keys, extra approved/reviewer/actor fields, URL semantics,
exact stored spelling and invalid Unicode. Run
`pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-exemption.test.ts`
once RED and once GREEN. Export the two primitives, not a new live draft shape.

- [x] **Run package gates and review this isolated deliverable.** Run domain and contracts `test`, `typecheck`, `lint`, `build`. Re-run existing readiness/finalization contract tests unchanged, proving the active v2/v1 paths did not move. Write red/green evidence and the pre-task diff to the report; do not commit.

Task 1 verified 2026-09-07: domain 903/903, contracts 433/433, active-contract
regression 14/14; typecheck/lint/build passed in both packages. Independent
spec/quality review approved with no findings. No active API/UI change.

### Task 2: Additive storage and independently tested frozen-v2 contracts

**Files:**

- Modify `packages/db/src/schema/traceability-receiving.ts`; create `packages/db/migrations/0123_us_receiving_exemption.sql` and generated metadata/journal. At planning time the last migration is 0122. Recheck before generation; if 0123 was taken, use the actual next number and update all plan/test references, never overwrite a file.
- Create `packages/db/test/us-receiving-exemption-migration.e2e.test.ts`; update `packages/db/test/us-receiving-schema.test.ts`.
- Create `packages/platform-contracts/src/traceability/receiving-finalization-v1.ts` and `receiving-finalization-v2.ts`; modify `receiving-finalization.ts` to import/re-export the extracted v1 schema without changing its active behavior.
- Create `packages/platform-contracts/test/us-receiving-finalization-v2.test.ts`; extend existing v1 tests with extraction/regression cases. Export named v1/v2 snapshots from package `src/index.ts`.
- Read migrations0121/0122, Drizzle config, both `test/support/us-profile-database.ts` fixtures and existing receiving guard tests before SQL changes.

**Interfaces:**

- DB adds `receivingEventItems.exemptReceipt`, backed by nullable `exempt_receipt` JSONB, typed `unknown` at the persistence boundary.
- `receivingFinalizationSnapshotV1Schema` / `ReceivingFinalizationSnapshotV1` preserve the old snapshot exactly, including literal `receiving-readiness-v2` and its frozen issue vocabulary.
- `receivingFinalizationSnapshotV2Schema` / `ReceivingFinalizationSnapshotV2` require version 2, literal `receiving-readiness-v3`, per-item `receiptBasis`, and `confirmation.reviewedExemptLines`.
- Existing `receivingFinalizationSnapshotSchema` stays a v1 alias until Task 3. V2 remains explicitly testable without enabling a partly connected API.

- [x] **Write RED migration preservation tests.** Create a disposable database through index122, seed an incomplete exempt draft, an ordinary draft, original operation receipts and a valid finalized-v1 specimen. Query complete rows before the new migration; compare all previous fields and receipt bytes afterward. The fixture's `throughIndex` argument and existing raw migration application pattern are already implemented.

```sql
SELECT e.id, to_jsonb(e) AS event,
  (SELECT jsonb_agg(to_jsonb(i) - 'exempt_receipt' ORDER BY i.line_no)
   FROM receiving_event_items i
   WHERE i.tenant_id = e.tenant_id AND i.event_id = e.id) AS items,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_key)
   FROM receiving_operations o
   WHERE o.tenant_id = e.tenant_id AND o.event_id = e.id) AS operations
FROM traceability_events e ORDER BY e.id;
```

Run `pnpm --filter @markiro/db exec vitest run test/us-receiving-exemption-migration.e2e.test.ts`
with the isolated test variable. Expected RED: absent migration/column, not a
shared-database schema error. The test owns and closes its own database.

- [x] **Generate the additive column and inspect metadata.** Add
      `exemptReceipt: jsonb("exempt_receipt").$type<unknown>()` to receiving items and run
      `pnpm --filter @markiro/db exec drizzle-kit generate --name us_receiving_exemption`.
      The configured generation command does not require migrating a database. Review
      SQL and metadata; only the intended table/column/checks and new journal entry may
      change. Never hand-edit old generated snapshots or the dependency lockfile.

Add a present-value JSON check with these exact semantics: SQL null is allowed;
JSON null as the whole object is rejected; otherwise require an object with
exactly `evidenceUrl`, `tlcHandling`, `proposedTlc`, all present. Each value is
JSON null or its required scalar type. Evidence text is nonempty, credential
semantics stay outside SQL, and byte length is at most1,024. Handling is null or
one of the two enum values. Proposal matches the existing stored-TLC SQL bounds.
Do not require a complete draft or an active flag for storing valid hidden data.

The generated column SQL is shown here for review; do not append a second copy
of the generated `ADD COLUMN` statement. The following predicate belongs inside
the complete CHECK described above:

```sql
ALTER TABLE receiving_event_items
  ADD COLUMN exempt_receipt jsonb;
-- Include this predicate inside the object branch of the new CHECK:
jsonb_typeof(exempt_receipt) = 'object'
AND exempt_receipt ?& ARRAY['evidenceUrl','tlcHandling','proposedTlc']
AND (exempt_receipt - ARRAY['evidenceUrl','tlcHandling','proposedTlc']) = '{}'::jsonb
```

- [x] **Freeze the old snapshot validator before adding v2.** Move only the old
      snapshot primitives/refinements to `receiving-finalization-v1.ts`; leave command,
      record envelope and list contracts in their existing module. The v1 module must
      not import the main finalization module or v2, avoiding an initialization cycle.
      Keep strict legacy strings/UUIDs, profile coverage, document/source relationships
      and warning/rule literals unchanged. Re-run
      `pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-finalization.test.ts`
      before adding new behavior.
- [x] **Write RED v2-contract tests, then build the strict new snapshot.** Use
      the complete existing frozen specimen from `us-receiving-finalization.test.ts`
      as a locally defined fixture, with version2, rulev3 and the new fields. Do not
      import another test file, use partial casts, or replace the old fixture with v2.
      Test all three paths, unknown keys, missing review, wrong source, and exact data.

```ts
const reviewedLines = z
  .array(z.number().int().min(1).max(100))
  .max(100)
  .refine((lines) => lines.every((line, index) => index === 0 || line > (lines[index - 1] ?? 0)));
const reason = z
  .string()
  .max(2000)
  .refine(
    (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
  );
const review = {
  reason,
  evidenceUrl: z.string().refine(isTlcSourceReferenceUrl),
  reviewedBy: reason.pipe(z.string().max(128)),
  reviewedAt: z.iso.datetime(),
};
const receiptBasis = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ordinary") }).strict(),
  z.object({ kind: z.literal("exempt_existing_tlc"), ...review }).strict(),
  z.object({ kind: z.literal("exempt_assigned_tlc"), ...review, receivedTlc: z.null() }).strict(),
]);
```

Build a new object from the old snapshot's `.shape`, overriding version, items
and confirmation. Validate common content with an explicit v1 projection inside
the v2 refinement: remove only `receiptBasis` from items and
`reviewedExemptLines` from confirmation; set the projection's version/rule to
their v1 literals. This validation projection is never returned or persisted.
Forward every v1 issue; do not discard its refinements by copying `.shape` alone.
New exemption findings are errors, not a new warning vocabulary in this increment.

```ts
const v1 = receivingFinalizationSnapshotV1Schema.shape;
export const receivingFinalizationSnapshotV2Schema = z
  .object({
    ...v1,
    snapshotVersion: z.literal(2),
    items: z.array(v1.items.element.extend({ receiptBasis })).min(1).max(100),
    confirmation: z
      .object({
        ...v1.confirmation.shape,
        ruleVersion: z.literal("receiving-readiness-v3"),
        reviewedExemptLines: reviewedLines,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const { reviewedExemptLines, ...confirmation } = value.confirmation;
    const common = receivingFinalizationSnapshotV1Schema.safeParse({
      ...value,
      snapshotVersion: 1,
      items: value.items.map(({ receiptBasis: basis, ...item }) => {
        void basis;
        return item;
      }),
      confirmation: { ...confirmation, ruleVersion: "receiving-readiness-v2" },
    });
    if (!common.success) {
      for (const issue of common.error.issues) context.addIssue(issue);
    }
    const expected = value.items.flatMap((item) =>
      item.receiptBasis.kind === "ordinary" ? [] : [item.lineNo],
    );
    if (
      expected.length !== reviewedExemptLines.length ||
      expected.some((line, index) => line !== reviewedExemptLines[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmation", "reviewedExemptLines"],
        message: "Reviewed lines must match the exempt receipt lines",
      });
    }
    value.items.forEach((item, index) => {
      if (
        item.receiptBasis.kind === "exempt_assigned_tlc" &&
        (item.lotLinkMode !== "create_on_finalize" ||
          item.source.kind !== "location" ||
          item.source.locationId.toLowerCase() !== value.locationId.toLowerCase())
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "receiptBasis"],
          message: "Own assignment requires the physical receiving location and a new lot",
        });
      }
    });
  });
export type ReceivingFinalizationSnapshotV2 = z.infer<typeof receivingFinalizationSnapshotV2Schema>;
```

V2 additionally checks exact exempt line set, preserved path's common source
identity, and own path's create mode/source location equal to header/receivedTlc
null. Task3's record envelope verifies all reviewers/times equal finalizer/time.
Stored reason and URL values never transform on read.

- [x] **Add raw-SQL RED cases, then extend the header guard with version dispatch.**
      Keep the existing finalized INSERT denial, immutable header branch, child-parent
      locks/pulses, and profile-insertion pulse. Add version2 shape and relational checks
      in the new migration; use the existing complete v1 branch for version1. Do not
      call a `RETURNS trigger` function as an ordinary SQL function.

For every v2 line require exact stored product/quantity/unit/source/doc order,
matching lot ID and permanent source latch. Ordinary and preserved paths compare
snapshot TLC to `i.tlc`; own assignment compares to the proposal without changing
`i.tlc`. Validate the saved flag/mode/reason/URL against `receiptBasis`, not only
that the snapshot is internally plausible. Core own-path relational predicate:

```sql
i.exempt_supplier
AND i.exempt_receipt->>'tlcHandling' = 'assign_if_missing'
AND i.tlc IS NULL
AND i.lot_link_mode = 'create_on_finalize'
AND i.source_location_id = NEW.location_id
AND frozen_item->>'tlc' = i.exempt_receipt->>'proposedTlc'
AND frozen_item->'receiptBasis'->>'reason' = i.exempt_reason
AND frozen_item->'receiptBasis'->>'evidenceUrl' = i.exempt_receipt->>'evidenceUrl'
AND frozen_item->'receiptBasis'->>'reviewedBy' = NEW.finalized_by
AND lot.assignment_basis = 'exempt_supplier_receipt'
```

Here `i`, `lot` and `frozen_item` are the receiving-item, tenant-joined lot and
ordered snapshot-item aliases in the new guard query. Add exact review timestamp
matching, proposal/lot equality, reference-column absence, complete descriptions
and exact review-set checks; preserve all ordinary guard invariants. SQL shape
checks must use `coalesce(..., false)` when SQL null could otherwise pass a CHECK
or avoid a rejection branch. Missing JSON keys must not succeed by null logic.

- [x] **Run GREEN plus migration/contract regression.** Include malformed/null
      objects, missing/extra keys, wrong JSON scalar types, 1,025-byte evidence,
      invalid proposal, v1/v2 unknown fields, v2 basis inconsistent with a saved line,
      wrong reviewer/time, absent/extra review numbers, and attempted finalized child
      insert/update/delete/move. Distinguish SQL-accepted malformed URL semantics from
      server-reader503, and preserve valid international URL controls.
- [x] **Run DB/contracts package gates and review.** Build DB output before any
      API test. Run all DB and contract `test`, `typecheck`, `lint`, `build`, plus the
      existing isolated API ordinary-finalization tests against the new migration
      chain. Report unrelated DB skips explicitly. Record the migration's actual name,
      metadata diff and red/green evidence. No active v3 API or commit yet.

Task 2 verified 2026-09-07: contracts 469/469; DB full gate 395 passed with 141
unrelated environment skips, then final migration regressions 108/108 after a
review-found timestamp precision correction. Both packages typecheck/lint/build
passed; existing ordinary API regressions 152/152 passed with the pre-existing
Vite native-config/CommonJS warning. Independent review and scoped re-review
approved. New v2 remains named-only; active API activation belongs to Task 3.

### Task 3: Activate strict drafts, readiness and the atomic QA command

**Files:**

- Modify `packages/domain/src/traceability/receiving-readiness.ts`, `packages/domain/test/us-receiving-readiness.test.ts` and relevant exported types.
- Modify `packages/platform-contracts/src/traceability/receiving.ts`, `receiving-records.ts`, `receiving-readiness.ts`, `receiving-finalization.ts` and package exports.
- Modify `apps/api/src/modules/traceability/receiving/us-receiving-reference-context.ts`, `us-receiving-persistence.ts`, `us-receiving-snapshots.ts`, `us-receiving-finalization.ts`; preserve store method signatures. Verify the unchanged `us-receiving-readiness.ts` wrapper forwards the updated context's readiness result without filtering or rebuilding it.
- Modify `us-receiving-store.ts` only to retain no-op save comparison when the new optional extension is missing versus null; do not change operation digests or receipt bodies.
- Modify `apps/admin/src/us/client.ts` only for missing/null extension acknowledgement compatibility in this task; keep ordinary browser saves functional when fresh reads start exposing null.
- Create `apps/api/src/modules/traceability/receiving/us-receiving-finalization-command.ts` for the canonical finalize digest helper; exact review-set validation stays inside the existing finalizer.
- Create `apps/api/test/us-receiving-exemption.e2e.test.ts`, `us-receiving-exemption-concurrency.e2e.test.ts`, `us-receiving-exemption-compatibility.e2e.test.ts`; extend `us-receiving-http.e2e.test.ts` and `support/us-receiving-fixture.ts` only as needed.
- Update existing readiness result fixtures and EN/ES detail vocabulary in affected domain/contract/API/admin tests and `apps/admin/src/us/receiving/readiness-copy.ts`. Do not replace v1 historical fixtures when updating active readiness to v3.
- Update check-only `.github/workflows/us-development.yml` with Tasks1–3 test names.

**Interfaces:**

- Active `ReceivingDraftItem.exemptReceipt?: ReceivingExemptReceiptInput | null` and lossless corresponding saved field; existing create/save/read method signatures stay unchanged.
- Active domain `assessReceivingReadiness` returns existing state/issues plus `exemptReviewRequiredLines: number[]`. `ReceivingReadiness` response requires the same field and literal v3 rule.
- `FinalizeReceivingInput.reviewedExemptLines?: number[]`; omission/empty means none. `receivingFinalizationSnapshotSchema` accepts explicit v1/v2; the finalized record stays one object with a nested snapshot union, preserving the outer status-discriminated record union.
- `receivingFinalizationCommandDigest(eventId: string, input: FinalizeReceivingInput): string` preserves the original digest for no reviews and includes a nonempty review list.
- `planReceivingSnapshot(saved: ReceivingDraftRecord, context: Context, review: { actorUserId: string; finalizedAt: string; reviewedExemptLines: number[] }): ReceivingFinalizationSnapshotV2`. `Context` remains the inferred return of `readReceivingReferenceContext`.
- Client-local `sameReceivingDraftInput(left: ReceivingDraft, right: ReceivingDraft): boolean` normalizes only missing versus null extension for comparison, without changing the request, response or historical receipt.

- [x] **Write RED for persisted own-assignment without review, then success with review.**
      Use the existing `seedCompleteReceiving`, disposable fixture and `UsReceivingStore`
      setup shown in `us-receiving-finalization.e2e.test.ts`. Keep the second linked
      ordinary line. The core new test body is:

```ts
const first = c.draft.items[0];
if (!first) throw new Error("Missing fixture line");
first.exemptSupplier = true;
first.exemptReason = "Synthetic receipt-specific supplier declaration";
first.tlc = null;
first.exemptReceipt = {
  evidenceUrl: "https://supplier.example.test/declarations/2026-09",
  tlcHandling: "assign_if_missing",
  proposedTlc: "=Own/Ä-001",
};
const saved = await store.createDraft(
  c.tenant,
  c.actor,
  { operationKey: randomUUID(), draft: c.draft },
  "save",
);
const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
  expectedDraftVersion: saved.draftVersion,
});
expect(check).toMatchObject({ state: "complete", exemptReviewRequiredLines: [1] });
const command = {
  operationKey: randomUUID(),
  expectedDraftVersion: saved.draftVersion,
  expectedInputDigest: check.inputDigest,
};
await expect(
  store.finalize(c.tenant, c.actor, saved.id, command, "missing-review"),
).rejects.toMatchObject({ response: { code: "event_incomplete" } });
const reviewed = { ...command, reviewedExemptLines: [1] };
const result = await store.finalize(c.tenant, c.actor, saved.id, reviewed, "reviewed");
expect(result.snapshot.items[0]).toMatchObject({
  tlc: "=Own/Ä-001",
  quantity: "500.000",
  receiptBasis: {
    kind: "exempt_assigned_tlc",
    receivedTlc: null,
    reviewedBy: c.actor,
    reviewedAt: result.finalizedAt,
  },
});
expect(await store.finalize(c.tenant, c.actor, saved.id, reviewed, "retry")).toEqual(result);
const stored = await fixture.pool.query(
  "SELECT tlc,exempt_receipt FROM receiving_event_items WHERE tenant_id=$1 AND event_id=$2 AND line_no=1",
  [c.tenant, saved.id],
);
expect(stored.rows[0]?.tlc).toBeNull();
```

Run `pnpm --filter @markiro/api exec vitest run test/us-receiving-exemption.e2e.test.ts`
with the isolated test variable; expected RED is new input rejection/blocking,
not missing infrastructure. Add exact pre/post row and audit comparisons around
the rejected call; a later count alone cannot prove zero side effects.

- [x] **Activate draft persistence with compatibility.** Add the Task1 primitive
      as `.nullable().optional()` to live item input and its preserved counterpart to
      stored records; no default transformation. Save the field explicitly into the new
      column, expose null on fresh reads, and retain legacy receipt bodies unchanged.
      Keep operation-input serialization unchanged for old requests without the field.
      Test new-field round trips, structural failures with zero writes, and old receipt
      replays both before and after finalization.

```ts
exemptReceipt: receivingExemptReceiptSchema.nullable().optional();
// Stored record variant:
exemptReceipt: preservedReceivingExemptReceiptSchema.nullable().optional();
// Fresh database read mapping; parsing still validates unknown JSON:
exemptReceipt: row.exemptReceipt ?? null;
```

- [x] **Keep ordinary browser acknowledgements compatible during activation.**
      Write RED client tests using an old response with no extension and a new response
      with null, then replace raw draft `JSON.stringify` comparisons in create/save with
      this helper. Validate both schemas before comparing. Removing the optional key
      before appending it makes property order consistent for legacy and new shapes.

```ts
function sameReceivingDraftInput(left: ReceivingDraft, right: ReceivingDraft): boolean {
  const comparable = (draft: ReceivingDraft) => ({
    ...draft,
    items: draft.items.map(({ exemptReceipt, ...item }) => ({
      ...item,
      exemptReceipt: exemptReceipt ?? null,
    })),
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}
```

Test that a populated extension or any changed reason, proposal, mode, evidence,
quantity or source still fails acknowledgement. Do not normalize URLs/TLCs or
drop inactive input. This step changes only comparison views, not receipt bytes.

The existing server save path also compares the parsed saved draft with the
incoming draft to detect no-op saves. Apply the same missing/null-only equivalence
there, retaining its deep comparison and exact operation-input digest. Add a RED
regression proving an unchanged legacy payload does not bump draftVersion or
rewrite header/children/audit; a populated or changed extension remains a real edit.
No-op operation receipts still record the actual response through the existing path.

- [x] **Activate readiness v3 using the one pure assessment.** Extend the domain
      input's optional field; map each local finding to error/lines/index+1 metadata.
      Compute effective TLCs before intra-draft duplicate checks and before the server's
      tenant/source conflict query. Use the same effective value for both conflict-query
      construction and matching returned rows; otherwise absent received TLCs bypass
      duplicate checks. Keep original saved fields in the digest, not just derived data.
      Do not produce an assignment-missing error from received `tlc = null` when the
      own proposal is valid. Return all active exempt line numbers even for blocked
      drafts; a complete result is never a persisted review.

```ts
const assessed = draft.items.map((line) => assessReceivingExemptionLine(line, draft.locationId));
const exemptReviewRequiredLines = draft.items.flatMap((line, index) =>
  line.exemptSupplier ? [index + 1] : [],
);
```

Retain all existing profile/reference/location/GTIN/quantity/document checks.
Add details `evidenceUrl`, `tlcHandling`, `proposedTlc` to the active issue vocabulary
and EN/ES copy. Freeze the old v1 vocabulary separately instead of widening its
validator when these active constants change.

- [x] **Write digest compatibility tests and implement the exact command helper.**

```ts
import { createHash } from "node:crypto";
import type { FinalizeReceivingInput } from "@markiro/platform-contracts";

export function receivingFinalizationCommandDigest(
  eventId: string,
  input: FinalizeReceivingInput,
): string {
  const base = {
    eventId,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedInputDigest: input.expectedInputDigest,
  };
  const value = input.reviewedExemptLines?.length
    ? { ...base, reviewedExemptLines: input.reviewedExemptLines }
    : base;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
```

Verify the helper against a locally computed original digest, omission versus
empty, and changes to event/version/digest/nonempty reviews. Array validation
requires ascending unique integers1–100/max100, without silently sorting or
deduplicating input. A correctly shaped but wrong required set is409
`event_incomplete`; a replay key rebound to another command is409
`receiving_operation_conflict`.

- [x] **Wire v2 snapshot and finalizer together.** Switch the public snapshot
      validator to explicit v1/v2, preserve record envelope timestamp/actor equality,
      and add v2 per-line reviewer/time equality against that envelope. Allocate one
      server finalization time before building the snapshot; pass its ISO value and
      authenticated actor into `planReceivingSnapshot`. Use the same instant in DB and
      lot latches. Snapshot every exemption field from the locked saved draft, never
      from request-supplied metadata.

```ts
const expected = context.readiness.exemptReviewRequiredLines;
const reviewed = value.reviewedExemptLines ?? [];
const reviewMatches =
  reviewed.length === expected.length && reviewed.every((line, index) => line === expected[index]);
if (!reviewMatches) {
  const mismatched = [...new Set([...expected, ...reviewed])]
    .filter((line) => expected.includes(line) !== reviewed.includes(line))
    .sort((left, right) => left - right);
  throw new ConflictException({
    code: "event_incomplete",
    issues: mismatched.map((line) => ({
      severity: "error",
      group: "lines",
      line,
      field: "exemption",
      code: "exemption_review_required",
      detail: null,
    })),
  });
}
const now = new Date();
const snapshot = planReceivingSnapshot(before, context, {
  actorUserId,
  finalizedAt: now.toISOString(),
  reviewedExemptLines: reviewed,
});
// In the existing sorted new-lot insertion:
const assignmentBasis =
  line.receiptBasis.kind === "exempt_assigned_tlc" ? "exempt_supplier_receipt" : "imported";
```

Keep successful receipt lookup before mutable-reference checking and current QA
authorization before receipt lookup. Preserve deterministic lot locks/insertion,
three whole-transaction retries, existing-lot identity, source latches, audit and
receipt atomicity. The stored received TLC is never replaced with a proposal.
All new ordinary finalizations also use v2 with `{ kind: "ordinary" }` and an
empty review list; existing v1 successes remain v1 on replay/read.

- [x] **Add exact audit and negative regression tests.** Inspect every new/linked
      lot and event: tenant, actor, action, target, outcome, before/after, source latch,
      assignment basis, effective versus received TLC and request ID. Cover preserved
      supplier TLC with a distinct source site, both location and URL-reference sources,
      linking a lot with an existing non-imported basis, inactive hidden inputs, two
      own proposals colliding, ordinary/proposed collisions, and existing-tenant lot
      collisions. Inject audit failure to prove full rollback. No inventory/status side
      effects; manual lot creation still rejects own-assignment basis.
- [x] **Add compatibility, concurrency and HTTP denial tests.** Keep real v1
      snapshots/receipts unchanged across migration and read/replay. Exercise missing,
      extra, duplicate and unordered reviews; forged reviewer/time; unknown mode;
      current QA revocation; operator and other-tenant denial; stale version/digest;
      source/product-profile/document mutations; same/different-key concurrent finalize;
      child insert/update/delete/move during finalization; original successful replay
      after live reference changes. Use explicit transaction barriers from existing
      concurrency tests, not sleeps. Real HTTP still requires MFA, allowed Host/Origin,
      JSON and existing 16KiB finalize/256KiB draft limits; no new route or proxy scope.
- [x] **Run GREEN and review server activation.** Build domain/contracts/DB before
      API tests. Run affected receiving/lot/product-profile API suites, all new suites,
      DB receiving suites and package typecheck/lint/build. Run affected admin client
      tests/typecheck to catch nested snapshot-union or readiness-fixture breaks. Add
      test filenames to check-only CI. Record unrun legacy infrastructure tests and
      known setup limitations honestly; do not load primary env to conceal them. No commit.

Task 3 verified 2026-09-07: domain 904/904, contracts 469/469, DB Receiving128/128,
admin1228/1228. The broad scoped API run passed334 with two synthetic fixture
setup failures; only two test files changed afterward and their final rerun
passed42/42. This covers337 current scoped API tests across runs, not one green
337-test run. Final typecheck/lint/build, whole formatting and17 isolation tests
passed with the documented pre-existing warnings. Independent spec/quality review
approved; real HTTP/MFA exercised, connected exemption browser acceptance pending.

### Task 4: Per-line QA interface and real browser evidence

**Files:**

- Create `apps/admin/src/us/receiving/exemption-fields.tsx` and `exemption-review.tsx` for the draft inputs and controlled QA review list.
- Modify existing receiving `line-editor.tsx`, `editor.tsx`, `finalization-dialog.tsx`, `finalized-detail.tsx`, `copy.ts`, `receiving.css` and `apps/admin/src/us/client.ts`.
- Modify `readiness-panel.tsx` and `readiness-copy.ts` to show the current check's exact pending-QA line list in EN/ES, including non-QA operators, as required by spec section3. Keep the existing generation/QA/edit invalidation and nonblocking completeness semantics; per-line confirmation controls remain in the dialog. Final whole-feature review corrected the earlier verify-only interpretation: forwarding v3 data alone does not display this required notice.
- Create `apps/admin/test/us-receiving-exemption.test.tsx`, `us-receiving-exemption-client.test.ts`, and `support/us-receiving-exemption-fixture.ts`. Preserve old finalization fixtures for v1; add separate v2 fixtures.
- Create `tools/us-development/test/receiving-exemption-flow.mjs`; call it from `receiving-flow.mjs` after the existing ordinary-finalization companion. Do not move earlier global event/audit assertions after the new fixture writes.
- Update `.github/workflows/us-development.yml` test names and scoped docs `docs/us/receiving-browser.md`, `browser-entry.md`, `development-isolation.md`, `requirements-traceability.md`, `implementation-plan.md`, plus this plan's actual checklist/evidence.

**Interfaces:**

- `ReceivingExemptionFields` accepts the current `ReceivingDraftItem`, receiving
  site ID/label, disabled state and an explicit `onChange` callback. It is mounted
  inside the existing numbered line group and cannot issue server commands.
- `ReceivingExemptionReview` accepts `ReceivingDraftRecord`, required line numbers,
  controlled `reviewedLines: number[]`, `disabled`, and
  `onChange(lines: number[]): void`, plus `labels: { products: ReadonlyMap<string, string>;
locations: ReadonlyMap<string, string> }`. It displays the exact saved basis and
  initially unchecked per-line controls; the dialog owns review state and loads
  readable labels through existing `getProduct` / `getLocation` methods.
- Client `finalizeReceiving` preserves its method signature, validates the new
  body and v1/v2 result, and correlates event/version/digest and effective reviews.
  `sameReceivingDraftInput(left: ReceivingDraft, right: ReceivingDraft): boolean`
  in the client treats only missing versus null extension as equivalent.
- `exerciseUsReceivingExemption({ page, expect, screenshots, fixture })` follows
  the existing real-browser companion signature and owns only its synthetic rows.

- [x] **Write RED draft/client tests before components.** Cover visible fields,
      both paths, switching without erasing populated TLC/source/lot, changing receiving
      site, inactive hidden proposal, old receipt with missing extension, and current
      read with null. Set up i18next/ThemeProvider/ReceivingView using the existing
      finalization test pattern, with a new independently defined exempt fixture.

```ts
await user.click(screen.getByRole("button", { name: "Check saved draft" }));
await user.click(await screen.findByRole("button", { name: "Finalize" }));
const dialog = await screen.findByRole("dialog");
const confirm = within(dialog).getByRole("button", { name: "Confirm finalization" });
expect(confirm).toBeDisabled();
await user.click(within(dialog).getByRole("checkbox", { name: "Review exemption for line 1" }));
expect(confirm).toBeEnabled();
```

These are the new English review-control names; preserve the existing button's
actual localized name if it differs, and test the new checkbox's Spanish label
from copy rather than English fallback. For several exempt lines, checking one
does not enable finalization until all are checked.

- [x] **Extend acknowledgement regression to the connected exempt editor.**
      Retain Task3's `sameReceivingDraftInput`; do not introduce another normalization
      policy. Use the real client with controlled responses to verify that changed
      reason/proposal/mode/evidence/quantity/source produces `invalid_response` and
      preserves input/retry identity, while only missing/null extension is equivalent.

- [x] **Implement the draft fields and source summary.** Keep received TLC and
      own proposal separate. Explicitly accepting own assignment sets the receiving
      source only when the source is empty or already the same; conflicting input
      needs explicit correction and remains visible. No toggle erasure, automatic save,
      code generation or supplier-wide status. Add copy in EN/ES with existing shared
      inputs, segmented/radio choice, focus labels and tokens. Use the same plain-text
      receiving-source summary at desktop and narrow widths.
- [x] **Implement controlled per-line review and invalidation.** In the dialog,
      derive required lines from the checked saved record and validate equality with
      the server's required list. Show product, previous source, reason, evidence URL,
      received/proposed TLC and source for each. Unknown/mismatched check metadata blocks
      confirmation. Checkbox updates produce ascending unique arrays; no select-all.

The saved draft contains IDs, not readable product/location descriptions. In the
dialog's existing reference-loading lifecycle, deduplicate product and location
IDs for the exempt lines, previous source and receiving site, then resolve each
once. Keep the review component presentational and block confirmation while a
required lookup is pending or failed. Reuse the existing auth/error and stale
response handling; no approval metadata is derived from these live labels.

```ts
const productIds = [
  ...new Set(
    record.draft.items.flatMap((item) =>
      item.exemptSupplier && item.productId ? [item.productId] : [],
    ),
  ),
];
const locationIds = [
  ...new Set(
    [
      record.draft.locationId,
      record.draft.previousSourceLocationId,
      ...record.draft.items
        .filter((item) => item.exemptSupplier)
        .map((item) =>
          item.source?.kind === "location"
            ? item.source.locationId
            : item.source?.kind === "reference"
              ? item.source.resolvedLocationId
              : null,
        ),
    ].filter((id): id is string => id !== null),
  ),
];
const [products, locations] = await Promise.all([
  Promise.all(productIds.map(async (id) => [id, (await client.getProduct(id)).name] as const)),
  Promise.all(locationIds.map(async (id) => [id, (await client.getLocation(id)).name] as const)),
]);
const labels = { products: new Map(products), locations: new Map(locations) };
```

Run these new lookups only for exempt receipts; ordinary confirmation keeps its
current dependencies. Test shared IDs are fetched once, failed reads cannot
enable review, and late results cannot revive an invalidated dialog. Finalization
still rechecks the original readiness digest under locks before freezing names.

```ts
const [reviewedLines, setReviewedLines] = useState<number[]>([]);
const reviewComplete =
  requiredLines.length === reviewedLines.length &&
  requiredLines.every((line, index) => line === reviewedLines[index]);
const toggleReview = (lineNo: number, checked: boolean) => {
  if (pending || uncertain) return;
  setReviewedLines((current) =>
    checked
      ? [...new Set([...current, lineNo])].sort((a, b) => a - b)
      : current.filter((line) => line !== lineNo),
  );
};
```

The existing synchronous busy ref still guards double submission. Build the
command once per confirmed attempt, including a nonempty reviewed list; freeze
all review choices during pending/uncertain delivery. Retry reuses that exact
command. Dirty generation, save/reload/recheck, dialog cancellation, session loss
and QA loss/restoration must not resurrect earlier checks. Test each boundary,
including failed current-record reload and deliberately late responses.

- [x] **Render v2 frozen history and correlate final acknowledgements.** V1
      renders unchanged without invented review details. V2 reads only its snapshot
      for reason/evidence/handling/reviewer/time; effective TLC and existing lot/back
      navigation stay visible. The client rejects a v2 response with different confirmed
      line numbers, reviewer metadata inconsistent with the envelope, or the wrong
      event/version/digest. Keep successful legacy v1 replay possible only for a command
      without exempt reviews. Any external evidence link uses the existing safe-link
      pattern and never auto-previews/downloads the URL.
- [x] **Add and run the real synthetic browser companion.** Seed distinct previous
      source and receiving locations with full descriptions; create a mixed receipt
      through the real API. Exercise one preserved existing code and one own proposal,
      review controls, persisted effective code/basis and null received TLC, and a second
      receipt from the same supplier with no inherited approval. Intercept only delivery
      failure after a genuine server commit to test same-body retry. Assert exact audit
      and stable lot IDs/counts, not a mocked successful body. Mutate live master data
      and reopen to prove frozen review/identity. Use real operator membership for403.

```js
// In receiving-flow.mjs, after the existing ordinary companion has completed:
await exerciseUsReceivingExemption({ page, expect, screenshots, fixture });
// In the new companion, confirm the saved frozen result through the real endpoint:
const current = await page.request.get(`${base}/receiving/${saved.id}`);
assert.equal(current.ok(), true);
const frozen = await current.json();
assert.equal(frozen.snapshot.snapshotVersion, 2);
assert.deepEqual(frozen.snapshot.confirmation.reviewedExemptLines, [1, 2]);
```

The companion defines `base = "http://localhost:5174/api/us/traceability"` and
`saved` from its actual create response, as in the existing companion. Use the
installed Playwright runtime via
`NODE_PATH=/Users/thevladbog/PRSOME/q/tools/production-browser/node_modules`.
Run `node --test tools/us-development/test/browser-flow.smoke.mjs` under Node24
with scoped loopback permission. The parent harness owns setup/cleanup and the
disposable database; do not start a second uncontrolled server.

- [x] **Verify EN/ES, themes and keyboard in the real browser.** Exercise
      1440/1024/390 widths, long evidence/rationale/source text, several review rows,
      visible focus and no body overflow. Capture only safe application screens for
      both handling paths, confirmation and frozen review. Inspect original-resolution
      mobile screenshots. Preserve parent page-error/external-request/storage checks;
      do not capture MFA, traces or HAR. Fluent Spanish/screen-reader/hosted/hardware
      acceptance stays separate.
- [x] **Run final gates and update evidence, then request final scoped review.**
      Use the commands below; record actual pass/fail/skip counts, final-source browser
      timing and remaining external limits. Update requirement status only as far as
      the evidence proves; full Receiving lifecycle/US-03/MVP remain incomplete. Keep
      previous dated evidence intact. No commit, push or release.

Task 4 verified 2026-09-07: connected Receiving tests99/99, final full admin
1248/1248 and post-fix Chromium1/1 (33.83s test/35.71s total). Fresh admin
typecheck/lint/US build and scoped format/diff pass. Independent review found a
receiving-site label race; keyed-label correction, three connected regressions,
location-read dedup assertions and current REC-001 wording were approved on
scoped re-review. Prior full domain904/contracts469/DB406pass141unrelated-env
skips/API337 gates remain current for their unchanged source. Known warnings and
external limits remain explicit; see [connected evidence](../../us/receiving-browser.md#exempt-supplier-receipt-review--2026-09-07).
All four implementation tasks passed independent review. Whole-feature review
then found three UI gaps: native Unicode proposal truncation, omitted saved
reference-source identity in confirmation, and the missing pending-QA line notice.
All three were corrected together and accepted by independent scoped re-review
on 2026-09-07; no new Critical/Important findings remained. Final correction
checks passed 35/35 focused, 106/106 Receiving and 1255/1255 full admin tests;
the final Chromium journey passed 1/1 (34.36s test/35.91s total). Admin
typecheck/lint, primary and US builds passed. The controller inspected the final
EN desktop and ES mobile source-reference and pending-QA notice originals.
The unchanged ordinary received-TLC input's native 200-UTF-16-unit cap remains a
pre-existing follow-up outside this increment. Full US-03/MVP and external
acceptance remain incomplete. Nothing is committed, pushed or released.

## Final verification commands

Commands run from the US worktree with the host-specific pnpm prefix and isolated
test variable from Global Constraints. Run package gates sequentially to limit
database contention; an unavailable fixture is a reported gap, not a pass.

```sh
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/platform-contracts build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/us-receiving.e2e.test.ts test/us-receiving-readiness.e2e.test.ts test/us-receiving-finalization.e2e.test.ts test/us-receiving-finalization-concurrency.e2e.test.ts test/us-receiving-finalization-child-concurrency.e2e.test.ts test/us-receiving-finalization-snapshot-guards.e2e.test.ts test/us-receiving-finalization-url-boundary.e2e.test.ts test/us-receiving-exemption.e2e.test.ts test/us-receiving-exemption-concurrency.e2e.test.ts test/us-receiving-exemption-compatibility.e2e.test.ts test/us-receiving-http.e2e.test.ts test/us-product-profile.e2e.test.ts test/us-lot.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
VITE_DEPLOYMENT_EDITION=US MARKIRO_DEPLOYMENT_EDITION=US pnpm --filter @markiro/admin build:us
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/*.test.mjs
node --test tools/us-development/test/browser-proxy.smoke.mjs
NODE_PATH=/Users/thevladbog/PRSOME/q/tools/production-browser/node_modules node --test tools/us-development/test/browser-flow.smoke.mjs
pnpm format:check
git diff --check
```

The full legacy API suite has previously recorded primary-environment setup
failures. Do not claim it green from the focused US suites or import primary
credentials to run it. Record any omitted broad gate and its reason. Root-level
lint/build success cannot substitute for these DB, contract and browser checks.

## Plan self-review and handoff

- Spec§1–2: Task1 pure assessment, Task3 persistence/authorization, Task4 explicit UI; no supplier registry or legal automation.
- Spec§3: Task3 v3 check/strict review command and Task4 confirmation/reset/retry.
- Spec§4: Tasks2–3 v2 frozen contract, atomic assignment, exact audit and latches.
- Spec§5: Task2 migration/guard/v1 preservation, Task3 old receipts/digest and null/omitted acknowledgement compatibility, Task4 connected-editor regression.
- Spec§6: Task4 grouped EN/ES controls, frozen detail and safe navigation; domain/store/UI responsibilities remain separate.
- Spec§7: Each task has RED/GREEN, role/tenant/data integrity gates, with real browser and final scoped review in Task4.

This plan does not prove implementation; only verified tasks are checked above.
The owner chose subagent-driven execution with per-task reviews on 2026-09-07.
Execution preserves the same isolation and no-publication boundary.
