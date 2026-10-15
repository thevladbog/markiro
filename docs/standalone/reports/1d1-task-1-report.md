# Task 1 report: карантин записей ленты — `src/local/reference-sync.ts`

## What was implemented

- New migration `apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql`:
  creates `sync_quarantine(entity, id, rev, reason, seen_at)`, key `(entity, id)`,
  no `STRICT`/`WITHOUT ROWID` (matching `0001_reference_data.sql`).
- `apps/standalone/src/local/reference-sync.ts` rewritten (verbatim from the brief):
  - `SyncResult`'s `"synced"` branch now carries `quarantined: number`.
  - `SyncOptions` gained `now?: () => number` (defaults to `Date.now`), used only
    for `sync_quarantine.seen_at`.
  - New `SyncFeedError extends Error` (`name: "SyncFeedError"`) replaces the two
    plain `Error`s previously thrown for a feed contract violation (double
    rollback in one run; `hasMore` without progress).
  - `ENTITIES` entries now `check` (Zod `safeParse`, returning either a flattened
    row or a `{ reason }`) instead of `row` (which threw on a bad record).
  - `ENTITY_SET` gained a schema-version suffix: `SYNC_SCHEMA_VERSION = 2`, so
    `ENTITY_SET === "org_profile,site,lines;v2"`.
  - `pageStatements` now, per entity, folds tombstones **and** unreadable
    records into one conditional `deleteOlder` delete (same SQL, fails closed:
    an older local copy of an unreadable record is removed only if the
    quarantined revision is newer — the tombstone rule), and emits one
    `QUARANTINE` upsert and one `LIFT_QUARANTINE` delete per page when
    applicable. `quarantineReason` builds `path: code` pairs (`data` for a
    root-level issue), `; `-joined, truncated to 200 characters, never a value.
  - `WIPE` now also clears `sync_quarantine`.
  - After the last page of a run, `syncReferences` does one more `local.query`
    (`SELECT count(*) AS n FROM sync_quarantine`) to fill `quarantined`.
- Test-only/typecheck-only edits to keep the rest of the suite honest about the
  new shapes: `test/local-executor.test.ts` (table list gains `sync_quarantine`),
  `test/api.test.ts` (the change-feed test moved to its own `describe`, per the
  brief's note that this belongs with task 1's file), `test/shell.test.ts` (two
  `SyncResult` literals gained `quarantined: 0` so `shellReducer`'s action type
  still compiles), `src-tauri/tests/local_db.rs` (table list assertion).
- Docs: `apps/standalone/AGENTS.md` ("Change feed" and "Reference sync"
  sections) and `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  (§5.3 table list, §5.4 quarantine/schema-version bullets) updated with the
  brief's exact replacement text.

All fragments named in the brief matched the pre-task files byte for byte
before editing (verified with `grep`/`Read` before touching anything); no
`NEEDS_CONTEXT` situation arose.

## TDD evidence

### RED — TypeScript (`test/reference-sync.test.ts`, `local-executor.test.ts`, `api.test.ts`)

Command (run with the new migration file temporarily moved aside, so the
`sync_quarantine` table genuinely does not exist yet — see "Deviations"):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/local-executor.test.ts test/api.test.ts
```

Result: **19 failed, 79 passed (98)**, 2 test files failed
(`local-executor.test.ts`, `reference-sync.test.ts`), 1 passed (`api.test.ts`)
— matching the brief's "19 тестов из 98" exactly. Failing tests included
`has exactly the shell's reference tables` (local-executor), the `ENTITY_SET`
test, and all 18 listed `reference-sync` cases (the `quarantined`-missing
results, the two `SyncFeedError`-instanceof checks, and all 7 `sync
quarantine` tests, which failed with `unreadable site record 1` /
`unreadable lines record …` since the old `checked()` still threw).

### RED — Rust (`src-tauri/tests/local_db.rs`)

Command (migration still absent, `local_db.rs` already updated to expect
`sync_quarantine` in the table list):

```
pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline
```

Result: **7 passed; 1 failed** —

```
---- opening_creates_the_reference_tables_in_wal_mode_and_keeps_data stdout ----
thread 'opening_creates_the_reference_tables_in_wal_mode_and_keeps_data' panicked at src-tauri/tests/local_db.rs:60:5:
assertion `left == right` failed
  left: ["ref_lines", "ref_org", "ref_site", "sync_state"]
 right: ["ref_lines", "ref_org", "ref_site", "sync_quarantine", "sync_state"]
```

Matches the brief's predicted RED exactly. (This check was captured after the
TypeScript implementation already existed, by transiently moving the
committed migration file aside and rebuilding — see "Deviations" — since it
depends only on the migrations directory, not on `reference-sync.ts`. The
migration was restored immediately after, and `git diff --stat` against the
commit was empty afterwards, confirming no residual change.)

### GREEN — TypeScript

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/local-executor.test.ts test/api.test.ts --reporter=verbose
```

Result: **98 passed (98)**, 3 files passed — 29 in `reference-sync.test.ts`
(1 `ENTITY_SET` + 17 `reference sync` + 7 `sync quarantine` + 4 `sync
scheduler`), 54 in `local-executor.test.ts`, 15 in `api.test.ts`, matching the
brief's expected split exactly. Verbose output showed only test names and the
summary — no stray console output.

### GREEN — Rust

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline
```

Result: **8 passed; 0 failed**, including
`opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`.

## Verification commands and results

| Command                                                                                                                                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                                                                            | 28 files, **490 passed (490)**                                                                                                                                                                                                                                                                                                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                                                                       | clean, no output                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                                                            | clean, no output                                                                                                                                                                                                                                                                                                                                                 |
| `node_modules/.bin/prettier --check` on the 7 changed TS/MD files (all changed files except the new `.sql`, which Prettier has no parser for and which the constraints' pre-commit list does not cover — SQL isn't TS/TSX/JSON/CSS/MD) | `All matched files use Prettier code style!`                                                                                                                                                                                                                                                                                                                     |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                                                                                | clean, no output                                                                                                                                                                                                                                                                                                                                                 |
| `git diff --check`                                                                                                                                                                                                                     | clean, exit 0                                                                                                                                                                                                                                                                                                                                                    |
| `git log -1 --format=%B`                                                                                                                                                                                                               | exactly one `Co-Authored-By` line, matching the required trailer                                                                                                                                                                                                                                                                                                 |
| Independent zod-issue sanity check (ad hoc Node script against the installed `zod@4.4.3`)                                                                                                                                              | confirmed `checked()`'s issue codes for every quarantine-reason fixture in the brief (`badgeSalt: invalid_format; badgeSalt: too_small; palletBlockSize: invalid_type`; `archived: invalid_type`; `name: invalid_type`; the 200-char-truncated org reason; `data: invalid_type` for a record with no `data`) before trusting the brief's verbatim implementation |

Not run: the broader `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
(binds `127.0.0.1`, requires running outside the sandbox) and any Windows/DPAPI
check — out of scope for this task, which only touches a Rust _test assertion_
and a new SQL migration, not `local_db.rs`'s implementation or anything
platform-specific. The brief's own Step 4 and Step 6 only call for the scoped
`--test local_db --offline` run, which passed.

## Files changed

- `apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql` (new)
- `apps/standalone/src/local/reference-sync.ts` (rewritten)
- `apps/standalone/test/reference-sync.test.ts` (rewritten)
- `apps/standalone/test/local-executor.test.ts` (table list)
- `apps/standalone/test/api.test.ts` (test moved to its own `describe`)
- `apps/standalone/test/shell.test.ts` (two literals gained `quarantined: 0`)
- `apps/standalone/src-tauri/tests/local_db.rs` (table list assertion)
- `apps/standalone/AGENTS.md` ("Change feed", "Reference sync" sections)
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.3, §5.4)

Commit: `a9551a559` — `feat(standalone): карантин записей ленты, которые не прошли свою схему`.

**Rust touched:** yes, but only `src-tauri/tests/local_db.rs` (a test
assertion — the table-name list) and the new pure-SQL migration file. No
`.rs` source file (`local_db.rs`, `lib.rs`, etc.) was modified; the crate
picks up the new table purely by re-running its embedded migrations. This
task did not touch any networking, DPAPI or Windows-specific code.

## Deviations

1. **Migration-file ordering during RED.** I created
   `0002_sync_quarantine.sql` before running the Step 2 RED command, which let
   `local-executor.test.ts`'s "has exactly the shell's reference tables" test
   pass prematurely (the table already existed even though
   `reference-sync.ts` hadn't changed yet), so the first RED run showed 18/98
   failing instead of the brief's predicted 19/98. I caught this, moved the
   migration file aside, and re-ran both the Vitest and (after implementing)
   a retroactive Rust RED check to get the exact evidence the brief
   describes; both then matched the brief's predictions exactly (19/98 and
   7-passed/1-failed respectively). The committed migration file and all
   other committed content are unaffected — `git diff --stat` was empty
   after restoring it, both immediately after the TS implementation and
   again after the later retroactive Rust-RED check.
2. No other deviations. Every fragment named in the brief matched the
   pre-task files byte for byte; the implementation, migration SQL, and all
   test/doc edits were applied verbatim as given.

## Self-review findings

- **Completeness against the brief:** all "Produces" interfaces match
  exactly — `sync_quarantine` schema, `SyncResult` (with `quarantined`),
  `SyncOptions` (with `now`), `SyncFeedError` (name `"SyncFeedError"`),
  `ENTITY_SET === "org_profile,site,lines;v2"`, unchanged signatures for
  `syncReferences`/`createSyncScheduler`. The "Сверх брифа" note (merging the
  tombstone delete and the unreadable-record delete into one operator per
  entity, budget 3E+6 instead of 4E+6) is exactly what the shipped
  `pageStatements`/`deleteOlder` does.
- **Names:** `SyncFeedError`, `ENTITY_SET`, `SYNC_SCHEMA_VERSION`,
  `quarantineReason`, `checked`, `Checked`, `QUARANTINE`, `LIFT_QUARANTINE`,
  `countRow` all match the brief's identifiers; no renames introduced.
- **No overbuilding:** the implementation is the brief's code verbatim — no
  extra options, no speculative generality, no handling of entities or
  scenarios beyond what task 1 defines (operators/badges are explicitly
  plan 1d3, untouched here).
- **Tests verify behavior, not implementation details:** the quarantine
  tests assert on the actual `sync_quarantine` table contents (`quarantine()`
  helper reading real rows), the actual `ref_*` table contents after a
  fails-closed delete, and the exact `reason` strings — not on internal call
  counts alone (except the dedicated statement-budget and batch-count tests,
  which are explicitly testing that behavior). I additionally verified
  independently (outside the given implementation) that the real installed
  `zod@4.4.3` produces exactly the issue paths/codes the brief's fixtures
  expect, rather than trusting the brief's text on faith.
- **Output pristine:** confirmed via a `--reporter=verbose` run of the three
  touched test files (98/98) — no console output leaked from any test, and
  the full-suite run (490/490) was likewise clean.
- **Scope discipline:** `git status --short` before starting was clean; only
  the 9 files listed above are staged/committed; `apps/station` untouched;
  no `git stash`, `pnpm install`, or `pnpm add` used anywhere in this session.
- Nothing needed fixing as a result of this self-review.

## Concerns

None. The implementation, tests, and docs are a byte-for-byte match to the
brief, all TDD evidence (including the retroactively-captured Rust RED) lines
up with the brief's own predictions, and every requested verification command
passed. The only thing intentionally left unexercised is the workspace-wide
Cargo test (port-binding, outside this task's scope per the brief), which is
noted above rather than silently skipped.
