# Plan 1d3 — final-review fix wave: report

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Base HEAD: `0d7e67f21`. Five commits, nothing pushed, no new branch, no stash, no `pnpm install`,
no dependency change. Webview (TypeScript), tests and Markdown only; no Rust, cargo not run.

| #        | Commit      | Subject                                                                                                               | Vitest after it                                           |
| -------- | ----------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| baseline | `0d7e67f21` | (HEAD before the wave)                                                                                                | 32 files / 631 tests, stderr = only pnpm's `$ vitest run` |
| 1        | `4fe81f30a` | итоговое ревью 1d3 (1/5) — запись встаёт на своё место, отозванное устройство сразу мёртвое, заголовок возврата линии | 33 files / 641 tests                                      |
| 2        | `0d2962e38` | итоговое ревью 1d3 (2/5) — обратные вызовы после записи вне try                                                       | 33 / 641 (every existing test unchanged)                  |
| 3        | `e776f469d` | итоговое ревью 1d3 (3/5) — непарные суррогаты и правило имени устройства                                              | 33 / 646                                                  |
| 4        | `ebc0bb15a` | итоговое ревью 1d3 (4/5) — тесты повтора чтения устройства, двойного щелчка, архива линии, заголовки                  | 33 / 650                                                  |
| 5        | `ef85eec6a` | итоговое ревью 1d3 (5/5) — документы и комментарии                                                                    | 33 / 650                                                  |

Every commit was checked with `git log -1 --format=%B`: exactly one `Co-Authored-By:` line,
`Claude Opus 5.5 <noreply@anthropic.com>`, last line of the message.
`typecheck`, `lint` and `prettier --check` (changed files) were green after every commit;
`git diff --check` clean; `git status` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
shows only the known `src/host/pairing-code.ts:66`. No raw invisible character is left in the
edited files (scanned by code point; two raw ZWJ that slipped into a new test string were replaced
by `\u200d` escapes before staging).

## How mutations were done

A mutation is a scratch edit made by a script that asserts its old text matches exactly once, then
the relevant test file is run with `--reporter=verbose` (stdout and stderr to different files under
`$TMPDIR`; vitest prints failure details to stderr), then the file is restored from a byte copy taken
before. The changed files were `git add`ed first, so `git diff -- <file>` (worktree vs index) is a
valid "empty" proof. After every restore the script printed the sha256 before and after (whole digest
compared) and `git diff -- <file>: EMPTY`. All restores: **sha256 EQUAL, git diff EMPTY**. The digests
(before = after) are listed in the last section.

## Commit 1 — `4fe81f30a`

### A. `withRecord` replaces in place

- `apps/standalone/src/office/records.tsx:30-39` (`withRecord` with its doc): replaces the record with
  its id at the same position (`map`), else appends (`[...records, record]`); never mutates. The doc of
  `useStoreRecord` (`:41-46`) says so too.
- New `apps/standalone/test/records.test.tsx` (10 tests, `renderHook` + a real `QueryClientProvider`,
  `vi.spyOn(client, "invalidateQueries")`; inputs are deep-frozen so a mutating implementation throws):
  - `withRecord`: replace keeps position `:32`, append when new `:44`, input array and record untouched `:53`;
  - `activeFirstByName`: active before archived, each group by name `:71`; «Линия 2» before «Линия 10» `:86`;
    equal names ordered by id `:96`; input not mutated `:106`;
  - `useStoreRecord`: replaces in place in the cached list `:129`; appends a new one `:139`; no cached list
    → `invalidateQueries({ queryKey })` and nothing cached `:148`.
  - Note: React Query's structural sharing means the cached list holds structurally shared copies, so the
    hook tests compare with `toStrictEqual` (order and content), not by identity.
- Mutation named in the brief — `withRecord` back to `[...records.filter(id !==), record]` (append again):
  - `test/records.test.tsx:38` `withRecord > puts the record in place … keeps its position` —
    `AssertionError: expected [ …(3) ] to strictly equal [ …(3) ]` (received order a, c, b);
  - `test/records.test.tsx:135` `useStoreRecord > replaces the record in the cached list, in place` — same message.
  - 2 failed | 35 passed (records + devices-page files).
- Extra mutants, one per remaining new test (each fails exactly the test named):
  - `withRecord` never appends (`: [...records]`) → `records.test.tsx:49` (append) and `:144` (`useStoreRecord` append);
  - `withRecord` mutates its input (`push` / index assignment) → `:59` `TypeError: Cannot assign to read only property '1' of object '[object Array]'`;
  - `activeFirstByName` without the archived term → `:78`; collator without `numeric` → `:93`; without the id tie-break → `:99`;
    `(records as T[]).sort` in place → `:109` `TypeError: Cannot assign to read only property '0'`;
  - `useStoreRecord` always invalidates → `:135` and `:144`; caches a one-row list when none is loaded → `:151`
    `expected "invalidateQueries" to be called 1 times, but got 0 times`.

### B. A revoked row is dead at once

- `apps/standalone/src/office/devices/DevicesPage.tsx:274-281`: `onRevoked` calls `storeDevice(device)` first
  (as `onSaved` does), then `setDialog(null)`, the notice and `devices.refetch()`.
- Pinned by `apps/standalone/test/devices-page.test.tsx:258-299` (the revoke test, extended): the second
  `listDevices` is held pending (`answerRead`); after the notice, `:286-290` the row shows «Отозвано», no
  «Действует», no buttons, another row unchanged; then the re-read resolves and the final state and the read
  count (`reads + 1`) are checked.
- Mutation: delete the `storeDevice(device)` call → `test/devices-page.test.tsx:286`
  `TestingLibraryElementError: Unable to find an element with the text: Отозвано.` (1 failed | 26 passed).

### K. The restore dialog title names the line

- `apps/standalone/src/office/lines/LineDialog.tsx:98` passes `{ name: mode.line.name }`;
  `apps/standalone/src/i18n/ru.json:318` `restoreTitle` = «Вернуть линию «{{name}}» из архива».
  No other place used the old text (`git grep`: only the two lines above and, in plan documents that were
  not touched, the plan's own copy).
- The old lines test never asserted the dialog's title (it used `getByRole("dialog")`), so an assertion was
  **added**: `apps/standalone/test/lines-page.test.tsx:252`
  `getByRole("dialog", { name: "Вернуть линию «Линия 1» из архива" })` (the row button has the same text but
  role `button`).
- Mutations: `LineDialog` without `{ name }` → and, separately, `ru.json` back to the old text → both fail
  `test/lines-page.test.tsx:226` (line numbers then; now `:252`)
  `Unable to find an accessible element with the role "dialog" and name "Вернуть линию «Линия 1» из архива"`.

## Commit 2 — `0d2962e38` (callbacks outside the `try`)

Every site now has `let saved: T; try { saved = await write } catch { …today's handling…; return; }` and the
callback after the `try/catch`. Sites (callback line after the change):
`users/CreateUserDialog.tsx:63`, `users/EditUserDialog.tsx:65`, `users/SetPasswordDialog.tsx:54`,
`ChangePasswordDialog.tsx:85-86` (`reset(); onChanged();` in the old order; the `reset()` at `:56` is the
dialog's own `close`), `sscc/CounterDialog.tsx:88` (the `sscc_below_floor` branch keeps its own `return`,
and the general branch now ends with one), `sscc/BlockSizesForm.tsx:75`, `org/OrgProfilePage.tsx:121`,
`counterparties/CounterpartyDialog.tsx:79`, `lines/LineDialog.tsx:90`, `lines/ArchiveLineDialog.tsx:40`,
`devices/DeviceDialog.tsx:93`, `devices/RevokeDeviceDialog.tsx:37`. All 12 fit the shape; no new
abstraction; `tsc` accepts the definite assignment through `try`/`catch … return`.
Every existing test passes **unchanged** (33 files / 641 tests).

Wave check (throwaway test, never committed, `CounterpartyDialog` rendered directly with `onSaved` throwing,
`createCounterparty` resolving; run with `--dangerouslyIgnoreUnhandledErrors` so the run's verdict depends
only on the observation):

- before the refactor: `OBSERVE host-failure alert shown: true | createCounterparty calls: 1 | onSaved calls: 1`
  (the generic alert «Что-то пошло не так. Повторите попытку.» for a successful write);
- after the refactor: `OBSERVE host-failure alert shown: false | createCounterparty calls: 1 | onSaved calls: 1`,
  plus one `Unhandled Rejection … Error: callback bug` (expected, by design).
  The file was deleted right after; `git status` was clean.

## Commit 3 — `e776f469d`

### D. Lone surrogates

- `apps/standalone/src/lib/rules.ts:23` `CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u` (renamed from
  `CONTROL_CHARACTER`; the single use is `:35`, `isPlainText`). A valid pair (emoji) is one code point and
  stays accepted. The doc comments at `:15-33` now say why (JSON.stringify escape, serde_json, IPC failure,
  blamed on the connection) and that a tab at the edge is trimmed by both JavaScript and Rust, only a tab
  inside survives, and a NUL survives `trim` anywhere (verified in node: edge tab trims, edge/inner NUL and
  inner tab do not).
- Tests, `apps/standalone/test/rules.test.ts`:
  - `:109` `\u0080` (C1 lower bound) joins the refused control list (the test at `:102`);
  - `:121` leading, trailing, inner and reversed lone surrogates refused, emoji/joined family accepted;
  - `:140` the same for `personNameRule`, `deviceNameRule`, `lineNameRule`, `companyNameRule`, `orgFieldsSchema`;
  - `:149` a tab at the edge is trimmed, inside it is refused, a NUL is refused at the edge and inside;
  - `:178` `companyNameRule` accepts exactly 200 characters (also 200 emoji) and refuses 201;
  - `:189` `deviceNameRule`: the host's limit is 100 (`host/src/validate.rs:321-322`, `device_name` →
    `clean_text(field, name, 100, …)`, Rust test `a_device_name_is_trimmed_to_1_to_100_characters`); 100 accepted,
    101 refused, both sides pinned.
  - `apps/standalone/test/wizard-form.test.ts:93-98`: `isPlainText` is also used by the wizard's line names; a lone
    surrogate there is `wizard.errors.lineName`, a pair is a name.
- Mutations on `rules.ts`:
  - `/\p{Cc}/u` (the brief's mutation) → `rules.test.ts:132` `expected true to be false`, `:141`
    `expected undefined to be 'rules.name'`, `wizard-form.test.ts:94` `expected [] to deeply equal [ { field: 'lines.0.name', …(1) } ]` (3 failed);
  - `companyNameRule` limit 100 → `rules.test.ts:179` `expected false to be true`; limit 201 → `:172` and `:180`
    `expected undefined to be 'rules.orgName'`;
  - `deviceNameRule` limit 101 → `:191` `expected undefined to be 'rules.name'`; limit 99 → `:190` `expected false to be true`;
  - regex without U+0080 (`[\u0000-\u001f\u007f\u0081-\u009f\p{Cs}]`) → only `:113` `expected true to be false`.
    (A first attempt used `\u0000-\u007f`, which also dropped printable ASCII and made 17 unrelated tests fail;
    it proved nothing and was replaced by the corrected mutant above.)
  - `plainTextRule` without `.trim()` → `:150` `expected undefined to be 'Линия 2'` and six older tests;
  - valid pairs refused too (`\u{10000}-\u{10ffff}` added) → `:136`, `:146` and the boundary tests.

### E. `NetworkPairing` uses `deviceNameRule`

- `apps/standalone/src/app/NetworkPairing.tsx:10` (import) and `:142`. Behaviour and messages are identical
  (both are `plainTextRule(100, "rules.name")`); `test/network-pairing.test.tsx` passes unchanged. There is no test
  that could tell the two rules apart, so none was added.

## Commit 4 — `ebc0bb15a` (tests and titles only)

- F1 `apps/standalone/test/app.test.tsx:1605` (Task 7 describe): fake timers, `refresh` rejects twice with
  `request_failed`, `link.revision(43)`, `waitFor` two reads, `elapse(2500)` → still 2 (`:1625`), `elapse(2000)` → 3.
  Mutant: delete `cancelRefreshRetry()` at the start of the read (`src/app/host-link.ts:166`) →
  `:1625` `AssertionError: expected "vi.fn()" to be called 2 times, but got 3 times`.
- F2 `app.test.tsx:1645`: `watch` rejects, the first read rejects with `request_failed`; after `settle()`
  `vi.getTimerCount()` is 0 (`:1661`); after `elapse(120_000)` still one read. Mutant: `if (online)` → `if (true)`
  before the read retry (`host-link.ts:192`) → `:1661` `AssertionError: expected 1 to be +0`.
- G1 `test/counterparties-page.test.tsx:287`: both clicks in one `act(() => { … })`. Mutant: delete
  `if (inFlight.current) return;` in `src/office/FormDialog.tsx:60` → `counterparties-page.test.tsx:293`
  `expected "vi.fn()" to be called 1 times, but got 2 times` (the existing `form-dialog.test.tsx:73` fails too).
  Demonstration that the OLD test was blind: the HEAD version of the file, run on the same mutant, passed 10/10.
- G2 `test/devices-page.test.tsx:402` and `:430`: the double-click test is split into the page's button and the
  dialog's «Новый код»; both use one `act` (`:415`, `:440`). Mutant: delete `if (requesting.current) return;`
  (`DevicesPage.tsx:96`) → each fails on its own: `:419` `expected "vi.fn()" to be called 1 times, but got 2 times`
  (page) and `:444` `expected … 2 times, but got 3 times` (dialog). Old combined test on the same mutant: it failed
  only at its dialog half; its page half was blind (the masking the brief anticipated), hence the split.
- H `devices-page.test.tsx:564-608` (join notice): after the join, click «Подключить устройство» and assert
  `toHaveBeenLastCalledWith("office-session-token")` (`:608`). Mutant: drop `&& dialogOpen`
  (`DevicesPage.tsx:102`) → `:608` `expected last "vi.fn()" call to have been called with [ 'office-session-token' ]`
  (it sends `{ replaces }`).
- I `test/lines-page.test.tsx:199`: `updateLine` rejects with `stale_revision`/`details: { currentRev: 43 }`; «Загрузить
  заново» closes the dialog and `listLines` is called exactly twice (checked again after two `setImmediate` turns), and
  `updateLine` once. Mutant: `ArchiveLineDialog` without `onReload` on its `WriteFailureAlert`
  (`ArchiveLineDialog.tsx:50`) → `:214` `Unable to find role="button" and name "Загрузить заново"`.
- J titles: `counterparties-page.test.tsx:88` and `lines-page.test.tsx:86` «is in the menu for a technologist …»;
  `app.test.tsx:1379` «… once together with the first sync …»; `app.test.tsx:1525` names «Повторить» on the line
  screen (comment: `requestSync` also runs after a `line_rejected`).

## Commit 5 — `ef85eec6a` (no behaviour)

`apps/standalone/AGENTS.md`: «Writes» `:196-202` (the trim sets differ in exactly two characters, U+0085 only Rust,
U+FEFF only JavaScript — verified by diffing the two sets over the BMP; a form is never more lenient than the host
only because it sends the trimmed value it validated, and lone surrogates are refused); «Protocol» `:355-360`
(builders since plan 1d3; users, organization, SSCC and wizard bodies are inline); «App shell» `:497-502` (a failed
device read shows no message of its own; `requestSync` triggers both, from «Повторить» and after `line_rejected`;
«The sync run's error …»); the `LineSelect` sentence re-wrapped at `:521-528`; «Office pages» `:567-576`
(`onSubmit` never rejects, callback outside the `try`, `destructive` = takes a record out of use).
Spec `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md:528-531` (§5.5): the cabinet's `useCan` is
replaced by the role-only `useCan` of `src/office/access.ts` (§4.8, plan 1e adds `editCatalog`); the other concepts
stay removed.
Code comments: `host/requests.ts` (`lineCreate` `:54-58`, `LineChange` `:62-66`, `DeviceChange` `:85-89` state the
trimmed-input precondition), `host/api.ts:82-88` (the host ends the named code only if it is live and this office user
created it, ignores anything else and issues the new code either way; checked against `create_code` in
`host/src/routes/pairing.rs` and `PairingCodeRequest` in `proto/src/lib.rs`), `app/host-link.ts:247-249` (the failed-`watch`
branch also reads the device once and retries neither), `office/FormDialog.tsx:12` (`destructive` = takes a record out
of use).

## Delayed `setImmediate` stand (3 ms)

Found and used the project's recipe (memory note «Vitest effect race harness»): a scratch setup file inside the Vite
root that replaces `globalThis.setImmediate` with the real `setTimeout` captured at load, plus a scratch config
`setupFiles: [scratch, "test/setup.ts"]`; both files were deleted after every run (`git status` clean). Proof that the
stand is active: a probe test measured `setImmediate` at 0.08 ms normally and 3.90 ms under the stand (probe deleted).
Results (all green, stderr empty):

- commit 1: `records`, `devices-page`, `lines-page` — 3 files / 47 tests;
- commit 2: `users-page`, `office`, `sscc-page`, `org-page`, `counterparties-page`, `lines-page`, `devices-page`,
  `form-dialog` — 8 files / 114 tests (no test file changed; run because these exercise the 12 sites);
- commit 3: `rules`, `wizard-form`, `network-pairing` — 3 files / 61 tests;
- commit 4: `app`, `devices-page`, `lines-page`, `counterparties-page` — 4 files / 114 tests;
- whole suite at HEAD under the stand: 33 files / 650 tests, stderr empty.
  The four commit-4 files were also run 6 times in a row normally: 114/114 each time, stderr empty.

## Final checks at HEAD `ef85eec6a`

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`: 33 files / 650 tests, stderr = only `$ vitest run`.
- `typecheck`, `lint`, `build` (`vite build`, only the pre-existing «chunks larger than 500 kB» notice): exit 0.
- `node_modules/.bin/prettier --check` on all 30 changed files: clean. `git diff --check 0d7e67f21..HEAD`: clean.
- `git status --short --untracked-files=all`: empty. Files outside the brief's list: none (nothing under `apps/station`,
  `proto`, `host`, `src-tauri`, `packages/`, `.superpowers/` (except this report, which is git-ignored), plan documents).

## Deviations, notes, left as is

1. `DevicesPage.newCode` is a 13th `mutateAsync` call that is not in the brief's 12-site list. It is a page action, not a
   form submit: the code after the write is `setPairing(...)` behind a generation guard, with a `finally` that releases
   the `requesting` flag. Left as is.
2. K: the brief asked to update assertions that name the dialog; none existed, so one was added (see above).
3. G1: the `inFlight` mutant also fails the existing `form-dialog.test.tsx` test, so the guard was already pinned at the
   component level; the counterparties test now pins the page's wiring too.
4. G2: split into two tests instead of one (the brief allowed it "if the dialog half masks it": it did).
5. Not in the brief, left: `AGENTS.md` «Устройства» still says only «then the list is read again» after a revoke; it is
   true, but it does not say that the row is dead at once now (commit 1, B).
6. The RTK hook appends a `Changes:` footer to `git diff --name-only` output; for scripted pipelines I filtered it.
   Tooling only, not a repository matter.

## Not verified (not exercised in this environment)

Tauri window, Windows, hardware/printer/scanner, a real host over the network, browser rendering. Cargo was not run
(no Rust change; expected to stay at 36 suites / 346 tests).

## sha256 of each mutated file (whole digest compared before/after each restore; all equal, `git diff` empty)

- `src/office/records.tsx` `2d24ab33d5ad2689791cfdf55f962e214f0ca5f14eac1d8536dac1eaea238cfa`
- `src/office/devices/DevicesPage.tsx` `dd78775dd24b2d4a6c5007c068cbddd9e2b0973d974bb78a94a241a9a4df0f19`
- `src/office/lines/LineDialog.tsx` `20170468a861c7536304a2866cf210d5dc49315f1f66f7b6ced9ceaee729b017` (state after commit 1; commit 2 edited it later)
- `src/i18n/ru.json` `8a920d7bfe5e885662f723e84cb9ca19e2e96f062f7dfa8d2928ccb3fe658bc8`
- `src/lib/rules.ts` `5350beddf640267feffe6d330de3de6f6c04109509ae9d0a371db68864e57bf0`
- `src/app/host-link.ts` `2bbee817ee7a7c110785166424023841d62ac60003a49907be3128931ff2845e` (state after commit 4; commit 5 edited a comment later)
- `src/office/FormDialog.tsx` `235ab5e6838300422de3203b6b6b0a027a1eae9ee6601bba8215d70cde311076` (state after commit 4; commit 5 edited a comment later)
- `src/office/lines/ArchiveLineDialog.tsx` `5fca3b8f8138f312fe0f6cd37b0fc0c54180968427f71d6ac973d0694f0e1455`
