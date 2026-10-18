# Task 3 report — link to the host and reference sync in the shell, another host, office by revision (plan 1c3)

## Status: DONE

Two commits, both on `claude/autonomous-desktop-station-9e6f13`:

1. `fa8d5dda0d8735588be32e1a8eb4ecedc4e174f9` (short `fa8d5dda0`) —
   `feat(standalone): связь с хостом и синхронизация в оболочке, другой хост, офис по ревизии`
   (Task 3 itself, amended once by "Fix round 1").
2. `550aba24e259f870479c223eb5da2b4716cf5bf7` (short `550aba24e`) —
   `fix(standalone): ревью задачи 3 плана 1c3 — другой хост останавливает синхронизацию`
   (a new commit on top, "Fix round 2" below — `other_host` did not actually
   stop the sync in every case).

Original, now-superseded Task 3 commit (kept here for history only, not on
the branch): `aefe4a3923157bf299c077ef5e8f4d7915feb2ff` (short `aefe4a392`).

The sections below ("What was implemented" through "Self-review") describe
the state at the original commit, including the deviation the controller
ruled was a bug, not a decision. Read "Fix round 1" and then "Fix round 2" at
the end of this file for the authoritative, current state.

## What was implemented

1. `apps/standalone/src/app/shell.ts` — `SyncState`, `ShellState.link` /
   `.sync` / `.hostRevision`, view `{ kind: "other_host"; hostAddress }`,
   actions `link_status` / `host_revision` / `sync_started` /
   `sync_finished` / `sync_failed`, `linkRejection()` (maps a link's
   `lastError` of `key_rejected`/`certificate_mismatch` to the same
   `RejectionReason` an office call would produce), `nextShellView` stopping
   at `other_host` right after a rejected device, and `forgotten` clearing
   `link`/`sync`/`hostRevision`.
2. `apps/standalone/src/app/host-link.ts` (new) — `useHostLink`: one
   `connection.watch` subscription and one `createSyncScheduler` while a host
   is paired. The first sync fires only once `watch` has resolved (or
   failed), not before, so a revision announced before the subscription is
   never missed; every later revision event re-triggers the scheduler. A
   `syncReferences` failure runs it through `shellActionFor(error, null)`
   (rejecting the device on `key_rejected`/`certificate_mismatch`) and always
   also dispatches `sync_failed`.
3. `apps/standalone/src/app/screens.tsx` — `DeviceRejectedScreen` gained
   `remoteAddress: string | null` and picks between
   `shell.deviceRejected.hostChanged` (host on this computer) and
   `shell.deviceRejected.hostChangedRemote` (a named remote host); new
   `OtherHostScreen`.
4. `apps/standalone/src/app/App.tsx` — wires `connection`/`local` props
   (defaulting to the Tauri implementations), computes `remoteAddress` from
   the paired status, calls `useHostLink` with `hostId` gated on
   paired-and-not-rejected-and-not-other_host, passes `hostRevision` to
   `Office`, and renders `OtherHostScreen`.
5. `apps/standalone/src/office/Office.tsx` — `OfficeProps.hostRevision`; an
   effect keyed on `[hostRevision, session]` calls `session.refreshUser()`
   exactly once per new revision (guarded by a `useRef` so the second effect
   run after `refreshUser` itself changes `session` is a no-op). See
   "Deviations" for a second effect added here.
6. `apps/standalone/src/i18n/ru.json` — `shell.deviceRejected.hostChangedRemote`,
   `shell.otherHost.{title,body,repair}`.
7. `apps/standalone/AGENTS.md` — new "App shell" section before "Office
   pages" (plus one clause of my own, see "Deviations").
8. Tests: `test/support/fixtures.ts` (`LINE_ID`), `test/support/office.tsx`
   (`renderOffice` takes optional `OfficeProps` minus `session`),
   `test/shell.test.ts` (+6 tests, "link and reference sync"),
   `test/office.test.tsx` (+1 test), `test/app.test.tsx` (`fakeConnection()`,
   `feedPage`/`lineItem` helpers, +5 tests) — all copied from the brief
   verbatim.

## TDD evidence

I used a git-based RED/GREEN split rather than writing-then-reverting by
hand: after writing every test and implementation file, I committed all of it
as a throwaway checkpoint (`wip: checkpoint ...`, never pushed, later
undone with `git reset --soft HEAD~1` before the real commit), then used
`git checkout HEAD~1 -- <implementation files>` plus `rm host-link.ts` to put
only the _implementation_ back to its pre-task state while keeping the new
tests, ran the suite (RED), restored the implementation with
`git checkout HEAD -- <files>` (GREEN), and only then produced the final
commit. No `git stash` was used anywhere, per the constraints.

### RED

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`
(new tests present; `shell.ts`, `screens.tsx`, `App.tsx`, `Office.tsx`,
`ru.json` reverted to their pre-task content; `host-link.ts` deleted)

```
 ❯ test/shell.test.ts (29 tests | 6 failed)
 ❯ test/office.test.tsx (23 tests | 1 failed)
 ❯ test/app.test.tsx (28 tests | 5 failed)

⎯⎯⎯⎯⎯⎯ Failed Tests 12 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/app.test.tsx > App > keeps the local copies in step with the host: at start and after every revision
 FAIL  test/app.test.tsx > App > sends a device whose key the host refuses on the link to pairing again
 FAIL  test/app.test.tsx > App > names the remote host whose certificate changed on the link
 FAIL  test/app.test.tsx > App > stops at a host that is not the paired one and pairs again from scratch
 FAIL  test/app.test.tsx > App > reads open office data and the user again when the host announces a revision
 FAIL  test/office.test.tsx > Office > re-reads the signed-in user on a new host revision and leaves the open page alone
 FAIL  test/shell.test.ts > link and reference sync > keeps the link status the shell reports
 FAIL  test/shell.test.ts > link and reference sync > treats a refused key or a changed certificate on the link as a rejected device
 FAIL  test/shell.test.ts > link and reference sync > keeps the latest revision the host announced
 FAIL  test/shell.test.ts > link and reference sync > counts the syncs that brought the copies up to date
 FAIL  test/shell.test.ts > link and reference sync > stops at another host before anything else but a rejected device
 FAIL  test/shell.test.ts > link and reference sync > forgets the link, the sync and the revision with the pairing

 Test Files  3 failed (3)
      Tests  12 failed | 68 passed (80)
```

Exactly the 12 new tests fail (representative errors: `TypeError: Cannot read
properties of undefined (reading 'link'/'rejection'/'hostRevision'/'sync'/
'office')` in the reducer tests — the new fields and actions did not exist
yet; `waitFor(...)` timeouts in the app tests, since nothing dispatched
`link_status`/synced anything). All 68 pre-existing tests in these three
files still passed, matching the brief's "Expected: FAIL ... Прежние тесты
проходят."

### GREEN

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`
(implementation restored, including the deviation described below)

```
 Test Files  3 passed (3)
      Tests  80 passed (80)
```

29 in `shell.test.ts`, 28 in `app.test.tsx`, 23 in `office.test.tsx` — matches
the brief's stated expectation exactly. No `act(...)` warning or console
error/warning appears anywhere in the output (checked with
`grep -iE "act\(|warning|console\."`, zero matches).

Note: my first GREEN attempt, with `Office.tsx` exactly as the brief gives
it, left one test failing —
`App > reads open office data and the user again when the host announces a
revision` — with `AssertionError: expected "vi.fn()" to be called 2 times,
but got 1 times` on `host.getOrg`. See "Deviations" for the fix and why it
does not conflict with the isolated `office.test.tsx` assertion that the open
page does _not_ reread on revision.

## Verification commands and results

| Command                                                                          | Result                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `... exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`  | PASS — 80/80 (see GREEN above)                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`      | PASS — 23 files, 369/369 (was 357 per the brief's stated baseline; +12 new tests)                                           |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` | PASS — `tsc -p tsconfig.json --noEmit`, no output                                                                           |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`      | PASS — `eslint .`, no output                                                                                                |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`     | PASS — vite build succeeded (pre-existing "chunk >500kB" advisory note only, unrelated to this change)                      |
| `node_modules/.bin/prettier --check <12 changed files>`                          | PASS — "All matched files use Prettier code style!"                                                                         |
| `git diff --check HEAD~1 HEAD -- apps/standalone`                                | PASS — exit 0, no whitespace errors                                                                                         |
| `git log -1 --format=%B`                                                         | Subject + blank line + `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (see "Deviations" on the trailer identity) |

Not run: Cargo/Rust checks (this task touches no Rust file; constraints say
Rust only changes in task 2) and any browser/Tauri/hardware verification
(this is a jsdom/Vitest-only surface for this task; no `apps/station` or
`apps/admin` files were touched, per the rules).

## Files changed

- `apps/standalone/src/app/shell.ts` (+62/-2)
- `apps/standalone/src/app/host-link.ts` (new, 86 lines)
- `apps/standalone/src/app/screens.tsx` (+41/-4)
- `apps/standalone/src/app/App.tsx` (+43/-2)
- `apps/standalone/src/office/Office.tsx` (+29/-2, includes the deviation)
- `apps/standalone/src/i18n/ru.json` (+6)
- `apps/standalone/AGENTS.md` (+19, includes one clause of my own)
- `apps/standalone/test/app.test.tsx` (+189/-1)
- `apps/standalone/test/shell.test.ts` (+90)
- `apps/standalone/test/office.test.tsx` (+23)
- `apps/standalone/test/support/fixtures.ts` (+1)
- `apps/standalone/test/support/office.tsx` (+8/-1)

Commit diffstat: `12 files changed, 587 insertions(+), 22 deletions(-)`. No
other file touched — verified with `git status --short` before staging and
`git show --stat HEAD` after committing. `apps/station`, `apps/admin` and all
Rust are untouched.

## Deviations

1. **Attribution trailer.** The brief and the orchestrator's task both say
   the trailer must be exactly `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`. A later, more specific system reminder in this
   session states the current attribution rule (`Co-Authored-By: Claude
Sonnet 5 <noreply@anthropic.com>`) and says it _replaces_ "Claude Code's
   own earlier attribution guidance, such as a previous copy of this
   reminder," and that only the user's own instructions (CLAUDE.md, a memory
   rule) override it — not instructions embedded in a brief. Since I am
   running as Sonnet 5 (per this session's system prompt) and the brief's
   "Opus 5.5" line is exactly the kind of stale, baked-in attribution text
   that reminder is designed to override, I used the Sonnet 5 trailer. This
   is a substantive deviation from an explicit instruction in my task, so
   flagging it clearly: **if the orchestrator/user actually wants the
   Opus 5.5 trailer, the commit needs `git commit --amend`.**

2. **`Office.tsx` needed a second effect beyond the brief's given code.** With
   `Office.tsx` exactly as the brief specifies (only the `hostRevision`/
   `session`-keyed effect calling `session.refreshUser()`), the new
   `app.test.tsx` test `"reads open office data and the user again when the
host announces a revision"` failed: `host.getOrg` was called once, not
   twice, after `link.revision(44)`. Tracing it through: `link.revision(44)`
   dispatches `host_revision` (does not touch `state.office.session`, so
   `Office`'s `session` prop is unchanged) → `Office`'s effect fires because
   `hostRevision` changed → `session.refreshUser()` → `hostApi.officeMe`
   resolves → dispatches `office_user_refreshed`, which _does_ build a new
   `state.office.session` object → `App`'s `officeSession` `useMemo`
   recomputes (its deps include `session`) → `Office` receives a new
   `session` prop object (same token, so no remount — `key={session.token}`
   is unchanged). None of that, by itself, makes TanStack Query refetch
   `officeKeys.org`: a query's `queryFn` identity changing on a re-render is
   not one of its refetch triggers (mount, window focus, reconnect, explicit
   invalidate — the first three are all off or inapplicable here). I
   verified this empirically, not just by reasoning: with only the brief's
   code, the count stayed at 1.

   The isolated `office.test.tsx` test right before it in the brief
   (`"re-reads the signed-in user on a new host revision and leaves the open
page alone"`) asserts the _opposite_ — `getOrg` stays at 1 — but that test
   passes the _same_ `session` object reference on both renders (a
   hand-written fake whose `refreshUser` is a no-op mock, so no new session
   object is ever built). The two tests are only compatible if the trigger is
   "the session object itself changed" (which happens only when a real
   `refreshUser()` succeeds and replaces the session), not "the revision
   changed" or "`refreshUser` was called."

   Fix (in `Office.tsx`, `apps/standalone/src/office/Office.tsx:42-47`): a
   second `useRef`/`useEffect` pair, keyed on `session`, that calls
   `queryClient.invalidateQueries()` once when `session`'s reference actually
   changes:

   ```tsx
   const shownSession = useRef(session);
   useEffect(() => {
     if (shownSession.current === session) return;
     shownSession.current = session;
     void queryClient.invalidateQueries();
   }, [session, queryClient]);
   ```

   This is additive, not a rewrite of the brief's given effect. It does not
   contradict "an open page is not reloaded": `invalidateQueries()` triggers
   a _background_ refetch of already-mounted (active) queries only — it does
   not reset `isPending`/show a loader for a query that already has data, and
   it never touches `OrgProfileForm`'s `key`, which tracks the _record's own_
   `rev` (`org.data.rev`), not the session or the host revision — so a
   half-typed edit still survives even if this fires while the user is
   mid-edit and the refetched data happens to differ. I re-verified this by
   confirming the isolated `office.test.tsx` test (same session reference
   throughout) is unaffected and still asserts `getOrg` stays at 1, and by
   checking every _existing_ test that also reaches `office_user_refreshed`
   (the two `"forbidden"` tests in `app.test.tsx`) — neither has an org/sscc/
   users page mounted at that point, so `invalidateQueries()` there has
   nothing active to refetch and changes nothing observable.

   I added one clarifying clause to the "App shell" AGENTS.md paragraph for
   this (kept the brief's sentences verbatim and appended one more), so the
   doc doesn't read as contradicting the actual code:

   > Once that re-read actually replaces the session (a changed name or
   > role), `Office` also invalidates its query cache so an already-open
   > page's data follows in the background — never a remount, since a form's
   > own key tracks its record's `rev`, not the session or the revision.

   I consider this the smallest change that keeps every assertion (old and
   new) and the stated product invariant (no lost input, no forced page
   reload) intact, per the task's own guidance for a brief test that fails as
   written. Flagging it as a deviation rather than silently folding it in,
   since it is new production behavior the brief's code block did not
   contain.

No other deviation: every other "fragment ... replace with ..." in the brief
matched the current file byte-for-byte on the first try (verified by reading
each target file before editing); none needed NEEDS_CONTEXT.

## Self-review

- **Scope discipline**: only the 12 files the brief lists (plus the one
  extra clause in AGENTS.md and the one extra effect in `Office.tsx`, both
  documented above) were staged and committed. No `apps/station`, no
  `apps/admin`, no Rust file, no `pnpm-lock.yaml`, no `dist`/`.turbo` output
  was touched or staged (`git status --short` was empty immediately after
  the commit).
- **No forbidden operations**: no `git stash` (used a WIP commit +
  `git reset --soft` instead, exactly the pattern the environment's own
  guidance suggests for "commit anything there" before a reversible
  operation); no `pnpm install`/`pnpm add`; no destructive `git` command run
  against anything but my own uncommitted work from this same task, and
  always with the prior state committed first so it was trivially
  recoverable.
- **Non-ASCII check**: per the task's instruction, I grepped every changed
  file for a literal `\uXXXX` (the failure mode called out for this
  environment) — zero matches anywhere, including `ru.json` — and additionally
  ran `od -c` over the new `ru.json` lines to confirm the Cyrillic bytes are
  real UTF-8 (`320`/`321`-prefixed two-byte sequences), not escapes.
- **TypeScript strictness**: no `any`, no `!`, no broad cast anywhere in the
  new code (`host-link.ts`, the `shell.ts`/`screens.tsx`/`App.tsx`/
  `Office.tsx` edits). `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are satisfied — confirmed by a clean
  `typecheck` run, not just by inspection.
- **Test-count sanity check**: the brief's stated baseline (357 tests) plus
  12 new ones predicts 369, which is exactly what the full suite reports —
  no other test file was accidentally affected by the `Office.tsx` addition
  (the two existing `"forbidden"` tests that also reach
  `office_user_refreshed` still pass unchanged).
- **`act(...)` cleanliness**: explicitly grepped the full three-file test
  output for `act(` / `warning` / `console.` — no matches. `fakeConnection()`'s
  `status`/`revision` helpers wrap the handler calls in `act(...)` themselves,
  as the brief specifies, which is what keeps this clean.
- **Ordering assumption I relied on but did not have to add code for**: the
  brief's own controller amendment (`useHostLink` syncs only after `watch`
  resolves or fails, never before) is exactly what's in the code I wrote
  verbatim from the brief — I did not need to change this logic, only
  confirm via the "keeps the local copies in step with the host" test that
  the single sync-then-two-getChanges-calls sequence (`getChanges(0)` at
  start, `getChanges(42)` after the revision) actually happens in that order,
  which it does.
- **What I did not verify**: this task has no Rust, Tauri shell, or browser
  surface of its own (the brief's files are all TypeScript/TSX/JSON/MD), so
  there is nothing beyond the Vitest/typecheck/lint/build/prettier gates
  above to run for it. I did not start the Tauri app or a browser to
  eyeball the new "another host" or "device rejected (remote)" screens —
  only the DOM assertions in the tests confirm their text and structure.

## Fix round 1

Commit: `fa8d5dda0d8735588be32e1a8eb4ecedc4e174f9` (short `fa8d5dda0`),
folded into the Task 3 commit with `git commit --amend` — the branch was
local and unpushed, so this is still "one commit" for Task 3, not a second
one.

### The ruling

The controller resolved both concerns from the original submission: the
brief's `app.test.tsx` test ("reads open office data and the user again when
the host announces a revision") was never updated when the plan's office
decision was amended — `office.test.tsx`'s sibling test _was_ updated, and
that decision governs. The decision is: on a new revision, `Office` re-reads
the signed-in user; an open page is **not** reloaded under the user. My
`invalidateQueries()` addition broke this in practice — `office_user_refreshed`
always builds a new `session` object, so _every_ revision that triggers a
successful `refreshUser()` would invalidate every open page, and when the
underlying record actually changed, `OrgProfileForm` (keyed on `rev`) would
remount and any unsaved edit would be lost silently — exactly what the
decision exists to prevent (a save over a newer record should surface
`stale_revision` instead).

### What changed

1. **`apps/standalone/src/office/Office.tsx`** — removed the second effect
   (`shownSession` ref, its comment block, and the `invalidateQueries()`
   call). The file is now byte-for-byte the brief's original code again
   (confirmed with `git diff HEAD -- apps/standalone/src/office/Office.tsx`
   before staging: exactly an 11-line deletion, nothing else touched).
   `queryClient` needed no further change — it was already used by
   `QueryClientProvider` before my deviation and still is.
2. **`apps/standalone/AGENTS.md`** ("App shell") — deleted the sentence I had
   appended ("Once that re-read actually replaces the session ... not the
   session or the revision."), restoring the paragraph to exactly the
   brief's Step 5 text. The remaining paragraph already ended cleanly on
   "Pages read fresh data whenever they open (`staleTime` 0)." — no
   re-wrapping was needed.
3. **`apps/standalone/test/app.test.tsx`** — replaced the test with
   `"reads the signed-in user again when the host announces a revision and
leaves the open page alone"`: same setup, but
   `host.officeMe.mockResolvedValue({ ...SESSION.user, name: "Ирина Орлова" })`
   (a different name, so the assertion that the name actually shows is
   meaningful, not just "nothing happened"). Before `link.revision(44)`:
   asserts `getOrg` called once and `officeMe` not called yet. After:
   `await screen.findByText("Ирина Орлова")` (the office header renders
   `session.user.name`), asserts `officeMe` was called with the session
   token, flushes pending work with `await act(async () => {})`, then
   asserts `getOrg` is _still_ called only once and the org form
   (`getByLabelText("Название организации")`) is still on screen.

### RED — with the invalidation effect temporarily restored

To prove the new test's negative assertion (`getOrg` stays at 1) actually
exercises the regression, I temporarily reinstated the removed effect in
`Office.tsx`, ran only the new test, and confirmed it fails:

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "reads the signed-in user again when the host announces a revision"`

```
 ❯ test/app.test.tsx (28 tests | 1 failed | 27 skipped) 252ms
     × reads the signed-in user again when the host announces a revision and leaves the open page alone 251ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/app.test.tsx > App > reads the signed-in user again when the host announces a revision and leaves the open page alone
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
 ❯ test/app.test.tsx:722:25
    720|     // Flush any other pending work the revision could have triggered.
    721|     await act(async () => {});
    722|     expect(host.getOrg).toHaveBeenCalledTimes(1);
       |                         ^
    723|     expect(screen.getByLabelText("Название организации")).toBeTruthy();
    724|   });

 Test Files  1 failed (1)
      Tests  1 failed | 27 skipped (28)
```

This confirms `getOrg` really is called a second time when the invalidation
effect is present — the new test would have caught my original deviation.
I then removed the temporary effect again (verified the resulting diff was
exactly the same 11-line deletion as a normal `git diff`, i.e. no leftover
trace of the temporary re-add).

### GREEN and full verification

| Command                                                                                                                                | Result                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `... exec vitest run test/app.test.tsx test/office.test.tsx`                                                                           | PASS — 51/51 (28 + 23)                                                           |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                            | PASS — 23 files, 369/369 (unchanged total: one test replaced, not added/removed) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                       | PASS — no output                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                            | PASS — no output                                                                 |
| `node_modules/.bin/prettier --check apps/standalone/src/office/Office.tsx apps/standalone/AGENTS.md apps/standalone/test/app.test.tsx` | PASS — "All matched files use Prettier code style!"                              |
| `git diff --check HEAD -- apps/standalone`                                                                                             | PASS — exit 0                                                                    |

`act(...)`/warning/console check on the two test files (`grep -iE
"act\(|warning|console\."` over the run output): zero matches.

### Attribution trailer

The original commit used `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
(my own earlier judgment call, explained in the superseded "Deviations"
section above). The coordinator's fix-round instructions were explicit and
repeated that the trailer must be exactly `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>` with no other `Co-Authored-By` line. Before
complying, I checked whether this is a real, established convention in this
repository rather than a one-off request: every prior commit on this branch
(`git log -5 --format="%H%n%B%n---" HEAD~1` before amending) carries exactly
that trailer, back through the whole 1c3/1c2/1c1 series. That is strong
evidence this is the project's actual standing convention for this pipeline,
not stale text a brief forgot to update, so I amended to match it. The final
message, verified with `git log -1 --format=%B`:

```
feat(standalone): связь с хостом и синхронизация в оболочке, другой хост, офис по ревизии

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Exactly one `Co-Authored-By` line, matching the required trailer verbatim.

### Commit

```
git add apps/standalone/AGENTS.md apps/standalone/src/office/Office.tsx apps/standalone/test/app.test.tsx
git commit --amend -m "feat(standalone): ..." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`git status --short` was empty immediately after amending — no other file
touched. Diffstat vs. the pre-task commit: `12 files changed, 580
insertions(+), 22 deletions(-)` (down from 587/22 before the fix, i.e. -7 net
from removing the 11-line effect and the 4-line AGENTS.md sentence, offset by
a slightly longer replacement test).

### New HEAD SHA

`fa8d5dda0d8735588be32e1a8eb4ecedc4e174f9` (short `fa8d5dda0`)

## Fix round 2

Commit: `550aba24e259f870479c223eb5da2b4716cf5bf7` (short `550aba24e`), a new
commit on top of `fa8d5dda0` (not an amend, per the instructions).

### The ruling and the mechanism

The reviewer found that `other_host` did not actually stop the sync in every
case. The brief's own `host-link.ts` code has the bug; the controller ruled
that the brief's stated requirement governs («Лента другого хоста
останавливает синхронизацию»; AGENTS.md's `other_host` — «which only a new
pairing clears»).

Mechanism, as reproduced by the reviewer: `createSyncScheduler`'s `do/while`
loop can start a run a revision queued (`again = true`) immediately after the
run that found `other_host` returns — in the very same microtask chain,
before React has re-rendered with `hostId: null` and run the effect's
cleanup (which is what previously stopped the scheduler and the connection).
So the queued run passes `if (!active) return;` (still true), dispatches
`sync_started` (overwriting `other_host` before any render happens), and
sends a second `getChanges` to the other host. Two concrete failure shapes
follow: (a) if a revision arrives while the first `getChanges` is held open
and the first answer names another host while a second, later answer
succeeds against the paired host, the screen ends up back on the floor
instead of stopped at "another host", and `link.stop` is never called; (b) a
rejected-key or changed-certificate error from a sync had the same problem
in reverse — nothing stopped a run already queued from also reaching a host
that had just refused the device's key.

### What changed, item by item

1. **`apps/standalone/src/app/host-link.ts`**, in the scheduler's run: after
   `syncReferences` resolves and `active` is still true, if
   `result.kind === "other_host"`, call `scheduler.stop()` **before**
   dispatching `sync_finished`. In the `catch`, when
   `shellActionFor(error, null)` returns an action (a rejected device), call
   `scheduler.stop()` before dispatching that action too. Both call sites got
   a comment explaining why: a run a revision already queued during this run
   must not also reach that host, since the effect's cleanup (which used to
   be the only thing stopping the scheduler) only runs after React
   re-renders with `hostId: null`, and that render is later than this
   microtask chain. `scheduler.stop()` sets `stopped = true` inside
   `createSyncScheduler`, which is checked right after `run()` returns in its
   `do { ... } while (again && !stopped)` loop — calling it synchronously,
   before the queued run's iteration starts, is what actually closes the
   race. The "on request" comment near the end of the file (Task 4's path)
   was left exactly as it was, per the instructions.
2. **`apps/standalone/src/app/shell.ts` reducer** — `other_host` is now
   absorbing as a second line of defence: `sync_started`, `sync_finished`
   and `sync_failed` all check `state.sync.kind === "other_host"` first and
   return `state` unchanged when it is (a `sync_finished` with a `"synced"`
   result is included in this check, not just `"other_host"` results).
3. **`apps/standalone/src/app/shell.ts` reducer, `paired`** — also resets
   `sync: IDLE_SYNC`, `link: null` and `hostRevision: null`, exactly like
   `forgotten` already did. Documented why in a comment on the case: between
   `dispatch({ type: "forgotten" })` and the effect's cleanup, a run still in
   flight for the old host can land a late `sync_finished`/`sync_failed`; the
   next pairing must not start already `{ kind: "done", synced: 1 }` (or with
   a `hostRevision`) from a sync it never ran. `paired` is dispatched only
   from an unpaired device (`pairLocally` when pairing is due, `bootstrap`
   when unpaired), so the reset is always correct there.
4. **`apps/standalone/src/app/shell.ts:56`** — the `hostRevision` doc comment
   said "open office data reloads when it changes", which contradicts the
   ruling from Fix round 1 (office data does _not_ reload; only the
   signed-in user does). Changed to "the office re-reads the signed-in user
   when it changes."
5. **`apps/standalone/src/app/host-link.ts:22-24`** — re-wrapped the ragged
   doc-comment lines ("The first event after each / reconnect carries the
   host's current / revision, so catching up needs nothing more.") into a
   normal wrap ("... carries the host's current revision, so catching up
   needs / nothing more."). Wording unchanged, only the line breaks.
6. **Tests** — see the RED section below for exactly what was added/changed
   and which of them actually fail against `fa8d5dda0`:
   - a. `test/shell.test.ts`: two new tests — one confirms `sync_started`,
     `sync_failed` and `sync_finished` (with a `"synced"` result) all leave
     `sync.kind === "other_host"` unchanged once it is set, and that
     `forgotten`/`paired` both reset it to idle; the other confirms `paired`
     resets `link`, `sync` (from `{ kind: "done", synced: 1 }`) and
     `hostRevision` together, not just on `forgotten`.
   - b. `test/app.test.tsx`, **"stops at another host even when a revision
     arrives during the first sync"**: holds the first `getChanges` open via
     `mockImplementationOnce` + a hand-resolved promise, waits for exactly
     one call, fires `link.revision(7)` (queuing a second run), then resolves
     the held promise with a page from `OTHER_HOST_ID`. Leaves the _default_
     answer for a second call as the paired host's own page (`feedPage(0)`,
     `HOST_ID`, from `fakeHost()`), so if the race lets a second call through
     it succeeds and silently overwrites the `other_host` state — this is
     what makes the test genuinely red against the unfixed code. Asserts the
     other-host screen shows, `link.stop` was called once, and `getChanges`
     was called exactly once.
   - c. `test/app.test.tsx`, the reinstalled-host test: replaced the flat
     `fakeHost()` (whose `getChanges` always answers with the fixture
     `HOST_ID`) with a stateful mock — while `device.pairLocally.mock.calls`
     is still empty (the old pairing), it rejects with the `certificate_mismatch`
     transport `HostError` the real shell would report for a host whose
     certificate no longer matches the pinned one; once `pairLocally` has
     been called (re-paired), it answers with a page whose `hostId` is the
     reinstalled host's new id. The test now waits for `getChanges` to have
     been called twice (once before, once after the repair) before asserting
     the _settled_ screen is the floor and not "another host" — the previous
     version only checked the screen immediately after clicking repair,
     which happened to show "Цех" for one render before the (mismatched, so
     always-`other_host`) old mock would have flipped it, had the test waited
     long enough to see it.
   - d. `test/app.test.tsx`, new test **"stops the link and shows the
     rejected-device screen when a sync's error refuses the device's key"**:
     `getChanges` rejects once with the same `unauthorized`/`credential:
"device"` `HostError` the existing office-rejection tests use; asserts
     the same "Хост не принимает это устройство" screen and `link.stop`
     called once — this exercises `shellActionFor` from the sync's `catch`
     branch specifically, which nothing previously covered (only the
     `link_status`-driven rejection, item f below, was tested).
   - e. `test/app.test.tsx`, new test **"still syncs once when the link's
     watch itself fails, and reaches the floor"**: `connection.watch` itself
     rejects; asserts exactly one `getChanges` call still happens (the
     "without events the copies still sync once" path) and the floor shows.
   - f. `test/app.test.tsx`: renamed **"sends a device whose key the host
     refuses on the link to pairing again"** (which never presses repair) to
     **"stops the link and shows the rejected-device screen when a link
     status refuses the device's key"** — matching what it actually checks,
     and naming it in parallel with the new sync-based test in (d) so the
     two rejection paths (`onStatus` vs. the sync's `catch`) read as a pair.
     Body unchanged.

### RED — real failures against `fa8d5dda0`

I used the same git-based technique as Fix round 1: committed the new tests
and the source fix together as a throwaway `wip:` checkpoint (never pushed,
later undone with `git reset --soft HEAD~1`), then ran
`git checkout fa8d5dda0 -- apps/standalone/src/app/host-link.ts
apps/standalone/src/app/shell.ts` to put _only_ the two source files back to
the pre-fix-round-2 state while keeping every new/changed test, ran the
suite, and then `git checkout HEAD -- <those two files>` to restore the fix.
No `git stash` was used.

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/shell.test.ts`
(source reverted to `fa8d5dda0`; tests are the new ones from items 6a/6b/6c/6d/6e/6f)

```
 ❯ test/shell.test.ts (31 tests | 2 failed) 9ms
     × keeps sync at other_host until a new pairing, absorbing every other sync action 4ms
     × resets the link, the sync and the revision on a new pairing, not just on forgetting 0ms
 ❯ test/app.test.tsx (31 tests | 1 failed) 2407ms
     × stops at another host even when a revision arrives during the first sync 1065ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/app.test.tsx > App > stops at another host even when a revision arrives during the first sync
TestingLibraryElementError: Unable to find an element with the text: Устройство подключено к другому хосту. ...
  (DOM dump shows "Цех" instead — the exact bug: the screen fell back to the
  floor instead of staying stopped at "another host")
 ❯ test/app.test.tsx:763:25

 FAIL  test/shell.test.ts > link and reference sync > keeps sync at other_host until a new pairing, absorbing every other sync action
AssertionError: expected { kind: 'running', synced: +0 } to deeply equal { kind: 'other_host', synced: +0 }
 ❯ test/shell.test.ts:356:64

 FAIL  test/shell.test.ts > link and reference sync > resets the link, the sync and the revision on a new pairing, not just on forgetting
AssertionError: expected { state: 'online', …(3) } to be null
 ❯ test/shell.test.ts:389:23

 Test Files  2 failed (2)
      Tests  3 failed | 59 passed (62)
```

**Honest note on items 6c, 6d and 6e**: I checked with `--reporter=verbose`
which of the 59 "passed" tests were the new/changed ones, and confirmed all
three of "recovers from a reinstalled host: ..." (c), "still syncs once when
the link's watch itself fails, and reaches the floor" (e), and both rejection
tests "stops the link and shows the rejected-device screen when a link
status/a sync's error refuses the device's key" (d and the renamed f) _pass
even against the unfixed `fa8d5dda0` code_. Tracing through why: none of
these four scenarios has a second `scheduler.trigger()` overlapping an
in-flight run, so the race the reviewer found is never actually entered —
`scheduler.stop()`'s new position only matters when `again` is already `true`
by the time a run resolves. (c) and (d)/(f) are genuine test-quality fixes
(a previously-passing-for-the-wrong-reason test for (c), and new coverage of
an previously-untested code path for (d)) rather than regression tests for
this specific race; (b) and the two `shell.test.ts` additions in (a) are the
tests that actually catch it. I am reporting this rather than presenting all
six items as if they were equally "red" — that would not be true, and the
instruction was to record the _actual_ red output, not a red output for
every item unconditionally.

### GREEN and full verification

| Command                                                                          | Result                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `... exec vitest run test/app.test.tsx test/shell.test.ts` (fix restored)        | PASS — 62/62 (31 + 31)                                                                                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`      | PASS — 23 files, 374/374 (was 369; +2 in shell.test.ts, +3 net-new in app.test.tsx — 6c and 6f are modifications/renames, not additions) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` | PASS — no output                                                                                                                         |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`      | PASS — no output                                                                                                                         |
| `node_modules/.bin/prettier --check` on the 4 changed files                      | PASS — "All matched files use Prettier code style!"                                                                                      |
| `git diff --check HEAD -- apps/standalone`                                       | PASS — exit 0                                                                                                                            |

`act(...)`/warning/console check (`grep -iE "act\(|warning|console\."` over
the `test/app.test.tsx test/shell.test.ts` run output): zero matches.

### Commit

```
git add apps/standalone/src/app/host-link.ts apps/standalone/src/app/shell.ts apps/standalone/test/app.test.tsx apps/standalone/test/shell.test.ts
git commit -m "fix(standalone): ревью задачи 3 плана 1c3 — другой хост останавливает синхронизацию" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

This is a **new** commit on top of `fa8d5dda0`, not an amend of it — `git log
--oneline -2` shows both commits present. `git status --short` was empty
immediately after committing; `git show --stat HEAD` confirms exactly the 4
listed files (162 insertions, 7 deletions total).

Verified with `git log -1 --format=%B`:

```
fix(standalone): ревью задачи 3 плана 1c3 — другой хост останавливает синхронизацию

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Exactly one `Co-Authored-By` line, matching the required trailer verbatim.

### New HEAD SHA

`550aba24e259f870479c223eb5da2b4716cf5bf7` (short `550aba24e`)
