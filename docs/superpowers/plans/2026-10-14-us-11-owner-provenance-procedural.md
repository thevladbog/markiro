# US-11 Sequential Owner Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Reduce five owner-provenance transport calls to one without reducing the five sequential native locking reads or their current-denial semantics.

**Architecture:** An additive versioned VOLATILE invoker function performs the existing five sequential reads and early returns. A private adapter keeps the existing TypeScript interface and canonical JS validation. No caller-carried proof, cache, fallback or isolation change.

**Tech Stack:** PostgreSQL17/PLpgSQL, Drizzle migrations, strict TypeScript/Zod, Vitest, existing owned US fixtures and CI ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-owner-provenance-procedural-design.md`

## Global Constraints

- Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve all unrelated/uncommitted unit-composition work and planning docs. Root owns commits/push; workers no agents/commit/push.
- Exact SQL signature `public.us_development_owner_provenance_v1(pg_catalog.text, pg_catalog.jsonb) RETURNS pg_catalog.jsonb`; VOLATILE, PARALLEL UNSAFE, SECURITY INVOKER, CALLED ON NULL INPUT, search_path=pg_catalog; schema-qualified relations/builtins.
- Preserve five separate sequential commands, complete matching-row enumeration/share locks, early denial, READ COMMITTED and REPEATABLE READ behavior. No joined single-snapshot CTE, result cache, supplied proof, skip mode, retry or exception swallowing.
- CREATE and REVOKE PUBLIC execute in one ordinary migration transaction. Migration owner only, no new roles or PUBLIC/read/write grants. Existing journal has no edition filter; additive migration is isolated by branch/callers, not an invented installer.
- Normal interfaces, finite-Date check before SQL/argument preparation, reserved seed constants, unlocked/provisioning/password behavior, database/user and capability/profile checks unchanged. Preserve audit JSON.stringify in JS.
- Only explicit loopback US_TEST_DATABASE_URL target127.0.0.1:55432/markiro_us_dev/user markiro_us, DATABASE_URL unset; owned children tracked/drained/normally disposed/verified absent. No shared/live DB, unknown resources/processes/env, overlapping native/build worker.
- No larger body/hook/SQL timers, assertion removal, setup relocation, filtered acceptance, RU/main/Station, public HTTP, Requests, PR, release or hosting. Original full900000ms test/fixture/snapshot byte-identical. Task1 unit composition, Shipping221 and full262 remain OPEN.

## Review Focus

- A duplicate membership/account/audit committed while organization lock is awaited must cause denial, not be hidden by a statement snapshot.
- Earlier denial must not resolve/lock later missing or ACCESS EXCLUSIVE-held relations, including warmed function plans.
- Actor undefined, JSON null, hostile objects, NUL and unpaired surrogates retain legacy lock/error ordering without coercion or early JS denial.
- Function execute permission is not table-read authority; invoker must still fail on body permissions and shadow objects must not redirect reads.
- Every matching duplicate/invalid row stays share-locked; no limit/partial scan, cached proof, or lost native error identity.

---

### Task 1: Versioned sequential function and real differential proof

**Files:**

- Create `packages/db/migrations/0144_us_owner_provenance.sql` and append ordinary generated journal/metadata, using the next available index if144 has changed after recheck.
- Create `packages/db/test/us-owner-provenance-migration.test.ts` for migration/function contract and journal/runtime packaging parity.
- Create `apps/api/test/support/us-owner-provenance-reference.ts`: test-only exact previous locked reader and native candidate decoding, no production fallback.
- Create `apps/api/test/us-owner-provenance-procedure.e2e.test.ts` and `apps/api/test/us-owner-provenance-procedure-locks.e2e.test.ts`; use existing owned fixture/drain patterns, no fixture/pin edits.
- Do not modify the production owner adapter or unit composition in this task.

**Interfaces:** SQL function accepts tenant text and actor JSON scalar. SQL NULL actor represents old undefined; string is exact identity; JSON null is a supplied invalid identity. It returns SQL NULL on upstream rejection or one bounded facts object, never a trusted public capability. Define this exact wire shape for Task2:

```ts
type OwnerFacts = {
  codec: "us-development-owner-provenance-v1";
  organization: { id: string; name: string; metadata: string | null };
  user: { id: string; name: string };
  memberships: { count: number; soleRole: string | null };
  credentials: { count: number; soleAccountId: string | null; nonemptyPassword: boolean };
  audits: {
    count: number;
    sole: {
      actorUserId: string | null;
      outcome: string;
      targetType: string;
      targetId: string | null;
      before: unknown;
      after: unknown;
    } | null;
  };
};
```

- [ ] Read full spec and copied approved design review in this plan's workspace; read current owner reader, target/master-data/journal guards, auth/team schemas, db Drizzle config and migration runtime. Record source/fixture hashes and actual migration head before editing. Build affected shared dependencies with declared Corepack pnpm before consumers; isolated mutable outputs only.
- [ ] Retain the previous five-query reader verbatim in the test-only reference, including actor undefined semantics, complete enumeration and exact JSON.stringify. No password/hash output; reference returns original safe metadata/null.
- [ ] Add a native RED that validates legacy safe result, then calls the absent candidate function through the exact signature; failure must reach owned native body, not fixture setup. Also pin migration contract before implementation:

```ts
const result = await fixture.db.execute<{ facts: unknown }>(sql`
  SELECT public.us_development_owner_provenance_v1(
    ${tenantId}::pg_catalog.text, ${JSON.stringify(actorId)}::pg_catalog.jsonb
  ) AS facts
`);
expect(result.rows).toHaveLength(1);
expect(result.rows[0]?.facts).toMatchObject({ codec: "us-development-owner-provenance-v1" });
```

- [ ] Generate an additive custom migration with Corepack Drizzle tooling; fill SQL using apply_patch. Do not rewrite any applied migration/snapshot. Ordinary runtime migration transaction must contain function creation and exact-signature PUBLIC revoke. Use only builtin types/generic RECORD declarations, not table %ROWTYPE/%TYPE/composites or initializers touching later relations.
- [ ] Implement this explicit function declaration and sequential algorithm, with no dynamic SQL, business writes, exception blocks or transaction control:

```sql
CREATE FUNCTION public.us_development_owner_provenance_v1(
  p_tenant pg_catalog.text, p_actor pg_catalog.jsonb
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY INVOKER
CALLED ON NULL INPUT SET search_path = pg_catalog
```

Query organization by original id/slug FOR SHARE; return NULL on missing/name/metadata mismatch using null-total byte-exact JS-equivalent gates. Query reserved-email user FOR SHARE; validate original name and scalar actor only now. Enumerate ALL matching memberships in one locking query; after full scan require count1/role owner. Enumerate ALL credential-provider accounts in one locking query; after full scan require count1, exact account_id=user.id, password neither SQL NULL nor empty (whitespace valid). Enumerate ALL original provisioning-action audits in one locking query. Return bounded count/sole-row facts for JS terminal audit validation; no hash is returned. Keep original database selector semantics distinct from JS-equivalent gate comparisons, and use deterministic C text identity for gates.

- [ ] Build a parameterized differential matrix comparing candidate-decoded safe metadata with the exact reference: valid/foreign/empty actor; invalid date/no SQL; organization/name/metadata/slug, user/email/name, missing/duplicate/non-owner membership, missing/duplicate/misbound/empty/whitespace credential, missing/duplicate/invalid actor/outcome/target/before/after audit, exact null and JSON serialization variants. Candidate terminal audit decision stays in JS, not jsonb containment/equality.
- [ ] Exercise all five Review Focus classes. Use real two-connection barriers, observed pg_blocking_pids rather than sleeps: organization writer holds FOR UPDATE; reader is confirmed blocked; writer adds duplicate membership, credential or audit then commits; both readers deny. Include existing-row updates/deletion/replacement and rows moving into/out of later selectors before their later query, preserving EvalPlanQual semantics. Test READ COMMITTED and REPEATABLE READ with each execution's emitted native cause identity, not object identity between separate runs.
- [ ] Prove full share-lock retention, duplicates/invalid rows included, and early denial without later table ACCESS EXCLUSIVE waits or missing-relation failures. Run cold backend plus multiple committed successful warm calls before altering/locking an unreachable later relation; no warm transaction locks left open. Executed missing relation must propagate; unreachable missing relation must not.
- [ ] Pin pg_proc signature/owner/volatility/parallel/security/null-input/search_path and complete ACL (including unexpected default grants). Test actual no-EXECUTE denial and, separately, body-level SELECT denial using an existing restricted PostgreSQL role with transaction-local EXECUTE grant rolled back in owned DB, no table privileges and no cluster role creation. If no such role exists, report blocked native permission coverage; do not substitute owner success. Schema-qualified exact builtin casts and search-path/temporary shadow tests required.
- [ ] In the same migration transaction, reject unexpected non-owner EXECUTE ACL entries after PUBLIC revoke; do not assume default ACLs are harmless or silently revoke unrelated grants. A real owned-database altered-default-ACL fixture must fail the migration atomically, leave no installed function/journal advancement, and roll back its local privilege changes. Superuser inherent powers are not explicit ACL grants and are not claimed to be constrained by function ACL.
- [ ] Test real runtime migration fresh install, repeat no-op/journal parity and atomic function/PUBLIC-revoke lifecycle. Pin constants against current owner source. Missing/unexecutable function remains infrastructure failure; no on-demand install/fallback. Capture raw logs and normal child absence for every native invocation.
- [ ] Run focused native files serially with verbose reporter and strict target checks; then DB tests/typecheck/lint/build, API typecheck and focused format/diff. Use original budgets; on failure read exact phase before source change, no unchanged retries. Report static/native/skipped gates separately and return unstaged source for root/independent review.
      Standard package tests must not accidentally launch the original full262 gate: unset DATABASE_URL and US_TEST_DATABASE_URL for broad static/unit package tests and explicitly report infrastructure skips; enable only the exact selected focused native suites with the canonical US fixture. Do not load the user's .env or treat skipped database suites as native acceptance.

### Task 2: Private locked adapter, CI ownership and measured consumers

**Files:**

- Modify `apps/api/src/deployment/us-development-owner.ts` only locked verification/private canonical helpers; public signatures and unlocked/provisioning/password behavior unchanged.
- Create `apps/api/test/us-owner-provenance-adapter.e2e.test.ts` for exact adapter/reference parity, hostile input and native failures.
- Modify `.github/workflows/us-development.yml`, `tools/us-development/test/support/prepared-services-owner.mjs`, `tools/us-development/test/dataset-prepared-services-ownership.test.mjs` with exact additive native selectors and independent pins; preserve prior literal/history/mutation defenses and budgets.
- Existing owner/target/master-data/native consumer tests only gain assertions; any interceptor adaptation needs root review before edit. No unit coordinator or full-test change.
- Reviewed transport-count exception: in `apps/api/test/us-dataset-shipping-prerequisites.e2e.test.ts` only the two existing measurement bodies update exact scalar48→32 and batch12→8 assertions after real scalar RED32 and the independently specified5→1 guard change. Preserve all value/receipt/no-write/snapshot assertions and original60000 bodies; predicted8 must be confirmed by native assertion, not assumed. No other counter/interceptor edits without root evidence review.
- Second reviewed transport-count exception after the actual Shipping221 RED: in `apps/api/test/us-dataset-journal-reader.e2e.test.ts` only `expect(measured.count).toBe(12)` and `expect(statements).toHaveLength(12)` become exact8. One owner guard5→1 saves4: BEGIN + actual target + owner function + membership + profile + header + stages + COMMIT =8. Preserve all separate transaction/target/header assertions, no-write snapshots, committed-membership recheck and original bodies. No timer or interceptor adaptation; the complete reader file must pass after the two literal edits. The aggregate45 timing failures remain unresolved, not waived by these edits.

**Interfaces:** consumes Task1 exact SQL signature/OwnerFacts wire; produces unchanged `verifyLockedTrustedSeed(tenantId, actorUserId, verifiedAt, transaction)` return metadata/null. Facts codec/validators stay private, no exported accepts-proof function.

- [ ] First add actual native RED asserting unchanged safe result and desired one client query dispatch; old locked path forwards five. Preserve raw RED before adapting. Use existing parameter-free per-client counter, not source counts or nested instrumentation.
- [ ] Keep finite-Date validation before any SQL/actor encoding. Encode undefined as SQL NULL, valid well-formed primitive strings through JSON.stringify, and supplied non-strings/NUL/unpaired-surrogate strings as JSON null WITHOUT early JS return, coercion/getter/toJSON/toPostgres invocation. Retain original actor value for final strict JS checks. Journal context still requires actor normally.
- [ ] Execute exactly once, schema-qualified/cast, strict private decoding of OwnerFacts or SQL NULL; malformed wire fails as `us_development_owner_provenance_contract_invalid`, never trusted or silently denied. Keep canonical JS organization/user/count/role/account/nonempty/audit checks and safe return exact. Do not catch/wrap/replace emitted native failures. Share pure private predicates with existing reader only if its original early-read order/behavior remains unchanged.

```ts
const native = await transaction.execute<{ facts: unknown }>(sql`
  SELECT public.us_development_owner_provenance_v1(
    ${tenantId}::pg_catalog.text, ${encodedActor}::pg_catalog.jsonb
  ) AS facts
`);
// Decode exactly one row/known codec privately, then apply canonical JS predicates.
```

- [ ] Repeat all ordinary/hostile actor cases through actual public locked method: undefined/null/number/boolean/bigint/symbol/String object, throwing getters/toJSON/toPostgres, NUL, both unpaired surrogate kinds, valid surrogate pair, wrong/empty/normal identity. Preserve organization/user lock/error order before invalid-actor denial; SQL NULL tenant and invalid Date do not accidentally bypass function execution or reorder errors.
- [ ] Test own-transaction mutations and later calls under both isolation levels, no write-on-verify full-table snapshots, actual driver/permission/lock-timeout cause identity and missing/unexecutable function without fallback. Replay parent protected-boundary denial-before-selector tests and unmodified capability/profile authorization tests.
- [ ] Add exact three new API native selectors for Task1 procedure/procedure-locks and Task2 adapter to reviewed prepared-services job/helper/independent pin; all existing selectors/historical pins/duplicate/missing/filter-denial checks remain. Add one separate `@markiro/db` native step in the same additive job, after its API native step, selecting `test/us-owner-provenance-migration.test.ts` with the canonical fixture and normal failure propagation. Pin its exact command, unique selector, fixture and step order independently. Do not alter predecessor office DB runner or historical workflow hashes. Test effective ownership, not a skipped surface.
- [ ] Measure client dispatches and native logical reads separately: standalone locked guard5-to1 transport while retaining5 internal statements; journal guards, creation/verify/replay for regular0/1/181/259 plus a small populated range and both specials. Original new unit-composition tests keep combined default5000 body; do not alter their assertions/budgets/layout to fit. Root authorizes one source-changed focused candidate run after evidence, not repeated retries. Full262 still unrun until whole-budget margin is justified.
- [ ] Run existing owner, journal-batch, target, master-data, terminal-projection and bounded native regressions, then original Shipping221 serial aggregate with full raw capture; no timeout relaxation. Run all Node tools/CI tests and relevant API+DB package gates/focused formatting/diff. Preserve full-test/fixture/snapshot hashes. Independent Task2 and most-capable full selected-plan review precede any scoped root commit/push.
- [ ] Report actual counts/timing uncertainty, exact RED/GREEN/raw logs/owned cleanup, remaining Task1 coverage and full262/same-SHA CI gates. Resume unit-composition plan only after this prerequisite is independently accepted. No claim that transport savings alone completes development.

## Integration status and diagnosed child prerequisite

The owner SQL/native adapter and exact counter corrections have focused native
and independent-review evidence, but this plan's integration/performance
acceptance remains open: Shipping has 45 original-budget timing failures and the
unchanged two-test unit composition gate remains RED. The corrected isolated
ordinary API aggregate subsequently passed 4761 tests with 3707 explicit skips;
that is not opt-in US-native or full-dataset acceptance.

The separately reviewed `2026-10-14-us-11-closed-terminal-readers.md` plan is a
diagnosed child prerequisite for those remaining costs, not completion of this
plan or resumption of the unit coordinator. Parent performance/global gates must
be re-evaluated after that changed path. No release, push or timeout waiver is
implied by either plan.
