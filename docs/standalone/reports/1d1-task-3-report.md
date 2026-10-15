# Task 3 report — Сбой и карантин на экранах

## What was implemented

Exactly the brief's Task 3, with the two controller amendments applied.

- `HostStatusLine({ status, sync })` (`apps/standalone/src/app/HostStatusLine.tsx`, full rewrite): the
  link tag as before, plus — while the link is `online` and the last sync failed — a second
  `attention` `StatusChip` "Справочники не обновились — повторим автоматически" with the failure's
  reason (`errors.sync.<failure>`), kept through the retry's own run (`sync.kind === "running"` does
  not clear it); and — at any link state — a third `attention` chip counting quarantined records
  ("Не приняты записи справочников: N") when `sync.quarantined > 0`. Layout: `.host-status` is now a
  `grid` (one row per line), each row wrapped in a new `.host-status__line` (the old `flex` rules,
  unchanged).
- `OfficeLinkProvider`/`useOfficeLink` (`apps/standalone/src/office/office-link.tsx`, full rewrite):
  value is now `{ status: HostStatus | null; sync: SyncState | null }` instead of bare `HostStatus |
null`.
- `FloorScreen` (`apps/standalone/src/app/screens.tsx`) and `LineSelect`
  (`apps/standalone/src/app/LineSelect.tsx`) take a `sync`/pass it into `HostStatusLine`; `App.tsx`
  passes `state.sync` to both plus to `Office`.
- `Office.tsx` takes an optional `sync` prop, folds `{ status: link, sync }` into a memoized value for
  `OfficeLinkProvider`; `OfficeShell.tsx` reads `link.status`/`link.sync` from the context.
- `LineSelect`'s failed-sync alert now picks its text by `sync.failure` via a `SYNC_FAILED_KEY` map
  (`host` → the screen's own `shell.lineSelect.syncFailed`, `local`/`feed` → the status line's
  `errors.sync.*`), and separately explains "Не удалось прочитать справочники на этом компьютере."
  when the _local_ read failed after the last sync — but only when no sync is currently `running`
  (the retry's progress spinner wins over a stale read-failure alert).
- `apps/standalone/AGENTS.md` (§ "App shell") and
  `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.1) updated to describe
  the new behaviour.
- `OtherHostScreen` deliberately left untouched — no `HostStatusLine`, no `sync` prop — since that
  absorbing state keeps stale `failure`/`quarantined` values (per the task's explicit instruction).

## TDD evidence

**RED** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/app.test.tsx`

```
 ❯ test/host-status-line.test.tsx (15 tests | 5 failed)
     × warns while the host answers that the copies did not update (host), in the live region
     × warns while the host answers that the copies did not update (local), in the live region
     × warns while the host answers that the copies did not update (feed), in the live region
     × keeps the warning through the retry's own run
     × counts the records the copies did not accept, with the host or without it
 ❯ test/line-select.test.tsx (14 tests | 5 failed)
     × explains a failed first sync by its class (local), as the status line does
     × explains a failed first sync by its class (feed), as the status line does
     × says a copy that cannot be read is this computer's, not the host's
     × shows progress, not the older alert, while the retry syncs
     × explains the latest failure: a sync that failed after the copy could not be read
 ❯ test/app.test.tsx (50 tests | 2 failed)
     × shows a failed sync on the floor and in the office header until a sync succeeds
     × shows how many feed records the copies did not accept

 Test Files  3 failed (3)
      Tests  12 failed | 67 passed (79)
```

Failure shape matches the brief's Step 2 exactly (5 + 5 + 2 = 12 new-test failures, all "Unable to
find an element with the text"); the grand total (79, not the brief's stale 77) is explained under
Deviations.

**GREEN** — same command:

```
 Test Files  3 passed (3)
      Tests  79 passed (79)
```

Re-run with `--reporter=verbose`: all 79 lines show `✓`, no stray console output between them
(pristine).

## Verification commands

| Command                                                                                                                                                           | Result                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/app.test.tsx` | PASS, 79/79                                                       |
| same, `--reporter=verbose`                                                                                                                                        | PASS, 79/79, pristine output                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                       | PASS, 29 files / 515 tests                                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                  | PASS (`tsc -p tsconfig.json --noEmit`, no output)                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                       | PASS (eslint, no output)                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                                                      | PASS (`vite build`, pre-existing >500kB chunk warning, unrelated) |
| `node_modules/.bin/prettier --check <14 changed files>`                                                                                                           | "All matched files use Prettier code style!"                      |
| `git diff --check -- apps/standalone docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`                                                        | clean, no output                                                  |
| `grep -n '\\u04' <14 changed files>`                                                                                                                              | no matches (no literal `\uXXXX` escapes introduced)               |
| `git status --short` before commit                                                                                                                                | exactly the 14 files the brief's file map predicts, nothing extra |

Not run: Cargo/Rust checks (no Rust files touched by this task) and any browser/manual check (no UI
surface changed that needs hand verification beyond the automated DOM assertions above).

## Files changed

- `apps/standalone/src/app/HostStatusLine.tsx` (rewritten)
- `apps/standalone/src/app/screens.tsx`
- `apps/standalone/src/app/LineSelect.tsx`
- `apps/standalone/src/app/App.tsx`
- `apps/standalone/src/app/shell.css`
- `apps/standalone/src/i18n/ru.json`
- `apps/standalone/src/office/Office.tsx`
- `apps/standalone/src/office/office-link.tsx` (rewritten)
- `apps/standalone/src/office/OfficeShell.tsx`
- `apps/standalone/test/host-status-line.test.tsx` (rewritten)
- `apps/standalone/test/line-select.test.tsx`
- `apps/standalone/test/app.test.tsx`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Commit: `0b2019118` — "feat(standalone): сбой синхронизации и карантин видны в цехе, на выборе линии и
в офисе", trailer verified as exactly one line:
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations

1. **Host failure text (amendment 1, instructed).** Used «Запрос к хосту не удался.» instead of the
   brief's «Хост не ответил на запрос.» for `errors.sync.host`, in exactly the three places named in
   the amendment: the `it.each` case in `host-status-line.test.tsx`, the assertion in the new
   `app.test.tsx` test, and the `ru.json` `errors.sync.host` value. Left the line screen's own
   `shell.lineSelect.syncFailed` text («Не удалось получить справочники с хоста.») untouched, as
   instructed. I did **not** extend this change to the descriptive parenthetical in the spec doc
   (§5.1 update reads "...с причиной (хост не ответил, ...)") — that phrase is prose describing the
   failure class, not a literal quotation of `errors.sync.host`, and the amendment named exactly three
   spots to change. Flagging this in case the controller wants that paraphrase reworded too.

2. **`app.test.tsx` append anchor (amendment 2, instructed).** The brief's Fragment 6 anchor
   (`await elapse(120_000); … }); });`) no longer matched: Task 2's follow-up commit (`03aec7141`,
   already at HEAD before this task started) had appended two more tests to the "reference sync
   retries" describe block (the last of them being "does not arm a retry while the link is not
   online, and syncs at once once it is"). I located the file's true last `it` block and appended the
   new `describe("reference sync health on screen", …)` after its closing `});` — content otherwise
   byte-for-byte as the brief gives it (plus amendment 1's text substitution).

   Consequence for the brief's stated test counts: because `app.test.tsx` already carried 2 more
   pre-existing tests than the brief assumed when it was written, every total the brief predicts for
   that file (and the grand totals derived from it) is off by exactly 2: RED showed 79 total instead
   of the brief's 77 (12 failures matched exactly, as reported); GREEN showed 50 tests in
   `app.test.tsx` instead of 48, and the full `@markiro/standalone` suite is 515 tests instead of the
   Step 6 estimate of 513. Both file counts (29 test files) and all pass/fail shapes otherwise match
   the brief precisely — this is purely the pre-existing baseline drift the amendment already flagged,
   not a new discrepancy.

3. Every other fragment in the brief matched the current files byte-for-byte before editing (verified
   by reading each target file and comparing against the brief's "old" text prior to applying any
   edit); no other NEEDS_CONTEXT situations arose.

## Self-review findings

- Completeness: every interface the brief's "Produces" section lists exists with the exact signature
  given (`HostStatusLineProps`, `FloorScreen`'s new prop shape, `OfficeProps.sync`, `OfficeLink`,
  `OfficeLinkProvider`, `useOfficeLink`), and every i18n key (`link.syncFailed`, `link.quarantined`,
  `errors.sync.host|local|feed`, `shell.lineSelect.readFailed`) and CSS class
  (`.host-status`, `.host-status__line`) is present.
- Names: match the brief verbatim, including `SYNC_FAILED_KEY` and the `link`/`sync` prop naming.
  No renaming drift introduced.
- No overbuilding: did not touch `OtherHostScreen`, did not add any prop/key/branch beyond what the
  brief and amendments specify, did not add dependencies, did not refactor unrelated code.
- Tests verify real behaviour: each new/changed test renders the component and asserts on visible
  text, `role`/`aria-live` attributes, or `.closest(".host-status")` containment — not on
  implementation internals.
- Output pristine: confirmed via a `--reporter=verbose` run of the three focused files (all 79 lines
  `✓`, nothing between them) and via the full-suite run (515/515, no stray output in the tail).
- Grepped the whole `src`/`test` tree for other consumers of `FloorScreen`, `HostStatusLine`, and
  `OfficeLinkProvider`: none exist outside the files the brief already lists, so no hidden call site
  was missed.
- `git status --short` before staging showed exactly the 14 files the brief's file map predicts for
  Task 3, and only those were staged/committed.

## Concerns

None blocking. The one open item is deviation 1's spec-doc paraphrase, noted above for the
controller's judgment — it is prose, not a literal UI string, so I left it as the brief specifies
rather than second-guessing the amendment's stated scope.
