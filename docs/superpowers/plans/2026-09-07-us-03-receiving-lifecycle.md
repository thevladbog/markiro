# US-03 Receiving Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audited Receiving amendments and voids with stable lot identities, immutable revision history and an explicit current receiving basis in the isolated US application.

**Architecture:** Keep a small tenant-owned Receiving root to coordinate distinct revision rows. Extend the existing transactional finalizer and frozen readers; separate historical command acknowledgements from current lifecycle reads. Domain rules and strict contracts precede additive storage, atomic server commands and the connected EN/ES office workflow.

**Tech Stack:** Node >=24, pnpm 11.22.0, TypeScript, Zod 4, Drizzle/PostgreSQL, NestJS, React/Vite, Vitest and the existing local Chromium harness; existing dependency pins only.

**Spec:** [Receiving lifecycle design](../specs/2026-09-07-us-03-receiving-lifecycle-design.md), approved by the owner on 2026-09-07. Read the complete spec and this plan before execution.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; implementation baseline `40a3c72fd2c2f36e463a827db2f027baa1584182`.
- Preserve the existing uncommitted scoped design documents. Capture a per-task pre-edit baseline; do not attribute all changes against HEAD to a single task.
- Keep the primary checkout, deployment locks and Downloads untouched; commit/push and release remain separate requests.
- Voiding a Receiving never deletes its lots or changes their ID, product, TLC, source, assignment basis or operational status.
- It never clears the permanent source lock, releases quarantine or recall, or automatically archives a lot.
- The normative current predicate remains `status = finalized AND superseded_by_event_id IS NULL`.
- Only one pending draft is allowed per root. Revision numbers are never reused. Ordinary draft saves increment only `draftVersion`; pointer transitions increment the root lifecycle version.
- Current QA permission is required to start, save, finalize or void an amendment. Revision-1 drafting retains its existing receiving-write permission; all voids require QA.
- Preserve version-pinned frozen v1/v2 content, old operation result JSON, old digest algorithms, exact decimals, opaque TLC and civil dates/timezone.
- New finalizations use snapshot v3 and readiness `receiving-readiness-v4`; activate them with the connected server path, not during contract scaffolding.
- The existing 120-code-point contract and exact stored values do not change. Fix only the ordinary TLC field's incompatible native UTF-16 cap.
- No autosave, automatic retry or persistent browser approval/key storage is added.
- No CSV, other CTE implementations, persisted genealogy, inventory balances, case/SSCC links, trace/export packages, automatic cascades, new lot status transitions, Station, dependency upgrades or release enablement.
- No hosted, real-data, hardware, screen-reader, fluent-Spanish or future downstream-consumer acceptance is implied by local automated checks.

---

## Sequence and reviewable boundaries

| Stage               | Task | Independently testable deliverable                                                                 |
| ------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| Rules and contracts | 1    | Pure transition, binding, change and readiness rules; old default behavior retained                |
| Rules and contracts | 2    | New strict commands/live records/snapshot v3 with unchanged legacy parsers                         |
| Storage             | 3    | Additive migration, raw-SQL guards and root coordination; existing create/save/finalize still work |
| Server              | 4    | Atomic lifecycle commands, basis/history reads, authorization, concurrency and HTTP contracts      |
| Interface           | 5    | Connected workflow, exact retry recovery, Unicode correction and real local browser acceptance     |

Run sequentially: no simultaneous implementation agents in overlapping files.
For subagent execution, dispatch a fresh bounded implementer per task, then review
the actual diff and evidence before accepting it. Use the selected execution
skill's review procedure. Do not create new user-visible tasks or commit merely
because a task passed. Keep durable progress and red/green evidence in ignored
`.superpowers/sdd/2026-09-07-us-03-receiving-lifecycle/`, not the completed exempt
Receiving workspace. Implementation checkboxes below start unchecked.

Read `AGENTS.md` and `docs/us/development-isolation.md`. There is no local Graphify
graph at planning time; inspect source/tests directly. If one exists at execution
time, follow the repository's graph query/update rules without reading `.pen` files.

## File responsibilities

Existing anchors are `receiving-readiness.ts` in domain, `receiving*.ts` in
platform-contracts, `traceability-receiving.ts` in DB, the API's
`modules/traceability/receiving/` folder and the admin's `us/receiving/` folder.
Use actual package entrypoints `packages/domain/src/index.ts` and
`packages/platform-contracts/src/index.ts`; there is no domain traceability barrel.

New units are scoped to Receiving, not a generic CTE framework:

- `receiving-lifecycle.ts` (domain): pure state transitions and counter bounds.
- `receiving-amendment.ts` (domain): predecessor bindings and material effects.
- `receiving-lifecycle.ts`, `receiving-live-records.ts`,
  `receiving-finalization-v3.ts` (contracts): inputs, live/history boundary and
  new immutable snapshot respectively.
- `us-receiving-roots.ts` (API): root allocation/locks and basis-version writes.
- `us-receiving-lifecycle.ts` (API): amend/void transactions.
- `us-receiving-history.ts` (API): exact revision and paginated history reads.
- `us-receiving-basis.ts` (API): complete current-support counts and bounded lists.
- `lifecycle-dialog.tsx`, `revision-history.tsx`, `amendment-comparison.tsx`
  (admin Receiving) and `receiving-basis.tsx` (admin lots): focused UI units.

Keep draft persistence, finalization and snapshot construction in their existing
modules. Extract repeated command receipt handling into
`us-receiving-operations.ts`; preserve legacy digest/parse branches explicitly.
Do not expand the already-large store or editor with all lifecycle logic inline.

## Test environment

Use the repository-declared toolchain. On this workstation, commands can be
invoked without inheriting a primary database variable as follows:

```sh
env -u DATABASE_URL PATH=/opt/homebrew/opt/node@24/bin:$PATH node /Users/thevladbog/.cache/node/corepack/v1/pnpm/11.22.0/bin/pnpm.cjs --version
```

The `pnpm` commands below mean that verified runtime, from the US worktree.
Dependency installation or a different runtime is not part of the plan.
DB-backed commands additionally use this explicit synthetic opt-in only:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/db exec vitest run test/us-receiving-schema.test.ts
```

`createUsProfileTestDatabase` creates/migrates/removes an owned random database.
Never migrate/reset the base database, load the primary `.env`, or use the ordinary
development Compose stack. Read `packages/db/drizzle.config.ts` before generating:
hand-migrated partitioned tables are intentionally excluded. Rebuild DB exports
before API tests. Missing infrastructure is an explicit skip/block, never a pass.

### Task 1: Pure lifecycle, amendment binding and readiness rules

**Files**

- Create `packages/domain/src/traceability/receiving-lifecycle.ts`.
- Create `packages/domain/src/traceability/receiving-amendment.ts`.
- Modify `packages/domain/src/traceability/receiving-readiness.ts` and `packages/domain/src/index.ts`.
- Create `packages/domain/test/us-receiving-lifecycle.test.ts` and `packages/domain/test/us-receiving-amendment.test.ts`.
- Extend `packages/domain/test/us-receiving-readiness.test.ts`; retain `us-receiving-exemption.test.ts` as a regression gate.

**Interfaces**

These domain-only types must not import platform-contracts. `ReceivingReadinessInput`
and `ReceivingReadinessIssue` are existing domain exports. Define the following
in the new files and export them from the package root:

```ts
export type ReceivingEventStatus = "draft" | "finalized" | "amended" | "void";
export interface ReceivingLifecycleState {
  id: string;
  rootId: string;
  status: ReceivingEventStatus;
  revision: number;
  supersededByEventId: string | null;
  currentEventId: string | null;
  pendingDraftId: string | null;
  lifecycleVersion: number;
  nextRevision: number;
}
export type ReceivingLifecycleAction = "amend" | "finalize" | "void";
export type ReceivingLifecycleDecision =
  | { ok: true }
  | {
      ok: false;
      code: "receiving_lifecycle_conflict" | "receiving_pending_amendment";
      pendingDraftId: string | null;
    };
export function isCurrentReceiving(value: {
  status: ReceivingEventStatus;
  supersededByEventId: string | null;
}): boolean;
export function assessReceivingTransition(
  state: ReceivingLifecycleState,
  action: ReceivingLifecycleAction,
): ReceivingLifecycleDecision;

export type ReceivingMaterialSource = ReceivingReadinessInput["draft"]["items"][number]["source"];
export interface ReceivingMaterialLine {
  lineNo: number;
  previousLineNo: number | null;
  productId: string | null;
  lotId: string | null;
  lotLinkMode: "create_on_finalize" | "link_existing";
  effectiveTlc: string | null;
  source: ReceivingMaterialSource;
  receiptHandling: "ordinary" | "exempt_existing_tlc" | "exempt_assigned_tlc";
  quantity: string | null;
  unitOfMeasure: string | null;
}
export interface ReceivingMaterialRevision {
  dateReceived: string | null;
  locationId: string | null;
  previousSourceLocationId: string | null;
  lines: readonly ReceivingMaterialLine[];
}
export interface ReceivingAmendmentEffect {
  kind: "documentary" | "material";
  affectedLotIds: string[];
  removedPreviousLineNos: number[];
  identityLockedLineNos: number[];
  invalidBindingLineNos: number[];
}
export function classifyReceivingAmendment(
  predecessor: ReceivingMaterialRevision,
  candidate: ReceivingMaterialRevision,
): ReceivingAmendmentEffect;

export interface ReceivingConsumerFact {
  eventId: string;
  kind: "transformation" | "shipping";
  receiptRootId: string;
  lotIds: readonly string[];
  status: ReceivingEventStatus;
  supersededByEventId: string | null;
}
export function getBlockingReceivingConsumerIds(input: {
  changeKind: "documentary" | "material" | "void";
  receiptRootId: string;
  affectedLotIds: readonly string[];
  consumers: readonly ReceivingConsumerFact[];
}): string[];

export interface ReceivingRetainedBinding {
  lineNo: number;
  previousLineNo: number;
  lotId: string;
}
export function assessReceivingRevisionReadiness(
  input: ReceivingReadinessInput,
  context: { retainedBindings: readonly ReceivingRetainedBinding[] },
): ReturnType<typeof assessReceivingReadiness>;
```

Signatures are the handoff contract, not empty implementation bodies. Authorization,
DB ownership, complete dependency discovery and UUID normalization belong to the
server/contracts, not these deterministic helpers.

- [x] **Write and run the first failing lifecycle test.**

```ts
import { describe, expect, it } from "vitest";
import { assessReceivingTransition, isCurrentReceiving } from "../src/index.js";

describe("Receiving revision lifecycle", () => {
  it("does not withdraw the predecessor while an amendment draft exists", () => {
    const state = {
      id: "r1",
      rootId: "r1",
      status: "finalized" as const,
      revision: 1,
      supersededByEventId: null,
      currentEventId: "r1",
      pendingDraftId: "r2",
      lifecycleVersion: 3,
      nextRevision: 3,
    };
    expect(isCurrentReceiving(state)).toBe(true);
    expect(assessReceivingTransition(state, "void")).toEqual({
      ok: false,
      code: "receiving_pending_amendment",
      pendingDraftId: "r2",
    });
  });
});
```

Run `pnpm --filter @markiro/domain exec vitest run test/us-receiving-lifecycle.test.ts`.
Record RED from the absent export/behavior, not an unrelated dependency failure.

- [x] **Implement transition rules, then extend their table-driven tests.**

```ts
export function isCurrentReceiving(value: {
  status: ReceivingEventStatus;
  supersededByEventId: string | null;
}): boolean {
  return value.status === "finalized" && value.supersededByEventId === null;
}
```

In `assessReceivingTransition`, reject terminal amended/void rows; require exact
current identity for amend/void of finalized rows; require the pending pointer to
equal the draft ID for finalize/void of drafts. Finalized amend/void with a pending
draft returns the pending-draft code and pointer. Original-draft finalization needs
no current predecessor; amendment finalization needs a current predecessor of the
same root. Check positive safe integer versions and the PostgreSQL int maximum
2,147,483,647 before any increment. Invalid stored state is rejected, not repaired.
Tests cover every row of spec section 3, wrong pointer, gaps and counter exhaustion.

- [x] **Write binding/change tests before implementing the comparison.**

Use a concrete two-line predecessor; reverse the candidate while retaining
`previousLineNo` and assert `documentary`, no affected lots and no identity issues.
Change a bound TLC/source/product/lot/mode/handling and assert its current line
number is in `identityLockedLineNos`. Unknown/duplicate bindings belong in
`invalidBindingLineNos`; do not classify them as new lines. Test all three receipt
handling paths and two predecessor lines pointing at the same lot.

The comparison algorithm is keyed to the predecessor, not the new array index:

```ts
function sameMaterialSource(a: ReceivingMaterialSource, b: ReceivingMaterialSource): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "location" && b.kind === "location") return a.locationId === b.locationId;
  return (
    a.kind === "reference" &&
    b.kind === "reference" &&
    a.referenceKind === b.referenceKind &&
    a.referenceValue === b.referenceValue &&
    a.resolvedLocationId === b.resolvedLocationId
  );
}
const previous = new Map(predecessor.lines.map((line) => [line.lineNo, line]));
const bound = new Set<number>();
const invalidBindingLineNos: number[] = [];
const identityLockedLineNos: number[] = [];
for (const line of candidate.lines) {
  if (line.previousLineNo === null) continue;
  const original = previous.get(line.previousLineNo);
  if (!original || bound.has(line.previousLineNo)) {
    invalidBindingLineNos.push(line.lineNo);
    continue;
  }
  bound.add(line.previousLineNo);
  if (
    original.lotId !== line.lotId ||
    original.productId !== line.productId ||
    original.effectiveTlc !== line.effectiveTlc ||
    original.lotLinkMode !== line.lotLinkMode ||
    original.receiptHandling !== line.receiptHandling ||
    !sameMaterialSource(original.source, line.source)
  ) {
    identityLockedLineNos.push(line.lineNo);
  }
}
```

Build source comparison using explicit discriminated fields in production, so
object property insertion order cannot change equality. Include resolved source
location in equality; never normalize frozen TLC or URLs. A header change affects
all prior/new bound lot IDs; quantity/UOM changes affect the changed line's lots;
add/remove affects those lines. Return sorted unique lot IDs and ordered line
numbers. Rationale/evidence, notes, supplier reference and documents are outside
the material projection and thus documentary; identity/handling stays locked.

Implement `getBlockingReceivingConsumerIds` as a pure filter: documentary returns
none; material/void selects current finalized consumer facts for the exact root
whose lotIds intersect affectedLotIds, then returns sorted unique event IDs.
Test current versus superseded/void consumers, unrelated roots/lots and pinned
older revisions of the same root. These are explicit synthetic contract facts,
not persisted consumers. Completeness, transitive dependency collection and
downstream-first ordering must be supplied and proven by real US-04/05 writers
before they are enabled; sorting IDs here is not that correction order.

- [x] **Add retained-line readiness with an explicit branch, not fake active lots.**

Refactor only the existing lot-link checks so the new evaluator can apply a
validated retained binding. All product, source, quantity, document and coverage
checks remain. For a retained line, compare the exact bound lot identity and skip
only new-use status and new-create collision requirements. Do not mutate input,
invent an active status or suppress other findings. A line absent from the binding
set uses the current create/link rules. Fresh exempt review is still required.

```ts
const retained = context.retainedBindings.find((binding) => binding.lineNo === lineNo);
const isRetained = retained !== undefined && retained.lotId === row.lotId;
if (!isRetained && lot.status !== "active") issue("lot", "inactive");
```

This conditional replaces only the status decision in the existing validated lot
branch; `row`, `lot`, `lineNo` and `issue` are its existing local values. Tests must
show that a retained recalled lot can receive a documentary correction while its
status stays recalled, but a newly added recalled linked lot remains blocked.
Existing `assessReceivingReadiness` stays the default old path until Task 4.

- [x] **Run focused and full domain gates; record the review checkpoint.**

```sh
pnpm --filter @markiro/domain exec vitest run test/us-receiving-lifecycle.test.ts test/us-receiving-amendment.test.ts test/us-receiving-readiness.test.ts test/us-receiving-exemption.test.ts
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
git diff --check
```

No route, migration, active readiness version or UI is switched by Task 1. Suggested
scoped commit, only on a later explicit request: `feat(us): define receiving revision rules`.

Task 1 checkpoint (2026-09-07): 84 new domain tests; focused Receiving suite
123/123 and full domain 988/988 (50 files), no skips. Typecheck, lint, build,
diff check and local release-isolation checker passed. Review confirmed old
readiness defaults and all source/reference/coverage/QA checks remain; the
exemption helper received only an explicit retained-lot context for its existing
assignment check. No persistence, route, active version or UI was changed.

### Task 2: Versioned contracts and lossless history

**Files**

- Create `packages/platform-contracts/src/traceability/receiving-lifecycle.ts`, `receiving-live-records.ts`, `receiving-finalization-v3.ts`.
- Modify `packages/platform-contracts/src/index.ts` for new exports only initially.
- Create `packages/platform-contracts/test/us-receiving-lifecycle.test.ts`, `us-receiving-live-records.test.ts`, `us-receiving-finalization-v3.test.ts`.
- Read existing `receiving.ts`, `receiving-records.ts`, `receiving-finalization.ts`, `receiving-finalization-v1.ts`, `receiving-finalization-v2.ts`, `receiving-readiness.ts`; do not silently widen historical receipt parsers.

**Interfaces**

Produce schemas and their `z.infer` types using the exact paired names below:

| Schema                                  | Type / responsibility                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amendReceivingSchema`                  | `AmendReceivingInput`: commandVersion 2, operationKey, expectedLifecycleVersion, reason                                                                                                 |
| `voidReceivingSchema`                   | `VoidReceivingInput`: commandVersion 2, operationKey, expectedLifecycleVersion, nullable expectedDraftVersion, reason                                                                   |
| `receivingAmendmentDraftSchema`         | `ReceivingAmendmentDraft`: existing draft with required nullable previousLineNo on every line                                                                                           |
| `saveReceivingAmendmentSchema`          | `SaveReceivingAmendmentInput`: commandVersion 2, operationKey, expectedLifecycleVersion, expectedDraftVersion, draft                                                                    |
| `finalizeReceivingRevisionSchema`       | `FinalizeReceivingRevisionInput`: commandVersion 2, operationKey, expectedLifecycleVersion, expectedDraftVersion, nullable previousRevisionId, expectedInputDigest, reviewedExemptLines |
| `receivingLiveRecordSchema`             | `ReceivingLiveRecord`: recordVersion 2, common identity, lifecycle and draft/finalized content                                                                                          |
| `receivingOperationReceiptV2Schema`     | `ReceivingOperationReceiptV2`: receiptVersion 2, command, operationKey, inputDigest, eventId, record as committed                                                                       |
| `receivingCommandResultSchema`          | `ReceivingCommandResult`: new receipt or exact legacy draft/finalized result                                                                                                            |
| `receivingRevisionListSchema`           | `ReceivingRevisionList`: bounded live summaries, limit, offset, lifecycleVersion                                                                                                        |
| `receivingBasisSchema`                  | `ReceivingBasis`: lotId, basisVersion, state, supportCount, items, limit, offset, hasMore                                                                                               |
| `receivingFinalizationSnapshotV3Schema` | `ReceivingFinalizationSnapshotV3`: frozen v3, explicit per-line lotBinding                                                                                                              |

All objects are strict. UUIDs/versions/reasons use existing validation conventions;
nullable means explicit null, not an omitted key, except unchanged legacy inputs.
For void: draft targets require the expected draft version; finalized targets
require null, checked again against actual state. All new version fields fit the
positive PostgreSQL int range. List limit defaults to 50/max 100; offset max 100,000.

- [x] **Write a failing strict-command test and implement its schema.**

```ts
import { expect, it } from "vitest";
import { amendReceivingSchema } from "../src/index.js";

it("requires an exact version and reason without accepting actor claims", () => {
  const input = {
    commandVersion: 2,
    operationKey: "b0000000-0000-4000-8000-000000000001",
    expectedLifecycleVersion: 2,
    reason: "  Quantity corrected after recount  ",
  };
  expect(amendReceivingSchema.parse(input).reason).toBe("Quantity corrected after recount");
  expect(amendReceivingSchema.safeParse({ ...input, actorId: "qa" }).success).toBe(false);
  expect(amendReceivingSchema.safeParse({ ...input, reason: " " }).success).toBe(false);
});
```

Run `pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-lifecycle.test.ts`;
record RED, then implement:

```ts
const version = z.number().int().min(1).max(2147483647);
const reason = z
  .string()
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value))
  .trim()
  .min(1)
  .max(2000);
export const amendReceivingSchema = z
  .object({
    commandVersion: z.literal(2),
    operationKey: platformUuidSchema,
    expectedLifecycleVersion: version,
    reason,
  })
  .strict();
export type AmendReceivingInput = z.infer<typeof amendReceivingSchema>;
```

Define every other command from the table, with required fields shown there.
Ordinary create/save input remains strict and cannot accept `previousLineNo`.
Amendment items retain ordinary fields plus `previousLineNo`; server-side binding
verification is mandatory even when the shape parses.

- [x] **Define current lifecycle separately from saved content.**

Use existing validated identity/actor/time fields. `ReceivingLiveRecord` has
`recordVersion`, `id`, `eventNumber`, `revision`, `draftVersion`, `timeZone`,
`createdAt/By`, `updatedAt/By`, `status`, `lifecycle` and `content`.
`lifecycle` has rootId, lifecycleVersion, previousRevisionId, supersededByEventId,
currentEventId, pendingDraftId, amendmentReason, supersededAt/By, voidedAt/By and
voidReason. Every absent lifecycle pointer/actor/time/reason is null.

```ts
type ReceivingContent =
  | { kind: "draft"; draft: ReceivingDraft | ReceivingAmendmentDraft }
  | {
      kind: "finalized";
      finalizedAt: string;
      finalizedBy: string;
      snapshot: ReceivingFinalizationSnapshot | ReceivingFinalizationSnapshotV3;
    };
```

This type is inferred from strict schema branches in `receiving-live-records.ts`.
`ReceivingDraft` and the legacy snapshot type already exist; the new types come
from this task. Draft and finalized content discriminate by `kind`, independently
of current `status`. Validate status/content/lifecycle combinations: amended has
a successor and finalized content; void has reason/actor/time and may have draft
or finalized content; finalized has no successor and matches the current pointer.
Historical finalized content preserves `updatedAt/By == finalizedAt/By`; do not
stamp the void actor into those fields. Revisions >1 require reason and predecessor.

`ReceivingRevisionList.items` contains common live identity/lifecycle fields plus
dateReceived, locationId, previousSourceLocationId, lineCount and documentCount,
not full content. Basis entries contain rootId, eventId, eventNumber, revision and
unique ordered lineNos. `supportCount` counts distinct revisions; state is missing
iff count is zero, regardless of offset; hasMore agrees with count/offset/page.

- [x] **Write immutable v3 tests, then build v3 without editing v1/v2.**

Use the existing v2 contract specimen as a new local v3 test fixture, preserving
the original v2 test. Add `lotBinding` to every frozen item:

```ts
const lotBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created") }).strict(),
  z.object({ kind: z.literal("linked") }).strict(),
  z
    .object({
      kind: z.literal("retained"),
      previousEventId: z.uuid(),
      previousLineNo: z.number().int().min(1).max(100),
    })
    .strict(),
]);
```

V3 keeps v2's receiptBasis and original lotLinkMode, adds the binding and uses
`snapshotVersion: 3` and `confirmation.ruleVersion: receiving-readiness-v4`.
Validate unchanged fields using an in-memory v2 projection that removes only
lotBinding and resets the version/rule literals. Return the original v3 object,
never the projection. Validate created/link mode agreement and unique retained
predecessor line references independently. The live envelope verifies all retained
previousEventIds equal its previousRevisionId, reviewer/time match its finalizer,
and original revisions have no retained bindings. SQL/server verifies real lot
and predecessor identity; a schema alone cannot establish ownership.

Test retained own assignment without a new-insertion assumption, null received
TLC, exact source reference/resolved location, reordered lines, fresh QA review,
wrong predecessor, duplicate bindings, unknown keys and malformed Unicode. Verify
v1/v2 parse results deep-equal their input and reject v3-only fields. The frozen
contract has no lot business-revision field; proof against an actual lot whose
revision increased belongs to the real database tests in Tasks 3–4.

- [x] **Define versioned receipts and prove historical compatibility.**

`command` is one of `receiving.create`, `receiving.save`, `receiving.finalize`,
`receiving.amend`, `receiving.void`; `eventId` equals `record.id`. A v2 receipt's
record is a snapshot of the acknowledgement, not live after later transitions.
The command-result union uses the unchanged legacy record schemas alongside v2.
Do not add lifecycle fields to a legacy receipt or derive it from a new live read.
Tests reject mismatched IDs and accept old successful results unchanged even when
the current live record supplied separately is amended or void.

- [x] **Run contract gates and review without activating public consumers.**

```sh
pnpm --filter @markiro/platform-contracts exec vitest run test/us-receiving-lifecycle.test.ts test/us-receiving-live-records.test.ts test/us-receiving-finalization-v3.test.ts test/us-receiving-finalization.test.ts test/us-receiving-finalization-v2.test.ts
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/platform-contracts build
git diff --check
```

Suggested later commit: `feat(us): add versioned receiving lifecycle contracts`.

Task 2 checkpoint (2026-09-07): 98 new contract tests; focused Receiving suite
143/143 and full contracts 567/567 (28 files), no skips. Typecheck, lint and build
passed. Existing version-pinned readers and historical test specimens remain
unchanged. A separate shared test fixture copies the old specimen for v3/live
tests. The new `receivingRevisionListQuerySchema` and `receivingBasisQuerySchema`
reuse bounded canonical pagination (50 by default, 100 maximum, offset 100,000).
Review added a failing-then-passing no-reopening test for a voided effective
receipt; cancelled amendment drafts still allow the predecessor to remain current.
The actual migrated-lot revision, audit and concurrency assertions remain in
Tasks 3–4. No current HTTP response, snapshot writer or browser consumer switched.

### Task 3: Additive storage and compatibility bridge

**Execution split — 2026-09-07**

Task 3 is complete as an additive storage/compatibility task. Its support-token,
original-root and full-chain slices preserve the intermediate database/server contract:

- [x] Generate `0124_us_receiving_basis_version` and its metadata; add the
      positive internal integer/default without rewriting existing lot fields.
- [x] Add the tenant-scoped, UUID-normalized, deduplicated/sorted tuple update
      helper in `us-receiving-roots.ts`; missing lots and exhaustion fail closed.
- [x] Coordinate the current original finalizer with every affected lot in its
      transaction, retaining v2 snapshots, operation digests/results and audits.
- [x] Keep readiness v3's lot/conflict projections pinned to pre-token fields.
      The later readiness v4 must explicitly include the token when evaluating
      current receipt support; do not copy this compatibility exclusion into v4.
- [x] Verify legacy-lot byte preservation, replay, rollback, tenant denial,
      recalled-lot field preservation, MVCC invalidation and independent-receipt races.
- [x] Generate `0125_us_receiving_roots`: permanent original root, mandatory event
      root ID, tenant/root composite deferred pointers, number/revision uniqueness
      and lossless legacy backfill. Restore the old header function exactly.
- [x] Bridge original create/save/finalize with atomic root allocation, root-first
      locks and finalization pointer/version updates; preserve public responses.
- [x] Deny persisted event/root deletion and original identity/provenance changes;
      validate committed revision-1 pointer and counter agreement.
- [x] Complete chain metadata, predecessor bindings, partial status indexes,
      amendment/void transition guards and relational frozen-v3 validation in
      generated migration0126. Migrations 0124/0125 remain unchanged.

The helper now allocates/locks roots and finalizes original root pointers in
addition to `bumpReceivingBasisVersions`. Migration 0125 deliberately retained the
revision-1-only lifecycle check. Migration0126 replaces that intermediate validator
with complete chain guards and does not rewrite historical rows. Allocating an
amendment inserts the next revision while holding the root lock, then advances the
root pointer/counter in that same transaction. Finalization supersedes the predecessor
before freezing its successor; deferred constraints validate the final chain.
No lifecycle endpoint or new public response is enabled. A pure internal token test is not
acceptance evidence for a future Transformation/Shipping consumer.

**Verified support-token checkpoint — 2026-09-07**

- DB package: 411 passed, 141 explicitly skipped (57 passed / 27 skipped files).
  Shared `DATABASE_URL` is deliberately absent; US migration tests use owned,
  randomly named local databases, including the upgrade from journal tag 0123.
- Final Receiving CI list: 12 files, 280 passed, no skips. This includes actual
  HTTP, frozen snapshot guards, legacy receipts, exemption handling and races.
- DB and API typecheck/lint/build passed. Repository formatting and diff checks
  passed; the check-only workflow now includes both new regression suites.
  Isolation checker and its 12 tests passed locally; no remote CI run is implied.
- The broad API run was attempted, not green: 2,048 passed / 1,411 skipped,
  eight unrelated primary-product environment-dependent files failed setup,
  and one old Receiving assertion expected the new internal field to stay one.
  The latter now compares every business field exactly and requires a one-step
  token increment; the final 280-test Receiving repeat passed after this change.
  The broad suite was not repeated or supplied primary-product credentials.
- Generated metadata differs only in snapshot lineage plus the lot column and
  positive check. No applied migration, legacy snapshot shape or writer changed.
  The primary checkout retains its original branch, HEAD and four untracked
  paths. No browser UI, hardware, hosted environment, push or release was exercised.

**Verified original-root checkpoint — 2026-09-07**

- New schema/backfill RED: six failures on the absent column/table/constraints;
  the existing 108 cases passed. Original create/finalize RED: two failures on
  missing roots. The final focused DB repeat passes all 114 cases.
- Full DB package: 417 passed / 141 explicitly skipped across 58 passed and
  27 skipped files. The absent primary `DATABASE_URL` explains those skips;
  the US migration suites ran against owned disposable PostgreSQL databases.
- Final Receiving CI list: 13 files, 286 passed, no skips. The new root suite
  covers exact replay/no-op save, full audit-failure rollback, foreign/missing
  IDs and real root-before-event lock barriers for save and finalize.
- Snapshot tests now perform raw header/pointer transitions in one transaction.
  The pagination fixture fixes the creation clock instead of rewriting immutable
  provenance. Existing historical assertions and negative cases remain intact.
- DB/API typecheck, lint and build pass; repository formatting and diff checks
  pass. The local release-lock checker and all 12 isolation contracts pass.
- Backfill compares complete legacy event/child/operation bytes, v1/v2 snapshots,
  advanced lot tokens and version-pinned function definitions before/after.
  Generated metadata changes only roots/events and snapshot lineage.
- This checkpoint is root-only storage, not acceptance of chain transitions,
  retained bindings, v3 relational guards, lifecycle endpoints or UI. The original
  guard deliberately keeps those closed for the next Task 3 slice.
- Primary checkout state is unchanged. No base database migration, hosted/browser
  acceptance, commit, push or release was performed. The full primary API suite
  was not rerun; its environment limitations at the earlier checkpoint still apply.

**Verified full-chain storage checkpoint — 2026-09-07**

- Migration0126 adds nullable lifecycle metadata, immediate-predecessor line
  bindings, tenant/root revision FKs and single-current/single-pending indexes.
  Deferred chain checks validate reciprocal links, root pointers and exact
  allocation/lifecycle counters. Cancelled draft numbers are never reused;
  voiding the latest revision never restores an amended predecessor.
- Raw PostgreSQL tests prove frozen header/child immutability, retained identity,
  review actor/time, ordinary/own-assigned/v1 predecessors, non-active retained
  lots and active-but-advanced own assignments. Unbound v3 created/linked/assigned
  paths and original v3 finalization retain the original new-use checks.
- Complete legacy headers, items, document links, operations, roots and lot bytes
  match before/after migration. V1/v2 validation function definitions are unchanged.
  A deliberate duplicate-function failure late in migration0126 rolls the entire
  migration back; removing only that synthetic collision permits a clean retry.
- Review found a narrow inconsistency in the already-prepared rules/contracts:
  retained own assignment must keep its original physical source even when the
  receiving header location is corrected. Focused RED/GREEN tests corrected the
  domain and v3 projection only; new assignment and v1/v2 rules remain unchanged.
- Final full domain: 989/989; full contracts: 567/567; full DB: 468 passed,
  141 explicitly skipped (59 passed / 27 skipped files). The shared primary
  `DATABASE_URL` is absent; every US migration test uses its owned disposable DB.
  The final Receiving API list passes 286/286 across 13 files, with no skips.
  Domain/contracts/DB/API typecheck, lint and build pass.
- Repository formatting, diff checks, local release-lock checker and all 12
  isolation contracts pass. These are local checks, not a remote CI run.
- The deliberate-corruption API fixture disables the new identity guard only in
  its owned database and restores it in `finally`; its fail-closed read assertion
  remains intact. Check-only CI includes the new lifecycle DB and contract suites.
- Generated metadata changes only events, items, operation commands and snapshot
  lineage. No old migration, old frozen reader or current writer is rewritten.
  Review is inline, following the owner's selected execution mode, not an
  independent-agent review. Task 3 is complete; Task 4 remains unopened.
- This proves storage and original-API compatibility, not lifecycle authorization,
  dependency/basis enforcement, new public commands or connected UI. No browser,
  hosted, hardware or external-service acceptance is claimed. The broad primary
  API suite was not rerun because its earlier primary-environment gaps remain
  outside this isolated increment. Main checkout, base DB and release locks stay
  untouched; there was no commit, push or release.

**Files**

- Modify `packages/db/src/schema/traceability-receiving.ts` and `traceability-lots.ts`. Verify exports through the existing `packages/db/src/schema.ts` barrel; its wildcard receiving export already covers a new root table in that module.
- Generate the next migration under `packages/db/migrations/` and its generated metadata through Drizzle. Determine the exact next filename from the current journal; do not reserve or overwrite 0121–0123.
- Modify `packages/db/test/us-receiving-schema.test.ts` and `us-lot-schema.test.ts`.
- Create `packages/db/test/us-receiving-basis-version-migration.e2e.test.ts` for
  the first additive slice and `apps/api/test/us-receiving-basis-version.e2e.test.ts`
  for the internal helper and current-finalizer compatibility.
- Create `packages/db/test/us-receiving-roots-migration.e2e.test.ts` and
  `apps/api/test/us-receiving-roots.e2e.test.ts` for the original-root slice.
- Create `packages/db/test/us-receiving-lifecycle-migration.e2e.test.ts` and `packages/db/test/support/us-receiving-snapshot-fixture.ts`.
- Adapt receiving migration test setup to allocate roots; preserve the old v1/v2 content assertions and negative cases.
- Create `apps/api/src/modules/traceability/receiving/us-receiving-roots.ts`.
- Modify `us-receiving-store.ts` and `us-receiving-finalization.ts` only for original-revision root allocation/locking and support-version coordination. No lifecycle route or new response shape is activated here.
- Modify `us-receiving-reference-context.ts` to preserve the original readiness
  v3 digest inputs while adding the internal-only lot column.
- Extend `apps/api/test/us-receiving.e2e.test.ts` and `us-receiving-finalization-concurrency.e2e.test.ts` for the compatibility bridge.

**Interfaces**

DB exports `receivingEventRoots` and the new event/item/lot columns in the spec.
The existing transaction type is `UsMasterDataTransaction`, exported by
`master-data/us-master-data-support.ts`. New API helper signatures:

```ts
export type ReceivingRootRow = typeof schema.receivingEventRoots.$inferSelect;
export function createReceivingRoot(
  tx: UsMasterDataTransaction,
  input: { tenantId: string; eventId: string; eventNumber: string },
): Promise<void>;
export function lockReceivingRoot(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<ReceivingRootRow>;
export function bumpReceivingBasisVersions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotIds: readonly string[],
): Promise<void>;
```

`lockReceivingRoot` resolves a tenant-owned event then locks its root, not the
event first. It fails on missing/inconsistent roots. `bumpReceivingBasisVersions`
deduplicates/sorts and updates only the internal counter; it never edits status,
identity, source latch, business revision or lastStatusReason/lastSourceReason.
Version exhaustion aborts the whole transaction.

- [x] **Write failing schema and migration tests.**

```ts
const result = await fixture.pool.query<{ column_name: string }>(
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='traceability_events'",
);
expect(result.rows.map((row) => row.column_name)).toEqual(
  expect.arrayContaining([
    "root_event_id",
    "previous_revision_id",
    "superseded_by_event_id",
    "amendment_reason",
    "superseded_at",
    "superseded_by",
    "voided_at",
    "voided_by",
    "void_reason",
  ]),
);
```

Run the new DB test with `US_TEST_DATABASE_URL`; RED must be the missing new schema,
not a skipped fixture. Use the existing `createUsProfileTestDatabase(url, throughIndex)`
to test legacy upgrades. Resolve the immediate pre-slice index from `_journal.json`:
`0124_us_receiving_basis_version` for root backfill; `0125_us_receiving_roots`
for the subsequent chain migration. Seed one incomplete draft, frozen v1/v2 ordinary
receipts and v2 own assignment with saved operation results before applying the
new migration. Extract the existing raw specimen/transition setup from
`us-receiving-exemption-migration.e2e.test.ts` into the new support file for reuse;
do not regenerate legacy content using the new v3 writer.

- [x] **Generate and review storage, then implement the root/chain constraints.**

```sh
pnpm --filter @markiro/db db:generate
```

Inspect every generated statement and metadata diff. Keep the root in
`traceability-receiving.ts`, already in the Drizzle schema list. Add explicit
hand-reviewed deferrable composite FKs and constraint triggers to the newly
generated SQL where Drizzle cannot express them. The root relationship is:

```sql
UNIQUE (tenant_id, event_number)
-- receiving_event_roots stores id, tenant_id, event_number,
-- lifecycle_version, next_revision, current_event_id, pending_draft_id.

-- On traceability_events:
UNIQUE (tenant_id, root_event_id, revision)
UNIQUE (tenant_id, root_event_id, id)
FOREIGN KEY (tenant_id, root_event_id)
  REFERENCES receiving_event_roots(tenant_id, id)
  DEFERRABLE INITIALLY DEFERRED

-- On receiving_event_roots, for both current and pending pointers:
FOREIGN KEY (tenant_id, id, current_event_id)
  REFERENCES traceability_events(tenant_id, root_event_id, id)
  DEFERRABLE INITIALLY DEFERRED
```

Add partial unique indexes per tenant/root for `status='finalized'` and
`status='draft'`. Predecessor/successor FKs use tenant/root identity, not UUID alone.
A deferrable constraint trigger validates at commit: root/event numbers agree;
first revision has no predecessor; later revisions point backward within the root;
amended rows point forward to the revision whose predecessor is that exact row;
current/pending pointers select the unique matching status rows; void drafts do
not supersede a predecessor; void reasons/actors/times and finalization metadata
have the appropriate nullability; counters exceed allocated revisions. Lower
predecessor and higher successor revision checks prevent cycles without recursion.

Apply the backfill under the migration transaction's table locks, with a scoped
header-guard update allowing the new root metadata initialization but not frozen
payload mutation. Do not globally disable integrity triggers. Existing draft roots
start at lifecycleVersion 1, nextRevision 2, pending=id, current=null; finalized
roots start at version 2, nextRevision 2, current=id, pending=null. Migration 0124
initializes old lots with basisVersion 1, whether or not they have support; the
token is a change version, not a receipt count. The subsequent root migration
must preserve already-advanced counters, not reset them to one. Finalization
JSON, IDs, timestamps, operation JSON
and digests remain exactly as stored.

- [x] **Implement lifecycle-only header changes and frozen v3 validation.**

For an old finalized row, compare all columns except the explicit allowed lifecycle
fields before accepting amended/void. Keep root identity, content update metadata,
finalized actor/time and finalization_snapshot immutable. Terminal amended/void
rows cannot change. Reject deleting every persisted event; cancellation uses void.
Child guards reject INSERT/UPDATE/DELETE for non-draft parents, including moved
children; child-parent pulses and snapshot matching remain enforced.

```sql
IF (to_jsonb(NEW) - ARRAY[
      'status','superseded_by_event_id','superseded_at','superseded_by',
      'voided_at','voided_by','void_reason'
    ]) IS DISTINCT FROM
   (to_jsonb(OLD) - ARRAY[
      'status','superseded_by_event_id','superseded_at','superseded_by',
      'voided_at','voided_by','void_reason'
    ]) THEN
  RAISE EXCEPTION 'Frozen receiving content is immutable' USING ERRCODE='23514';
END IF;
```

This is the finalized-row branch, not a substitute for status/chain validation.
V1/v2 validation functions stay version-pinned. Add v3 shape and relational checks:
bound predecessor exists in the same root/tenant; unique line binding; exact old
lot/product/TLC/source/mode/handling; fresh review matches the new finalizer; newly
created/linked rows retain existing active/reference checks. Only a validated
retained binding removes the new-use status and own-assignment lot-revision-1
assumptions. Malformed URLs remain the existing server validation boundary.

During amendment finalization, update the predecessor to amended before setting
the successor finalized (to satisfy the partial unique index), with both pointers
validated at commit. No other transaction can observe that intermediate state.

- [x] **Bridge current create/save/finalize to the new schema, preserving responses.**

Allocate an event UUID before inserting its root and original draft. Both pointer
FKs are deferred until the transaction has inserted the complete record:

```ts
const eventId = randomUUID();
await createReceivingRoot(tx, { tenantId, eventId, eventNumber });
await tx.insert(schema.traceabilityEvents).values({
  ...receivingHeader(value.draft),
  id: eventId,
  rootEventId: eventId,
  tenantId,
  eventNumber,
  timeZone: profile.timeZone,
  createdBy: actorUserId,
  updatedBy: actorUserId,
  createdAt: now,
  updatedAt: now,
});
```

This replaces the current generated-ID insertion within `createDraft`; its existing
variables come from that method. Root allocation uses version 1/nextRevision 2 and
pending=eventId. Save acquires the root before the event; unchanged-save comparison
still changes neither draftVersion nor root version. Original finalization locks
root before its saved draft and sorted lots, then updates current/pending/version
with the frozen write, increments basis versions for every affected lot (not only
new lots), writes the existing audits and retains the old result/digest shape.
No amend/void route, snapshot v3 emission or live envelope switch occurs yet.

- [x] **Prove backfill, raw-SQL denial and old runtime compatibility.**

Capture `finalization_snapshot::text`, operation result JSON and digest before and
after migration and compare exactly. Also inspect real constraints and root rows.
Execute forbidden statements in their own rolled-back transactions; force deferred
checks with `SET CONSTRAINTS ALL IMMEDIATE`. Cover cross-tenant/cross-root pointers,
duplicate current/draft rows, reused revisions, invalid chains, frozen child
changes, content edits hidden in a void, direct finalized insertion and deletion.
Retained v3 fixtures cover recalled lots and own assignments whose business revision
increased; the unbound versions of those cases remain denied.

```sh
pnpm --filter @markiro/db build
pnpm --filter @markiro/db exec vitest run test/us-receiving-schema.test.ts test/us-receiving-lifecycle-migration.e2e.test.ts test/us-receiving-migration.e2e.test.ts test/us-receiving-finalization-migration.e2e.test.ts test/us-receiving-exemption-migration.e2e.test.ts
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/api exec vitest run test/us-receiving.e2e.test.ts test/us-receiving-readiness.e2e.test.ts test/us-receiving-finalization.e2e.test.ts test/us-receiving-finalization-concurrency.e2e.test.ts test/us-receiving-exemption.e2e.test.ts test/us-receiving-exemption-compatibility.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

All DB-backed lines require the explicit synthetic environment above. Task 3 is
not accepted if existing Receiving fails after the migration; do not defer that
breakage to Task 4. Suggested later commit: `feat(us): persist receiving revision roots`.

### Task 4: Atomic commands, live reads and provenance

#### Read foundation checkpoint — 2026-09-08

Task 4 is in progress. Its first slice adds internal, authorized `getLiveRecord`,
`listRevisions` and `getLotReceivingBasis` methods without replacing the existing
`getRecord`/list/command responses or connecting new HTTP routes. The interfaces
and unchecked steps below describe the complete Task 4 target, not current API
availability.

- [x] Exact revision detail separates current lifecycle from frozen v1/v2/v3
      content and never substitutes live reference labels. Bounded history includes
      abandoned drafts. Saved child projection is shared with the unchanged original
      reader, while amendment bindings are preserved in the new envelope.
- [x] Current basis validates the exact tenant-owned lot, counts distinct current
      finalized receipts independently of pagination, and returns the lot token,
      count and page from one repeatable-read snapshot. A page beyond the end does
      not change a present basis to missing. No lot status/source/identity is changed.
- [x] Root/pointer/counter/predecessor/binding/frozen-shape checks reject
      inconsistent related chains even for an empty requested page. Unsupported
      stored CTE types and orphaned lot references cannot become a valid empty basis.
- [x] Real PostgreSQL read/write schedules cover concurrent void, amendment and
      saved-draft replacement. Temporarily downgrading the three new transactions to
      read committed made all four consistency tests fail; repeatable read was
      restored and all passed. Readers write no business state, audit or receipt.

Fresh verification: 396/396 API tests across the exact 16 Receiving files in
check-only CI plus `us-product-profile.e2e.test.ts` and `us-lot.e2e.test.ts`, with
no skips (60.95 seconds). This includes 40 new read cases across basis, history
and read-concurrency suites. API typecheck, lint and build pass. The local
release-lock checker, 12/12 isolation contracts and scoped tool lint pass.
The three new API suites are required by the isolation contract and CI list.

Lifecycle writes in the new read tests are explicitly test-only raw storage
fixtures. The v1 read specimen is a rollback-only synthetic fixture, not evidence
of old command replay or a historical migration. Self-review was inline, not an
independent agent review. New command authorization/replay/audit, amendment save,
readiness v4, atomic v3 finalization, registry filters, HTTP/OpenAPI and UI remain
pending. Full primary API and browser/hardware/hosted checks were not run; the
primary environment was not loaded. No primary/base database migration, commit,
push, main merge or release is included.

#### Amend/void command checkpoint — 2026-09-08

Task 4 remains in progress. Internal `amend` and `void` methods now require
current QA capability/profile, strict versioned input and exact tenant-owned
target identity. They run authorized replay before current-state checks. The
shared operation lock/query is also used by the existing original commands;
their digest algorithms and saved result parsers remain unchanged.

Amendment creation locks the root and predecessor, allocates the next revision,
copies saved header/line/document inputs with immediate-predecessor bindings and
stamps the current actor/reason. It does not revalidate live labels, create lots,
change basis or inherit finalization approval. Only one pending draft is allowed;
abandoned revision numbers are never reused.

Void checks root/draft versions, refuses hidden cancellation of a pending draft,
preserves original content/finalizer and changes only lifecycle metadata. Effective
void locks distinct lot UUIDs in order and increments each basis token once. Lot
identity, status, source lock and business timestamps remain unchanged. Draft
cancellation leaves the predecessor's support intact. New commands fail closed on
unknown stored CTE types; there is no fake downstream-dependency adapter.

State changes, full before/after audit and strict v2 command receipt commit
together. Same-key changed targets/reasons/versions conflict. Successful replay
returns the original acknowledgement, including after later void/supersession;
the separate live reader shows current status. Corrupt receipt identity/payload
is unavailable. Serialization/deadlock retries reauthorize and stop after three
attempts; failure leaves no partial revision, lot change, audit or receipt.

Tests exercise real amend/void commands, both competing-key schedules, and both
orders of an effective void versus a second original receipt finalizing on the
same lot. Rollback is injected at audit and receipt writes; real PostgreSQL
error codes and a test-only sequence prove the retry cap. Legacy-format
create/save/finalize receipts retain exact stored bytes and digests after later
changes. The v1 case is explicitly a synthetic frozen specimen, not a historical
migration; v3 supersession in the compatibility test still uses a labelled raw
storage helper, not an implemented amendment-finalization command.

Fresh gates: 434/434 API tests across 21 files, no skips (74.35 seconds): all
19 Receiving API files now selected by check-only CI, plus product-profile and
lot store regressions. The three new lifecycle suites contribute 38 tests. API
typecheck, lint and build pass; the local isolation checker, 12/12 isolation
contracts and scoped tool lint pass. The added CI selection was verified RED
before the workflow update and GREEN afterward. No independent reviewer was used;
inline review followed the selected sequential execution mode. Full primary API
and shared package suites were not rerun in this API-only slice; the primary
environment remains deliberately absent and shared source was unchanged. No
browser/hardware/hosted or remote CI verification was performed.

Remaining: amendment-save authorization/replay and retained identity validation,
readiness v4 and atomic v3 finalization, original save/finalize-versus-void race
acceptance, registry filters, typed current HTTP errors/OpenAPI, endpoint/MFA
activation and connected browser recovery. The original active API/UI are not
switched by these internal methods. No release or public mutation is enabled.

#### Saved amendment checkpoint — 2026-09-08

Task 4 is still partial. The additive internal `saveAmendment` command now accepts
the strict v2 input and returns a durable v2 `receiving.save` receipt. Its eventual
integration into `saveDraft` remains part of the complete HTTP/response switch,
alongside readiness v4 and v3 finalization. No incomplete lifecycle flow is exposed
through the existing controller or browser.

The command reloads current QA/profile before replay, checks exact root/draft
versions and the active pending amendment, and validates unique bindings against
the immediate predecessor's immutable saved children. It derives retained lot
UUIDs from those children and returns ordered `lot_identity_locked` line/field
details for disagreement in lot, product, exact TLC, complete source tuple,
original link mode or receipt handling. Own assignments preserve null received
TLC, the exact proposal and original source even when the receipt location changes.
An earlier amendment's origin binding is not confused with its current line number.

Changed saves lock root/target/predecessor, sorted lots and then current reference
entities; only the saved draft version/actor/time/header/children change. Existing
lots, source latches, current receipt support and root lifecycle version stay
unchanged. Retained inactive lots are allowed, but an added unbound use of the same
lot still requires active status. Product/location/party/document existence and
activity are rechecked. Incomplete new lines and empty document links remain
saveable; completeness and fresh exemption approval are not inferred from a save.
Unchanged saves preserve content, timestamps, versions and audit and remember only
their acknowledgement, matching the existing no-op boundary.

Full before/after audit and the receipt commit with the draft replacement. Changed
same-key input conflicts; replay after cancellation returns the original saved
acknowledgement without reopening it. Invalid/corrupt storage fails closed, including
unsupported stored CTE kinds. Counter exhaustion leaves no partial writes.
Real lock queues cover same/different save keys and save-versus-cancel in both
orders. Audit/receipt failure injection proves rollback of header and children.

Fresh verification: 479/479 API tests across 23 files, no skips (82.52 seconds).
This is the exact 21 Receiving API suites now selected by check-only CI plus
product-profile and lot regressions. The two new save suites contribute 45 tests.
The initial 18 save cases failed on the missing command before implementation.
Two later test expectations were corrected to the existing contracts: quantity
precision is at most three fractional digits; an invalid configured profile returns
`503 traceability_profile_invalid`. Neither production rule was changed.
API typecheck, lint and build pass, as do the local release-lock checker, 12/12
isolation contracts and scoped tool lint. New CI selection was verified RED/GREEN.

Inline self-review followed the selected sequential mode; there was no independent
reviewer. The immediate-v3-predecessor test uses a labelled raw frozen storage
specimen, not an implemented amendment finalization command. No shared sources or
migrations changed in this slice; their full suites were not rerun. Full primary
API, new endpoint/MFA, browser, hosted and remote CI checks remain unexecuted; the
primary environment was not loaded. No commit, push, PR, merge or release.

Next: reuse the predecessor validation in the working draft/readiness-v4 context,
then implement atomic v3 finalization and its support-token/dependency/replay races.
The complete lifecycle error schemas, registry filters, original-command terminal
conflicts, current HTTP/OpenAPI integration and connected UI are still pending.

#### Internal revision readiness checkpoint — 2026-09-08

Task 4 remains partial. Additive `checkRevisionReadiness` returns the strict
`receiving-readiness-v4` contract with root, predecessor and current lifecycle
version. The existing HTTP readiness v3 and finalization v2 paths stay active and
unchanged; the new method is not connected to a controller or browser client.

- A working-draft projection validates original/amendment live records without
  reinterpreting saved text through transforming entry schemas. It reuses exact
  immediate-predecessor binding validation without locking business rows.
- Shared reference facts distinguish retained lines from new use. Retained
  inactive lots and original own-assignment sources remain valid, but current
  reference/coverage checks and a fresh exempt-review line set still apply.
  New unbound lines retain active-only and duplicate-identity checks.
- One authorized repeatable-read snapshot supplies saved inputs, predecessor,
  bindings, root pointers, references, lot rows, complete support counts and
  support tokens, including lots removed from the amendment. Check time is not
  part of the digest. A missing predecessor lot fails closed, rather than silently
  disappearing from the reference selection. Checks write no business or audit data.
- Unknown persisted CTE kinds fail closed even for a draft without lots. This is
  Receiving-only integrity, not an always-empty dependency adapter or acceptance
  of actual Transformation/Shipping dependency writers.
- Real PostgreSQL concurrency cases cover amendment replacement, cancellation and
  independent receipt finalization after snapshot acquisition. Writer `NOWAIT`
  probes verify that business rows remain unlocked throughout the read.

Fresh scoped API verification: 505/505 across 25 files, no skips, 90.08 seconds.
This includes all 23 Receiving suites selected by check-only CI plus product-profile
and lot regressions; 26 cases are new. Shared contracts: 583/583 across 29 files,
including 16 new strict readiness cases. API and contracts typecheck/lint/build,
local release-lock checker, 12/12 isolation tests and scoped tool lint pass.
Initial missing-method/schema tests and CI selection were verified RED/GREEN;
the missing removed-lot test also failed before its explicit integrity fix.
A generic-profile fixture was corrected to the existing unreviewed generic
contract; production coverage policy was not relaxed.

Review was inline and sequential under the owner's execution choice, not an
independent review. No domain/DB source or migration changes in this slice; their
full suites and the primary API environment were not rerun. No new endpoint/MFA,
browser, hosted or remote CI acceptance, base-DB migration, commit, push or release.

Next: atomic v3 finalization with ordered locks, material-effect/dependency checks,
retained UUID reuse, fresh QA confirmation, root/basis updates and durable replay.
Typed lifecycle errors, original-command terminal conflicts, registry/HTTP/OpenAPI
activation and Task 5 UI remain pending. The combined step below stays unchecked.

#### Internal revision finalization checkpoint — 2026-09-08

Task 4 remains partial. Additive `finalizeRevision` accepts only the strict v2
revision command and returns a durable v2 receipt with frozen v3 content, for both
original and amendment drafts. The controller still uses legacy readiness/finalize;
this internal command does not activate a mixed or incomplete browser contract.

- Current QA/profile authorization precedes replay. Exact successful retries return
  the historical receipt without reapplying state, including after supersession or
  void. Changed key payload/target conflicts and corrupt stored receipts fail closed.
- Root, target and predecessor locks precede sorted affected lots and reference
  locks. The same v4 projection supplies the read-only and locked readiness digest.
  Draft/root/predecessor checks, current validity and fresh exempt-review sets are
  rechecked before writes. Serialization/deadlock retries are capped at three.
- A shared content builder preserves the legacy v2 snapshot path; v3 adds explicit
  created/linked/retained bindings. Only unbound create lines allocate lots; retained
  UUIDs, assignment/source locks and business fields remain unchanged, including
  inactive lots and own-assigned sources after a receiving-header correction.
- The command atomically writes line links, predecessor supersession, successor
  finalization, root pointers, every affected support token, exact audit and receipt.
  Removed lots lose support without being deleted. Historical finalizer/content
  timestamps are preserved. Audit includes both predecessor states, exact old/new
  line-to-lot maps, immutable reason and deterministic material/documentary effects.
- Real DB cases cover current QA versus original author, full rollback after lot
  creation at audit/receipt failure, retry exhaustion, exhausted support tokens,
  cross-tenant/malformed input and changed references. Nine races cover same/different
  finalization keys, save/cancellation in both orders, independent legacy receipts
  sharing a lot, and a snapshot-consistent basis read during actual finalization.

Fresh scoped API: 546/546 across 27 files, no skips, 108.26 seconds. This includes
all 25 Receiving API suites selected by check-only CI plus product-profile and lot
regressions; 32 ordinary/failure cases and nine races are new. API typecheck, lint
and build, the release-lock checker, 12/12 isolation tests and scoped tool lint pass.
Initial 20 cases failed on the missing method before implementation. Two later
test-only expectations were corrected: the exempt seed has two lines, and audit
selection must scope tenant/target/action rather than a reused synthetic request ID.
CI inclusion was verified RED/GREEN. No production rule was relaxed.

Review was inline and sequential, not independent. No shared-package source or DB
migration changed; those full suites were not rerun. No primary API environment,
new endpoint/MFA/browser, hosted or remote CI acceptance. Actual US-04/05 dependency
writers remain absent; unsupported stored kinds fail closed through the shared
context, without an always-empty adapter. No base-DB migration, commit or push.

Next: complete lifecycle error/result contracts, original-command terminal/replay
compatibility and registry filters, then coordinated HTTP/OpenAPI integration and
Task 5 UI. Legacy-input activation of v3 remains part of that coordinated switch;
the existing v3-readiness/v2-finalization HTTP path is intentionally unchanged.

#### Internal live registry checkpoint — 2026-09-08

Task 4 remains partial. Additive `listLiveRecords` returns strict versioned
summaries in the existing items/limit/offset envelope. The current controller,
legacy `listRecords` and browser transport have not switched.

- Current READ authorization precedes query validation. Canonical bounded
  pagination, literal case-insensitive number search, current/all history and the
  four statuses are strict. A status filter never silently expands history.
- Current history selects the current finalized revision and pending draft.
  A terminal root selects its last voided effective receipt, or its never-finalized
  void original draft. Later abandoned amendment drafts remain in all history only.
- Summary rows, ordered child counts and root lifecycle data share one repeatable-
  read snapshot. Selection precedes pagination; ordering remains createdAt/ID
  descending. No live master labels or frozen payloads are transferred in summaries.
- Complete matching-root integrity checks precede status and pagination. A root
  is checked when either its number or a revision number matches; divergent stored
  numbers cannot bypass validation through search. Foreign tenant roots are excluded.
- Schemas reject duplicate IDs, inconsistent same-root number/timezone/pointers/
  versions, oversized pages, unknown keys and non-summary content. Existing
  version-pinned history/detail parsers and command results are unchanged.
- Coverage adds 39 contract cases, 27 real DB cases and seven concurrent read
  cases. Concurrency uses real amendment/finalize/void/save commands after the
  reader's actual PostgreSQL snapshot, without replacing SQL results. Corruption
  specimens and temporary constraint changes are rolled back in their owned DB.

Contract/API tests failed on absent exports/module before implementation. A later
search corruption case reproduced an incorrectly successful result and drove the
matching-revision integrity scope fix. Two fixture-only setup corrections retained
the real number format and accounted for CHECK constraints remaining active under
replica mode. No persisted constraint, migration or product rule was relaxed.
CI inclusion was verified RED/GREEN under the existing check-only job and locks.

Fresh verification: 580/580 scoped API tests across 28 files, no skips, 109.87
seconds; 622/622 full contract tests across 30 files. API and contract typechecks,
lint and builds pass, as do the local release checker, 12/12 isolation tests and
scoped tool lint. The focused registry/concurrent-read repeat passed 38/38.
No domain/DB source or migration changed in this checkpoint, so their full suites
were not rerun. The broad primary API environment was not loaded; the US fixture
created and removed only its own disposable local databases, not the base database.

Review is inline/sequential, not independent. This slice is server-internal,
not HTTP/OpenAPI/MFA or connected browser acceptance. Next: complete lifecycle
error/result contracts and original-command terminal/replay compatibility, then
the coordinated HTTP/OpenAPI switch and Task 5. No staging, commit, push or release.

**Files**

- Create API modules `us-receiving-lifecycle.ts`, `us-receiving-history.ts`, `us-receiving-basis.ts`, `us-receiving-chain.ts`, `us-receiving-operations.ts` under `apps/api/src/modules/traceability/receiving/`.
- Add internal amendment modules `us-receiving-amendment.ts`, `us-receiving-amendment-references.ts` and `us-receiving-amendment-save.ts` in that folder.
- Add `us-receiving-working-draft.ts`, `us-receiving-revision-readiness.ts` and the strict `receiving-revision-readiness.ts` contract, with focused contract/API and concurrency suites.
- Add internal `us-receiving-revision-finalization.ts` with focused finalization/failure and real concurrency suites; reuse snapshot content builders without switching legacy responses.
- Add internal `us-receiving-registry.ts`, shared query/summary list contracts,
  `us-receiving-registry` contract/API suites and live-registry snapshot cases in
  `us-receiving-read-concurrency.e2e.test.ts`.
- Modify that folder's `us-receiving-store.ts`, `us-receiving-persistence.ts`, `us-receiving-reference-context.ts`, `us-receiving-readiness.ts`, `us-receiving-snapshots.ts`, `us-receiving-finalization.ts` and `us-receiving-finalization-command.ts`.
- Modify `apps/api/src/deployment/us-receiving.controller.ts` and `us-lot.controller.ts`; retain the existing `UsRuntime.receiving` store instance.
- Extend the new contract modules from Task 2 with active revision readiness and typed lifecycle errors; export them in `packages/platform-contracts/src/index.ts`.
- Create API tests `us-receiving-lifecycle.e2e.test.ts`, `us-receiving-lifecycle-concurrency.e2e.test.ts`, `us-receiving-lifecycle-compatibility.e2e.test.ts`, `us-receiving-basis.e2e.test.ts`, `us-receiving-history.e2e.test.ts`, `us-receiving-read-concurrency.e2e.test.ts` and the test-only `support/us-receiving-lifecycle-storage.ts` fixture.
- Add `us-receiving-amendment-save.e2e.test.ts` and `us-receiving-amendment-save-concurrency.e2e.test.ts` for the isolated saved-amendment checkpoint.
- Extend `apps/api/test/us-receiving-http.e2e.test.ts`, `support/us-receiving-fixture.ts` and existing receiving regression fixtures for new active results without replacing legacy fixtures.
- Add focused test invocations to `.github/workflows/us-development.yml`, preserving its check-only permissions and all operational locks.

**Interfaces**

Keep public store arguments in their existing order. New/updated methods are:

```ts
amend(tenantId: string, actorUserId: string, id: unknown, input: unknown,
  requestId: string): Promise<ReceivingOperationReceiptV2>;
void(tenantId: string, actorUserId: string, id: unknown, input: unknown,
  requestId: string): Promise<ReceivingOperationReceiptV2>;
getRecord(tenantId: string, actorUserId: string, id: unknown): Promise<ReceivingLiveRecord>;
listRevisions(tenantId: string, actorUserId: string, id: unknown,
  query: unknown): Promise<ReceivingRevisionList>;
getLotReceivingBasis(tenantId: string, actorUserId: string, lotId: unknown,
  query: unknown): Promise<ReceivingBasis>;
```

Create/save/finalize now return `ReceivingCommandResult`: new operations create v2
receipts, old successful operations replay exact legacy results. `saveDraft`
accepts the strict legacy ordinary command or the v2 amendment command; finalize
accepts the legacy original-revision command or the explicit v2 revision command.
Legacy input cannot authorize an amendment. A new original-revision finalization
also writes snapshot v3, even when its input uses the supported original shape.

`receivingRevisionReadinessSchema` / `ReceivingRevisionReadiness` extends the
existing readiness fields with `ruleVersion: receiving-readiness-v4`, rootId,
expectedLifecycleVersion and nullable previousRevisionId. Keep the old readiness
schema available for old tests/read-only fixtures; switch the current controller
to the new schema. Both original and amendment checks return the new result.

`receivingLifecycleErrorSchema` defines strict 409 variants: existing draft,
operation, readiness and lot conflicts; `receiving_lifecycle_conflict` with current
root/pointer/version data; `receiving_pending_amendment` with pendingDraftId;
`lot_identity_locked` with ordered line/field entries;
`receiving_downstream_dependencies` with ordered blocking records, correctionOrder
and hasMore. `event_incomplete` retains the existing issue-panel contract.
No not-found/conflict response discloses other-tenant records.

- [ ] **Write a failing store test for the complete root transition.**

Use existing `createUsProfileTestDatabase` and `seedCompleteReceiving`; define
`fixture`, `store` and `c` in the same beforeAll/beforeEach pattern as the existing
finalization test. The following is the test body:

```ts
const created = await store.createDraft(
  c.tenant,
  c.actor,
  { operationKey: randomUUID(), draft: c.draft },
  "create",
);
expect("receiptVersion" in created).toBe(true);
if (!("receiptVersion" in created)) throw new Error("Expected a new receipt");
const id = created.eventId;
const readiness = await store.checkReadiness(c.tenant, c.actor, id, { expectedDraftVersion: 1 });
await store.finalize(
  c.tenant,
  c.actor,
  id,
  {
    operationKey: randomUUID(),
    expectedDraftVersion: 1,
    expectedInputDigest: readiness.inputDigest,
  },
  "finalize",
);
const original = await store.getRecord(c.tenant, c.actor, id);
const command = {
  commandVersion: 2,
  operationKey: randomUUID(),
  expectedLifecycleVersion: original.lifecycle.lifecycleVersion,
  reason: "Quantity corrected after recount",
};
const amendment = await store.amend(c.tenant, c.actor, id, command, "amend");
expect(amendment.record).toMatchObject({
  eventNumber: original.eventNumber,
  revision: 2,
  status: "draft",
  lifecycle: { previousRevisionId: id, currentEventId: id, pendingDraftId: amendment.eventId },
});
expect((await store.getRecord(c.tenant, c.actor, id)).status).toBe("finalized");
expect(await store.amend(c.tenant, c.actor, id, command, "retry")).toEqual(amendment);
```

Run `pnpm --filter @markiro/api exec vitest run test/us-receiving-lifecycle.e2e.test.ts`
with the owned DB opt-in. Capture RED before implementation. Extend the same
fixture with successful amendment finalization and cancellation, then exact lot
UUID/count/source-latch assertions and complete audit payloads.

- [ ] **Implement authorized replay and root-level command execution.**

Move shared operation locking/parsing into `us-receiving-operations.ts`. A new
command's digest uses explicit `commandVersion: 2`, command name, target ID and
strict parsed input. The old create/save digest and
`receivingFinalizationCommandDigest` branch remain unchanged for legacy keys.
Do not try a new digest first and overwrite an old operation on mismatch.

```ts
const inputDigest = createHash("sha256")
  .update(
    JSON.stringify({
      commandVersion: 2,
      command,
      eventId,
      input: value,
    }),
  )
  .digest("hex");
```

Here `command` is the validated command kind, `eventId` the parsed target and
`value` its strict input. Authorization precedes successful replay. Amendment-save
replay requires QA even after the saved draft became historical. Check operation
key/digest/correlated target; return saved result without reapplying state, checking
today's live references or adding audit. Corrupt stored results return sanitized
503, never an empty success. Failed operations do not reserve successful receipts.

For a new amendment, lock root then predecessor, verify current version and no
pending draft, allocate root.nextRevision, copy saved input/document children with
bindings, stamp its immutable reason/current actor/time, set pending pointer and
increment root lifecycleVersion/nextRevision. Preserve event number/timezone. No
lot or source lock changes on amendment creation. New reason/key against a pending
draft conflicts; exact retry returns its existing receipt.

Use the existing three-attempt serialization/deadlock retry policy for these
transactions. All roots are acquired before events/lots; lots sort by UUID;
reference locks retain the existing product/profile/party/location/document order.

- [ ] **Implement current support reads and basis-token coordination.**

Use a complete tenant-scoped query, grouping by current event rather than line:

```sql
SELECT e.root_event_id, e.id AS event_id, e.event_number, e.revision,
       array_agg(i.line_no ORDER BY i.line_no) AS line_nos
FROM receiving_event_items i
JOIN traceability_events e ON e.tenant_id=i.tenant_id AND e.id=i.event_id
WHERE i.tenant_id=$1 AND i.lot_id=$2
  AND e.type='receiving' AND e.status='finalized'
  AND e.superseded_by_event_id IS NULL
GROUP BY e.root_event_id,e.id,e.event_number,e.revision
ORDER BY e.root_event_id,e.id
LIMIT $3 OFFSET $4;
```

Count distinct matching event IDs without LIMIT/OFFSET in the same repeatable-read
transaction as the lot token and page. Validate the exact requested lot before
querying; an absent/foreign lot is not a valid zero-support response. Check root
pointer agreement and unsupported stored kinds before treating input as complete.
No independent Receiving becomes a consuming dependency. Historical creation
remains the original unbound create line; retained `create_on_finalize` rows must
not be mistaken for new lot creation.

For mutations, lock all prior/candidate lot IDs then update their basis tokens
when support changes, even if support count stays the same across revisions.
Count/pointer reads occur after those locks within the retryable transaction;
a tuple updated after its repeatable-read snapshot forces a retry. A lock-only
protocol is not acceptable. Retain the original source lock and business revision.

Tests cover manual lots with no basis; two receipts supporting one lot; deleting
neither lot on either void; removing the last matching line; duplicate lines in
one receipt counting once; offset beyond the page retaining `state=present`;
new receipt after void; all columns unchanged except the internal token.

- [ ] **Extend saved amendment validation, readiness and v3 finalization together.**

Add an internal working-draft projection for original/amendment records; do not
force revision 2 through the legacy revision-1 parser. Validate predecessor
bindings against immutable saved children, derive lot ID/original mode and reject
client disagreement. Saved amendment changes require QA and current root/draft
versions. Unchanged saves keep the existing no-op behavior and do not increment
either version or emit another saved audit. Reasons and identities are not editable.

The readiness digest includes saved draft, immutable predecessor and bindings,
root pointer/version, current lot rows/basis tokens, complete registered dependency
facts, profile and current reference content. A GET remains mutation-free. A stale
root may change the digest even when draftVersion did not change.

Use Task 1's retained-line evaluator and Task 2's new readiness/snapshot schemas.
Freeze v3 with explicit lotBinding; issue fresh exemption review for every current
exempt line. Before finalization, recheck versions/digest, binding identity and
material effects. New unbound create lines allocate lots; retained lines reuse
their exact predecessor UUIDs and do not reassign TLC or write a create audit.
Apply predecessor→amended, successor→finalized, root pointer change, basis tokens,
audit and receipt within the one transaction. Rollback leaves the original current
and the draft unchanged, with no partially created lot.

For registered downstream facts, Task 1's `getBlockingReceivingConsumerIds` blocks
material changes/voids when a current finalized consumer depends on the affected receipt. Documentary changes preserve
the consumer's pinned old revision. A bounded error response never weakens the
complete internal check. Current storage implements Receiving only: reject unknown
stored CTE kinds and retain a clearly labelled contract test with synthetic
consumer facts. Do not install an always-empty adapter or claim real US-04/05
dependency coverage. Their actual dependency writer and downstream-first ordering
remain mandatory acceptance before those CTEs are enabled.

- [ ] **Implement void, exact history and filtered registry reads.**

Void authorizes QA, replays first, locks root/target/affected lots, checks root and
draft versions and rejects a current revision with a pending draft. Preserve draft
content or original finalization content; stamp only void lifecycle metadata,
remove the corresponding root pointer, increment root version and basis tokens
when a finalized receipt loses support. Voiding an amendment draft leaves current
support untouched. No lot status/source audit is fabricated. Amended/void targets
reject new command keys as lifecycle conflicts.

Read exact UUID revisions with frozen content and current lifecycle. History
includes abandoned drafts, ordered by revision, with bounded pages. Registry
`history=current|all` and status filtering follow spec section 9 exactly; retain
literal bounded number search and createdAt/ID ordering. Read paths write no audit
or receipt. Source labels in old snapshots never come from live joins.

- [ ] **Wire HTTP/OpenAPI and verify body/role/tenant boundaries.**

Use `UsReceivingController` for amend/void/revisions and current read/list schemas;
use the existing singular `UsLotController` for receiving-basis, calling
`runtime.receiving.getLotReceivingBasis`. Keep US session/MFA/current membership
checks, cache/host/origin requirements and no outbound clients. Lifecycle command
bodies stay 16 KiB; full draft replacement stays 256 KiB/max 100 lines/documents.
Amend returns HTTP 201 for its created draft receipt, including an exact successful
replay; finalize and void return 200. Pin these statuses in OpenAPI and HTTP tests.
Readiness adds no new query fields: expected root/predecessor values are returned
and bound into its digest; clients submit them at finalization. Reject unknown,
duplicated and noncanonical list/history/basis query keys. API documentation must
describe historical replay versus fresh GET, not promise an effective replay.

- [ ] **Exercise races and failure injection with real transactions.**

Use explicit deferred promises and database transaction barriers, not arbitrary
sleeps. Run both schedules for: two amend keys; save versus void; finalize versus
void; two finalizations; ordinary second-receipt finalization versus first-receipt
void; amendment support replacement versus basis read; source correction versus
first finalization. Assert one accepted effect or typed conflict/retry, exact root
and lot tokens, no duplicate lots and exact audit rows. Inject failure before
receipt/audit commit and prove every prior write rolled back.

Replay old create/save/finalize after amendment and after void using specimens
written under the old migration/digest. Stored receipt JSON must deep-equal its
original result; a separate GET must show the actual later lifecycle. Test QA
revocation before replay, unrelated tenant IDs and malformed storage separately.

- [ ] **Run server gates and update check-only CI.**

```sh
pnpm --filter @markiro/domain build
pnpm --filter @markiro/platform-contracts build
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/us-receiving-lifecycle.e2e.test.ts test/us-receiving-lifecycle-concurrency.e2e.test.ts test/us-receiving-lifecycle-compatibility.e2e.test.ts test/us-receiving-basis.e2e.test.ts test/us-receiving-http.e2e.test.ts test/us-receiving.e2e.test.ts test/us-receiving-readiness.e2e.test.ts test/us-receiving-finalization.e2e.test.ts test/us-receiving-finalization-concurrency.e2e.test.ts test/us-receiving-finalization-child-concurrency.e2e.test.ts test/us-receiving-finalization-snapshot-guards.e2e.test.ts test/us-receiving-finalization-url-boundary.e2e.test.ts test/us-receiving-exemption.e2e.test.ts test/us-receiving-exemption-concurrency.e2e.test.ts test/us-receiving-exemption-compatibility.e2e.test.ts test/us-product-profile.e2e.test.ts test/us-lot.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/isolation.test.mjs
```

Use the synthetic DB opt-in for the API run. Rerun domain/contracts/DB package
gates for changed shared code and the new migration; do not rely on stale dist.
Do not load the primary environment to chase unrelated legacy API setup failures;
record that limitation and the exact US file list. This is server acceptance, not
connected browser acceptance: Task 5 must adapt the transport and UI before anyone
uses the new live response contract. No intermediate deployment is permitted.
Suggested later commit: `feat(us): implement receiving amendments and voids`.

### Task 5: Connected lifecycle, recovery and browser proof

**Files**

- Modify `apps/admin/src/us/client.ts`, `apps/admin/vite.us.config.ts` and `apps/admin/src/us/master-data/workspace.tsx` for exact transport/navigation wiring.
- Create `apps/admin/src/us/receiving/lifecycle-dialog.tsx`, `revision-history.tsx`, `amendment-comparison.tsx` and `apps/admin/src/us/lots/receiving-basis.tsx`.
- Modify Receiving `view.tsx`, `editor.tsx`, `line-editor.tsx`, `finalization-dialog.tsx`, `finalized-detail.tsx`, `exemption-review.tsx`, `copy.ts`, `readiness-copy.ts`, `receiving.css`; modify lots `lots-view.tsx` and `copy.ts` for basis and exact-revision return navigation.
- Create `apps/admin/test/us-receiving-lifecycle-client.test.ts`, `us-receiving-lifecycle.test.tsx`, `us-receiving-basis.test.tsx`, `us-receiving-tlc-input.test.tsx` and `support/us-receiving-lifecycle-fixture.ts`.
- Extend existing Receiving client/UI/readiness/finalization/exemption tests for the active live response shape; keep separate immutable v1/v2 fixtures.
- Create `tools/us-development/test/receiving-lifecycle-flow.mjs`; invoke it from `receiving-flow.mjs` after both existing finalization/exemption companions.
- Update `tools/us-development/test/browser-proxy.smoke.mjs` and `.github/workflows/us-development.yml` with exact new tests/paths, not permissive wildcard proxying.
- Update `docs/us/receiving-browser.md`, `implementation-plan.md`, `development-isolation.md`, `requirements-traceability.md`, `docs/design-briefs/us/03-cte-events.md` and this plan with actual acceptance and limitations only after verification.

**Interfaces**

The existing `createUsBrowserClient` gains `amendReceiving(id,input)`,
`voidReceiving(id,input)`, `listReceivingRevisions(id,query)` and
`getLotReceivingBasis(lotId,query)`. The first two return
`ReceivingOperationReceiptV2`; lists return Task 2 types. Existing record methods
return `ReceivingLiveRecord`, mutation methods accept/return Task 4 unions, and
`checkReceivingReadiness(id,expectedDraftVersion)` returns the v4 type. The client
validates correlation before handing results to the UI; mutations do not silently
resend themselves or substitute current content for a historical acknowledgement.

```ts
type ReceivingLifecycleDialogProps = {
  action: "amend" | "void";
  record: ReceivingLiveRecord;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};
type ReceivingRevisionHistoryProps = {
  value: ReceivingRevisionList;
  selectedEventId: string;
  onOpen: (eventId: string) => void;
  onPage: (offset: number) => void;
};
type ReceivingAmendmentComparisonProps = {
  predecessor: ReceivingLiveRecord;
  draft: ReceivingAmendmentDraft;
};
type LotReceivingBasisProps = {
  value: ReceivingBasis;
  onOpenReceiving: (eventId: string) => void;
  onPage: (offset: number) => void;
};
```

Their modules export `ReceivingLifecycleDialog`, `ReceivingRevisionHistory`,
`ReceivingAmendmentComparison` and `LotReceivingBasis` respectively. Loading/error
is owned by the existing query/view layer and never passed as a false empty value.
Preserve the parent mutation lock, dirty-navigation guard and session handlers;
do not introduce an independent persistent cache or second auth state machine.

- [ ] **Read applicable frontend/React and Playwright skills at execution time.**

Use established office components/tokens and the existing logo; no visual redesign
or `.pen` work. Follow the frontend guidance for the grouped comparison/history
controls, and `playwright-best-practices` before writing browser automation. These
skills guide implementation/verification, not permission to expand scope.

- [ ] **Write failing transport and connected recovery tests.**

In the new fixture file, derive an explicit live-v1 specimen from the existing
`finalized` export in `us-receiving-finalization-fixture.ts` without altering it:

```ts
const { snapshot, finalizedAt, finalizedBy, ...header } = finalized;
export const liveFinalized: ReceivingLiveRecord = {
  ...header,
  recordVersion: 2,
  lifecycle: {
    rootId: finalized.id,
    lifecycleVersion: 2,
    previousRevisionId: null,
    supersededByEventId: null,
    currentEventId: finalized.id,
    pendingDraftId: null,
    amendmentReason: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  },
  content: { kind: "finalized", snapshot, finalizedAt, finalizedBy },
};
```

Add corresponding valid amendment, amended and void specimens through explicit
field changes; each must parse with the shared schema. Use the existing
`MasterDataWorkspace` test setup (real client, mocked fetch, ThemeProvider,
I18nextProvider and StrictMode) to open a finalized record as QA. Submit a reason,
hold the response, assert synchronous double-click/dismiss/edit blocking, then
lose the acknowledgement and assert the exact same body and operation key on retry.

For the current-state recovery regression, return a valid historical finalize
receipt and then a live void record from GET. Expect the Void banner, original
frozen content and no effective-finalized action. Return 503 for that GET in a
separate case: show current-state unavailable and keep edits/check/finalize blocked.
The following assertion uses the setup's captured fetch mock `send`:

```ts
const mutationBodies = send.mock.calls
  .filter(([url, init]) => String(url).endsWith("/amend") && init?.method === "POST")
  .map(([, init]) => String(init?.body));
expect(mutationBodies).toHaveLength(2);
expect(mutationBodies[1]).toBe(mutationBodies[0]);
```

Run `pnpm --filter @markiro/admin exec vitest run test/us-receiving-lifecycle-client.test.ts test/us-receiving-lifecycle.test.tsx`
and capture RED before adding behavior. Also test wrong event/root/reason/version
acknowledgements; they cannot clear unsaved input or retained retry identity.

- [ ] **Implement transport validation and exact proxy paths.**

Allow only UUID `/amend` and `/void` without queries; UUID `/revisions` and lot
UUID `/receiving-basis` with bounded unique limit/offset; Receiving list with
bounded unique history/status/search/limit/offset; unchanged readiness query and
finalize route. Deny unknown keys, repeated keys, extra nested commands, invalid
UUIDs and RU paths. Mutating HTTP methods remain independently server-checked.

For each response correlate operation kind/key, target/root, reason, expected
version and saved data as applicable. Ordinary historical create/save/finalize
results still parse through the legacy branch. Preserve exact save comparison
and null-versus-absent exemption compatibility; do not cast v3 into an old type.
Expose structured lifecycle/binding/dependency errors with their context instead
of reducing them to a generic network failure.

- [ ] **Connect lifecycle commands with explicit current-state recovery.**

Capture command body/key/root/draft version before sending. Distinguish (a) unknown
mutation outcome, which offers an exact command retry, from (b) acknowledged
mutation followed by failed current-record read, which offers a read retry only.
Use the existing synchronous mutation guard before the first await. After either
fresh success or historical replay, obtain the exact current record before
rendering the next editor/detail state:

```ts
const eventId = "receiptVersion" in acknowledged ? acknowledged.eventId : acknowledged.id;
const current = await client.getReceivingRecord(eventId);
```

`acknowledged` is `ReceivingCommandResult` returned by the validated client;
`client` is the current workspace client. Keep the command/acknowledgement in
memory until that read settles. Cancelled/failed reload preserves input; session
loss clears all protected transient state. QA restoration cannot restore earlier
review checkboxes or confirmation digests. No storage, timers or autosave are added.

- [ ] **Render amendment editing and frozen comparison.**

The editor discriminates original draft versus bound amendment by its live
lifecycle. QA alone edits amendments. Copy immutable predecessor content into the
comparison pane; do not resolve its labels from current master records. Render
retained ID/product/TLC/full source/handling as summaries. Reorder carries its
previousLineNo; add has null; remove leaves the original visible in the comparison.
Show source-reference kind/URL/resolved location separately from exemption evidence.
Reason is read-only after amendment creation. Existing per-line exemption review
starts unchecked for every new revision, including retained own assignments.

Keep explicit save/check/finalize. Confirmation groups exact quantity totals by
unit and distinguishes retained lots, existing links and new creations; it must
not announce another assignment for a retained own-TLC line. At 1440 use the
comparison pane; at 1024/390 use accessible tabs and stacked content. Use existing
tokens and focus treatment without copying design-handoff CSS.

- [ ] **Render history, void consequences and independent basis.**

Show status/revision plus original finalizer and separate amendment/void actor,
time and reason. Exact historical navigation never redirects silently to current.
Provide explicit current/pending/previous links, history filter and bounded paging.
Keep lots→receipt→lot return context on success and failed lookups.

Before void, explain unchanged lot identity/status and identify lost-last-basis
lots from a fresh server-derived read; treat this as a preview, not authorization.
The command rechecks state, so a conflict refreshes the explanation without
automatically resubmitting. A pending amendment blocks current-receipt void with
an explicit link to cancel the draft. A voided draft has no fabricated finalizer.

Lot cards show current receiving basis separately from status, with count and
revision links; missing/read-failed/loading are distinct. Preserve `present` on an
empty later page with a positive supportCount. No stock balance or export-ready
indicator is inferred. EN/ES copy follows the approved brief and spec wording.

- [ ] **Write the ordinary TLC regression, then remove only the native cap.**

In `us-receiving-tlc-input.test.tsx`, use a controlled `ReceivingLineEditor` harness
and the existing TLC contract to test 120 and 121 supplementary points. Confirm
the ordinary input no longer exposes a lower UTF-16 cap; keep contract rejection
and error display. Then remove only `maxLength={200}` on the ordinary TLC input
in `line-editor.tsx`, just as the exempt proposal's cap was corrected previously.
Never silently slice/trim valid input, loosen the contract or cap its UTF-16 units
at 120. Actual native enforcement is proved by the browser step below, not JSDOM.

- [ ] **Add real lifecycle browser proof within the owned fixture.**

Export `exerciseUsReceivingLifecycle({ page, expect, screenshots, fixture })` from
the new companion and call it after existing Receiving companion assertions.
Keep the actual MFA login/proxy/API/DB harness; do not substitute mocked finalization
or run against the base database. Seed/use independent synthetic receipts so old
global counts remain meaningful. Reuse the established response-loss pattern:

```js
const attempts = [];
const loseFirst = async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  attempts.push(route.request().postDataJSON());
  if (attempts.length !== 1) return route.continue();
  const response = await route.fetch();
  assert.equal(response.status(), 200);
  return route.abort("failed");
};
```

Use status 201 for amend creation/replay, as required by Task 4; finalize/void are 200.
Install the handler on the exact command route, trigger it through visible UI,
retry and assert the two captured bodies are identical. Remove each handler in
finally. Repeat separately for amend, amendment finalization and void, checking
actual persisted roots, lots, source latches, frozen content and exact audit.

Exercise amendment cancellation and non-reused revision numbers; preserve/update
two-line bindings after reorder; retain own assignment; display second-receipt
support after voiding one; missing basis after voiding the last; role revocation
and a real receiving-operator 403. Hold a stale current-read response and prove it
cannot overwrite newer navigation or resurrect an effective receipt.

Native ordinary TLC proof uses real key events, never fill/programmatic setters:

```js
const tlc = page.getByRole("textbox", { name: "Lot code (TLC)", exact: true });
await tlc.click();
await tlc.press("ControlOrMeta+A");
await tlc.press("Backspace");
await tlc.pressSequentially("𐐀".repeat(120));
await expect(tlc).toHaveValue("𐐀".repeat(120));
```

Save through the UI and verify exact stored text. Enter a 121st point, attempt
save and prove rejection leaves stored text and draftVersion unchanged. Retain
the existing exempt native-input regression as well.

Capture amendment editor/comparison, final confirmation, history, void, missing
basis and preserved-basis states in EN/ES/light/dark at 1440, 1024 and 390. Verify
keyboard focus, footer occlusion and horizontal overflow. Inspect original
screenshots, including mobile confirmation and void warnings; no auth/MFA images,
HAR or secret-bearing logs. Keep external-request/browser-storage safety checks,
production source hash checks and confirmed fixture/server cleanup.

- [ ] **Run package/proxy/browser gates and record actual delivery.**

```sh
pnpm --filter @markiro/admin exec vitest run test/us-receiving-lifecycle-client.test.ts test/us-receiving-lifecycle.test.tsx test/us-receiving-basis.test.tsx test/us-receiving-tlc-input.test.tsx test/us-receiving-client.test.ts test/us-receiving-ui.test.tsx test/us-receiving-references.test.tsx test/us-receiving-readiness-client.test.ts test/us-receiving-readiness.test.tsx test/us-receiving-finalization-client.test.ts test/us-receiving-finalization.test.tsx test/us-receiving-exemption-client.test.ts test/us-receiving-exemption.test.tsx test/us-lots-ui.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
VITE_DEPLOYMENT_EDITION=US MARKIRO_DEPLOYMENT_EDITION=US pnpm --filter @markiro/admin build:us
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/browser-proxy.smoke.mjs
NODE_PATH=/Users/thevladbog/PRSOME/q/tools/production-browser/node_modules US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/browser-flow.smoke.mjs
```

Run with the verified Node 24 runtime. The browser suite owns ports 3100/5174;
inspect listeners and do not kill an unrelated user process. The referenced
Playwright installation is read-only; no primary files are changed. If browser
production code changes after the run, rebuild and rerun before claiming final
browser evidence. Suggested later commit: `feat(us): connect receiving revision workflow`.

## Cross-task final verification and self-review

The controller reviews the final scoped diff against the approved spec and the
following coverage map, not just the task checkboxes:

| Spec requirement                          | Implementing tasks | Required evidence                                                |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------- |
| Approved void/identity/source-lock rule   | 1, 3, 4, 5         | Exact unchanged lot fields in DB + independent basis UI          |
| Root/revision/current/pending semantics   | 1, 2, 3, 4         | Pure transitions + commit-time constraints + real command races  |
| Bindings/identity/change classification   | 1, 2, 3, 4, 5      | Reorder and duplicate/forged binding denial; no duplicate lots   |
| Current support count and missing basis   | 2, 4, 5            | Complete count versus pages, both shared-lot schedules           |
| Frozen v1/v2/v3 and historical replay     | 2, 3, 4, 5         | Pre-migration specimens + unchanged receipts + current reread    |
| QA/MFA/current authorization              | 4, 5               | Store and real HTTP denial, including after role loss/retry      |
| Documentary correction of non-active lots | 1, 3, 4, 5         | Retained recalled/archived cases; new-use denial remains         |
| Reason/audit/rollback/no-op safety        | 3, 4, 5            | Exact before/after rows and empty side effects on failure/replay |
| Unicode and EN/ES accessible office UI    | 5                  | Native 120/121 input, exact persistence, inspected screenshots   |
| Runtime/release isolation                 | 3, 4, 5            | Legacy runtime bridge, exact proxy denial and lock checker       |
| Future downstream consumers               | 1, 4               | Explicit contract boundary; real US-04/05 proof remains open     |

- [ ] Run the final package tests/typecheck/lint/build for domain, contracts, DB,
      API and admin after their last source edit. For API, run the exact scoped
      US list from Task 4 with the synthetic DB, plus affected deployment/HTTP
      tests; record the known full-primary-suite environment limitation separately.
- [ ] Run final isolation and repository formatting/diff gates:

```sh
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/isolation.test.mjs
pnpm format:check
git diff --check
git status --short
```

- [ ] Inspect the primary checkout status read-only and compare with its pre-edit
      baseline. Report any unrelated changes without including or resetting them.
- [ ] Update actual evidence in the scoped docs: counts, skips, source revision,
      owned-DB cleanup, screenshots personally inspected and external limits.
      Do not mark US-03 Done: fixed-template CSV and remaining acceptance are open.
- [ ] Apply the execution skill's final review gate. Findings must name concrete
      code paths and tests; do not repeat a completed whole-feature review merely
      because a reviewer becomes available. Keep follow-up fixes scoped and rerun
      affected checks. Preserve all earlier ignored evidence.
- [ ] Hand off behavior, areas changed, automated results, browser proof and
      unverified external surfaces. No commit/push/PR/merge/deployment is automatic.

Planning self-review: all ten spec sections map to tasks above; new schema/type
names and method argument ordering are shared explicitly. The storage task
includes the compatibility bridge so existing commands do not break between
schema and lifecycle work. Contract-only downstream facts are not recorded as
implemented Transformation/Shipping. Tasks 1–2 are complete; Task 3's support-token
slice is implemented, with root/chain storage still pending. Tasks 4–5 and
cross-task final acceptance remain unexecuted.

## Execution handoff

The owner selected inline sequential execution (option 2) on 2026-09-07, using
`executing-plans` with the same review checkpoints. Stage 1 (Tasks 1–2: rules and
contracts) is complete. Task 3 has its compatible support-token slice; the next
checkpoint is revision root/chain storage and the original-command root-lock
bridge. This choice does not authorize publication or release.
