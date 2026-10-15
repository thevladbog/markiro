# Task 5 report: the «Линии» page (plan 1d3)

Status: DONE. Commit: `6acf82fa7 feat(standalone): страница «Линии» в офисе` (one commit, the brief's 11 files, one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer, verified with `git log -1 --format=%B`).

## What I implemented

Exactly the brief, in its step order (tests, RED, implementation, GREEN, docs, checks, commit). To avoid transcription errors I applied the brief's fenced blocks with a script that reads the brief itself: every «фрагмент … заменить на …» anchor had to occur exactly once in its target (all 9 code anchors and both doc anchors matched; the script aborts otherwise), and the four created files are byte-identical to the brief's blocks (checked after the commit-time mutation check too).

Behaviour added in `apps/standalone`:

- `src/office/lines/LinesPage.tsx`: the read-only list of every line (archived ones included, `activeFirstByName`), with «Добавить линию», per active line «Переименовать» and «В архив», per archived line «Вернуть». A technologist gets the list and the read-only note only (`useCan("editReference")`).
- `src/office/lines/LineDialog.tsx`: one dialog with three modes (`create`, `rename`, `restore`). The form sends the zod output of `handleSubmit` (the trimmed name), never the raw input; the resolver has no `raw: true`. Bodies come from `lineCreate` / `lineUpdate` only. A `conflict` with `constraint: line_name` goes under the name field on all three paths, so a restore can take another name in the same dialog. `stale_revision` offers «Загрузить заново» (`onReload`).
- `src/office/lines/ArchiveLineDialog.tsx`: the confirmation, with the sentence that stations already on the line stay there. Its `submit` catches everything through `alertFailure` (never rejects).
- `officeKeys.lines = ["office", "lines"]` (Task 6 reuses it), the `/lines` route, the «Линии» menu item in «Производство» for both roles, the `office.nav.lines` and `office.lines.*` texts in `ru.json`.
- `test/devices-page.test.tsx`: the technologist menu test now asserts «Линии» is in the menu instead of «Производство» being absent.
- Docs: `apps/standalone/AGENTS.md` («Office pages» bullet) and spec §5.5 (Russian bullet), as the brief says. I read `host/src/routes/lines.rs` and `host/tests/lines.rs` and the docs match the host: add, rename and restore all answer `conflict` on `line_name`; an empty update is a no-op; archiving leaves devices alone.

## TDD evidence

RED, before any implementation:

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lines-page.test.tsx test/devices-page.test.tsx
    Test Files  2 failed (2)
         Tests  11 failed | 16 passed (27)

All 10 tests of `lines-page.test.tsx` failed with `Unable to find role="link" and name "Линии"` (`openLines` or the direct `findByRole`), and `devices-page.test.tsx > is in the menu for administrators only` failed with `Unable to find an accessible element with the role "link" and name "Линии"`. That is the brief's expected failure, for the expected reason (the menu item does not exist yet).

GREEN, after the implementation, same command:

    Test Files  2 passed (2)
         Tests  27 passed (27)

Verbose run of the new file (`... exec vitest run test/lines-page.test.tsx --reporter=verbose`), stdout and stderr captured separately: 10 of 10 passed, **stderr 0 bytes**.

Full gate before the commit (and again on the committed tree, clean `git status`):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
    Test Files  32 passed (32)
         Tests  605 passed (605)

No `stderr |` / `stdout |` / `Warning:` / `act(` blocks in the output. (The 13 bytes on the stderr of the pnpm call are pnpm's own `$ vitest run` echo, not test output.) The brief's «604» is one low, as the controller warned: 31/595 + 10 new = 605.

## Other checks

- `... typecheck` (`tsc -p tsconfig.json --noEmit`): exit 0, no diagnostics.
- `... lint` (`eslint .`): exit 0, no diagnostics (the `_variables: void` parameter in `ArchiveLineDialog` passes the lint config).
- `node_modules/.bin/prettier --check` on all 11 changed files (including the two Markdown files and `ru.json`): clean. The brief's code needed no reformatting.
- `git diff --check` and `git diff --cached --check`: clean.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test` (and the two docs): only the known intentional hit `src/host/pairing-code.ts:66`. The brief contains no NBSP, soft hyphen or ZWJ (scanned).
- Race check, since the controller flagged effect-vs-`waitFor` races: with a temporary setup file that delays React's `setImmediate` (the memory note's harness, files created inside `apps/standalone` and deleted afterwards; `git status` clean), the new file passes at 1, 3, 6 and 10 ms, and the full suite passes at 3 ms (32 files / 605 tests). Eight consecutive normal runs of the new file: 8 of 8 green. None of the brief's tests asserts effect-driven state right after `findBy*`; list updates reach the DOM through react-query's `setTimeout(0)` notification plus a sync-lane re-render, which RTL's own `setTimeout(0)` drain waits for.
- Mutation check: I temporarily set `raw: true` on the resolver (untrimmed input goes out): exactly `adds a line with its trimmed name` fails (1 failed | 9 passed). Restored and re-verified byte-identical.
- `graphify update .`: not run, there is no `graphify-out/` in this worktree (the guide says to run it when a local graph exists).

## Not run / not verified

- Browser, Tauri webview and Windows: nothing here was exercised in a real webview or on Windows; the automated DOM tests are jsdom only.
- Rust: no cargo tests were run (nothing Rust changed, and the brief's step 6 does not include them). The host behaviour the docs describe was confirmed by reading `host/src/routes/lines.rs` and `host/tests/lines.rs`, not by running them.
- `pnpm --filter @markiro/standalone build` (vite build): not in the brief's step 6, not run.

## Files changed (11, +622 -1)

Created: `apps/standalone/src/office/lines/LineDialog.tsx` (120 lines), `ArchiveLineDialog.tsx` (52), `LinesPage.tsx` (145), `apps/standalone/test/lines-page.test.tsx` (245).
Modified: `apps/standalone/src/office/office-query.ts`, `nav.ts`, `routes.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.

## Self-review

- Completeness: every step and every file of the brief is done; nothing beyond it (no extra tests, no extra files, no changes under `apps/station`, `proto`, `host`, `src-tauri`, no dependency changes).
- Trim rule: the create and rename/restore paths both send the `handleSubmit` output; covered by `adds a line with its trimmed name` (the mutation above proves it bites). The rename and restore tests send the exact bodies (`{ name, expectedRev }`, `{ archived: false, expectedRev }`, `{ name, archived: false, expectedRev }`, `{ archived: true, expectedRev }`) checked with `toStrictEqual`.
- Never-reject rule for `FormDialog.onSubmit`: `LineDialog.submit` and `ArchiveLineDialog.submit` catch everything (including a throw from `onSaved` / `onArchived`, which would surface as an alert).

## Concerns (none blocking)

1. Trailer: the harness attribution reminder names `Claude Sonnet 5.5`, but the task's hard rule, the brief's commit command and the six previous commits on this branch all use `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. I used the pinned Opus 5.5 trailer, exactly once, and no other `Co-Authored-By` line.
2. Rename with a name that differs from the loaded one only by surrounding whitespace enables «Сохранить» (`isDirty` compares the raw field) and sends `{ expectedRev }` only; the host treats that as a no-op (no revision bump) and the page says «Изменения сохранены.». Harmless, and inside the brief's design; noted only for the record.
3. The brief's total of 604 tests should read 605 (already known to the controller).
