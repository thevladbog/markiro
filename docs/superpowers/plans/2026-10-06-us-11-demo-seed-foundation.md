# US-11 Demo Seed Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the exact Scenario A descriptor and a tenant-safe durable seed journal, independently verified before business-chain orchestration.

**Architecture:** Keep the versioned synthetic definition in a small API-local module and use an additive PostgreSQL journal for exact stage ownership and receipts. A guarded internal store rechecks the original synthetic owner/profile/database identity before journal writes. This foundation does not seed business records, expose a command or claim a ready demo.

**Tech Stack:** Existing Node 24+, Corepack pnpm 11.22.0, strict TypeScript, Zod, Drizzle/PostgreSQL, Vitest and `@markiro/domain` canonical hashing. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-single-tenant-demo-seed-design.md` (owner approved 2026-10-06).

## Global Constraints

- Work remains in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve unrelated and accepted uncommitted work.
- No staging, commit, push, PR, merge, release, primary-database mutation, old fixture cleanup, dependency installation, personal environment-file write or local archive/design file change is included.
- Tests use owned disposable U.S. databases and owned private storage fixtures; they never populate the shared base database implicitly.
- Existing organization name, slug, metadata and owner audit are not repurposed as the dataset journal.
- Runtime code must not import from `apps/api/test` or mutable fixture transports.
- No deletion, reset, password reset, MFA reset or role restoration command is included.
- No machine/authentication/audit clock override or silent deadline extension is allowed.
- No passwords, MFA keys, tokens, cookies, signed URLs, requester payloads or storage credentials in output/logs.
- The viewer must not modify business records or generate new packages. There is no self-service registration, new customer onboarding, billing, multi-customer provisioning, Station workflow, physical scanner/print claim or second demo.
- Do not loosen either runtime edition/loopback enforcement or worker build checks to make this increment appear deployed or publish the current dirty checkout.
- Preserve exact decimal quantities: two inputs `500 lb` each, output/shipment `100 case`, 100 synthetic SSCC links; no implicit packaging conversion.
- Preserve existing EN/ES cabinet, shared UI tokens and Auditor policy. This foundation makes no UI/auth-policy change.
- Use per-task byte baselines and explicit path manifests instead of commit ranges. Every task has RED→GREEN and independent review; broad source review follows acceptance of all tasks.

## Review Focus

1. Same version with different content must conflict, not create a parallel seed or overwrite its journal: Task 2/3 digest collision regressions.
2. A committed stage whose reply is lost must preserve its exact body/key/receipt; a changed body cannot reuse that ownership: Task 3 lost-reply and compare-and-swap tests.
3. A forged expected tenant/actor/database or corrupted reserved provenance must produce zero journal writes: Task 3 wrong-target and revoked-owner tests.
4. Concurrent journal initialization/updates must not lose a stage or grant two owners: Task 3 real PostgreSQL concurrent calls and CAS tests.
5. Added migrations must preserve existing finalized snapshots and fail cross-tenant stage references, without changing historical migration tests to the latest migration: Task 2 fresh/upgrade/FK tests.

## Scope and file responsibilities

This is the first independently usable foundation increment, not a compressed implementation of the entire US-11 spec. The remaining service-backed chain, Plan/package, viewer provisioning and full browser acceptance get their own plans after this checkpoint. Their current services are unchanged here; no dummy runtime adapter or success-returning placeholder is introduced.

| File/area                                                            | Responsibility                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api/src/modules/traceability/demo/us-demo-definition.ts`       | Exact frozen Scenario A data, version and content digest                     |
| `apps/api/src/modules/traceability/demo/us-demo-journal-contract.ts` | Strict internal stage intent/receipt codec, sizes and finite errors          |
| `packages/db/src/schema/traceability-demo-seed.ts`                   | Header/stage tables with tenant-composite FK and non-cascading retention     |
| `apps/api/src/modules/traceability/demo/us-demo-journal.ts`          | Authorized initialize/read/CAS stage persistence, no business writes         |
| `apps/api/test/support/us-demo-journal-fixture.ts`                   | Owned test database, genuine reserved owner/profile, journal test helpers    |
| Focused API/DB tests                                                 | Definition, codec, schema, migration, authorization and concurrency evidence |
| `.github/workflows/us-development.yml`                               | Exact serial check-only ownership of the new focused gates                   |

Migration SQL and metadata use the next free migration assigned during Task 2, not a number reserved by this document. Schema exports live in `packages/db/src/schema.ts`, not a nonexistent schema/index module.

## Shared internal interface

Task 1 defines the following names/types; Task 3 consumes them without signature drift. They are API-internal, not public HTTP/platform contracts.

```ts
export const US_DEMO_VERSION = "us-processor-demo-v1";
export type UsDemoStage =
  | "references"
  | "receiving"
  | "transformation"
  | "cases"
  | "shipping"
  | "trace_readiness"
  | "plan"
  | "request"
  | "package";
export type UsDemoJournalContext = Readonly<{
  tenantId: string;
  actorUserId: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: "markiro_us";
}>;
export type UsDemoIntent = Readonly<{
  stage: UsDemoStage;
  operationKey: string;
  inputDigest: string;
  input: Readonly<Record<string, unknown>>;
}>;
export type UsDemoReceipt = Readonly<{
  recordIds: readonly string[];
  resultDigest: string;
  result: Readonly<Record<string, unknown>>;
}>;
export type UsDemoJournal = Readonly<{
  id: string;
  tenantId: string;
  scenarioVersion: typeof US_DEMO_VERSION;
  definitionDigest: string;
  revision: number;
  stages: readonly Readonly<{
    stage: UsDemoStage;
    revision: number;
    intent: UsDemoIntent;
    receipt: UsDemoReceipt | null;
  }>[];
}>;
```

`input`/`result` mean bounded JSON evidence, not arbitrary driver objects, credentials or unvalidated future business commands. The codec requires plain JSON-compatible data, object roots, maximum UTF-8 size 256 KiB for each, depth at most 16, no secret-bearing keys at any depth, canonical lowercase UUID keys/record IDs and lowercase 64-hex digests. Operation keys are stable seed intent identities; they do not pretend an existing command supports idempotency. No whole-demo `complete` flag exists in this foundation: a saved receipt is not canonical business verification.

## Task 1: Scenario A definition and strict journal codec

**Files:** Create the two definition/contract modules above; create `apps/api/test/us-demo-definition.test.ts` and `apps/api/test/us-demo-journal-contract.test.ts`.

**Consumes:** Existing `canonicalExportDigest` and GS1/SSCC validators in `@markiro/domain`; exact Scenario A in `docs/us/demo-scenario.md`.

**Produces:** `US_DEMO_VERSION`, `usDemoDefinition`, `usDemoDefinitionDigest`, `UsDemoStage`, `UsDemoJournalContext`, `UsDemoIntent`, `UsDemoReceipt`, `UsDemoJournal`, `parseUsDemoIntent(raw: unknown): UsDemoIntent`, `parseUsDemoReceipt(raw: unknown): UsDemoReceipt`.

- [ ] **Step 1 — write focused failing tests.** Check exact three fictional parties/locations/555 contacts, two products, TLCs, references, civil dates, Los Angeles timezone, quantities/UOM and 100 distinct SSCCs. The definition includes static business facts only, no receipt/approval/auth times or credential fields. Assert recursive immutability, deterministic digest, valid SSCC checksums and unchanged digest on repeated import. Pin these behaviors:

```ts
expect(usDemoDefinition.receiving.lines.map((x) => [x.tlc, x.quantity, x.unitOfMeasure])).toEqual([
  ["OSS-260914-A1", "500", "lb"],
  ["OSS-260914-A2", "500", "lb"],
]);
expect(usDemoDefinition.transformation.output).toMatchObject({
  tlc: "NRF-260915-APL01",
  quantity: "100",
  unitOfMeasure: "case",
});
expect(new Set(usDemoDefinition.cases).size).toBe(100);
expect(usDemoDefinitionDigest).toBe(canonicalExportDigest(usDemoDefinition));
```

Codec tests reject unknown root fields, invalid stage/UUID/digest, non-JSON values, lone surrogate/NUL, oversized UTF-8 input/result, depth 17 and nested password/token/cookie/MFA/storage-credential fields. Valid maximum boundaries and exact preserved strings pass. Do not cap a valid TLC by UTF-16 units or add arbitrary business schema rules to the journal codec.

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-demo-definition.test.ts test/us-demo-journal-contract.test.ts`; record absent-module/behavior failure before implementation.
- [ ] **Step 3 — implement the definition and codec.** Follow this digest/ownership pattern, without changing existing export hashing:

```ts
export const usDemoDefinitionDigest = canonicalExportDigest(usDemoDefinition);
export function parseUsDemoIntent(raw: unknown): UsDemoIntent {
  const parsed = usDemoIntentSchema.parse(raw);
  assertBoundedSyntheticJson(parsed.input);
  if (canonicalExportDigest(parsed.input) !== parsed.inputDigest)
    throw new Error("us_demo_intent_digest_mismatch");
  return parsed;
}
```

Define `usDemoIntentSchema`/`usDemoReceiptSchema` as strict Zod objects matching the shared interface; `assertBoundedSyntheticJson(value: unknown): void` owns the limits above and finite private-safe errors. Validate receipt result against `resultDigest` the same way. Use existing domain SSCC generation with an explicitly fictional, fixed fixture sequence. Deep-freeze owned definition objects/arrays; never freeze caller objects as a side effect. Export no mutable secret or clock state.

- [ ] **Step 4 — run GREEN** with the same tests, API typecheck/lint and affected formatting. No database dependency or skips in these pure tests.
- [ ] **Step 5 — checkpoint/review.** Capture exact changed paths, hashes, commands and RED/GREEN results; no commit. Independent review checks descriptor fidelity and actual codec branches before Task 2.

## Task 2: Additive database journal storage

**Files:** Create `packages/db/src/schema/traceability-demo-seed.ts`, `packages/db/test/us-demo-seed-schema.test.ts`, `packages/db/test/us-demo-seed-migration.e2e.test.ts`; modify `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`; add generated new SQL/metadata migration only.

**Consumes:** Task 1 field meanings and stage enum; never import API code into DB package.

**Produces:** `schema.traceabilityDemoSeeds` and `schema.traceabilityDemoSeedStages`, with the exact DB names `traceability_demo_seeds` / `traceability_demo_seed_stages`.

- [ ] **Step 1 — write schema/migration RED.** Header columns: UUID `id`; text `tenant_id`, `scenario_version`, `definition_digest`, `created_by`; positive int `revision` default 1; UTC `created_at`. Unique `(tenant_id,id)` and `(tenant_id,scenario_version)`; non-cascading tenant FK. Stage columns: UUID `id`, text `tenant_id`, UUID `seed_id`, text `stage`, positive int `revision` default 1, UUID `operation_key`, text `input_digest`, JSONB object `input`, nullable JSONB object `receipt`, UTC `created_at`. Unique `(tenant_id,seed_id,stage)` and `(tenant_id,seed_id,operation_key)`; composite FK `(tenant_id,seed_id)` to header. Add positive revisions, valid digests/stages, bounded JSON size and object/null checks in PostgreSQL. No credentials, lease, public access token, whole-demo success flag or cascade delete.

```ts
const config = getTableConfig(schema.traceabilityDemoSeedStages);
expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
  "tenant_id",
  "seed_id",
  "stage",
]);
expect(
  config.foreignKeys.some(
    (fk) =>
      fk
        .reference()
        .columns.map((c) => c.name)
        .join() === "tenant_id,seed_id",
  ),
).toBe(true);
```

Real migration tests cover fresh/upgrade, preservation of existing receiving snapshots/Plan/request rows, rejection of a stage under another tenant's header, duplicate stage/key, invalid revision/JSON/digest and attempted cascade deletion. Use DB package's actual `test/support/us-profile-database.ts` and legacy migration copier; inspect its supported migration-index arguments instead of importing the different API helper. Pin predecessor and new migration indices explicitly. Opt-in missing US URL skips must be disclosed; configured URL failures fail.

- [ ] **Step 2 — run RED** schema tests and configured disposable migration tests, without applying anything to the base DB.
- [ ] **Step 3 — implement schema and generate additive migration.** Export through `src/schema.ts` and add the new schema path to the existing Drizzle list, preserving exclusions. Select the next free migration at execution; use package `db:generate`, never hand-edit the lockfile or old SQL. Essential tenant binding:

```ts
foreignKey({
  name: "traceability_demo_seed_stages_seed_fk",
  columns: [t.tenantId, t.seedId],
  foreignColumns: [traceabilityDemoSeeds.tenantId, traceabilityDemoSeeds.id],
});
```

Review SQL/defaults/checks/indexes and recovery impact. The header retains synthetic seed history even if an operator later stops using the demo; no delete API is added. In the new `us-demo-seed-migration.e2e.test.ts`, call existing `runRuntimeMigrations` from `../src/runtime-migrate.js` against the exact owned scratch URL with the actual migration folder and a silent callback; assert its packaged tags contain the newly generated migration and both journal tables exist. Do not alter the generic runner or use its ambient `DATABASE_URL` suite to reach a primary database.

- [ ] **Step 4 — run GREEN.** DB focused schema/migration/runtime tests, package tests/typecheck/lint/build, then rebuild DB before any API consumer. Record skips separately; run configured migration acceptance against an owned random DB.
- [ ] **Step 5 — checkpoint/review.** Exact migration/table/metadata diff and preservation evidence; no commit or primary DB migration. Independent review before Task 3.

## Task 3: Guarded journal store and check-only ownership

**Files:** Create `apps/api/src/modules/traceability/demo/us-demo-journal.ts`, `apps/api/test/support/us-demo-journal-fixture.ts`, `apps/api/test/us-demo-journal.e2e.test.ts`; modify `.github/workflows/us-development.yml`, `docs/us/implementation-plan.md` and `docs/us/development-isolation.md` only for factual foundation evidence.

**Consumes:** Task 1 exact types/codecs/digest, Task 2 tables, current `UsDevelopmentOwnerStore.verifyTrustedSeed`, `authorizeUsMasterData` and existing owned API profile-test DB helper.

**Produces:** Internal `UsDemoJournalStore` constructed with `Db`, methods below. No CLI/HTTP/module registration, no seed execution endpoint and no business orchestration.

```ts
read(context: UsDemoJournalContext): Promise<UsDemoJournal | null>;
initialize(context: UsDemoJournalContext): Promise<UsDemoJournal>;
captureIntent(context: UsDemoJournalContext, seedId: string,
  expectedRevision: number, intent: UsDemoIntent): Promise<UsDemoJournal>;
recordReceipt(context: UsDemoJournalContext, seedId: string,
  expectedRevision: number, stage: UsDemoStage,
  operationKey: string, receipt: UsDemoReceipt): Promise<UsDemoJournal>;
```

- [ ] **Step 1 — write real DB RED.** Fixture creates only its owned random DB, provisions the genuine reserved owner using the existing store and selects processor/profile timezone through current services. Never fake trusted-origin audit or copy a primary tenant. Context's expected DB name is that exact fixture identity. Test initialize twice returns byte-identical header/no duplicate; equal intent/receipt replay returns current journal without mutation; different definition/intent/receipt under an existing identity conflicts. Assert capture→receipt advances revision once each, stage order returned canonically and stale CAS refuses overwrite. Receipt capture is bookkeeping only, never grants complete business status.

```ts
const first = await store.initialize(context);
const second = await store.initialize(context);
expect(second).toEqual(first);
const intent = parseUsDemoIntent({
  stage: "receiving",
  operationKey: randomUUID(),
  input: { eventDate: "2026-09-14" },
  inputDigest: canonicalExportDigest({ eventDate: "2026-09-14" }),
});
const recorded = await store.captureIntent(context, first.id, first.revision, intent);
expect(await store.captureIntent(context, first.id, first.revision, intent)).toEqual(recorded);
```

Also test concurrent identical initialize, concurrent different-intent CAS, lost reply simulated by discarding a real committed return then exact replay, wrong actual DB/user/tenant/actor, revoked owner, QA-but-not-original-owner, corrupt seed metadata/audit, profile/timezone mismatch, another tenant's seed ID and unsupported stored version/corrupt receipt. Every rejection asserts exact journal and business-table before/after equality. Direct test-only corrupt-row setup is deliberate boundary testing, not production repair behavior.

- [ ] **Step 2 — run configured RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-demo-journal.e2e.test.ts --maxWorkers=1`; use explicit `US_TEST_DATABASE_URL`, never primary `DATABASE_URL`. Helper only uses the base URL to create/drop its own random target.
- [ ] **Step 3 — implement small transactional store.** At every method, strict-parse context, verify actual `current_database()/current_user`, original reserved owner identity/current `owner` membership, trusted seed and `US_FSMA204_PROCESSOR` with `America/Los_Angeles`. Treat expected DB identity as trusted internal input; future CLI must derive it from its validated environment, not expose arbitrary URL/target trust. No relaxation of `loadUsDevelopmentEnv` is included. Read has no writes; mutating methods serialize the tenant/version and lock the header, compare version/digest and parse stored journal strictly.

```ts
await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
  ${context.tenantId + ":" + US_DEMO_VERSION}, 0))`);
const profile = await authorizeUsMasterData(
  tx,
  context.tenantId,
  context.actorUserId,
  US_CAPABILITY.QA_MANAGE,
);
if (profile !== "US_FSMA204_PROCESSOR") throw new Error("us_demo_target_invalid");
const seed = await new UsDevelopmentOwnerStore(db).verifyTrustedSeed(
  context.tenantId,
  new Date(),
  tx,
);
if (!seed) throw new Error("us_demo_target_invalid");
```

The snippet supplements, not replaces, actual DB, owner and timezone checks. Reject expectedRevision mismatch only after checking whether the exact intent/receipt was already recorded, allowing safe lost-reply replay without overwriting another writer. On new capture, increment header revision atomically; same stage/key cannot adopt another body. Receipt must refer to its previously persisted operation key, parse/digest exactly, and be immutable once recorded. Do not reinterpret driver failures as mismatch, hide them behind `already_exists`, or log raw SQL. No business audit claiming finalization; original trusted-origin audit remains unchanged.

- [ ] **Step 4 — run GREEN and covering gates.** Run `corepack pnpm --filter @markiro/api exec vitest run test/us-demo-definition.test.ts test/us-demo-journal-contract.test.ts test/us-demo-journal.e2e.test.ts test/us-owner-command.test.ts test/us-development-owner.e2e.test.ts test/us-profile-store.e2e.test.ts test/us-request-tenant-origin.e2e.test.ts --maxWorkers=1`, then API typecheck/lint/build after shared DB build. Add exact new pure/DB/API commands to the serial check-only US workflow; preserve release locks and existing browser ownership. Use root `format:check`, `git diff --check` and per-new-file whitespace checks. No remote dispatch. Report any default API setup failures rather than supplying primary secrets or claiming a full green gate.
- [ ] **Step 5 — checkpoint/review.** Record exact hashes/results/configured DB coverage/cleanup, independent task review, then one whole-foundation review. Docs say descriptor/journal foundation only; no actual business seed, viewer, Plan/package generation, browser demo, base DB initialization or hosted acceptance claim.

## Plan self-review and handoff

Spec sections 1/2/3 are represented by Task 1's definition and all-task isolation; the journal portion of section 4 is Tasks 2/3. Full business canonical verification and preflight for storage/build belong to the later orchestration plan and cannot be inferred from this journal. Section 5 viewer setup, section 6 full browser/artifact acceptance and hosting remain outside this independently accepted foundation. All five Review Focus lines have named Task 2/3 tests. No plan step marks a journal receipt as complete demo evidence.

Preserved execution method: separate implementer per task, independent task review before proceeding, final review after all three. Before implementation the owner reviews this plan. Checkpoints remain uncommitted; no integration or cleanup follows acceptance automatically.
