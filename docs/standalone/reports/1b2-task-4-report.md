# Task 4 report: Зависимости вебвью, схемы протокола и контракт фикстур

## What was implemented

Followed `.superpowers/sdd/1b2-task-4-brief.md` steps 1–7 in order (TDD).

1. **Dependencies.** Added to `apps/standalone` (outside the sandbox, per the
   brief): `@markiro/domain@workspace:*`, `react-router@8.3.0`,
   `react-hook-form@7.85.0`, `@hookform/resolvers@5.9.1`, all with
   `--save-exact`. Built `@markiro/domain`, `@markiro/ui` and
   `@markiro/platform-contracts` (the workspace deps of `@markiro/standalone`)
   with `turbo run build --filter='@markiro/standalone^...'` so the webview
   reads fresh `dist` output.

2. **Protocol schemas (`apps/standalone/src/host/protocol.ts`).** Replaced the
   file with the brief's Step 4 code verbatim: kept `PROTOCOL_VERSION`,
   `DEFAULT_HOST_PORT`, `LOCAL_HOST_ADDRESS`, `helloSchema` (still `.strict()`)
   and changed `errorBodySchema` from strict to lenient (a host response).
   Added the Rust-shell-payload schemas (`deviceKindSchema`, `officeRoleSchema`,
   `credentialSchema`, `deviceStatusSchema` strict, `hostResponseSchema`
   strict), the lenient host-response schemas (`deviceInfoSchema`,
   `officeUserSchema`, `officeSessionSchema`, `bootstrapResponseSchema`,
   `orgProfileSchema`, `ssccCounterSchema`, `ssccStateSchema`,
   `officeUserRecordSchema`), and the strict request schemas
   (`officeLoginRequestSchema`, `newOfficeUserSchema`, `orgProfileInputSchema`,
   `ssccStartSchema`, `bootstrapRequestSchema`, `orgProfileUpdateSchema`,
   `ssccCounterUpdateSchema`, `blockSizesUpdateSchema`,
   `officeUserCreateSchema`, `officeUserUpdateSchema`, `passwordSetSchema`).
   Every schema and its inferred type is exported, matching the brief's
   interface list exactly.

3. **Fixture contract tests.** Extended `apps/standalone/test/protocol.test.ts`
   with the brief's import list and the `RESPONSES`/`REQUESTS`
   `describe.each` tables plus the `unauthorized errors` block, verbatim.
   Created `apps/standalone/test/phc-contract.test.ts` verbatim, consuming the
   already-existing `proto/fixtures/phc-password.json` (created by an earlier
   plan task) via `@markiro/domain`'s `parsePhc`/`verifyPhc`/`PHC_ITERATIONS`.

4. **ESLint.** Extended the native-form-control ban's `files` array in
   `eslint.config.mjs` from `["apps/admin/src/**/*.{ts,tsx}"]` to also cover
   `"apps/standalone/src/**/*.{ts,tsx}"`. Confirmed no native `input`/`select`/
   `textarea`/`button`/`option`/`datalist` JSX exists yet under
   `apps/standalone/src` (only `main.tsx` and `app/App.tsx` exist from plan 1a),
   so the new rule doesn't fail lint.

5. **CI routing.** In `tools/ci/affected.mjs`, added `...standaloneJobs` after
   `...stationJobs` in `sharedJobs.domain` (the webview now depends on
   `@markiro/domain`). In `tools/ci/test/affected.test.mjs`, added
   `"standalone_rust"` and `"standalone_windows_build"` after
   `"station_windows_build"` in the `packages/domain/src/gtin.ts` case of
   "shared packages fan out to their current consumers", exactly as specified.

## Dependency and lockfile check

- `apps/standalone/package.json` `dependencies` now list exactly:
  `"@hookform/resolvers": "5.9.1"`, `"@markiro/domain": "workspace:*"`,
  `"react-hook-form": "7.85.0"`, `"react-router": "8.3.0"` — the four exact
  versions the brief specified, no others.
- `git diff pnpm-lock.yaml` is a single 12-line insertion, entirely inside the
  existing `apps/standalone` importer block (adds the four new
  specifier/version pairs next to the existing `@markiro/ui`, `react-i18next`,
  `zod` entries; no other importer or package touched).

## TDD evidence

**RED** (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/phc-contract.test.ts`,
run before touching `protocol.ts`): `Test Files 1 failed | 1 passed (2)`,
`Tests 32 failed | 7 passed (39)`. The 7 passing were the 4 pre-existing
`protocol.test.ts` tests (using the schemas already exported at the time:
`helloSchema`, `errorBodySchema`), the already-green
`error-unauthorized.json > parses without losing a field` case (the old
`errorBodySchema` still parsed that fixture), and the 2 `phc-contract.test.ts`
tests (which only touch `@markiro/domain` and the fixture, not `protocol.ts`).
The 32 failures were `TypeError: Cannot read properties of undefined` for
every schema not yet defined (`deviceInfoSchema`, `officeUserSchema`, …) plus
one real assertion failure (`error-unauthorized.json` did not yet tolerate an
added field, because the old `errorBodySchema` was still `.strict()`).

**GREEN** (same command, after implementing `protocol.ts`): `Test Files 2
passed (2)`, `Tests 39 passed (39)` — 37 in `protocol.test.ts` (4 prior + 33
new: 8 response fixtures × 2 + 8 request fixtures × 2 + 1 credential test) and
2 in `phc-contract.test.ts`.

Note: the brief's Step 6 text says "34 new" for `protocol.test.ts`; the actual
count from 8×2 + 8×2 + 1 is 33 (37 total with the 4 prior tests). This is a
one-off arithmetic slip in the brief's prose, not a behavioral discrepancy —
every fixture/schema pair and the credential test described in Step 2 is
present and passing.

Full suite after implementation
(`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`):
`Test Files 5 passed (5)`, `Tests 51 passed (51)` (adds the pre-existing
`app.test.tsx`, `fingerprint.test.ts`, `probe.test.ts` from earlier tasks,
untouched by this one).

## Final checks (all green)

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` → 5 files, 51 tests passed.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` → clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` → clean.
- `node --test tools/ci/test/affected.test.mjs` → 20 tests passed (see deviation below for how it got there).
- `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/package.json eslint.config.mjs tools/ci` → all matched files use Prettier style (a prior `--write` on the exact changed files reported them all already formatted).
- `git diff --check` → clean.

## Files changed

- `apps/standalone/package.json` — four new exact-version dependencies.
- `pnpm-lock.yaml` — matching lockfile entries for those four (only the
  `apps/standalone` importer block).
- `apps/standalone/src/host/protocol.ts` — replaced with the full schema set.
- `apps/standalone/test/protocol.test.ts` — extended import list and new
  fixture-contract tests.
- `apps/standalone/test/phc-contract.test.ts` — new file.
- `eslint.config.mjs` — native-form-control ban now also covers
  `apps/standalone/src`.
- `tools/ci/affected.mjs` — `sharedJobs.domain` now includes
  `...standaloneJobs`.
- `tools/ci/test/affected.test.mjs` — two assertions updated (see deviation).

## Deviations from the brief, with reasons

- **`tools/ci/test/affected.test.mjs`: a second assertion needed updating,
  beyond the one the brief named.** The brief's Step 5 only calls out adding
  `"standalone_rust"`/`"standalone_windows_build"` to the
  `packages/domain/src/gtin.ts` case in "shared packages fan out to their
  current consumers". But `sharedJobs.domain` is also spread into the
  offline-grants routing block in `affected.mjs`
  (`[...sharedJobs.domain, "handheld_android"]`, covering
  `packages/domain/src/offline-grants/*`, `packages/domain/src/product-labels/km.ts`,
  matching `platform-contracts` and `handheld` fixture paths). Adding
  `...standaloneJobs` to `sharedJobs.domain` therefore also adds the two
  standalone jobs to that block's output, which broke the pre-existing test
  "offline grant protocol and signed fixture changes exercise every native
  consumer" (a `deepEqual` against the full enabled-jobs array). This is a
  direct, correct, mechanical consequence of the exact line the brief asked
  for — not a logic change — and `node --test tools/ci/test/affected.test.mjs`
  is one of the mandatory final checks, so I added
  `"standalone_rust"`/`"standalone_windows_build"` after `"handheld_android"`
  in that test's expected array (matching `HEAVY_JOBS` order, which is how
  `enabledJobs()` orders its output) to make the suite green again. I did not
  touch the "validation reprocessing wire producers select Android parity"
  test, which only asserts `jobs.handheld_android === true` and stays
  unaffected. No other test in the file asserts a full array through
  `sharedJobs.domain`.

No other deviations. The brief's code compiled and behaved exactly as written
everywhere else.

## Concerns

- None blocking. The one open question is whether the offline-grants CI block
  cascading into the two new standalone jobs is the intended long-term
  routing (it seems architecturally consistent — those paths are all still
  `@markiro/domain` compilation units the standalone webview depends on — but
  it wasn't explicitly called out in the plan, so a reviewer may want to
  confirm).
- `apps/standalone` still has no form UI (`main.tsx` and `app/App.tsx` only),
  so the new ESLint rule is currently unexercised; it will start mattering
  once Tasks 5+ add real forms.
