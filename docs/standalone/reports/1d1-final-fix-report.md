# Plan 1d1 — final-review fix wave: report

Scope: items A–L of `.superpowers/sdd/1d1-final-fix-brief.md`, constraints in
`.superpowers/sdd/1d1-constraints.md`. Worked in
`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

## A. The quarantine count after a failed run

**Changed:**

- `src/local/reference-sync.ts`: exported `readQuarantineCount(local): Promise<number | null>`,
  wrapping `SELECT count(*) AS n FROM sync_quarantine`; returns `null` on a
  failed read. The success path in `syncReferences` now calls it too
  (`quarantined: (await readQuarantineCount(local)) ?? 0`), so the query lives
  in one place.
- `src/app/host-link.ts`: in the run's `catch`, when `shellActionFor` maps the
  error to no shell action (not a rejection), `await readQuarantineCount(local)`
  and carry the result as `sync_failed`'s new `quarantined: number | null`
  field; re-checks `active` after the await. When there is a shell action
  (rejection), `quarantined` is `null` (nothing to read for a pairing about to
  reset).
- `src/app/shell.ts`: `ShellAction`'s `sync_failed` gained
  `quarantined: number | null`. Reducer: `quarantined: action.quarantined ??
state.sync.quarantined` — `null` keeps the previous count, a number replaces
  it.
- `AGENTS.md` "App shell" section: documents `readQuarantineCount`, that a
  failed run (not a rejection) reads and carries the count too, and the
  null-keeps/number-replaces reducer rule.

**Tests:**

- `test/shell.test.ts` "counts the syncs that brought the copies up to date":
  a `sync_failed` action with `quarantined: 3` now replaces a previous 0.
- `test/shell.test.ts` "keeps why a sync failed through its retry, and the
  quarantine of the last success": extended with `quarantined: null` on the
  intermediate failures (keeps 0, then keeps 2 after a success), plus a new
  `recounted` case where `quarantined: 5` on the action replaces the last
  success's 2.
- `test/app.test.tsx` "shows the quarantine count after a run that failed with
  the host away, as after a restart": seeds `sync_quarantine` (1 row) and
  `sync_state` (`host_id` = `DEVICE_STATUS.hostId`, `entity_set` =
  `ENTITY_SET`, `last_rev` = `10`) directly on `openLocalDb()`'s database,
  renders with a connection that reports `offline` at once and
  `host.getChanges` always rejecting. Asserts «Не приняты записи справочников:
  1» on the floor, then again in the office header after signing in (the fake
  `officeLogin` succeeds independently of the sync failure).

**Red:** with `host-link.ts`'s `quarantined` hard-coded to `null`
unconditionally, the new app test fails:

```
✗ shows the quarantine count after a run that failed with the host away, as after a restart
  expect(await screen.findByText("Не приняты записи справочников: 1"))
  → element not found (waitFor timed out)
```

**Mutation:** with the reducer's fallback changed from
`action.quarantined ?? state.sync.quarantined` to `action.quarantined ?? 0`,
"keeps why a sync failed through its retry…" fails:

```
- quarantined: 2   (expected)
+ quarantined: 0   (received, after mutation)
```

Both reverted and re-verified green (see "Verification commands" below).

## B. `LineSelect` stale read-failure alert

**Changed:** `src/app/LineSelect.tsx`: `readFailed: boolean` → `readFailedAt:
number | null`, set to `sync.synced` on a failed read and to `null` on a
successful one. `content()` now computes `readFailed = readFailedAt ===
sync.synced` instead of trusting the stale boolean across a `sync.synced`
change.

**Test:** `test/line-select.test.tsx` "stops showing a stale read failure once
a new sync succeeds, before the new read itself resolves": a custom
`LocalExecutor` fails the first `query` (for `synced: 1`) and leaves every
later `query` pending. After rerendering with `sync: { ..., synced: 2 }`
(success), asserts the spinner shows and the old failure text is gone — before
the new (still pending) read has any chance to resolve.

**Red:** with `readFailed` reverted to `readFailedAt !== null` (the old
"stays true until a new read resolves" behaviour), the new test fails:

```
✗ stops showing a stale read failure once a new sync succeeds, before the new read itself resolves
  expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy()
  → unable to find the element (the stale Alert was still showing)
```

Reverted and re-verified green.

## C. Line screen double failure text

**Changed:** `src/app/LineSelect.tsx`: `statusSync = lines === null ? {
...sync, failure: null } : sync`, passed to `HostStatusLine` instead of the
raw `sync`. While no lines are listed, the content area already names the
failure in its own words, so the status line shows only `quarantined`; once
lines are listed, nothing else on the screen reports a later failure, so it
gets the real `sync`.

**Tests** (all `test/line-select.test.tsx`, with an online `link`):

- "shows a local failure exactly once when no lines are listed, not doubled by
  the status line": `failure: "local"` — the text is asserted to appear
  exactly once (`getAllByText(...).toHaveLength(1)`).
- "shows no failure line while a retry runs with no lines listed yet":
  `{ kind: "running", failure: "host" }` (the reducer keeps `failure` through
  a retry) — asserts the spinner shows and the "Справочники не обновились…"
  line does not.
- "shows the failure line once lines are already listed, since nothing else
  reports it": lines are read once, then a later run fails without changing
  `synced` (so the read effect does not rerun and the buttons stay) — asserts
  both the buttons and the status line's failure text show.

**Red:** with `statusSync` reverted to the raw `sync`, two of the three new
tests fail:

```
✗ shows a local failure exactly once…
  expected [ Array(2) ] to have a length of 1 but got 2
✗ shows no failure line while a retry runs with no lines listed yet
  expected <span>Справочники не обновились…</span> to be null
✓ shows the failure line once lines are already listed…   (unaffected — this
  branch always used the real `sync`, before and after the fix)
```

Reverted and re-verified green.

## D. Spec §5.1 wording

**Changed:** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
line 313: «хост не ответил» → «запрос к хосту не удался», matching
`errors.sync.host`. No test (prose doc).

## E. `host-status-line.test.tsx` quarantine test

**Changed:** `test/host-status-line.test.tsx`: split "counts the records the
copies did not accept, with the host or without it" (one case, `offline`)
into `it.each` over four link states — online, connecting, offline, and
`status: null` (no link status yet, the case that matters for item A: the
count must show even before/without the shell's own link status).

## F. `hostGuard` requires the stamped row

**Changed:**

- `src/local/reference-sync.ts`: `hostGuard`'s SQL flipped from `... AND value
<> ?` / `expectedChanges: 0` to `... AND value = ?` / `expectedChanges: 1` —
  the batch now aborts unless the `host_id` row still exists **and** still
  equals this run's `hostId`, catching both a re-pair to another host and
  `clear_copies` having deleted the row entirely (`device_forget` mid-flight).
- The "continuing sync" branch's condition gained `stored.hostId === hostId
&&`, so a state whose `entity_set`/`last_rev` match but whose `host_id`
  doesn't (or is absent) falls through to the branch that (re)stamps it,
  instead of being treated as "already correctly stamped" and then failing
  the new guard forever.
- Doc comment on `hostGuard` and the "Reference sync" section of `AGENTS.md`
  rewritten to describe both failure modes the guard now covers.
- The "applies the same page again without changing a record" test's pinned
  batch row-counts updated from `[0, 0, 0, 0, 0, 3]` to `[1, 0, 0, 0, 0, 3]`:
  the guard's own row now reports 1 changed row (it matches and is touched),
  not 0, under the new SQL — a direct, expected consequence of the fix, not a
  behaviour regression (`tables(db)` before/after is still asserted equal).

**Test:** `test/reference-sync.test.ts` "fails a page committed after
clear_copies wiped the local copies mid-flight, instead of resurrecting
them": syncs a device to revision 10, starts a second sync whose fetch is held
open, deletes every row of every table directly (as `clear_copies` would),
then resolves the held fetch with a newer page. Asserts the run rejects with
`LocalDbError`/`changes_mismatch` and every table (including
`sync_quarantine`) stays empty.

**Red:** with `hostGuard` reverted to `value <> ?` / `expectedChanges: 0`, the
new test fails:

```
✗ fails a page committed after clear_copies wiped the local copies mid-flight…
  Error: expected the page to fail against the cleared copies
```

(the old guard finds 0 rows either way against an empty `sync_state`, so it
"passes" and the page commits, resurrecting the wiped pairing's data).

**Mutation (case-2 condition):** with `stored.hostId === hostId &&` dropped
from the continuing-sync branch (guard fix kept), the full
`reference-sync.test.ts` + `app.test.tsx` suites (84 tests) still pass —
**no existing or new test currently reaches this branch with a mismatched
`host_id`**, since every reachable state that has a matching `entity_set` and
`last_rev` was, per the codebase's own invariant ("there are never copies
without a `host_id`"), already stamped with the correct one by whichever run
wrote them. This sub-fix is defensive/forward-looking per the brief's own
reasoning, not a fix for a currently reachable bug; I did not add a synthetic
test for an unreachable state. Flagging this as a known gap rather than
hiding it.

Re-pair race tests ("wipes the copies of a pairing with another host…",
"rejects a stale in-flight page…", "fails the old host's page as soon as…",
"stamps host_id before the first fetch…") all stay green under the new guard
— verified in the full focused run below.

## G. Out-of-date `sqlite_master` references

**Changed:**

- `apps/standalone/AGENTS.md`: "The tables come from `sqlite_master`" →
  "The tables come from `pragma_table_list` (`type IN ('table', 'virtual')`)"
  (folded into the same edit as item H below).
- `src-tauri/tests/local_db.rs` (`clearing_the_copies_empties_every_table…`
  doc comment): "since the list comes from `sqlite_master`" → "…from
  `pragma_table_list`".
- `src-tauri/tests/ipc.rs` (`forgetting_the_device_without_a_local_database…`
  doc comment): removed the false claim that the test above "pairs a real
  `markiro-host` and needs a loopback socket" (it uses an unreadable
  `device.json` and no host at all); replaced with an accurate contrast — both
  tests avoid a real host, the difference is whether `LocalDbState` opens a
  populated database or is never opened.

No behaviour change; doc/comment-only.

## H. `clear_copies` contract, a future data-loss trap

**Changed:**

- `AGENTS.md` (`device_forget`/`clear_copies` paragraph) and the doc comment
  on `LocalDb::clear_copies` in `src-tauri/src/local_db.rs`: both now state
  that every table is treated as a disposable copy of the host's data, and
  that the first plan adding device-owned data (scan journal, boxes, outbox —
  stage 1 spec §6.2) must exclude those tables from `clear_copies` and
  block/confirm a forget while unsynced records exist, not extend the list
  silently.
- `src-tauri/tests/local_db.rs`: added a doc comment on
  `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` (which
  already pinned the exact table list — `ref_lines`, `ref_org`, `ref_site`,
  `sync_quarantine`, `sync_state`) explaining that a new migration's table
  failing this assertion is deliberate: it forces the copy-or-owned decision
  above instead of a silent addition.

No new test needed — the existing assertion already pins the list; only the
explanatory comment was missing.

## I. Quarantine lift at an equal revision

**Changed:** `AGENTS.md` "Reference sync" section: "A newer readable record,
or a tombstone at least as new, lifts the quarantine" → "A readable record or
a tombstone at least as new lifts the quarantine" (both sides are `>=` in the
code; "newer" wrongly implied a strict `>` for records).

**Test:** `test/reference-sync.test.ts` "lifts a quarantine for a readable
record at exactly the quarantined revision": quarantines `LINE_1` at rev 42,
then resends it readable at the same rev 42; asserts it is applied and the
quarantine entry is lifted.

**Mutation:** with `LIFT_QUARANTINE`'s `>=` changed to `>`, exactly the new
test fails and nothing else does:

```
✗ lifts a quarantine for a readable record at exactly the quarantined revision
  (31 other reference-sync.test.ts tests still pass)
```

Reverted and re-verified green.

## J. Wipe coverage of the quarantine

**Changed** (chose the "assert it explicitly" option over widening
`tables()`, since `tables()` is shared by many tests that don't care about
quarantine and would all need a `quarantine: []` addition otherwise):

- "starts again from zero when the host went back to an older revision":
  added `expect(quarantine(db)).toEqual([])`.
- "keeps the previous copies when the rollback's own refetch fails": captures
  `quarantineBefore` alongside `before`, asserts `quarantine(db)` unchanged.
- "stops at a feed from another host without applying anything, even with a
  deferred wipe pending": same `quarantineBefore`/after pattern.
- New test "keeps a quarantine entry through a rollback until the first new
  page lands, not merely the rollback itself": quarantines a record, then a
  rollback whose refetch fails (entry survives — deferred wipe), then a
  rollback whose refetch succeeds (entry cleared with the rest of the
  copies).

## K. Label replay-only expectations

**Changed:** added a one-line comment to two tests in `test/reference-sync.test.ts`:

- "fails closed: an unreadable record newer than the copy deletes it, an
  older one does not" — the `brokenLine(LINE_2, 15)` page (an older revision
  following LINE_2's already-newer rev-20 copy, in a forward-moving,
  non-rollback page) is called out as something only a replay/synthetic feed
  produces.
- "lifts a quarantine for a newer readable record or tombstone, never for an
  older one" — the `tombstone(LINE_1, 40)` case (older than the quarantined
  rev 42) gets the same note.

**Deviation to flag:** the brief names these two scenarios as "a quarantined
count with a newer copy intact" and "an older readable record after a
fail-closed delete". I matched the first to LINE_2's case above (quarantined
count 2, its rev-20 copy stays intact) with high confidence. The second
phrase ("readable") does not literally describe either of my two picks (both
poison/tombstone, not a readable record); after checking every test in the
file for a scenario combining a fail-closed delete with a subsequent older
_readable_ record, I could not find an exact match, so I used the tombstone
case above (same "older item after a newer one, outside a rollback" shape,
directly under the umbrella the brief's own closing sentence describes) as
the best available second instance. If a different pair was intended, please
point at it and I will move the comment.

## L. Small additions

1. `src/app/LineSelect.tsx`: when `lines.length === 0 && sync.quarantined >
0`, shows `shell.lineSelect.emptyQuarantined` instead of
   `shell.lineSelect.empty`. New key added to `src/i18n/ru.json`: «Нет линий,
   которые можно выбрать: часть записей справочников не принята.». Test:
   "says no line can be chosen when the copies have quarantined records".
2. `test/app.test.tsx` "leaves no retry behind and syncs no more once the
   link reports a rejected key": a pending retry (from a failed first sync),
   then a `key_rejected` link status — asserts `vi.getTimerCount()` drops to
   0 and `host.getChanges` is never called again even after advancing well
   past the retry delay.

## Verification commands

All run from `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

| Command                                                                                                                                                                                                                                                    | Result                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`                                                                                                                                                               | OK (domain, platform-contracts, ui built)                                                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/app.test.tsx test/host-status-line.test.tsx test/line-select.test.tsx test/shell.test.ts test/host-link.test.ts --reporter=verbose` | 158/158 passed, exit 0, no stderr, no `act` warnings (checked explicitly)                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                                                                                                | 528/528 passed (29 files)                                                                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                                                                                           | clean                                                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                                                                                | clean                                                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                                                                                                                                               | OK (pre-existing >500kB chunk warning, unrelated to this change)                                                                                   |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                                                                                                    | clean, no diff                                                                                                                                     |
| `cargo test --manifest-path apps/standalone/Cargo.toml --test local_db --offline` (sandboxed)                                                                                                                                                              | 10/10 passed                                                                                                                                       |
| `cargo test --manifest-path apps/standalone/Cargo.toml --test ipc forgetting_the_device --offline` (sandboxed)                                                                                                                                             | 2/2 passed                                                                                                                                         |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside sandbox, some tests bind 127.0.0.1)                                                                                                                                 | 226/226 passed (30 suites), 0 warnings (checked explicitly via `grep -c '^warning\|FAILED\|error\['` → 0)                                          |
| `node_modules/.bin/prettier --check <changed TS/TSX/JSON/MD files>`                                                                                                                                                                                        | initially flagged 5 files (formatting I wrote by hand); `--write` applied, re-`--check` clean; full focused suite re-run afterwards, still 158/158 |
| `git diff --check`                                                                                                                                                                                                                                         | clean                                                                                                                                              |
| `grep -rn "TEMP-REVERT\|TEMP-MUTATE" src test`                                                                                                                                                                                                             | no matches (all temporary red/mutation edits reverted)                                                                                             |
| Cyrillic encoding scan (`git diff` added lines, grep for `\u04`)                                                                                                                                                                                           | 0 matches                                                                                                                                          |

## Deviations / notes

- Item F's case-2 condition addition (`stored.hostId === hostId &&`) has no
  test currently exercising it (see item F above) — documented as a known,
  intentionally defensive change rather than silently claiming coverage that
  doesn't exist.
- Item K's exact test pairing is my best match to the brief's two
  descriptions, not a verbatim identification — see the note under K.
- Item J: chose per-test explicit quarantine assertions over widening the
  shared `tables()` helper, to avoid touching every other test that uses it;
  the brief explicitly offered this as an alternative.
- No other deviations. Items A–I, L implemented and verified as specified;
  `apps/station` untouched; no new dependencies; no `git stash`, `pnpm
install`, or `pnpm add` used.

## Follow-up (on top of `03a838ac3`)

Re-review found A and F's gaps closed (backed by 22 mutations) and named five
remaining small items. Commit: `ce367f34a`.

### 1. Success path silently reported `quarantined: 0` on a failing count read

**Changed:** `src/local/reference-sync.ts`: split the count read in two.
`countQuarantined(local): Promise<number>` (not exported) runs the query and
throws on failure — used by `syncReferences`'s success path
(`quarantined: await countQuarantined(local)`), so a page that committed
cleanly but whose trailing count read fails now fails the whole run
(`LocalDbError` propagates), instead of resolving `{ kind: "synced",
quarantined: 0 }`. `readQuarantineCount` (still exported, still used by
`useHostLink`'s failure-path catch) now wraps `countQuarantined` in a
try/catch and keeps returning `null` on failure — its contract for the
"nothing better to show" case is unchanged.

**Test:** `test/reference-sync.test.ts` "fails the run when a successful
page's own count read fails, instead of reporting quarantined: 0": a
`LocalExecutor` that rejects only `query` calls whose SQL mentions
`sync_quarantine` (the page's own `transaction` write, and the initial
`sync_state` read, both pass through untouched). Asserts the run rejects
with `LocalDbError` / `statement_failed`.

**Red:** with the success path reverted to
`quarantined: (await readQuarantineCount(local)) ?? 0`, the new test fails:

```
✗ fails the run when a successful page's own count read fails…
  promise resolved "{ kind: 'synced', rev: 42, quarantined: 0 }" instead of rejecting
```

Reverted and re-verified green.

### 2. J's assertions without teeth

**Changed:** `test/reference-sync.test.ts`:

- "keeps the previous copies when the rollback's own refetch fails": now
  seeds one `sync_quarantine` row (`site`/`'1'`) right after `syncedTwoLines`,
  before capturing `before`/`quarantineBefore` (asserted `toHaveLength(1)`),
  so the trailing `quarantine(db)).toEqual(quarantineBefore)` actually proves
  survival, not `[] equals []`.
- "stops at a feed from another host without applying anything, even with a
  deferred wipe pending": same seed-and-assert-length pattern.

**Mutation:** temporarily made the `other_host` short-circuit in
`syncReferences` also run `DELETE FROM sync_quarantine` before returning.
The now-seeded "stops at a feed from another host…" test fails:

```
✗ stops at a feed from another host without applying anything…
  expected [] to deeply equal [ { entity: 'site', id: '1', … } ]
```

Reverted (the short-circuit is back to a bare `return { kind: "other_host" }`)
and re-verified green. (The "keeps the previous copies…" test was not put
through a separate mutation, per the coordinator's ask — seeding was the
requested fix there.)

### 3. Pin the quarantine count on the line screen while no lines are listed

**Changed:** no source change — `LineSelect`'s `statusSync` already preserved
`quarantined` while nulling only `failure` (item C of the original wave);
this was a missing-test gap, not a bug.

**Test:** `test/line-select.test.tsx` "shows the quarantine count while no
lines are listed and the sync failed, without the failure line": `{ kind:
"failed", synced: 0, failure: "host", quarantined: 2 }`, online link, no
lines seeded. Asserts «Не приняты записи справочников: 2» shows and
«Справочники не обновились…» does not.

**Mutation:** temporarily changed `statusSync` to also zero `quarantined`
(`{ ...sync, failure: null, quarantined: 0 }`) while `lines === null`. The
new test fails:

```
✗ shows the quarantine count while no lines are listed and the sync failed…
  unable to find an element with the text: Не приняты записи справочников: 2
```

Reverted and re-verified green.

### 4. Test for F's branch-2 condition (`stored.hostId === hostId &&`)

**Changed:** `test/reference-sync.test.ts`: new test "recovers from a state
with entity_set and last_rev but no host_id row, instead of looping on
changes_mismatch forever". Seeds `sync_state` with `last_rev` and
`entity_set` (matching `ENTITY_SET`) but no `host_id` row at all. The feed
mock answers both `since=0` (what the fixed continuing-branch condition
actually reaches — falls through to the branch that stamps `host_id` and
starts from zero) and `since=99` (what the pre-fix condition would have
reached, treating the seeded `last_rev` as current). Asserts exactly one
fetch, from `0`, and `{ kind: "synced", rev: 12, quarantined: 0 }`.

**Mutation:** dropped `stored.hostId === hostId &&` from the continuing
branch's condition. The new test fails exactly as the coordinator predicted:

```
✗ recovers from a state with entity_set and last_rev but no host_id row…
  promise rejected "LocalDbError: UPDATE sync_state SET value = value WHERE
  key = 'host_id' AND value = ?" instead of resolving
  Serialized Error: { code: 'changes_mismatch' }
```

Reverted and re-verified green. This retires the "no test reaches this
branch" gap noted in the original report's item F.

### 5. Wrong spec reference and a `hostGuard` doc nit

**Changed:**

- `apps/standalone/AGENTS.md`, `src-tauri/src/local_db.rs`,
  `src-tauri/tests/local_db.rs`: all three "stage 1 spec §6.2" references
  (which actually named the foundation spec, whose own §6 is the protocol
  contract) now point at the station design's §6.2 ("Логическая модель") —
  `docs/superpowers/specs/2026-09-26-standalone-station-design.md`, called
  "the design" in `AGENTS.md`'s own terms; the two Rust doc comments spell it
  out as "the station design's §6.2" since Rust has no established
  markdown-link shorthand for that document.
- `src/local/reference-sync.ts`'s `hostGuard` doc comment: fixed "the two
  branches above, in `syncReferences`" (`syncReferences` is below `hostGuard`
  in the file, not above) and clarified that only two of the three branches
  actually write the stamp — the continuing branch writes nothing and merely
  requires a previous run's stamp to still match.

No test (doc/comment-only).

### Commands and results (this follow-up)

| Command                                                                                                                                                                           | Result                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/line-select.test.tsx test/app.test.tsx --reporter=verbose` | 106/106 passed, exit 0, no stderr/warnings                                                                                                       |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                       | 531/531 passed (29 files; +3 over the previous wave's 528)                                                                                       |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                  | clean                                                                                                                                            |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                       | clean                                                                                                                                            |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`                                                                           | 10/10 passed                                                                                                                                     |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                           | clean                                                                                                                                            |
| `node_modules/.bin/prettier --check` on the 4 changed TS/MD files                                                                                                                 | flagged `test/reference-sync.test.ts` (my hand-written formatting); `--write` applied, re-`--check` clean, focused suite re-run green afterwards |
| `git diff --check`                                                                                                                                                                | clean                                                                                                                                            |
| `grep -rn "TEMP-REVERT\|TEMP-MUTATE" src test`                                                                                                                                    | no matches after each revert                                                                                                                     |

No deviations from the coordinator's five items. `apps/station` untouched; no
new dependencies; no `git stash`, `pnpm install`, `pnpm add`, or `--amend`
used. New SHA: `ce367f34a`.
