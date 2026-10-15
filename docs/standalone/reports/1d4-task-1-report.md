# Plan 1d4, Task 1 report: hashes and field rules

Status: DONE. Commit `8493a2edc feat(standalone): хеши PIN и бейджа в офисе, правила полей операторов`
(branch `claude/autonomous-desktop-station-9e6f13`, on top of `d36668e08`; not pushed).

## What I implemented

Everything in the brief, in its step order, applied from the brief's own text (I parsed the brief's
«фрагмент … заменить на …» blocks with a scratch script and applied each one with an exactly-once
assertion, so nothing was retyped; `credentials.ts` and `credentials.test.ts` were cut from the brief's
code blocks by line range and diffed back against them).

- `src/lib/credentials.ts` (new): `BADGE_ITERATIONS = 100_000`, `hashPin` (16 fresh random salt bytes,
  `PHC_ITERATIONS`, standard base64 with padding), `hashBadge` (site salt, exactly `BADGE_ITERATIONS`).
- `src/lib/rules.ts`: `isTransferable`, `optionalTextRule`, `toOptionalText`, `operatorLoginRule`,
  `pinRule`, `operatorRoleRule`, `badgeLabelRule`, `badgeCodeRule` (imports `hasCyrillic`);
  `plainTextRule` now checks length first (the field's own message) and a control character / lone
  surrogate second (`rules.controlCharacter`); `isPlainText` untouched (the wizard still calls it);
  `passwordRule` refuses a lone surrogate (`rules.passwordCharacter`).
- `OfficeLogin.tsx`: login (`rules.login`) and password (`rules.passwordCharacter`) refuse a lone surrogate.
  `ChangePasswordDialog.tsx`: the current password refuses it (`rules.passwordCharacter`).
- `ru.json`: 8 new `rules.*` keys (`controlCharacter`, `passwordCharacter`, `operatorLogin`, `pin`, `role`,
  `badgeLabel`, `badgeCode`, `badgeCodeLayout`); no duplicates, all Cyrillic written as letters.
- Tests: new `credentials.test.ts` (5), `rules.test.ts` (+7 new tests; four existing free-text tests
  rewritten to expect `rules.controlCharacter`), `office.test.tsx` (+2), and one rewritten assertion each in
  `lines-page`, `devices-page`, `counterparties-page`.
- `apps/standalone/AGENTS.md`: the two documentation paragraphs of Step 6.

Nothing changed under `apps/station`, `apps/standalone/proto|host|src-tauri` or any Rust file; no
dependencies added; no `pnpm install`/`add`; no stash; no push; no new branch.

## Anchors

All 19 «фрагмент» anchors checked before editing matched exactly once against HEAD `d36668e08`. The
controller's «19» is 9 (Step 1) + 8 (Step 3) + 2 (Step 6, AGENTS.md); Steps 1+3 alone are 17. The four
Step 5 fragments (which describe the code after Step 3) matched when their mutation was applied, as
the brief says they would. No anchor failed, nothing was improvised.

## Baseline

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` before any edit:
33 files / 650 tests passed; stderr only `$ vitest run`.

## TDD evidence

### RED (Step 2)

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/credentials.test.ts test/rules.test.ts test/office.test.tsx test/lines-page.test.tsx test/devices-page.test.tsx test/counterparties-page.test.tsx`
(run through `rtk proxy`, stdout and stderr to separate files; exit 1)

    Test Files  6 failed (6)
         Tests  16 failed | 87 passed (103)

- `credentials.test.ts` does not load: `Failed to resolve import "../src/lib/credentials.js" from "test/credentials.test.ts". Does the file exist?`
- 16 of the 103 tests of the other five files fail, exactly the brief's split:
  - `rules.test.ts` 11: `office user rules > refuses an unpaired surrogate in a password…` (`expected undefined to be 'rules.passwordCharacter'`);
    `free text >` «refuses an unpaired surrogate in every free-text field, as a control character», «names a control character…»,
    «trims a tab at the edge…», «trims before it counts…», «holds every free-text field…» (`expected 'rules.name' to be 'rules.controlCharacter'`,
    `expected 'rules.lineName' to be 'rules.controlCharacter'`); the 5 `operator rules >` tests
    (`TypeError: Cannot read properties of undefined (reading 'safeParse')`, the rules are not exported yet).
  - `office.test.tsx` 2 (`OfficeLogin`, `ChangePasswordDialog`): `Unable to find an element with the text: В пароле есть повреждённый символ — наберите пароль заново`.
  - `lines-page`, `devices-page`, `counterparties-page`, 1 each: `Unable to find an element with the text: Уберите табуляцию, перенос строки или другой служебный символ`.
- Why expected: the rules, the credentials module and the two new i18n keys did not exist, and the rewritten
  assertions describe the new behaviour.

### GREEN (Step 4)

Same command: exit 0.

    Test Files  6 passed (6)
         Tests  108 passed (108)

- `--reporter=verbose`: exit 0, 108 passed, per-file counts 5 (credentials) / 29 (rules) / 25 (office) /
  11 (lines-page) / 28 (devices-page) / 10 (counterparties-page), no skipped or failed marks;
  stderr file is 0 bytes.
- Delayed-`setImmediate` stand (the two temporary files created exactly as in the plan's notes,
  `--config vitest.delay.config.ts`, verbose): exit 0, 6 files / 108 tests, the same per-file counts,
  stderr 0 bytes. Both temporary files were then deleted (`git status` clean of them, never staged).

## Mutation evidence (Step 5)

Each mutation: `shasum -a 256` of the file, the brief's scratch edit, the named command, then the
reverse edit, `shasum -a 256` again, and `cmp`/`diff` against a copy of the file taken just before the
mutation. Note on «`git diff` empty»: at this point the implementation was still uncommitted (and
`credentials.ts` untracked), so `git diff` against HEAD is non-empty by design; the equivalent proof is
that the file is byte-identical to its pre-mutation copy (`cmp` exit 0, `diff` empty) and the sha256 is equal.

| #   | File                         | sha256 before                                                      | sha256 mutated                                                     | sha256 after revert      |
| --- | ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------ |
| 1   | `src/lib/rules.ts`           | `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` | `7dc98d32d36c8805482726ea6e79fd6845cfc77e4d85fc8d2692d4bbf1c2991c` | `ca3df070…ddc21` (equal) |
| 2   | `src/lib/rules.ts`           | `ca3df070…ddc21`                                                   | `77b8fdf917fa09655950a908b309423a95be32084e97223e89232547dfede168` | `ca3df070…ddc21` (equal) |
| 3   | `src/lib/credentials.ts`     | `f11f96d4df395ada042b99d563f23ae6998a72862b120abd397b7caa96489d8d` | `98514b13140e716a9851fd292f80a3ea58d063818433304305ebb2acdad2d9d2` | `f11f96d4…89d8d` (equal) |
| 4   | `src/office/OfficeLogin.tsx` | `41bf1ffb97db1d2b7f52efbf06868f0d64beab7a022b01eeab535e533d4c27c8` | `0367bcc8cd717eebfc641cc7f2a4cf70b965f49569f09a73edde4171d5570e33` | `41bf1ffb…c27c8` (equal) |

1. Single free-text check restored (`isPlainText`): `vitest run test/rules.test.ts -t "names a control character"` exit 1,
   `1 failed | 28 skipped`, `AssertionError: expected 'rules.name' to be 'rules.controlCharacter'`.
2. No surrogate check in `passwordRule`: `-t "unpaired surrogate in a password"` exit 1, `1 failed | 28 skipped`,
   `AssertionError: expected undefined to be 'rules.passwordCharacter'`.
3. `BADGE_ITERATIONS = 200_000`: `test/credentials.test.ts` exit 1, `2 failed | 3 passed (5)`:
   `expected 200000 to be 100000` and `expected 'pbkdf2$sha256$200000$AAECAwQFBgcICQoL…' to be 'pbkdf2$sha256$100000$AAECAwQFBgcICQoL…'`
   (the «MRK-000742» hash no longer equals `badge-create.json`).
4. No surrogate check on the sign-in password: `office.test.tsx -t "broken character in the login"` exit 1,
   `1 failed | 24 skipped`, `Unable to find an element with the text: В пароле есть повреждённый символ — наберите пароль заново`.

Nothing of the mutations was staged or committed.

## Final checks (Step 7), on the tree that was committed

- `pnpm … --filter @markiro/standalone test`: 34 files / 664 tests passed (650 + 14: 5 credentials, 7 rules,
  2 office); stderr only `$ vitest run`.
- `typecheck` exit 0; `lint` exit 0; `build` (`vite build`) exit 0. The build's stderr carries vite's
  «Some chunks are larger than 500 kB» notice for the `index` (730 kB) and `PairingDataMatrix` (926 kB)
  chunks; both were far above 500 kB before and this change adds only a few KB of source, so the notice
  predates it and I did not touch it.
- `node_modules/.bin/prettier --check` on the 12 files: all use Prettier code style.
- `git diff --check` and `git diff --cached --check`: exit 0; no trailing whitespace in the two new files.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
  The intended escapes (`\ud800`, `\udc00`, `\u0000`, `\u0085`, `\t`) sit in the test blocks as the brief wrote them.
- i18n: each of the 8 new keys occurs once in `ru.json`, no duplicate key in `rules`; `ru.json` is the only locale.
- `graphify update .` not run: there is no `graphify-out/` in this worktree.
- Commit: 12 explicit paths (exactly the brief's list), `git status` clean afterwards;
  `git log -1 --format=%B` shows the pinned `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` exactly once
  and no other `Co-Authored-By` line.

## Files changed (12; 411 insertions, 26 deletions)

`apps/standalone/src/lib/credentials.ts` (new), `apps/standalone/src/lib/rules.ts`,
`apps/standalone/src/office/OfficeLogin.tsx`, `apps/standalone/src/office/ChangePasswordDialog.tsx`,
`apps/standalone/src/i18n/ru.json`, `apps/standalone/test/credentials.test.ts` (new),
`apps/standalone/test/rules.test.ts`, `apps/standalone/test/office.test.tsx`,
`apps/standalone/test/lines-page.test.tsx`, `apps/standalone/test/devices-page.test.tsx`,
`apps/standalone/test/counterparties-page.test.tsx`, `apps/standalone/AGENTS.md`.

## Self-review

- Completeness: every brief step done in order (RED, implementation, GREEN, verbose, stand, four mutations
  with revert proof, both doc paragraphs, checks, commit). All numbers in the brief matched the run
  (16 of 103 red, 108 green with the 5/29/25/11/28/10 split, 34 files / 664 tests).
- Quality: the code is the brief's text, byte for byte; no local additions, no reformatting (prettier agrees).
- Discipline: only the brief's 12 paths; no change to `isPlainText` or the wizard; the stand files, scratch
  files and every mutation left no trace in the tree.
- Testing: the new tests fail without the code (RED and mutations), pass with it, and the output is pristine:
  no `act(...)` warnings or React errors on stderr, also under the delayed-`setImmediate` stand.

## Concerns and notes

- None blocking. Points for the controller:
  - The message count «19 anchors» covers Steps 1, 3 and 6 (9 + 8 + 2); see Anchors above.
  - `rules.pinConfirm` appears in the plan's global key list but is a Task 4 key (it is in Task 4's «Produces»);
    Task 1's brief does not add it and I did not either.
  - Only form-level behaviour was exercised: the tests prove the office forms refuse a lone surrogate before
    calling the host. That such a string really fails the Tauri IPC (serde) as a «lost connection» is taken
    from the plan and the existing AGENTS.md text; I did not run the Tauri shell. No browser, Windows or
    hardware surface was touched or verified; DOM tests are not visual confirmation.
