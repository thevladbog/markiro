# US-08 Plan Rules and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish tested, strict P0 Traceability Plan rules and contracts before any plan row, HTTP route, PDF or UI is added.

**Architecture:** Keep pure plan semantics in `@markiro/domain` and the untrusted HTTP shape in `@markiro/platform-contracts`, which depends on domain, never the reverse. This is the first independently reviewable US-08 increment. Follow-up plans own persistence/approval and the US cabinet; this increment must not imply that a plan can already be approved.

**Tech Stack:** TypeScript 6 strict mode, Vitest 4, Zod 4, `@noble/hashes` through the existing domain canonical digest helper.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md`

## Global Constraints

- Work only in the isolated `codex/us-mvp` US worktree; preserve its existing US-06/07 modifications. No RU route, Station behavior, push, release or deployment in this plan.
- US interface locales are `en-US` and `es-US`; plan artifact text is English and independent of UI locale.
- A processor profile alone cannot prove no farm activity. `yes` or `unknown` farm activity blocks the selected non-farm P0 plan.
- Synthetic provenance comes from a trusted server seed, never from a request field; real operational confirmations are attributed to the server-resolved actor in the later persistence stage.
- Drafts may be incomplete; approval validation is server authoritative. Never treat a configured bucket, product count or architecture prose as proof of real record or backup practice.
- Retention default is five calendar years, minimum two; superseded plans use the supersession anchor and effective plans remain retained. The existing pure calculator remains the authority for calendar math.
- Use one focused failing test before each implementation, build changed workspace dependencies before consumer checks, and report database skips separately. No commit/push is included without separate authorization.

## Review Focus

1. A client adds `syntheticDemo`, `tenantId` or `actorUserId` to a plan body: strict contracts reject it (Task 3).
2. A processor also grows/raises FTL food, or farm activity is unknown: approval validation blocks it, despite the processor profile (Task 1).
3. A real operator has not confirmed record locations, backup practice or contact: approval validation blocks with field-specific issues (Task 1).
4. Location and product facts arrive in a different DB order: the snapshot digest stays identical, while a changed individual profile revision changes the digest (Task 2).
5. A draft contains an invalid or misleading regulatory claim in any free-text section: approval validation returns its section/path, not a generic success (Task 1).

---

### Task 1: Pure draft model and approval validation

**Files:**

- Create: `packages/domain/src/traceability/plan/model.ts` — versioned draft/confirmation/fact types.
- Create: `packages/domain/src/traceability/plan/validation.ts` — deterministic issue list and claim guard.
- Create: `packages/domain/test/us-plan-validation.test.ts` — positive and field-specific negative cases.
- Modify: `packages/domain/src/index.ts` — export the rules and types.

**Interfaces:**

- Consumes: no plan implementation; uses the existing `US_CAPABILITY` only in later server work.
- Produces: `UsPlanSections`, `UsPlanApprovalInput`, `UsPlanValidationIssue`, and `validateUsPlanApproval(input): UsPlanValidationIssue[]`.

- [ ] **Step 1: Write the failing test.** Start with a complete fictional non-farm fixture and assert `[]`. Then table-test missing record format/location, backup statement, contact name/title/phone, TLC-source location, confirmation, v2 change summary, unsupported profile, `farmActivity: yes|unknown`, and case-insensitive misleading claims. Assert exact `{ code, section, path }`, including a forged phrase in a nested narrative paragraph.

```ts
expect(validateUsPlanApproval(valid)).toEqual([]);
expect(
  validateUsPlanApproval({
    ...valid,
    sections: {
      ...valid.sections,
      farmActivity: { status: "unknown", explanation: "" },
    },
  }),
).toContainEqual({
  code: "farm_scope_unsupported",
  section: "farmActivity",
  path: "farmActivity.status",
});
expect(
  validateUsPlanApproval({
    ...valid,
    confirmations: {
      ...valid.confirmations,
      backupAndRecovery: false,
    },
  }),
).toContainEqual({
  code: "confirmation_required",
  section: "recordMaintenance",
  path: "confirmations.backupAndRecovery",
});
```

- [ ] **Step 2: Confirm red.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-plan-validation.test.ts`; expect an unresolved export or the specified assertion to fail, not a skipped test.
- [ ] **Step 3: Implement the minimum model and validator.** Use the exact domain shape below; strings may be empty in a draft and are checked at approval. Validate with trim for presence but preserve original text bytes. Do not autocorrect, translate or rewrite user narrative. Scan all free-text fields with a fixed case-insensitive claim list based on `docs/us/limitations.md`; return sorted, stable issue codes without storing raw narrative in logs.

```ts
export interface UsPlanSections {
  recordMaintenance: {
    systemOfRecord: string;
    formats: string[];
    recordLocations: string[];
    responsibleRoles: string[];
    backupAndRecovery: string;
    narrative: string[];
  };
  ftlIdentification: { procedure: string; reviewCadence: string };
  tlcAssignment: { procedure: string };
  pointOfContact: { name: string; title: string; phone: string; email: string | null };
  farmActivity: { status: "no" | "yes" | "unknown"; explanation: string };
  reviewAndUpdate: { procedure: string };
}
export interface UsPlanApprovalInput {
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  versionNumber: number;
  changeSummary: string;
  sections: UsPlanSections;
  tlcSourceLocationCount: number;
  provenance: "trusted_synthetic" | "operational";
  confirmations: {
    procedures: boolean;
    backupAndRecovery: boolean;
    contact: boolean;
    nonFarmScope: boolean;
  };
}
export interface UsPlanValidationIssue {
  code: string;
  section: keyof UsPlanSections | "plan";
  path: string;
}
export function validateUsPlanApproval(input: UsPlanApprovalInput): UsPlanValidationIssue[];
```

- [ ] **Step 4: Confirm green and package health.** Run the focused test, then `corepack pnpm --filter @markiro/domain test`, `typecheck`, `lint`, and `build`. Review that the demo provenance bypasses only real-operator confirmation, never required content, non-farm scope, profile or prohibited claims.
- [ ] **Step 5: Review gate.** Independently inspect issue order, exact paths, all free-text fields and the absence of any browser/server dependency. Run `git diff --check`; record the result before Task 2.

### Task 2: Frozen configuration snapshot and change detection

**Files:**

- Create: `packages/domain/src/traceability/plan/snapshot.ts` — canonical snapshot, digest and section impacts.
- Create: `packages/domain/test/us-plan-snapshot.test.ts` — order stability, provenance and change tests.
- Modify: `packages/domain/src/index.ts` — export functions and types.

**Interfaces:**

- Consumes: `UsPlanSections` from Task 1 and `canonicalExportDigest` from `packages/domain/src/traceability/export/canonical.ts` after explicit sorting of unordered plan lists.
- Produces: `UsPlanConfiguredFacts`, `UsPlanSnapshot`, `buildUsPlanSnapshot(facts, sections, provenance): UsPlanSnapshot`, `usPlanSnapshotDigest(snapshot): string`, and `changedUsPlanSections(effective, current): (keyof UsPlanSections)[]`.

- [ ] **Step 1: Write the failing test.** Two fixtures differing only in input array order produce the same digest and JSON snapshot; changing one product `revision`, location description, baseline or retention value changes it. Verify that user-entered narrative order remains significant, provenance is frozen, and `changedUsPlanSections` identifies `recordMaintenance`, `ftlIdentification` or `tlcAssignment` precisely.

```ts
const a = buildUsPlanSnapshot(facts, sections, "trusted_synthetic");
const b = buildUsPlanSnapshot(
  {
    ...facts,
    tlcSourceLocations: [...facts.tlcSourceLocations].reverse(),
    productProfiles: [...facts.productProfiles].reverse(),
  },
  sections,
  "trusted_synthetic",
);
expect(usPlanSnapshotDigest(a)).toBe(usPlanSnapshotDigest(b));
expect(
  usPlanSnapshotDigest(
    buildUsPlanSnapshot(
      {
        ...facts,
        productProfiles: [{ productId: "product-1", revision: 2, coverageStatus: "covered" }],
      },
      sections,
      "trusted_synthetic",
    ),
  ),
).not.toBe(usPlanSnapshotDigest(a));
```

- [ ] **Step 2: Confirm red.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-plan-snapshot.test.ts`; expect a missing export or specific failed assertion.
- [ ] **Step 3: Implement the minimum frozen model.** Accept only explicit scalar facts from the future database reader. Copy and sort locations by ID and product profiles by product ID; do not mutate the caller's arrays. Include full referenced location description and each product's coverage status/revision, not only counts. Use the existing canonical JSON digest helper on this normalized model. Compare the effective configured subset against current configured facts; do not claim a contact change from unrelated current configuration because contact is plan-owned.

```ts
export interface UsPlanConfiguredFacts {
  tenantName: string;
  profileCode: "US_FSMA204_PROCESSOR";
  baselineVersion: string;
  timeZone: string;
  retentionYears: number;
  tlcSourceLocations: { id: string; description: string }[];
  productProfiles: { productId: string; revision: number; coverageStatus: string }[];
}
export interface UsPlanSnapshot {
  schemaVersion: 1;
  configured: UsPlanConfiguredFacts;
  sections: UsPlanSections;
  provenance: "trusted_synthetic" | "operational";
}
export function buildUsPlanSnapshot(
  facts: UsPlanConfiguredFacts,
  sections: UsPlanSections,
  provenance: UsPlanSnapshot["provenance"],
): UsPlanSnapshot;
export function usPlanSnapshotDigest(snapshot: UsPlanSnapshot): string;
export function changedUsPlanSections(
  effective: UsPlanSnapshot,
  current: UsPlanConfiguredFacts,
): (keyof UsPlanSections)[];
```

- [ ] **Step 4: Confirm green and package health.** Run focused test, then domain `test`, `typecheck`, `lint`, `build`. Verify no `Date.now()`, locale formatting or network/file I/O enters domain code.
- [ ] **Step 5: Review gate.** Independently review that reordering does not change bytes but changed individual products do, and the digest rejects non-JSON values through the canonical helper. Run `git diff --check`.

### Task 3: Strict HTTP boundary schemas

**Files:**

- Create: `packages/platform-contracts/src/traceability/plans.ts` — draft-save and approve request schemas.
- Create: `packages/platform-contracts/test/us-plans-contracts.test.ts` — strictness, bounds and schema compatibility.
- Modify: `packages/platform-contracts/src/index.ts` — export schemas/types.

**Interfaces:**

- Consumes: Task 1's `UsPlanSections` as a compile-time structural compatibility check.
- Produces: `usPlanSectionsSchema`, `usPlanDraftSaveBodySchema`, `usPlanApproveBodySchema` and their inferred types for the later US controller. These bodies never accept tenant, actor, provenance or trusted-demo fields.

- [ ] **Step 1: Write the failing test.** Parse a complete but not necessarily approval-ready draft. Verify nested `.strict()` rejection of an extra section key, top-level rejection of `tenantId`, `actorUserId` and `syntheticDemo`, reject an invalid UUID operation key and negative revisions, reject oversized text/arrays, and assert the inferred section type satisfies `UsPlanSections` without `any` or broad casts.

```ts
expect(
  usPlanDraftSaveBodySchema.safeParse({
    expectedRevision: 1,
    changeSummary: "Initial plan",
    sections,
    syntheticDemo: true,
  }).success,
).toBe(false);
expect(
  usPlanApproveBodySchema.safeParse({
    expectedRevision: 1,
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    confirmations: { procedures: true, backupAndRecovery: true, contact: true, nonFarmScope: true },
    actorUserId: "client-forged",
  }).success,
).toBe(false);
```

- [ ] **Step 2: Confirm red.** Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-plans-contracts.test.ts`; expect a missing export or exact assertion failure.
- [ ] **Step 3: Implement strict schemas.** Use bounded `z.string()` and arrays for each of the Task 1 fields, allowing empty draft strings but limiting each text field to 4096 characters, an array to 50 entries and total request bytes again at the later HTTP adapter. Use `platformUuidSchema` for the idempotency key, `z.number().int().min(1)` for revision and `z.boolean()` for confirmation requests. Make every object `.strict()`; do not add optional `isDemo` or `tenantId` convenience fields.

```ts
const text = z.string().max(4096);
const texts = z.array(text).max(50);
export const usPlanSectionsSchema = z
  .object({
    recordMaintenance: z
      .object({
        systemOfRecord: text,
        formats: texts,
        recordLocations: texts,
        responsibleRoles: texts,
        backupAndRecovery: text,
        narrative: texts,
      })
      .strict(),
    ftlIdentification: z.object({ procedure: text, reviewCadence: text }).strict(),
    tlcAssignment: z.object({ procedure: text }).strict(),
    pointOfContact: z
      .object({
        name: text,
        title: text,
        phone: text,
        email: text.nullable(),
      })
      .strict(),
    farmActivity: z
      .object({
        status: z.enum(["no", "yes", "unknown"]),
        explanation: text,
      })
      .strict(),
    reviewAndUpdate: z.object({ procedure: text }).strict(),
  })
  .strict();
export const usPlanDraftSaveBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    changeSummary: z.string().max(4096),
    sections: usPlanSectionsSchema,
  })
  .strict();
export const usPlanApproveBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    idempotencyKey: platformUuidSchema,
    confirmations: z
      .object({
        procedures: z.boolean(),
        backupAndRecovery: z.boolean(),
        contact: z.boolean(),
        nonFarmScope: z.boolean(),
      })
      .strict(),
  })
  .strict();
```

- [ ] **Step 4: Confirm green and both package gates.** Build `@markiro/domain` first; run the focused contract test, then `@markiro/platform-contracts` `test`, `typecheck`, `lint`, `build`. Re-run the focused domain tests after the contract shape is finalized.
- [ ] **Step 5: Review gate.** Independently compare the inferred schema to Task 1's domain model and verify no client-controlled provenance or authority fields are accepted. Run `git diff --check` and `corepack pnpm exec prettier --check` on touched paths.

## Handoff and later plans

### 2026-10-02 review reconciliation

The independent integration review found two gaps between this plan's original interfaces and the approved design. The owner approved correcting them within this rules/contracts increment before any server approval or persisted snapshot uses the model:

- The fixed prohibited-wording list is matched against a temporary comparison copy that folds whitespace and common hyphen/dash separators. Affirmative variants are blocked; an immediately preceding `not` or `no` permits that one explicit negative disclaimer. Stored text is unchanged. This is a bounded English wording guard, not legal or general linguistic assessment.
- `UsPlanSnapshot` additionally freezes a versioned, code-owned `ftlReviewWorkflow` descriptor of the existing manual product review: supported statuses, conditionally required evidence, QA authority and server actor/time on a coverage change, narrative (not configured) cadence, and no automatic legal determination. A changed frozen descriptor changes the digest and marks `ftlIdentification` as changed. Product result facts remain separate. The descriptor must be versioned when those code-supported semantics change.

These additions extend the original Task 1/2 interface examples above; they do not add persistence, a route, PDF, UI, or operational acceptance. Each correction had its own red/green tests and independent review in the local SDD ledger.

After all three review gates, report this increment as **rules/contracts only**. Do not mark PLN-001–010 implemented: no persisted version, artifact, route or screen exists yet. The next plan covers additive tenant-safe schema, revisioned draft commands, retention boundary and exact audit; a later plan covers deterministic PDF/artifact publication and HTTP; the final plan covers the US cabinet and synthetic integrated flow. The approved spec remains the source for all three.

Before execution, review the current worktree status and the complete US-06/07 dirty diff. Use a separate implementer and independent reviewer for each task, with my acceptance between tasks; do not stage unrelated files. No commit, push, PR, merge or release is authorized by this plan.
