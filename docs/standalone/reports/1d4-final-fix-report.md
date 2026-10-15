# Plan 1d4 — final-review fix wave: report

Range `ae9c15e4d..89f99cba7` (base for the whole plan: `d36668e08`). Four commits, no push, no new branch, no stash; each message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified with `git log -1 --format=%B`). 17 files changed (613 insertions, 117 deletions); nothing under `apps/station`, `apps/standalone/proto`, `packages/`, applied migrations, `.superpowers/`, the plan documents, manifests or the lockfile; no dependency added.

| #   | SHA         | Subject                                                                                                                                               |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `d3b082776` | fix(standalone): итоговое ревью 1d4 (1/4) — код бейджа не попадает в подпись, поле кода закрыто на время отправки, фокус после отказа по подписи      |
| 2   | `e1b907e91` | fix(standalone): итоговое ревью 1d4 (2/4) — тесты хешей, правил, соли, тел запросов и диалогов операторов; сообщение имени устройства при подключении |
| 3   | `8d4a3a295` | fix(standalone): итоговое ревью 1d4 (3/4) — тесты хоста и оболочки: владелец бейджа, откат отказа, остаток файлов при сбросе                          |
| 4   | `89f99cba7` | fix(standalone): итоговое ревью 1d4 (4/4) — документы: правила входа плана 1f, строгие записи ленты, пределы стирания, таблица отказов бейджа         |

## Totals after each commit

Baseline at `ae9c15e4d`: Vitest 37 files / 772 tests (stderr clean); cargo 36 suites / 348 tests (0 warnings).

| After           | Vitest files / tests           | Vitest stderr                  | cargo suites / tests                                                                                                                                                                                | cargo warnings                                        | typecheck / lint / build | prettier                                                         | `git diff --check`                          | `\u04` grep               |
| --------------- | ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ------------------------------------------- | ------------------------- |
| commit 1        | 37 / **775** (+3)              | only pnpm's own `$ vitest run` | not run (no Rust touched)                                                                                                                                                                           | n/a                                                   | ok / ok / ok             | ok (3 files)                                                     | ok                                          | only `pairing-code.ts:66` |
| commit 2        | 37 / **808** (+33)             | same                           | not run (no Rust touched)                                                                                                                                                                           | n/a                                                   | ok / ok / ok             | ok (7 files)                                                     | ok                                          | same                      |
| commit 3        | 37 / 808 (unchanged, run once) | same                           | **36 / 348** (full workspace, outside the sandbox, log `/tmp/claude/1d4fix-c3-cargo-full.log`); `-p markiro-host --test badges` 8/8 and filtered ipc `forgetting_the_device` 3/3 inside the sandbox | 0 (`cargo check --workspace --all-targets --offline`) | vitest only              | `cargo fmt --check` ok; no Markdown changed                      | ok                                          | n/a                       |
| commit 4 (HEAD) | 37 / 808                       | same                           | **36 / 348** again on HEAD (log `/tmp/claude/1d4fix-final-cargo-full.log`)                                                                                                                          | 0                                                     | ok / ok / ok             | ok (all 52 `.ts/.tsx/.json/.md/.css` files of `d36668e08..HEAD`) | ok, also `git diff --check d36668e08..HEAD` | same                      |

`git status` is clean after commit 4. Every vitest stderr above contains only the `$ vitest run` line pnpm prints.

Vitest commands: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test|typecheck|lint|build`. Cargo commands: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline`; `… -p markiro-standalone --test ipc --offline forgetting_the_device`; full `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` with `dangerouslyDisableSandbox: true`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`; `cargo fmt … --all -- --check`.

## Commit 1 — `AddBadgeDialog` (d3b082776)

| Item                                         | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Pinned by                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 label guard                               | `AddBadgeDialog.tsx:103-106`: after the form's validation and the salt check, before `hashBadge`, `values.label.includes(values.code)` → `setError("label", { type: "validate", message: LABEL_HAS_CODE }, { shouldFocus: true })` and `return` (no hashing, no request, the code is kept). `LABEL_HAS_CODE` at `:27`; new key `office.operators.badges.errors.labelHasCode` at `ru.json:431` («В подписи есть код бейджа — уберите его: подпись видят все станции»). | `operator-badges.test.tsx:405` «refuses a label that holds the scanned code before hashing or sending, and keeps the code» (label typed, scan appended into the LABEL field → empty code refused, no request; code wedged → guard: no call, message under the label with `aria-describedby`, focus on the label, code kept, `deriveBits` not called; label corrected to «Пропуск №8» → exactly one call `{ badgePhc: BADGE_PHC, label: "Пропуск №8" }`, `deriveBits` once) |
| T5#7 focus after a host refusal of the label | `AddBadgeDialog.tsx:121-129`: `setError(outcome.field, {…}, { shouldFocus: true })`                                                                                                                                                                                                                                                                                                                                                                                   | `operator-badges.test.tsx:394` (`document.activeElement` is the label input) in «keeps the masked code when the host refuses only the label…» (`:374`)                                                                                                                                                                                                                                                                                                                     |
| T5#6 in-flight residual                      | `AddBadgeDialog.tsx:65` (`formState: { errors, isSubmitting }`), `:176` `readOnly={saltMissing                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | isSubmitting}`; comment at `:148-154` | `operator-badges.test.tsx:444` «keeps the code field read-only from the submit to the answer, hashing included, and editable after» (holds `crypto.subtle.deriveBits` pending: request not yet made, field read-only; releases it: request pending, still read-only; rejects the request: alert, field editable again and empty) |
| T5#2 (part) empty list                       | `BadgesDialog.tsx` unchanged; the test renders VERA's dialog                                                                                                                                                                                                                                                                                                                                                                                                          | `operator-badges.test.tsx:237` «says so when an operator has no badges yet» (text «Бейджей пока нет.», no list)                                                                                                                                                                                                                                                                                                                                                            |

Test-file helpers added: `labelField()`, `wedgeInto(field, text)` (`wedge` now calls it), `openBadges(session, operator = ANNA)`, `afterEach(vi.restoreAllMocks)`.

### Mutations (commit 1, run on the final file state)

**`c1f-m1-drop-guard`** — AddBadgeDialog.tsx: the whole `if (values.label.includes(values.code)) { … }` block removed (the brief's mutant).

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > refuses a label that holds the scanned code before hashing or sending, and keeps the code 1185ms
  → Unable to find an element with the text: В подписи есть код бейджа — уберите его: подпись видят все станции. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your tex
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m2a-drop-shouldFocus-host`** — AddBadgeDialog.tsx: the host's field refusal `setError(outcome.field, …, { shouldFocus: true })` without `shouldFocus` (T5#7, the brief's mutant).

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > keeps the masked code when the host refuses only the label, and shows it under the label 1166ms
  → expected <input …(11)></input> to be <input …(11)></input> // Object.is equality
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m2b-drop-shouldFocus-guard`** — AddBadgeDialog.tsx: the guard's `setError("label", …)` without `{ shouldFocus: true }`.

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > refuses a label that holds the scanned code before hashing or sending, and keeps the code 1181ms
  → expected <input …(11)></input> to be <input …(11)></input> // Object.is equality
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m3-drop-isSubmitting`** — AddBadgeDialog.tsx: `readOnly={saltMissing || isSubmitting}` → `readOnly={saltMissing}` (T5#6, the brief's mutant).

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > keeps the code field read-only from the submit to the answer, hashing included, and editable after 146ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m3b-add-isPending`** — AddBadgeDialog.tsx: `readOnly={saltMissing || add.isPending}` (stronger: the brief says `add.isPending` misses the hashing window).

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > keeps the code field read-only from the submit to the answer, hashing included, and editable after 150ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m4-drop-empty-branch`** — BadgesDialog.tsx: `operator.badges.length === 0 ? (<p>…</p>) : (<ul>…)` → `false ? …` (T5#2, the brief's mutant).

- file: `apps/standalone/src/office/operators/BadgesDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > says so when an operator has no badges yet 73ms
  → Unable to find an element with the text: Бейджей пока нет.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.
  ```
- revert: sha256 before `928bd2b60142aaa8323dcd7e6872afa1f1ef3da3bf8c3e6539fb337bfb0e55d3` = restored `928bd2b60142aaa8323dcd7e6872afa1f1ef3da3bf8c3e6539fb337bfb0e55d3`; identical to before: True; cmp against pre-mutation copy: identical

**`c1f-m5-guard-after-hashing`** — AddBadgeDialog.tsx: the guard moved after `hashBadge`, still before the request (stronger: pins «BEFORE hashBadge» / «no hashing»).

- file: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 22 passed (23)
- failing output:
  ```
  × test/operator-badges.test.tsx > operator badges > refuses a label that holds the scanned code before hashing or sending, and keeps the code 201ms
  → expected "deriveBits" to not be called at all, but actually been called 1 times
  Received:
  ```
- revert: sha256 before `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef` = restored `4d6d7d0ae27c64bfe71ab5772207c75bc1e43e8affb5d2b418bbe8a7df0118ef`; identical to before: True; cmp against pre-mutation copy: identical

## Commit 2 — webview test teeth and the pairing-screen message (e1b907e91)

| Item | What changed                                                                                                                                                                                                                                                                                                                                                                                              | Pinned by                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1#1 | `NetworkPairing.tsx:108,146,253`: `nameInvalid` boolean → `nameError` (i18n key of the FIRST issue, `parsed.error.issues[0]?.message ?? "rules.name"`); a tab or a lone surrogate now says `rules.controlCharacter`, a blank / too long name keeps `rules.name`. `AGENTS.md` never named the pairing screen as an exception to the message rule (only the wizard's line names), so no doc fix was needed. | `network-pairing.test.tsx:280` (empty, 101 characters → length text), `:292` (tab inside, lone surrogate → control-character text), `:304` (manual form, tab)                                                           |
| T1#2 | tests only                                                                                                                                                                                                                                                                                                                                                                                                | `rules.test.ts:346` (DEL refused, `~` accepted), `:306` (lone surrogate in role and label), `:317` (120/121 emoji for role, 100/101 for label), `:329` (order for `optionalTextRule`), `:98` (order for `passwordRule`) |
| T1#3 | test only                                                                                                                                                                                                                                                                                                                                                                                                 | `credentials.test.ts:77` (mocked bytes `0xfb 0xff 0xbf …` → salt field exactly `+/+/+/+/+/+/+/+/+/+/+w==`, verified with Node's own base64; `verifyPhc` true)                                                           |
| T2#1 | six refusal rows added to the shared salt table (all three `SALT_CHECKS` schemas)                                                                                                                                                                                                                                                                                                                         | `protocol.test.ts:312-317` (`SALT` at `:283`)                                                                                                                                                                           |
| T2#2 | tests only (+ the optional re-enable)                                                                                                                                                                                                                                                                                                                                                                     | `protocol.test.ts:473` (`active: false` → `{ active: true }`), `:478` (`role: null` over `null`, renamed and not renamed)                                                                                               |
| T2#3 | tests only                                                                                                                                                                                                                                                                                                                                                                                                | `protocol.test.ts:396` (`typed` with `pin`), `:407` (`scanned` with `code`), `toStrictEqual` against the fixtures                                                                                                       |
| T4#1 | PIN typed as « 4821 » / « 1357 » (both inputs), `verifyPhc("4821"/"1357", …)` kept; test count unchanged                                                                                                                                                                                                                                                                                                  | `operators-page.test.tsx:164` (`fillNewOperator`), `:412`                                                                                                                                                               |
| T4#2 | four new tests                                                                                                                                                                                                                                                                                                                                                                                            | `operators-page.test.tsx:375` (stale PIN change), `:430` (stale turn-off), `:388` (`pinPhc` under the PIN, PIN dialog), `:295` (`pinPhc` under the PIN, create dialog)                                                  |
| T4#5 | class assertions                                                                                                                                                                                                                                                                                                                                                                                          | `operators-page.test.tsx:453` (`mk-btn--destructive` for «Выключить»), `:475-476` (`mk-btn--primary`, not destructive, for «Включить»)                                                                                  |
| T4#7 | rename only                                                                                                                                                                                                                                                                                                                                                                                               | `operators-page.test.tsx:173` «sits between «Линии» and «Устройства» in an administrator's menu»                                                                                                                        |
| T8#3 | rename only                                                                                                                                                                                                                                                                                                                                                                                               | `line-select.test.tsx:174` «shows progress, not the older read failure, while the retry syncs»                                                                                                                          |

The two renames (T4#7, T8#3) change no behavior and have no mutant.

### Mutations (commit 2)

The credentials mutants were re-run after the last edit of `credentials.test.ts` (the bytes literal); all others ran on the committed state of their files.

**`c2-a1-constant-name-text`** — NetworkPairing.tsx: `t(nameError)` → `t("rules.name")`, the constant text again (T1#1, the brief's mutant).

- file: `apps/standalone/src/app/NetworkPairing.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 3 failed | 34 passed (37)
- failing output:
  ```
  × test/network-pairing.test.tsx > NetworkPairing > names a tab inside it in a device name in its own words, not as a wrong length 1021ms
  → Unable to find an element with the text: Уберите табуляцию, перенос строки или другой служебный символ. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text mat
  × test/network-pairing.test.tsx > NetworkPairing > names an unpaired surrogate in a device name in its own words, not as a wrong length 1018ms
  × test/network-pairing.test.tsx > NetworkPairing > says the same on the manual form, where the name is checked too 1027ms
  ```
- revert: sha256 before `2ef19906ad606f6331c1f7594abe6604d2baf9212097f0411d1df51ba65a1fc1` = restored `2ef19906ad606f6331c1f7594abe6604d2baf9212097f0411d1df51ba65a1fc1`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a2-code-upper-bound-DEL`** — rules.ts `badgeCodeRule`: `/^[ -~]{1,256}$/` → `/^[ -\x7f]{1,256}$/` (T1#2, the brief's mutant).

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > operator rules > ends printable ASCII at the tilde: ~ is a code character, DEL is not 4ms
  → expected undefined to be 'rules.badgeCode' // Object.is equality
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a3-code-upper-bound-tilde`** — rules.ts `badgeCodeRule`: `[ -~]` → `[ -}]` (the tilde refused).

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > operator rules > ends printable ASCII at the tilde: ~ is a code character, DEL is not 3ms
  → expected undefined to be 'MRK~742' // Object.is equality
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a4-optionalText-Cc-only`** — rules.ts `optionalTextRule`: the control check is `/\p{Cc}/u` only, no lone surrogate (T1#2, the brief's mutant).

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > operator rules > refuses an unpaired surrogate in a role and a label, as a control character 3ms
  → expected undefined to be 'rules.controlCharacter' // Object.is equality
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a5-optionalText-utf16-length`** — rules.ts `optionalTextRule`: `characters(text) <= max` → `text.length <= max` (UTF-16 units).

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > operator rules > counts a role and a label in characters, not UTF-16 units: an emoji is one 3ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a6-optionalText-order`** — rules.ts `optionalTextRule`: the length refine and the control refine swapped.

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > operator rules > says the length first when a role or a label is too long and holds a control character too 4ms
  → expected [ 'rules.controlCharacter', …(1) ] to deeply equal [ 'rules.role', …(1) ]
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a7-password-order`** — rules.ts `passwordRule`: the length refine and the surrogate refine swapped.

- file: `apps/standalone/src/lib/rules.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 33 passed (34)
- failing output:
  ```
  × test/rules.test.ts > office user rules > says the length first when a password is too short and holds an unpaired surrogate too 4ms
  → expected [ 'rules.passwordCharacter', …(1) ] to deeply equal [ 'rules.password', …(1) ]
  ```
- revert: sha256 before `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21` = restored `ca3df070e515dc631fdfa847e321415db630bc53c809d4684ccbb732135ddc21`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-a8-constant-control-text`** — NetworkPairing.tsx: `t(nameError)` → `t("rules.controlCharacter")` (the other direction: kills the length-message tests).

- file: `apps/standalone/src/app/NetworkPairing.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 3 failed | 34 passed (37)
- failing output:
  ```
  × test/network-pairing.test.tsx > NetworkPairing > asks for a device name before anything reaches the network 1017ms
  → Unable to find an element with the text: Укажите имя, до 100 символов. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more fl
  × test/network-pairing.test.tsx > NetworkPairing > keeps the length message for a device name that is empty 1020ms
  × test/network-pairing.test.tsx > NetworkPairing > keeps the length message for a device name that is over 100 characters 1023ms
  ```
- revert: sha256 before `2ef19906ad606f6331c1f7594abe6604d2baf9212097f0411d1df51ba65a1fc1` = restored `2ef19906ad606f6331c1f7594abe6604d2baf9212097f0411d1df51ba65a1fc1`; identical to before: True; cmp against pre-mutation copy: identical

**`c2f-b1-urlsafe-toBase64`** — credentials.ts `toBase64`: URL-safe alphabet (`+`→`-`, `/`→`_`) (T1#3, the brief's mutant).

- file: `apps/standalone/src/lib/credentials.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 2 failed | 6 passed (8)
- failing output:
  ```
  × test/credentials.test.ts > operator credentials > writes the salt in standard base64 with padding, with + and / where the bytes need them 2ms
  × test/credentials.test.ts > operator credentials > gives every PIN hash a fresh salt, in standard base64 with padding 1ms
  ```
- revert: sha256 before `178fe45ad2347b9d53020c5f4b205c8d0f1dd5d0f53bf0b69d3f141f93ae8988` = restored `178fe45ad2347b9d53020c5f4b205c8d0f1dd5d0f53bf0b69d3f141f93ae8988`; identical to before: True; cmp against pre-mutation copy: identical

**`c2f-b2-unpadded-toBase64`** — credentials.ts `toBase64`: padding stripped.

- file: `apps/standalone/src/lib/credentials.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 3 failed | 5 passed (8)
- failing output:
  ```
  × test/credentials.test.ts > operator credentials > hashes a PIN with 16 random salt bytes into the domain's format 15ms
  → expected 'pbkdf2$sha256$100000$bWFya2lyby1waW4t…' to be 'pbkdf2$sha256$100000$bWFya2lyby1waW4t…' // Object.is equality
  × test/credentials.test.ts > operator credentials > writes the salt in standard base64 with padding, with + and / where the bytes need them 12ms
  → expected '+/+/+/+/+/+/+/+/+/+/+w' to be '+/+/+/+/+/+/+/+/+/+/+w==' // Object.is equality
  × test/credentials.test.ts > operator credentials > gives every PIN hash a fresh salt, in standard base64 with padding 23ms
  → expected 'pbkdf2$sha256$100000$/Fse97RSrUBH8tqH…' to match /^pbkdf2\$sha256\$…/]{22}==\$[A-Za-z0-9+
  ```
- revert: sha256 before `178fe45ad2347b9d53020c5f4b205c8d0f1dd5d0f53bf0b69d3f141f93ae8988` = restored `178fe45ad2347b9d53020c5f4b205c8d0f1dd5d0f53bf0b69d3f141f93ae8988`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c1-eq-0-2`** — protocol.ts `canonicalSaltSchema`: `==` → `={0,2}` (T2#1, the brief's mutant 1 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 6 failed | 132 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 4ms
  → AAECAwQFBgcICQoLDA0ODw: expected true to be false // Object.is equality
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes with one = (23 characters) 0ms
  → AAECAwQFBgcICQoLDA0ODw=: expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 0ms
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes with one = (23 characters) 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c2-eq-star`** — `canonicalSaltSchema`: `==` → `=*` (2 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 6 failed | 132 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 3ms
  → AAECAwQFBgcICQoLDA0ODw: expected true to be false // Object.is equality
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes with one = (23 characters) 0ms
  → AAECAwQFBgcICQoLDA0ODw=: expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 0ms
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 16 bytes with one = (23 characters) 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses 16 bytes without padding (22 characters) 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c3-no-caret`** — `canonicalSaltSchema`: the `^` dropped (3 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 6 failed | 132 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 4ms
  → AAECAwQFBgcICQoLDA0ODxAREg==: expected true to be false // Object.is equality
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses a character in front of a canonical salt 0ms
  → xAAECAwQFBgcICQoLDA0ODw==: expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 0ms
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses a character in front of a canonical salt 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c4-no-dollar`** — `canonicalSaltSchema`: the `$` dropped (4 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 6 failed | 132 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses a character after a canonical salt 3ms
  → AAECAwQFBgcICQoLDA0ODw==A: expected true to be false // Object.is equality
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses a newline after a canonical salt 0ms
  : expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses a character after a canonical salt 0ms
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses a newline after a canonical salt 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses a character after a canonical salt 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c5-21-plus`** — `canonicalSaltSchema`: `{21}` → `{21,}` (5 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 6 failed | 132 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 3ms
  → AAECAwQFBgcICQoLDA0ODxAREg==: expected true to be false // Object.is equality
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses a character in front of a canonical salt 0ms
  → xAAECAwQFBgcICQoLDA0ODw==: expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 0ms
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses a character in front of a canonical salt 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses 19 bytes, which end in a valid last data character (28 characters) 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-c6-m-flag`** — `canonicalSaltSchema`: the `m` flag added (6 of 6).

- file: `apps/standalone/src/host/protocol.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 3 failed | 135 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > badgeSaltSchema takes only a canonical 16-byte salt > refuses a newline after a canonical salt 4ms
  : expected true to be false // Object.is equality
  × test/protocol.test.ts > canonicalSaltSchema takes only a canonical 16-byte salt > refuses a newline after a canonical salt 0ms
  × test/protocol.test.ts > siteRecordSchema takes only a canonical 16-byte salt > refuses a newline after a canonical salt 0ms
  ```
- revert: sha256 before `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e` = restored `5b67bb26cb9973f24380756ec158ccd54417971a6139984f0ace91a09c38b98e`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-d1-role-null-always`** — requests.ts `operatorUpdate`: `role` is sent whenever it is `null` (T2#2, the brief's mutant).

- file: `apps/standalone/src/host/requests.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 137 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > request builders send only what changes > names only the operator fields that differ, clears a role with null and always sends a new PIN 4ms
  → expected { expectedRev: 55, …(2) } to strictly equal { name: 'Анна Петрова', …(1) }
  ```
- revert: sha256 before `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a` = restored `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-d2-active-true-never-sent`** — requests.ts `operatorUpdate`: `active` goes only when turning off (T2#2 re-enable).

- file: `apps/standalone/src/host/requests.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 137 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > request builders send only what changes > names only the operator fields that differ, clears a role with null and always sends a new PIN 4ms
  → expected { expectedRev: 55 } to strictly equal { active: true, expectedRev: 55 }
  ```
- revert: sha256 before `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a` = restored `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-d3-operatorCreate-spread`** — requests.ts `operatorCreate`: `return { ...operator }` (T2#3, the brief's mutant).

- file: `apps/standalone/src/host/requests.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 137 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > request builders produce their fixtures exactly > an operator to create, and one to update that clears the role, turns off and gets a new PIN 4ms
  → expected { login: '0042', …(4) } to strictly equal { login: '0042', …(3) }
  ```
- revert: sha256 before `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a` = restored `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-d4-badgeCreate-spread`** — requests.ts `badgeCreate`: `return { ...badge }` (T2#3, the brief's mutant).

- file: `apps/standalone/src/host/requests.ts`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 137 passed (138)
- failing output:
  ```
  × test/protocol.test.ts > request builders produce their fixtures exactly > a badge to add 4ms
  → expected { …(3) } to strictly equal { …(2) }
  ```
- revert: sha256 before `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a` = restored `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e1-pin-raw`** — OperatorPinDialog.tsx: `zodResolver(pinFormSchema, undefined, { raw: true })` (T4#1, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorPinDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > replaces the PIN with a new hash and the loaded revision 188ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c` = restored `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e2-pin-getValues`** — OperatorPinDialog.tsx: `hashPin(getValues("pin"))` (T4#1, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorPinDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > replaces the PIN with a new hash and the loaded revision 184ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c` = restored `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e3-create-raw`** — CreateOperatorDialog.tsx: `zodResolver(newOperatorSchema, undefined, { raw: true })` (bonus; also un-trims login/name/role).

- file: `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 3 failed | 16 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > adds an operator with the trimmed values and only a hash of the PIN 153ms
  → expected [ [ 'office-session-token', …(1) ] ] to strictly equal [ [ 'office-session-token', …(1) ] ]
  × test/operators-page.test.tsx > office operators > sends a blank role as none 1132ms
  → Unable to find an element with the text: Оператор «Иван Петров» добавлен.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher mor
  × test/operators-page.test.tsx > office operators > hashes and sends one operator for a double click 1130ms
  ```
- revert: sha256 before `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b` = restored `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e4-create-getValues`** — CreateOperatorDialog.tsx: `hashPin(getValues("pin"))` (T4#1, the brief's mutant).

- file: `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > adds an operator with the trimmed values and only a hash of the PIN 160ms
  → expected false to be true // Object.is equality
  ```
- revert: sha256 before `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b` = restored `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e5-pin-no-onReload`** — OperatorPinDialog.tsx: `onReload` dropped from `WriteFailureAlert` (T4#2, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorPinDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > offers to load the operators again after a stale PIN change 1115ms
  → Unable to find role="button" and name "Загрузить заново"
  ```
- revert: sha256 before `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c` = restored `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e6-access-no-onReload`** — OperatorAccessDialog.tsx: `onReload` dropped from `WriteFailureAlert` (T4#2, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorAccessDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > offers to load the operators again after a stale turn-off 1125ms
  → Unable to find role="button" and name "Загрузить заново"
  ```
- revert: sha256 before `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362` = restored `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e7-create-no-pinPhc`** — CreateOperatorDialog.tsx: `pinPhc` entry dropped from `CREATE_FIELDS` (T4#2, the brief's mutant).

- file: `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > says under the PIN when the host refuses its hash in a new operator 1147ms
  → Unable to find an element with the text: Хост не принял это значение. Проверьте его.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your
  ```
- revert: sha256 before `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b` = restored `9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e8-pin-no-pinPhc`** — OperatorPinDialog.tsx: `PIN_FIELDS = {}` (the `pinPhc` entry dropped) (T4#2, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorPinDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > says under the PIN when the host refuses its hash in a new PIN 1118ms
  → Unable to find an element with the text: Хост не принял это значение. Проверьте его.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your
  ```
- revert: sha256 before `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c` = restored `1e631a422539d1682486bb4fe456c031bfab507e8e8380d8526559ed3073fc7c`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e9-variant-primary-both`** — OperatorAccessDialog.tsx: `submitVariant="primary"` for both (T4#5, the brief's mutant).

- file: `apps/standalone/src/office/operators/OperatorAccessDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > turns an operator off after saying they can no longer sign in on the stations 113ms
  → expected 'mk-btn mk-btn--primary mk-btn--md' to contain 'mk-btn--destructive'
  ```
- revert: sha256 before `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362` = restored `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362`; identical to before: True; cmp against pre-mutation copy: identical

**`c2-e10-variant-destructive-both`** — OperatorAccessDialog.tsx: `submitVariant="destructive"` for both (reverse).

- file: `apps/standalone/src/office/operators/OperatorAccessDialog.tsx`; exit `1 (non-zero expected)`; run: Test Files 1 failed (1); Tests 1 failed | 18 passed (19)
- failing output:
  ```
  × test/operators-page.test.tsx > office operators > turns an operator back on after a light confirmation 118ms
  → expected 'mk-btn mk-btn--destructive mk-btn--md' to contain 'mk-btn--primary'
  ```
- revert: sha256 before `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362` = restored `34671b4e6b4834b0da54d1afe1120a76b760a7d72c9e1157a314aea794ea1362`; identical to before: True; cmp against pre-mutation copy: identical

## Commit 3 — Rust tests and comments (8d4a3a295)

| Item          | What changed                                                                                                                                                                                                                                                                              | Pinned by                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T3#1          | `badges.rs`: after the revoke and the re-add by `second` the request uses `Some(same.clone())`, then `same` is POSTed for `first` and `details == {constraint: "badge", operatorId: second}`                                                                                              | `badges.rs:245-251` (fails at `:245` under the mutant)                       |
| T3#2          | `host_revision` and `audit_rows` asserted unchanged around both refused-conflict blocks                                                                                                                                                                                                   | `badges.rs:193-194,211-212` (first block), `:236-237,252-253` (second block) |
| T3#4          | loop variable `owner` → `asker`                                                                                                                                                                                                                                                           | `badges.rs:195`                                                              |
| T3#3 comment  | `operators.rs:298-304`: «whom `details.operatorId` names when the holder is found … the plain conflict, without `operatorId`, if it is not (only the new badge's random id colliding …)» — verified: `operator_badges` has only the PK and the partial unique index as unique constraints | comment only                                                                 |
| T7#1 comments | `local_db.rs:73-76` (`StatementFailed` doc: the busy checkpoint is the one exception, the delete stays committed and a retry repeats only the checkpoint) and `:233-236` (`clear_copies` doc)                                                                                             | comments only                                                                |
| M4 comment    | `local_db.rs:327-331`: `remove_unopened` states the rule of `AGENTS.md` (device-owned data must stay out of this removal; block or confirm a forget while unsynced records exist)                                                                                                         | comment only                                                                 |
| T7#4          | the stuck-file test now has `-shm` and `-journal` (after the WAL in removal order), asserts they are gone after the failed forget, that the stuck directory stays, the main file is gone, and that `device_status` is unchanged (the pairing stays)                                       | `ipc.rs:495-533` (fails at `ipc.rs:528` under the mutant)                    |
| T7#5          | helper `unopened_database(dir, beside)` (`ipc.rs:453`): the open fails with ONLY the garbage main file present, then the other files are created; both unopened-database tests use it (first test asserts all four exist before the forget)                                               | see «Deviations» (not exercisable on this host)                              |

Stability: the three `forgetting_the_device` tests passed 60 of 60 consecutive runs of the built binary on the final sources.

### Mutations (commit 3) and control runs

**`c3-m1-owner-lookup-revoked`** — operators.rs owner lookup without `AND revoked_at IS NULL` (T3#1, the brief's mutant).

- file: `apps/standalone/host/src/routes/operators.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
- failing output:
  ```
  test one_badge_code_belongs_to_one_operator_at_a_time ... FAILED
  thread 'one_badge_code_belongs_to_one_operator_at_a_time' (230443922) panicked at host/tests/badges.rs:245:5:
  assertion `left == right` failed
  left: (409, Object {"constraint": String("badge"), "operatorId": String("f3c106e7-633c-49f6-8047-ffd9edb205ea")})
  right: (409, Object {"constraint": String("badge"), "operatorId": String("ca2b6913-241c-479e-8bf4-c076784c6b83")})
  test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
  error: test failed, to rerun pass `-p markiro-host --test badges`
  ```
- revert: sha256 before `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428` = restored `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-m2a-conflict-commits-revision`** — operators.rs `create_badge`: a refused conflict commits the revision it took (`commit_with_revision` before returning the error) (T3#2).

- file: `apps/standalone/host/src/routes/operators.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
- failing output:
  ```
  test one_badge_code_belongs_to_one_operator_at_a_time ... FAILED
  thread 'one_badge_code_belongs_to_one_operator_at_a_time' (230445552) panicked at host/tests/badges.rs:211:5:
  assertion `left == right` failed
  left: 6
  right: 4
  test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
  error: test failed, to rerun pass `-p markiro-host --test badges`
  ```
- revert: sha256 before `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428` = restored `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-m2b-conflict-writes-audit-row`** — operators.rs `create_badge`: a refused conflict writes an audit row on a pooled connection after the rollback (T3#2).

- file: `apps/standalone/host/src/routes/operators.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
- failing output:
  ```
  test one_badge_code_belongs_to_one_operator_at_a_time ... FAILED
  thread 'one_badge_code_belongs_to_one_operator_at_a_time' (230447143) panicked at host/tests/badges.rs:212:5:
  assertion `left == right` failed
  left: 7
  right: 5
  test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
  error: test failed, to rerun pass `-p markiro-host --test badges`
  ```
- revert: sha256 before `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428` = restored `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-m4a-stop-at-first-failure`** — local_db.rs `remove_unopened`: `if std::fs::remove_file(file).is_err() { break; }` (T7#4, the brief's mutant).

- file: `apps/standalone/src-tauri/src/local_db.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.11s
- failing output:
  ```
  test forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays ... FAILED
  thread 'forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays' (230451036) panicked at src-tauri/tests/ipc.rs:528:9:
  /tmp/claude-501/.tmpRIXh6e/standalone-station.db-shm is still there
  test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.11s
  error: test failed, to rerun pass `-p markiro-standalone --test ipc`
  ```
- revert: sha256 before `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35` = restored `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-m4b-question-mark`** — local_db.rs `remove_unopened`: `std::fs::remove_file(file)?` (stronger: a missing file ends the call too).

- file: `apps/standalone/src-tauri/src/local_db.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.04s
- failing output:
  ```
  test forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays ... FAILED
  thread 'forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays' (230452646) panicked at src-tauri/tests/ipc.rs:528:9:
  /tmp/claude-501/.tmpQqSaNd/standalone-station.db-shm is still there
  test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.04s
  error: test failed, to rerun pass `-p markiro-standalone --test ipc`
  ```
- revert: sha256 before `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35` = restored `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-old-a-badges`** — CONTROL RUN: HEAD's OLD badges.rs against the m1 mutant (exit 0 = the mutant SURVIVES the old test).

- file: `apps/standalone/host/src/routes/operators.rs`; exit `0 (non-zero expected)`; run: test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.27s
- failing output:
  ```
  test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.27s
  exit with the OLD test: 0 (0 = the mutant survives the old test)
  new test restored: sha256 6c9f81860e0e04648f1ccbf6e90cddafb7ccc50f2c83e810b591972c39c4d1d6; identical to before: True; cmp: True
  --- old test (apps/standalone/src-tauri/tests/ipc.rs at HEAD) against the mutant; a PASS here means the mutant survived it
  ```
- revert: sha256 before `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428` = restored `42676b59123be1e7a49b99871a6e499202b0b9f9fefb241e5c38a2a5e3a3c428`; identical to before: True; cmp against pre-mutation copy: identical

**`c3-old-b-ipc`** — CONTROL RUN: HEAD's OLD ipc.rs against the m4a mutant (the old stuck-file test passes, i.e. survives; the old first test fails only through a race, see «Deviations»).

- file: `apps/standalone/src-tauri/src/local_db.rs`; exit `101 (non-zero expected)`; run: test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.13s
- failing output:
  ```
  test forgetting_the_device_removes_a_local_database_that_did_not_open ... FAILED
  thread 'forgetting_the_device_removes_a_local_database_that_did_not_open' (230506032) panicked at src-tauri/tests/ipc.rs:469:5:
  assertion `left == right` failed
  left: Err(String("storage"))
  right: Ok(Null)
  test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.13s
  error: test failed, to rerun pass `-p markiro-standalone --test ipc`
  ```
- revert: sha256 before `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35` = restored `95b47429c5ef22936aaa041c7612a6c4588ef4801432ba7b993851b2464e4d35`; identical to before: True; cmp against pre-mutation copy: identical

## Commit 4 — documents and comments (89f99cba7)

| Item          | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I2            | spec §5.6 (`…-01-foundation-design.md:624-630`): one sentence — the plan-1f rules in `AGENTS.md` override «без изменений алгоритма» (`auth.ts` does not trim and takes the first match; here trim, hash once, whole-string compare, refuse an ambiguous badge). `AGENTS.md:332-337`: clause «A scan is trimmed as `badgeCodeRule` trims a code, and a Cyrillic one is refused with the hint to switch the layout, never read by key position»; the ~85-column line re-wrapped.                                                                                                                                                                                                                         |
| I3            | all four places: `AGENTS.md:449-456` («Protocol»), spec §6 (`:652-653` a pointer in the first bullet, `:660-668` the full statement in the second), `protocol.ts:17-24` (header comment) and `protocol.ts:113-117` (section title comment). Each says: feed records that grant access or carry the salt are read strictly, an additive field on them breaks older stations (quarantine, then the fail-closed delete of their copy; an operator edited after a host upgrade cannot sign in on a station not updated; `site` loses the badge salt AND the block sizes); the policy is carried to plan 5, the block-size coupling to plan 2a and the owner. `proto/src/lib.rs:7` untouched as instructed. |
| M1            | `AGENTS.md:424`: «until a new pairing with the same host stamps `host_id` again (as above)»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| M2            | `AGENTS.md:816-818` («Logs»): badge codes (a scan is one; plan 1f will handle them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3            | `AGENTS.md:610-612`: badge-salt exception to «`staleTime` 0»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T1#6          | `AGENTS.md:310-318`: the forms' rules follow the host for login, role, label; the PIN rule mirrors the cloud's (`apps/api/src/modules/operators/dto.ts`), the host never sees a PIN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T3#3 docs     | spec §4.6 (`:303-304`), `AGENTS.md:296-298`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T5#10         | `AGENTS.md:752-753` (message under a field stays until the next input into it, an alert until the next send; the old sentence is gone with the rewritten prose); spec §5.5 (`:587-589`): «отказ только по подписи (в том числе подпись с кодом внутри) код не стирает» with a pointer to `AGENTS.md`, without duplicating the table                                                                                                                                                                                                                                                                                                                                                                    |
| T7#1 docs     | `AGENTS.md:154-156`: «the call then fails; the delete stays committed and a retry repeats only the checkpoint»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T7#3          | `AGENTS.md:148-154` and spec §5.2 (`:449-455`): one sentence each on the limits of the erasure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T8#2          | `AGENTS.md:631-634` («App shell»): while `lines` is `null` the status line gets the sync state without `failure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Failure table | `AGENTS.md:726-766` (table at `:742-750`): code field read-only until the salt is read and while a submit is in flight; 7-row table (failure → code field emptied/kept → focus → where the message appears); the label guard and its two trade-offs (a label that repeats the printed number; a very short code that is a substring by coincidence)                                                                                                                                                                                                                                                                                                                                                    |

Checks: `prettier --check` on the three files and on all 52 changed `.ts/.tsx/.json/.md/.css` files of the range; `git diff --check`; full vitest/typecheck/lint/build (comments only in `protocol.ts`).

## Delayed-`setImmediate` stand (3 ms; the two temporary files were created, used and removed each time; `git status` confirmed)

- Commit 1: `operator-badges.test.tsx` 23/23 passed, stderr empty (run twice: before and after the final comment edits).
- Commit 2: `network-pairing`, `rules`, `credentials`, `protocol`, `operators-page`, `line-select` — 6 files, 257/257 passed, stderr empty.
- Commits 3 and 4: no webview test file changed (`protocol.ts` got comments only), so the stand was not run.
- `--reporter=verbose` (stdout and stderr to different files): commit 1 `operator-badges.test.tsx` 23/23, stderr empty; commit 2 the same six files 257/257, stderr empty.

## Deviations and decisions

1. **`setError` type of the guard is `"validate"`**, not `"server"`: it is a client-side refusal, as `ChangePasswordDialog` does for the repeated password; the brief left the `type` open.
2. **Extra strength in commit 1**: the guard test also spies on `crypto.subtle.deriveBits` (call-through) to pin «no hashing»; the in-flight test holds `deriveBits` to look at the hashing window. Extra mutants beyond the brief: the guard after hashing (`c1f-m5`), `add.isPending` (`c1f-m3b`), no `shouldFocus` in the guard (`c1f-m2b`).
3. **Commit 2 extras**: the «renamed role-less operator» assertion beside the brief's (`{ name: anna.name, role: null }`); the optional re-enable assertion; length-message tests for the pairing screen (empty, 101 characters) and a manual-form case, so both directions of T1#1 are pinned (`c2-a1` and `c2-a8`).
4. **T1#1 fallback**: `issues[0]?.message ?? "rules.name"` — `noUncheckedIndexedAccess` needs a value; a failed parse always has an issue.
5. **T7#5 cannot be exercised on this host, but its cause is visible here.** The Windows failure needs a mapped `-shm` that is truncated while sqlx still holds it, which macOS cannot show. What I could show: SQLite removes `-wal`, `-shm` and `-journal` when a failed open of a garbage database is closed (probe with Python's sqlite3 3.53.4: all four files present before, only the main file after; with only the main file present nothing appears or vanishes), and sqlx closes the handle asynchronously. So the OLD first unopened-database test did not reliably hand the forget the four files it wrote: with HEAD's old `ipc.rs` and a `remove_unopened` that prints the first failing `remove_file` and stops (`c3-race-probe`), the forget found the rewritten `-wal` already gone (`PROBE …-wal failed: NotFound`), stopped there and left `-shm` and `-journal` (`left: Err("storage") right: Ok(Null)`); the OLD stuck-file test still passed (`PROBE …-wal failed: PermissionDenied`, then `NotFound` on the retry, and no `-shm`/`-journal` existed to be left behind). That is why the OLD suite only caught the «stop at the first failure» mutant by accident, and why the new stuck-file test carries the `-shm`/`-journal` assertion on purpose. The new helper creates the side files only after the failed open, when SQLite has nothing of theirs to remove (60/60 stable runs of the three forget tests on the final sources).
6. **Doc claim without a committed test**: table row «The form refuses the label → focus goes to the label» rests on react-hook-form's default `shouldFocusError`; I checked it with a scratch assertion (`document.activeElement` is the label after the form's own refusal; passed; reverted byte-identical) but did not add it to the suite, since the brief lists no such item.
7. **`graphify update .`** not run: this worktree has no `graphify-out/`.
8. The `AGENTS.md` table is wider than 100 columns because prettier aligns Markdown tables; the file is prettier-clean.

## Left / not verified

- Windows (T7#5's mapped-file case), the CI job `standalone-windows-build` (needs a push, not authorized), WebView2 (WebCrypto and PBKDF2 timing, wedge-scanner Enter and focus behavior), a real scanner, any browser: none exercised here.
- Repo-wide `pnpm format:check` was not run; prettier was run on every changed file of the range instead.
- Queued minors that the brief did not adopt stay queued/dropped: T1#4, #5, #7; T2#4, #5; T3#5; T4#3, #6 (T4#4 only at builder level through T2#2); T5#1, #4, #9 (the narrow «scan that starts while the salt loads» case is not recorded in `AGENTS.md`); T7#2, #6; T8#1, #4, #5, #6.
- `proto/src/lib.rs:7` still carries the lenient-responses wording (out of scope).
