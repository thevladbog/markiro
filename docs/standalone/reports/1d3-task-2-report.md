# Task 2 report: field rules as on the host (`src/lib/rules.ts`), plan 1d3

**Status: DONE.** Commit `b9f6972c7` on `claude/autonomous-desktop-station-9e6f13`, on top of `1f3caab1f`.

## What was implemented

Webview-only. The host's `validate::clean_text` rule (trimmed, counted in characters, no control character) now lives in the forms, and the company field rules are extracted so the organization profile and counterparties share them.

- `src/lib/rules.ts`
  - `CONTROL_CHARACTER = /\p{Cc}/u` (U+0000-U+001F and U+007F-U+009F, the same set as `char::is_control`).
  - `isPlainText(text, max)`: `1 <= characters(text) <= max` and no control character.
  - `plainTextRule(max, message)`: `z.string().trim().refine(...)`, so a NUL or a tab at the edge survives `trim` and is refused.
  - `personNameRule` (100, `rules.name`) is now built on it, with the same key and text.
  - New: `deviceNameRule` (100, `rules.name`), `lineNameRule` (100, `rules.lineName`), `companyNameRule` (200, `rules.orgName`).
  - Extracted unchanged from `orgFieldsSchema`: `innRule`, `glnRule` (13 digits plus GS1 check digit), `gs1PrefixesRule`.
  - `orgFieldsSchema` is assembled from them; fields and keys are unchanged.
- `src/wizard/wizard-form.ts`: the master's line rows use `isPlainText(name, 100)`. The `characters` import is gone; nothing else in `src/` calls `characters()` outside `rules.ts`.
- `src/i18n/ru.json`: new `rules.lineName` = «Укажите название линии, до 100 символов». No existing text changed.
- `AGENTS.md` (Writes): the "office forms mirror this rule (plan 1d3)" sentence became the concrete statement (functions, where they are used, the JS-vs-Rust `trim` edge cases).
- Tests: `test/rules.test.ts` gets a `free text` describe (5 tests); `test/wizard-form.test.ts` gets one assertion (a tab inside a line name).

## TDD evidence

**RED** (after the test edits, before any source edit):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/wizard-form.test.ts
    -> exit 1;  Test Files 2 failed (2);  Tests 6 failed | 18 passed (24)
     ❯ test/rules.test.ts (17 tests | 5 failed)
         × takes 1 to max characters, counted as the host counts them      TypeError: isPlainText is not a function
         × refuses a control character anywhere, as `char::is_control` does  TypeError: isPlainText is not a function
         × trims before it counts, and a NUL at the edge is not trimmed away  TypeError: Cannot read properties of undefined (reading 'safeParse')   (lineNameRule)
         × holds every free-text field the office and the wizard send      AssertionError: expected undefined to be 'rules.name'   (personNameRule lets a tab through)
         × checks company fields with the organization's rules             TypeError: Cannot read properties of undefined (reading 'safeParse')   (innRule)
     ❯ test/wizard-form.test.ts (7 tests | 1 failed)
         × check the lines, repeats ignoring case                          AssertionError: expected [] to deeply equal [ { field: 'lines.0.name', message: 'wizard.errors.lineName' } ]

This is exactly the failure set the brief predicted (6 of 24: 5 of 17 and 1 of 7, with the same messages).

**GREEN** (same command, after the source edits):

    -> exit 0;  Test Files 2 passed (2);  Tests 24 passed (24)      (17 in rules.test.ts, 7 in wizard-form.test.ts)

## Verification commands and results

| Command                                                                                                              | Result                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED command above                                                                                                    | exit 1, 6 failed of 24 (as predicted)                                                                                                                                                       |
| GREEN command above                                                                                                  | exit 0, 24 passed                                                                                                                                                                           |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (full suite, run once before the commit) | exit 0, **30 files, 553 tests passed** (see Deviations for 553 vs 552)                                                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                     | exit 0                                                                                                                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                          | exit 0                                                                                                                                                                                      |
| `node_modules/.bin/prettier --check` on the six changed files                                                        | exit 0, "All matched files use Prettier code style!"                                                                                                                                        |
| `git diff --check` and `git diff --cached --check`                                                                   | exit 0 both                                                                                                                                                                                 |
| `--reporter=verbose` run of `test/rules.test.ts`                                                                     | exit 0, 17 passed, stdout 2038 B, **stderr 0 B**, no `act(`, `Warning`, `console.`, `Errors` or `Unhandled`                                                                                 |
| `--reporter=verbose` run of `test/wizard-form.test.ts`                                                               | exit 0, 7 passed, stdout 921 B, **stderr 0 B**, same scan clean                                                                                                                             |
| `grep -nF '\u04'` on the six changed files                                                                           | prints nothing (the baseline printed nothing either; the only `\u04` in the app is the pre-existing `/[\u0400-\u04ff]/` in `src/host/pairing-code.ts:66`, untouched)                        |
| Scan of the six files for raw control or invisible characters (C0 except LF, DEL, C1, NBSP, SHY, ZW*, BOM)           | none in any file (final run: a scanner built from numeric code points and validated on a positive control, since two earlier hand-typed classes were unreliable; also clean on this report) |
| Programmatic comparison of all 10 edits with the brief's own code blocks (extracted from the brief file)             | 10/10: the `new` block occurs exactly once in its target file; the `old` block is gone (pair 2's `old` is a suffix of its `new` by design and occurs once)                                  |
| `graphify update .`                                                                                                  | not run: no `graphify-out/` exists in this worktree (the rule applies only when a local graph exists)                                                                                       |

All 10 anchors in the brief matched the files byte for byte before editing (checked by an exactly-once assertion in the edit script; an edit would have aborted otherwise).

## Files changed (6, all in `apps/standalone`)

- `src/lib/rules.ts` (+50/-16)
- `src/wizard/wizard-form.ts` (+2/-2)
- `src/i18n/ru.json` (+1)
- `test/rules.test.ts` (+59)
- `test/wizard-form.test.ts` (+4)
- `AGENTS.md` (+5/-1)

No changes to `apps/station`, `apps/standalone/host`, `apps/standalone/proto`, `src-tauri`, any Rust crate, `package.json` or the lockfile. Explicit paths staged; nothing else was in the tree.

## Deviations

1. **Test total is 553, not the brief's 552.** The brief's number was computed against the baseline before Task 1's review-fix commit. `1f3caab1f` (current HEAD before this commit) added one test (`form-dialog.test.tsx`, 11 -> 12); Task 1's own report records 547 -> 548. 548 + my 5 new tests = 553. The file count (30) is as the brief says. Nothing was added beyond the brief's 5 new tests.
2. No deviation in content: the final bytes of all ten edits are identical to the brief's blocks (verified programmatically, see above).

## Self-review findings

- **Caught and fixed a typing slip before the first test run.** When I typed the "Not control characters" test line by hand, the no-break space, soft hyphen and zero-width joiner landed as raw invisible characters instead of the escapes `\u00a0`, `\u00ad`, `\u200d`. I replaced that line with the literal escapes, then verified every edit against the brief's blocks by extracting them from the brief file rather than by eye; I applied the source and docs edits (pairs 4-10) from those extracted blocks directly. The committed file has the literal escapes and no raw invisible characters.
- Completeness: every step of the brief is done (tests, RED, source, GREEN, docs, gates, commit).
- No existing test was changed beyond additions: `rules.test.ts` +59 lines and 0 deleted, `wizard-form.test.ts` +4 and 0 deleted. The one added assertion in `wizard-form.test.ts` is inside the existing "check the lines, repeats ignoring case" test, exactly as the brief specifies. No assertion was weakened.
- The full suite still pins `rules.name` and `rules.orgName` texts (wizard, network-pairing and org tests are green); existing messages and behaviour are unchanged.
- Read-only cross-check against the host (`host/src/validate.rs`): `is_plain` and `clean_text` (trim, 1..=max chars via `chars()`, no `char::is_control`), `company` (name 200, INN blank or 10/12 digits, GLN 13 digits with no check digit on the host, at most 10 distinct prefixes of 4-12 digits), `device_name` and `line_name` and `person_name` (100). The mirrored rules and the comments I added agree with it. `\p{Cc}` equals Rust's `is_control` (general category Cc).
- The AGENTS.md statement "the office forms, the wizard and the device name at pairing" is true of the current code: `NetworkPairing.tsx` validates the device name with `personNameRule`, `wizard-form.ts` uses `adminName: personNameRule` and `isPlainText` for lines, `user-forms.ts` uses `personNameRule`. The counterparty, line and device dialogs come in later tasks and take the rules from here.
- Naming follows the brief exactly; nothing was added beyond it.

## Concerns

- None blocking.
- `rules.lineName` (i18n) and `lineNameRule`, `deviceNameRule`, `companyNameRule`, `innRule`, `glnRule` and `gs1PrefixesRule` are not yet consumed by any UI other than through `orgFieldsSchema`; later tasks (counterparty, lines and devices dialogs) use them, as planned.
- Automated checks only: this change is webview text rules, so no browser, Windows, hardware or Rust verification was applicable or performed (`cargo` not run; Rust and the station are untouched).
