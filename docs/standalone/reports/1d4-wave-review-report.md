# Plan 1d4 — review of the final-review fix wave and the gate fix (`ae9c15e4d..34babfeed`)

**Verdict: NEEDS FIXES** — Critical 0, Important 2, Minor 5.

The wave does what its brief asked, item by item, and every new test I mutated has teeth (43 mutant runs; the only
survivor is the clamp mutant, run against both the fixed and the pre-commit countdown tests — the pre-existing gap
the controller already carries). Scope, subjects, trailers,
whitespace, prettier and rustfmt are clean. Two things keep the plan's Important items from being closed: the I1
label guard misses the code in the form the Russian layout types it, which is the natural form for a label typed
in Russian (probe below: the request body carries «Пропуск №7ЬКЛ-000742»), and the spec's decision table still tells plan
1f to verify with the station's code unchanged (I2 fixed only §5.6).

## Findings

### Important

**I-1. The label guard misses the code as the Russian layout types it — the I1 leak is still open for letter
codes.** `apps/standalone/src/office/operators/AddBadgeDialog.tsx:103` tests
`values.label.includes(values.code)`. A Russian label needs the Russian layout, so in the very I1 flow (label typed
first, focus left in it) the scan lands in the label by key position: «MRK-000742» arrives as «ЬКЛ-000742». The
empty code is refused, the next scan into the code field (still Russian) gets the layout hint and is emptied, the
admin switches the layout as told, the third scan fills the code with «MRK-000742», and the guard compares a Latin
code with a Cyrillic label: no match, the label goes. Scratch probe (copy of `operator-badges.test.tsx` plus one
test, run and deleted): exit 0 with `createBadge` called once with `{ badgePhc: BADGE_PHC, label: "Пропуск
№7ЬКЛ-000742" }` and `fromRussianLayout(label)` containing «MRK-000742». The host stores that label, writes it
into the audit row (`host/src/routes/operators.rs:391`), lists it, sends it to every station; revoking takes none
of it back — the I1 harm, reversible by anyone who knows the layout. The same happens after any label-only refusal
(form, host, guard): the focus is in the label, the code is kept, and a reflex re-scan lands in the label, in
Cyrillic if the admin switched to Russian to correct the label. Separator codes are hit too (EM-Marine «123,45678»
types «123б45678»). The docs overstate: `apps/standalone/AGENTS.md:754-755` («the guard against the one way a code
could leave the webview in clear text»), `:760-761` («a plain substring test of the two trimmed values»),
`:285-286` («the host never sees … a badge code»), and the controller's deviations draft («кроме пути через
подпись, закрытого волной»).
_Fix:_ refuse when `values.label.includes(values.code) || fromRussianLayout(values.label).includes(values.code)`
(`fromRussianLayout` is already exported from `src/host/pairing-code.ts`); add the test above as a refusal (label
«Пропуск №7», wedge «ЬКЛ-000742» into the label, «ЬКЛ-000742» into the code → layout hint, «MRK-000742» → no call,
no `deriveBits`, message under the label, focus on the label, code kept), mutant «drop the second clause»; update
the table row, the prose and the draft.

**I-2. I2 is not closed: the spec's decision table still says the station verifies badges with its code
unchanged.** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md:50` (decision 9): «Станция
проверяет их кодом станции без изменений», rationale «(`apps/station/src/lib/crypto.ts`, `auth.ts`)». That is the
instruction I2 was about (`auth.ts` `verifyOperatorBadge` runs PBKDF2 per operator, returns the first match, never
trims — verified), and it now contradicts both `AGENTS.md:332-337` and the new exception in the same spec's §5.6
(`:624-630`). A plan-1f author who reads the accepted-decisions table ports the first-match lookup and loses the
ambiguity backstop.
_Fix:_ one clause in row 9: the PIN as the station checks it, the badge by the plan-1f rules in
`apps/standalone/AGENTS.md` (trimmed scan hashed once with the site's salt, whole-string compare, an ambiguous
badge refused, a Cyrillic scan refused) — see §5.6.

### Minor

**M-1. Both scan-straddle residuals are recorded nowhere.** `AGENTS.md:726-731` says a scan typed while the code
field is read-only «is not taken and cannot be glued to the code being sent». True, but a scan that starts while
the field is read-only and ends after loses its head and sends its tail, which passes `badgeCodeRule` (a badge no
station matches): at the salt's arrival (T5#9) and at the end of a failed submit (T5#8 — `scanAgain` empties and
focuses the field inside the callback; `readOnly` drops only when React renders `isSubmitting: false`). The triage
said «record the straddle residual» for T5#8; the deviations draft (line 40) says the T5#9 one is «записано в
`AGENTS.md`» — it is not (the wave report says so too). _Fix:_ one sentence after `:731`, and correct the draft.

**M-2. The table row «the form refuses the label → focus on the label» has no committed test.** The claim is true:
react-hook-form 7.85 `handleSubmit` calls `onInvalid` (`refused` does nothing when the code is valid), then
`_focusError()` and `setTimeout(_focusError)`, which focus the first field with an error in registration order —
the label; my scratch probe (too long; tab) confirms it, the code kept. But the other six rows are pinned and this
one rests on the default `shouldFocusError`. _Fix:_ in `test/operator-badges.test.tsx:354` add
`await waitFor(() => expect(document.activeElement).toBe(labelField()))`; mutant `shouldFocusError: false` in the
dialog's `useForm`.

**M-3. The VACUUM wording now contradicts itself across documents.** `apps/standalone/src-tauri/src/local_db.rs:235-236`
(edited by this wave) still says «`VACUUM` is not needed: it would only shrink the file», while `AGENTS.md:152-154`
now says that for a database freed before `secure_delete` «`VACUUM` would do more than shrink the file». The spec's
new sentence (`…-01-foundation-design.md:455`) quotes «только сжал бы файл», a phrase the spec never states. _Fix:_
qualify the doc comment as AGENTS does; drop the quotation marks or state the claim in §5.2.

**M-4. «an alert until the next send» (`AGENTS.md:752-753`) is not what the code does.** `setFailure(null)`
(`AddBadgeDialog.tsx:93`) runs at the start of every submit the form accepts, before the label guard: a
`labelHasCode` refusal clears the alert although nothing is sent, and a form refusal leaves it. _Fix:_ «an alert
until the next submit the form accepts».

**M-5 (nit). `host/tests/badges.rs:191-192`: «It is the one refusal that takes a revision before it fails».**
`create_operator` takes `next_revision` (`operators.rs:155`) before the insert that can fail with `login_taken`
(`:168`), pinned by `tests/operators.rs:192-194`. _Fix:_ «the one badge refusal».

## Seam by seam

### 1. I1 label guard (`AddBadgeDialog.tsx:92-138`)

- Position: after the form's validation (`handleSubmit`'s valid branch) and the salt check (`:95`), before the
  `try` (`:108`) and `hashBadge` (`:109`). Both values are the resolver's output: RHF 7.85
  `fieldValues = cloneObject(values)` from `_runSchema()`; `badgeFormSchema` is `badgeCodeRule` + `badgeLabelRule`,
  both `.trim()` (`src/lib/rules.ts:148-152`, `:71-77`). An empty label never matches (`"".includes(code)` is false;
  the code is 1–256 characters).
- The code is kept (no `scanAgain`), message key `office.operators.badges.errors.labelHasCode`
  (`ru.json:431`, the brief's text exactly), `setError("label", …, { shouldFocus: true })` focuses at once
  (RHF `setError`: `options.shouldFocus && ref.focus()`), no request, no `deriveBits` (mutants below).
- The two documented false positives are in `AGENTS.md:760-763`.
- Other paths for a code: `badgeCreate` names only `badgePhc` and `label` (`src/host/requests.ts:182-184`, pinned by
  the new `code`-dropping test); the mutation variables the query cache keeps are that body; host error messages
  carry no values (`host/src/validate.rs:48-51`, `:111-116`) and `details` are `{field}`/`{constraint,
operatorId}`; alert texts come from error codes; the webview has no `console.*`; the host logs only internal
  errors. The label is the one carrier — and the Russian-layout rendition goes through it (**I-1**).

### 2. T5#6 `readOnly={saltMissing || isSubmitting}` and T5#7

- Can it stick? `isSubmitting: true` is dispatched synchronously at the start of `handleSubmit` and `false` at its
  end on every path that returns: `onValid`'s throw is caught (`onValidError`), the valid and invalid branches both
  reach the final `_subjects.state.next`. It would stick only if the resolver threw a non-Zod error or `refused`
  threw — neither can (`hasCyrillic`, regex tests, `setValue`/`setFocus`). `hashBadge` always settles and the IPC
  request has the shell's 10 s limit. `FormDialog`'s `inFlight` drops a second submit before RHF sees it, so
  submits never overlap.
- `scanAgain` inside the callback: `setValue` writes the DOM value through the ref regardless of `readOnly`,
  `setFocus` focuses a read-only input; `readOnly` drops at the render after `isSubmitting: false`. Pinned: empty and
  editable by the new test (`operator-badges.test.tsx:444`, `readOnly` false and value `""` after the failure),
  focused by the `CODE_FAILURES` tests (`document.activeElement` is the code field after each failure). Note: the
  `wedge` helper uses `fireEvent.change`, which bypasses `readOnly`, so the attribute test is the only proof of
  «not editable» — adequate. The end-of-submit straddle is **M-1**.
- T5#7: `setError(outcome.field, …, { shouldFocus: true })` (`:125-129`), asserted at `:394`; for `code`,
  `scanAgain` refocuses anyway.

### 3. T1#1 `NetworkPairing.tsx`

`checkedName` stores `parsed.error.issues[0]?.message ?? "rules.name"` (`:146`) and the field shows `t(nameError)`
(`:253`); both the scan path (`:172`) and the manual form (`:209`) call it. Tests cover empty and 101 characters
(length), a tab and a lone surrogate (control character) on the scan screen, a tab on the manual form. Both
direction mutants fail (below). `AGENTS.md:210-212` already lists the device name among `plainTextRule` users, now
consistent.

### 4. Webview test teeth — mutants I ran

Runner: a scratch Python script under `$TMPDIR` that copies the file to `$TMPDIR/rv/<name>.orig`, applies exact
one-match replacements, runs the test file, restores with a byte copy, and prints sha256 before/after and a byte
comparison. Every restore: equal sha256 and `cmp` identical; `git status --short` empty after every batch.

| Mutant                                                                      | File (sha256 before = after)                  | Result                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[ -\x7f]` in `badgeCodeRule`                                               | `src/lib/rules.ts` (`ca3df070…ddc21`)         | 1 failed: «ends printable ASCII at the tilde…» `expected undefined to be 'rules.badgeCode'`                                                                                                                                |
| `[ -}]` (tilde refused)                                                     | same                                          | same test: `expected undefined to be 'MRK~742'`                                                                                                                                                                            |
| `\p{Cc}`-only control check in `optionalTextRule`                           | same                                          | «refuses an unpaired surrogate in a role and a label…» `expected undefined to be 'rules.controlCharacter'`                                                                                                                 |
| `text.length <= max` in `optionalTextRule`                                  | same                                          | «counts a role and a label in characters…» `expected false to be true`                                                                                                                                                     |
| refines swapped in `optionalTextRule`                                       | same                                          | «says the length first … role or a label…» `expected [ 'rules.controlCharacter', …] to deeply equal [ 'rules.role', …]`                                                                                                    |
| refines swapped in `passwordRule`                                           | same                                          | «says the length first when a password…» `expected [ 'rules.passwordCharacter', …] …`                                                                                                                                      |
| URL-safe `toBase64`                                                         | `src/lib/credentials.ts` (`178fe45a…e8988`)   | 1 failed: the new deterministic `+`/`/` test (the random-salt test did not hit `+`/`/` this run — which is why the deterministic one matters)                                                                              |
| `==` → `={0,2}`                                                             | `src/host/protocol.ts` (`3fc8efbc…dd57`)      | 6 failed: 22- and 23-character rows × three schemas                                                                                                                                                                        |
| `==` → `=*`                                                                 | same                                          | 6 failed: same rows                                                                                                                                                                                                        |
| no `^`                                                                      | same                                          | 6 failed: 19-byte row and `x${SALT}` × three                                                                                                                                                                               |
| no `$`                                                                      | same                                          | 6 failed: `${SALT}A` and `${SALT}\n` × three                                                                                                                                                                               |
| `{21}` → `{21,}`                                                            | same                                          | 6 failed: 19-byte row and `x${SALT}` × three                                                                                                                                                                               |
| `m` flag                                                                    | same                                          | 3 failed: `${SALT}\n` × three                                                                                                                                                                                              |
| `return { ...badge }`                                                       | `src/host/requests.ts` (`8620d8f7…c817a`)     | «a badge to add» `expected { …(3) } to strictly equal { …(2) }`                                                                                                                                                            |
| `return { ...operator }`                                                    | same                                          | «an operator to create…» `expected { login: '0042', …(4) } …(3)`                                                                                                                                                           |
| `role` sent whenever `null`                                                 | same                                          | «names only the operator fields that differ…» `expected { expectedRev: 55, …(2) } to strictly equal { name: 'Анна Петрова', …(1) }` (the `{ name: anna.name, role: null }` → `{ expectedRev: 55 }` assertion kills it too) |
| `zodResolver(pinFormSchema, undefined, { raw: true })`                      | `OperatorPinDialog.tsx` (`1e631a42…fc7c`)     | «replaces the PIN with a new hash…» `expected false to be true` (verifyPhc)                                                                                                                                                |
| `hashPin(getValues("pin"))`                                                 | same                                          | same test, same message                                                                                                                                                                                                    |
| `hashPin(getValues("pin"))`                                                 | `CreateOperatorDialog.tsx` (`9a721a5a…c311b`) | «adds an operator with the trimmed values…» `expected false to be true`                                                                                                                                                    |
| `submitVariant="primary"` for both                                          | `OperatorAccessDialog.tsx` (`34671b4e…1362`)  | «turns an operator off…» `expected 'mk-btn mk-btn--primary mk-btn--md' to contain 'mk-btn--destructive'`                                                                                                                   |
| `onReload` dropped                                                          | `OperatorPinDialog.tsx`                       | «offers to load the operators again after a stale PIN change» `Unable to find role="button" and name "Загрузить заново"`                                                                                                   |
| `onReload` dropped                                                          | `OperatorAccessDialog.tsx`                    | «… after a stale turn-off», same message                                                                                                                                                                                   |
| `pinPhc` dropped from `CREATE_FIELDS`                                       | `CreateOperatorDialog.tsx`                    | «says under the PIN when the host refuses its hash in a new operator» `Unable to find … Хост не принял это значение…`                                                                                                      |
| `PIN_FIELDS = {}`                                                           | `OperatorPinDialog.tsx`                       | «… in a new PIN», same message                                                                                                                                                                                             |
| empty branch → `false ?`                                                    | `BadgesDialog.tsx` (`928bd2b6…55d3`)          | «says so when an operator has no badges yet» `Unable to find … Бейджей пока нет.`                                                                                                                                          |
| guard removed                                                               | `AddBadgeDialog.tsx` (`4d6d7d0a…118ef`)       | the guard test: `Unable to find … В подписи есть код бейджа…`                                                                                                                                                              |
| guard moved after `hashBadge`                                               | same                                          | `expected "deriveBits" to not be called at all, but actually been called 1 times`                                                                                                                                          |
| guard without `shouldFocus`                                                 | same                                          | `expected <input …> to be <input …>` (focus)                                                                                                                                                                               |
| guard empties the code (`setValue("code", "")`)                             | same                                          | `expected '' to be 'MRK-000742'`                                                                                                                                                                                           |
| host field refusal without `shouldFocus` (T5#7)                             | same                                          | «keeps the masked code when the host refuses only the label…» `expected <input …> to be <input …>`                                                                                                                         |
| `readOnly={saltMissing}`                                                    | same                                          | «keeps the code field read-only from the submit…» `expected false to be true`                                                                                                                                              |
| `readOnly={saltMissing \|\| add.isPending}`                                 | same                                          | same test, same message (the hashing window)                                                                                                                                                                               |
| constant `t("rules.name")`                                                  | `NetworkPairing.tsx` (`2ef19906…1fc1`)        | 3 failed: tab, lone surrogate, manual form                                                                                                                                                                                 |
| constant `t("rules.controlCharacter")`                                      | same                                          | 3 failed: blank, empty, 101 characters                                                                                                                                                                                     |
| read failure kept while the retry syncs (`if (syncFailed \|\| readFailed)`) | `LineSelect.tsx` (`b03114e5…cd74`)            | «shows progress, not the older read failure, while the retry syncs» `Unable to find … Получаем справочники с хоста…`                                                                                                       |

### 5. Rust

- `host/tests/badges.rs`: after the revoke and the re-add by `second`, `same` for `first` must name `second`
  (`:245-251`); `host_revision` and `audit_rows` unchanged around both refused blocks (`:193-194`, `:211-212`,
  `:236-237`, `:252-253`); `asker` rename. `audit_rows` is a count — the right assertion for «no row».
- `src-tauri/tests/ipc.rs`: `unopened_database` (`:453`) fails the open with only the garbage main file, then writes
  the side files (SQLite has nothing of theirs to remove, and the first test asserts all four exist before the
  forget); the stuck-file test creates `-shm`/`-journal`, checks the pairing through `device_status` before and after,
  the stuck `-wal` stays, the main file, `-shm` and `-journal` go. Comments in `operators.rs:298-304` (verified: the
  `Ok(None)` arm is reachable only through a primary-key collision) and `local_db.rs:73-76`, `:233-236`, `:327-331`
  (verified: a busy checkpoint returns `StatementFailed` after `tx.commit()`, `:277-287`).
- Mutants (baselines first: badges 8/8, filtered ipc 3/3):

| Mutant                                              | File (sha256 before = after)                     | Result                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| owner lookup without `AND revoked_at IS NULL`       | `host/src/routes/operators.rs` (`42676b59…c428`) | exit 101, panicked at `host/tests/badges.rs:245:5`, `left: (409, {…"operatorId": "1be34495…"})` vs `right: (409, {…"operatorId": "2e9f8b0c…"})` |
| a refused conflict commits its revision             | same                                             | exit 101, panicked at `badges.rs:211:5`, `left: 6 right: 4`                                                                                     |
| `remove_unopened` stops at the first failed removal | `src-tauri/src/local_db.rs` (`95b47429…4d35`)    | exit 101, panicked at `src-tauri/tests/ipc.rs:528:9`: `…standalone-station.db-shm is still there`                                               |

Both suites green again on the restored sources (8/8, 3/3); `cargo fmt --check` clean.

- Not verifiable here: T7#5's Windows mapped-file case. The helper removes the «truncate a mapped `-shm`» risk; a
  Windows run could in principle still race `remove_file` of the main file against sqlx's asynchronous close (SQLite
  opens without `FILE_SHARE_DELETE`), but that window closes long before the forget (a mock app is built in
  between) and existed before; not a finding.

### 6. Documents

- I2: §5.6 now carries the exception and points to AGENTS; the AGENTS clause is in (`:332-334`). Left over:
  decision table row 9 (**I-2**). The station design spec (`2026-09-26-standalone-station-design.md`) does not ask for
  unchanged code.
- I3: stated in all four places (`AGENTS.md:449-456`, spec §6 `:652` pointer and `:660-668` statement,
  `protocol.ts:14-25` header, `:113-117` section title); `proto/src/lib.rs` has no diff in the range (its line 7 still
  promises tolerance — carried to plan 5 in the draft).
- M1 (`AGENTS.md:423-424`), M2 (`:816-818`), M3 (`:609-612`), T1#6 (`:310-315`; `apps/api/src/modules/operators/dto.ts`
  trims and takes `^\d{4,6}$` — verified), T3#3 (AGENTS `:295-298`, spec `:303-304`), T7#1 (`:154-156`), T7#3
  (`:148-154`, spec `:449-455`), T8#2 (`:631-634`; matches `LineSelect.tsx` `statusSync = lines === null ? { ...sync,
failure: null } : sync`): accurate. T5#10: see **M-4**; T7#3: see **M-3**.
- Failure table (`AGENTS.md:742-750`), every row against the code: form code refusal → `refused` → `scanAgain`,
  `_focusError` picks the code (first field with an error) — emptied/code/under the code ✓; `badge` conflict (named
  holder: `setError` + `scanAgain`; unnamed: `BADGE_CONFLICTS` → field `code` + `scanAgain`) ✓; `validation_failed`
  on `badgePhc` (`BADGE_FIELDS`) ✓; request failure → `setFailure` + `scanAgain`, alert rendered before the children
  in `FormDialog` ✓; form label refusal → no `scanAgain`, `_focusError` → label ✓ (true by the RHF source and my
  probe; unpinned — **M-2**); host `validation_failed` on `label` → `shouldFocus` ✓; `labelHasCode` ✓ (incomplete —
  **I-1**).
- Phrases the wave made false: none of «kept after an alert», «once per session», «fails as a whole» remains; «outlives
  `device_forget`» is qualified; «would only shrink» survives in `local_db.rs:236` (**M-3**).

### 7. The fifth commit (`test/devices-page.test.tsx`)

- Bounds: the dialog shows `ceil(max(0, min(deadline − sampledNow, lifetime)) / 1000)` with
  `deadline = requestedAt + lifetime` (`DevicesPage.tsx:114-121`, `PairingCodeDialog.tsx:34-60`). With
  `since ≤ requestedAt ≤ sampledNow ≤ now` on one clock: `shown ≥ L/1000 − floor((now − since)/1000) ≥ L/1000 −
ceil(…)` and `shown ≤ L/1000` — the helper's check is exact (slightly conservative below). Under
  `useFakeTimers({ shouldAdvanceTime: true })` the component and the test read the same fake clock, which advances
  only between macrotasks (20 ms per real interval tick) and never goes back, so the chain holds there too.
- `since` is taken right before the click that sends that request at all five sites (`:380-383`, `:411-414`,
  `:433-436`, `:455-458`, `:738-741` — the last one before «Новый код», the second request); `requestedAt` is read
  synchronously in the click handler before the first `await` of `newCode`.
- Mutants, fixed file: −30 s → 6 failed (all five sites, `expected 570 to be greater than or equal to 599`, the
  5-minute one `270 … 299`); `deadline: Date.parse(code.expiresAt)` → 3 failed (DataMatrix, «behind», 5-minute),
  «ahead» survives through the clamp; clamp dropped → 0 failed. With the pre-commit file (`git show 89f99cba7:…` as a
  scratch test): clamp dropped → 0 failed, −30 s → the same 6 failed. So the commit keeps the teeth it had, and the
  clamp gap is pre-existing: the stale-`now` frame lasts one commit, until `useRemainingMs`'s effect re-samples
  `now`, and no assertion runs inside it. Correctly carried (plan 1c3), not this commit's job; a test would render
  the dialog, rerender with a new deadline and record the countdown's text with a `MutationObserver`.
- The negative assertion (`:727`) cannot fail under load (more time only lowers the countdown); it could pass
  vacuously if no countdown were shown, which the other tests exclude. Sound; optional hardening: assert
  `COUNTDOWN` with at most 08:00 left instead.
- Other clock windows in `apps/standalone/test`: `host-status-line.test.tsx` pins the system time;
  join-detection `pairedAt = Date.now() + 1000` is an inequality in the safe direction; `app.test.tsx`'s retry tests
  (`:1053-1060`, `:1228-1229`, …) race 1.5–2 s windows against a fake `setTimeout` clock with `shouldAdvanceTime`,
  but that clock gains 20 ms per real interval callback, so it lags under load rather than leads (the controller's
  saturated full run passed) — not a finding. `pairingCode()` (`:78-86`) reads `Date.now()` twice, so its lifetime
  can be 600 001 ms, and my probe shows such a code reads «10:01» if the dialog's first clock read falls in the click's
  millisecond (Date frozen); measured 0 of 25 real runs — not a practical risk (optional: derive both timestamps from
  one `Date.now()`).

### 8. Scope and process

- Files per commit match the briefs exactly (3 / 7 / 4 / 3 / 1); nothing under `apps/station`,
  `apps/standalone/proto`, `packages/`, migrations, manifests, the lockfile, `.superpowers` or `docs/superpowers/plans`.
- The five subjects equal the briefs' strings byte for byte (checked by script); each message has exactly one
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the last line.
- `git diff --check ae9c15e4d..HEAD` clean; `prettier --check` on the 14 changed TS/TSX/JSON/MD files clean;
  `cargo fmt --check` clean; `tsc --noEmit` for the package clean; the `\u04` grep shows only
  `src/host/pairing-code.ts:66`; no raw control or invisible characters in the 18 changed files.
- Totals plausible: +3 tests (commit 1), +33 (commit 2: 5 pairing, 5 rules, 1 credentials, 6 rows × 3 schemas, 4
  operators) → 808; 37 test files counted; cargo test bodies only, so 36/348 stands. The eight changed Vitest files:
  309/309, stderr empty (my run).

## Scratch work (all removed)

Scratch tests in `apps/standalone/test/` — `zz-scratch-review-probe` (I-1), `zz-scratch-old-devices` (pre-commit
file against the clamp and −30 s mutants), `zz-scratch-review-lifetime` (600 001 ms → «10:01»),
`zz-scratch-review-delta` (0 of 25 same-millisecond mounts), `zz-scratch-review-focus` (M-2 claim) — each deleted
right after its run; `git status --short` empty at the end. No production file was left changed.

## Not verified

WebView2 (focus, `readOnly` and WebCrypto in the real webview; whether its general autofill keeps typed label
values), a real wedge scanner under the Russian layout (the probe simulates it in jsdom), NVDA, Windows (T7#5, the
`standalone-windows-build` job), the full Vitest and cargo suites and the delayed-`setImmediate` stand (not rerun,
per the brief; the controller runs them).
