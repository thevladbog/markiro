# Plan 1e3 — final whole-plan review (0c887dea3..55156873d)

**Verdict: WITH FIXES.** Critical 0 · Important 0 · Minor 5 (new or re-rated below; the 29 queued items are triaged separately in (b)).

Nothing in the range breaks data, roles or the wire contract. Every seam I traced holds: the wizard → host, the builders → host handlers, the cache, the shared modules and the documents. The fix wave should do the cheap UI and accessibility items before plan 1e4 reuses `CategoryScopeField` and copies the defaults page's patterns.

## Gates and probes I ran myself (nothing else re-run)

- Scope: `git diff --stat 0c887dea3..55156873d -- apps/station packages apps/standalone/{host,proto,src-tauri} pnpm-lock.yaml apps/standalone/package.json` printed nothing. `git diff --check` exit 0. All ten commits carry exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and no other trailer.
- The delayed-`setImmediate` stand (3 ms) over the plan's 13 files, run once: **13 files / 276 tests passed**. The two stand files were deleted afterwards and `git status --short` was empty.
- Three one-line mutants of my own, each restored byte-identically (`cmp` silent, sha256 unchanged, tree clean):
  - M5: `template-options.ts` slot `chzProductGroupCode: group` → `null` (shared by the product dialog and the defaults page). Killed by 5 tests across `template-options.test.ts` and `template-defaults-page.test.tsx`.
  - M4: `withTemplateChange` with the `rev: template.rev` line removed. Killed by `templates-page.test.tsx` «keeps the cached list a list of summaries…».
  - M6: `key={defaults.data.rev}` → `key="form"` (the form no longer remounts on a new revision). Killed by «offers to load the defaults again after a stale save… the reload drops the edits».
- Greps:
  - `dangerouslySetInnerHTML|<Trans|innerHTML|console.*` under `src/office` and `src/wizard`: the only hit is the pre-existing `devices/PairingDataMatrix.tsx:28` (an SVG the app generates itself).
  - `escapeValue: false` is confirmed (`src/i18n/index.ts:28`).
  - No `refetchOnWindowFocus` or `refetchOnReconnect` (`office-query.ts:44-45` sets both off), so the only background refetch is the stale-on-mount read.

## (a) Findings, most severe first

### Minor 1 — «Убрать» stays on while the template list is loading or has failed. The page's own warning and both documents say otherwise.

`TemplateDefaultsPage.tsx:286-295`: the row button has no `disabled`. In the same state the page shows `office.templateDefaults.templatesFailed` «Список шаблонов не загрузился: умолчания сейчас не изменить.» Meanwhile «Убрать» removes a row, «Сохранить» turns on, and the save sends the stored defaults minus that row. AGENTS «Умолчания шаблонов» («the selects … are off and the defaults go out as stored») and spec §5.5 («умолчания уходят как были») are both slightly false. No wrong value is sent: what goes out is what the user did. But a visible string and two documents contradict the code. This is queued item 29 (proposed DOC).
**Fix in code instead of the wording:** `disabled={!templates.isSuccess || saving}` on «Убрать», plus one assertion in the existing test «keeps the choices off while the templates do not load…». With that, the warning, AGENTS and spec all become true and need no edit.

### Minor 2 — No in-flight lock on the defaults page (queued 16 + 25), rated as a whole

`TemplateDefaultsPage.tsx:174-187, 263-296, 336-343`. Only «Отменить изменения» is locked (`saving`). For one save round trip (tens of ms on the LAN, up to the host's 5 s `busy_timeout`) the user can still act, with these outcomes:

- (a) An edit made during the save is dropped when the answer remounts the form. The select then shows the saved value under «Изменения сохранены.», so the loss is visible, not silent.
- (b) A row removed during the save, if the host refuses that very row, gets a message no row renders. There is no alert and no notice, only the dirty note. Re-saving then succeeds without the row, which is what the user intended.
- (c) (not in the minors file) An organization select changed during the save, and then refused on that field: `chooseOrg` cleared `fieldError` _before_ the refusal set it. The message «Шаблон больше не подходит…» then sits under a select whose current value is not the refused one.
- (d) A `CategoryDefaultDialog` opened during the save is torn down by the remount.

No stored value is lost or written against the user's intent, so this stays Minor. It is the upper end of Minor, though: (c) explains the wrong thing.
**FIX in the wave:** add `|| saving` to the three organization selects, the row selects, «Убрать» and «Добавить умолчание категории». Add the cheap safeguard: a field refusal whose key is neither an `ORG_DEFAULTS` field nor a slot of the current draft becomes `setFailure(alertFailure(error))`. Cover it with one test that holds the save open and checks all four control kinds are disabled, plus one `defaultsFailure`-level or page test for the safeguard.

### Minor 3 — A field refusal on the defaults page can be invisible (queued 26). I propose FIX, not CARRY.

On a refusal the page sets `fieldError`, re-reads the list and re-enables «Сохранить». It shows no `Alert`, no notice and nothing in the actions row's live note. A refused organization select at the top of a short window can be off-screen. The user then presses «Сохранить», sees the button spin and stop, and nothing else happens. This is the only form in the office where the refused control is a page away from the button. Dialogs are short, so item 13 can stay app-wide.
**Fix (page-local, in the same focus pass as 12 and 22):** after a field refusal, move focus to the refused control. `focus()` scrolls it into view, and its `aria-describedby` error is then read. A small effect or a ref map keyed by `ORG_DEFAULTS` field or slot key does it. Add one test of `document.activeElement`.

### Minor 4 — The plan's «Перенесено» names a function that does not exist

Plan line 8836: «`wizardFieldFor` таких путей не знает». The wizard's mapper is `fieldFromHost` (`wizard-form.ts:246`, used at `BootstrapWizard.tsx:93`). The behaviour described is right: `templates.{i}.*` maps to `null`, and `setSubmitError` shows general text. Fix the name when the deviations are written (see (c)).

### Minor 5 — Some tests are pinned to `@markiro/ui` internals (observation; the fix rides with item 28)

- `template-defaults-page.test.tsx:698,700,924,932,1058,1060` assert `mk-btn--*`, `mk-alert--*` and `mk-badge--*` class names. This is the pattern Tasks 4–5 and the «Товары» suites already use, so I accept it.
- `:1049` asserts the inline `style.whiteSpace === "normal"` of `Table`'s first cell, and its comment «the other cells stay on one line» is not asserted. When fixing item 28, assert one other cell's `nowrap` or drop the clause. Do not add more inline-style assertions.

### Cross-task seams: what I checked and what I found

1. **Wizard → host.**
   - `stockTemplates()` sends 20 templates (16 box, 2 duplicate, 2 pallet), each enabled for every category, with `orgDefault` only on «Коробка 58×40» (box) and «Паллета 100×150» (pallet).
   - `host/routes/bootstrap.rs` checks: ≤ 32 templates (`MAX_STOCK_TEMPLATES`, mirrored and tested); a name through `validate::template_name` (≤ 200 chars); a layout through `template_spec` (object, ≤ 64 levels, ≤ 256 KB); at most one `orgDefault` per purpose. It does no slot check (`category_codes` NULL, enabled 1) and binds the three ids by index.
   - So no set `stockTemplates` can produce is refused, and no default can miss its slot. A duplicate of a default name in a family would be refused on `templates.{i}.orgDefault`, and test 2 pins exactly two.
   - The body is about 31 KB, against the < 256 KiB test and the 2 MiB axum default.
   - `templates` stays optional on the wire (`bootstrapRequestSchema` is strict; the host's serde default is empty), so a pre-plan wizard still works.
   - Gap: no test pins that `HostApi.bootstrap` forwards `templates` (item 1, FIX).
2. **Wire layer.**
   - `templateUpdate` sends only `enabled` or `chzProductGroupCodes`. The codes come from `scopeCodes` (ascending, `null` for every category). `name`, `enabled` and `spec` never go as `null`, and `expectedRev` is always the row snapshot taken at open (`dialog.template`).
   - The host (`routes/templates.rs:215-333`) checks groups before the revision, then `stale_revision`, then `template_is_default` with the organization flag and the unfitting category codes. It answers a full `LabelTemplate`, and `withTemplateChange` merges only name/enabled/codes/stock/rev, so the layout never enters the summary cache (asserted by a test; M4 killed).
   - `templateDefaultsUpdate` sends the whole draft with `document.rev`. The host (`routes/template_defaults.rs:90-150`) checks a twice-given slot as `categories.{i}`, then each organization slot, then per category `chzProductGroupCode` and `templateId`, all with `{i}` indexing the SENT list. `defaultsFailure` maps `{i}` against `sent` (the draft as captured at submit), not the displayed rows. The host refuses a stale revision only after these checks, matching the docs.
   - A template's `not_found` in a dialog shows general text, and the plan carries that to 1e4.
3. **The cache as one machine.**
   - `templates` (stale 0) is re-read on every mount of «Шаблоны», «Умолчания шаблонов» and the product dialog. A write merges in place. `productGroups` is Infinity. `templateDefaults` (stale 0) is replaced by `setQueryData`, and `key={rev}` remounts the form (M6 killed).
   - The sequence «disable or narrow on Шаблоны → open Умолчания → save» behaves:
     - the list is re-read on mount;
     - a stored default is always kept as an option, marked «— не подходит» or «— нет в списке»;
     - while the list is loading or has failed, the selects are off and keep the stored id («Шаблон a3b4c5d6…»);
     - a failed group read changes only names.
   - No sequence clears a default through a failed read, and none sends a stale draft over a newer document: `expectedRev` is the loaded one, so the host refuses it.
   - Disabling a default is refused at the source, so no default of a disabled template can be accepted or dropped silently.
   - The only remaining holes are the in-flight window (Minor 2) and «Убрать» while the list has failed (Minor 1).
   - Side note, not a finding: a defaults save moves the org record's revision. `OrgProfilePage` re-reads on mount and remounts on `key={org.data.rev}`, so at worst a quick save there meets `stale_revision`.
4. **Shared pieces.**
   - `template-options.ts` moved with an identical body; only the i18n keys moved (same words) and `purpose` widened to `TemplatePurpose`, so product-dialog behaviour is unchanged (gate green; M5 also hits it).
   - `StaleAlert`/`WriteFailureAlert` default to the old key, so every older caller keeps its text.
   - `TemplateFailureAlert` is shared by both «Шаблоны» dialogs.
   - `templateFitsSlot` is untouched (1e2 fixture parity).
   - `CategoryScopeField` reused inside a form: the Enter guard closes the only implicit-submission path. Its other controls are Radix `button`s, and Radix cancels Enter on its checkbox and radio items; the hidden bubble inputs are `aria-hidden` and `tabIndex -1`. So no further Enter hazard remains for 1e4.
   - Left for 1e4's sake: item 11 (a code the lookup lacks counts but cannot be unticked) and item 12 (focus leaves the modal after «Повторить»). Both FIX.
5. **Names, markup and secrets.** Names render only as React children, `title` or `aria-label` attributes, or `<option>` text. Markup-character tests exist on every surface (Tasks 3–7 and the defaults dialog). No layout body, token or record appears in any alert, and the webview logs nothing.
6. **Accessibility and UI.**
   - Both roles see and use everything (tests per page; D9).
   - Every table has `empty`, every dialog goes through `FormDialog`, state is in words, and the purpose tag carries its word, so colour is never the only signal. Live notes (count, dirty) are present.
   - The Modal restores focus on close, so after a dialog save focus returns to the row's button (the same element).
   - Gaps: queued 12, 22 and 26 (FIX), 13 and 27 (CARRY), 6 (CARRY).
   - The station's 64 px floor correctly does not apply to the office.
7. **Documents.** Task 8's items 2, 7, 10, 14, 20 and 23 are resolved: AGENTS :129-131, the two-failure rule, «or did not load», the precise narrowing rule plus the reflow, and the template-list states with groups «read once while cached». I found no stale `1e3` future tense in AGENTS or the spec (grep of both). New false text: only Minor 1 («go out as stored» / «уходят как были» / the warning).
8. **Tests as a suite.**
   - The stand passes over all 13 files.
   - Effect waits use `waitFor` plus two `setImmediate` turns (`settle`). Double clicks are in one `act`. The `act` uses that release promises are wrapped.
   - Titles to fix: items 15, 19, 28.
   - Count arithmetic agrees with the ledger: 958 + 84 (plan) + 59 (extras) = 1101.
9. **Scope and process:** clean (see gates).

## (b) TRIAGE

| #   | Decision                                   | Reason                                                                                                                                                                                                             |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | FIX                                        | One `recording`-client case in `test/api.test.ts`: the `POST /v1/bootstrap` body strictly equals a request with `templates`. The probe shows nothing else catches dropping them.                                   |
| 2   | DONE (Task 8)                              | AGENTS :129-131 now says it.                                                                                                                                                                                       |
| 3   | DROP                                       | `EXPECTED_TEMPLATES` is built from the domain builders in the cloud's order. That order is the spec, so the frozen concatenation already is the order assertion. A second assertion repeats it.                    |
| 4   | CARRY (1e4)                                | Name order and `byNameThenId`: equal names only become common with 1e4's copy and rename, and 1e4 touches these modules anyway. Not needed for 1e3 correctness.                                                    |
| 5   | DONE (Task 4)                              | —                                                                                                                                                                                                                  |
| 6   | CARRY (1e4/polish)                         | `title`-only list: the «Категории» dialog is the keyboard path. A screen-reader copy is a design question for the thumbnail list of 1e4.                                                                           |
| 7   | DONE (Task 8)                              | —                                                                                                                                                                                                                  |
| 8   | CARRY (1e4, with 4)                        | Same reason as item 4.                                                                                                                                                                                             |
| 9   | DONE (Task 5)                              | —                                                                                                                                                                                                                  |
| 10  | DONE (Task 8)                              | —                                                                                                                                                                                                                  |
| 11  | FIX                                        | Before 1e4 reuses the field: list the codes the lookup lacks after the named groups as checkboxes «Код N» (`office.templates.groupCode`), plus a field test.                                                       |
| 12  | FIX                                        | Focus leaves the modal after a successful «Повторить» in the field, and Escape and Tab then escape the dialog. Move focus to the search box when the list replaces the failure, and test `document.activeElement`. |
| 13  | CARRY (polish plan)                        | App-wide, a `FormDialog`-level change.                                                                                                                                                                             |
| 14  | DONE (Task 8)                              | —                                                                                                                                                                                                                  |
| 15  | FIX (wording)                              | `openCategories` doc, extra 6's title, Task 3's «the button stays on one line».                                                                                                                                    |
| 16  | FIX (with 25)                              | See Minor 2.                                                                                                                                                                                                       |
| 17  | DROP                                       | Equivalent today; mirrors `OrgProfilePage`.                                                                                                                                                                        |
| 18  | DONE (Task 7)                              | —                                                                                                                                                                                                                  |
| 19  | FIX (wording)                              | «reads the templates again only after a refused default» → e.g. «does not read the templates again after a 500 or a stale save».                                                                                   |
| 20  | DONE (Task 8)                              | —                                                                                                                                                                                                                  |
| 21  | FIX                                        | On submit with an empty choice list, set the no-fit text as the template field's error instead of «Выберите шаблон», plus a page test.                                                                             |
| 22  | FIX (with 12)                              | After «Убрать», focus the next row's «Убрать», else the previous row's, else «Добавить умолчание категории».                                                                                                       |
| 23  | DONE (Task 8)                              | —                                                                                                                                                                                                                  |
| 24  | DROP                                       | Defensive, not reachable from this UI, covered by the plan's tests.                                                                                                                                                |
| 25  | FIX (with 16)                              | Lock plus the orphan-key safeguard (Minor 2).                                                                                                                                                                      |
| 26  | FIX (page-local) — **disagree with CARRY** | The defaults page is the one form where the refused control can be off-screen with no other signal. Focus it (Minor 3). Item 13's dialog-level change stays CARRY.                                                 |
| 27  | CARRY (recorded, «Перенесено» line 8832)   | —                                                                                                                                                                                                                  |
| 28  | FIX (wording)                              | Retitle T2 and T3; assert one `nowrap` cell or drop the comment's clause (Minor 5).                                                                                                                                |
| 29  | FIX in code (not DOC)                      | Disable «Убрать» while `!templates.isSuccess`; that makes the warning, AGENTS and spec true (Minor 1).                                                                                                             |

**Proposed fix wave (one fixer, four commits):**

1. `test(standalone)`: item 1 (`test/api.test.ts`); wording items 15, 19 and 28 (titles and comments only; for 28 add the one `nowrap` assertion or drop the clause). Expected +1 test.
2. `fix(standalone): CategoryScopeField`: items 11 and 12 with their tests in `category-scope-field.test.tsx` (plus a page check if the «Код N» row shows in the «Категории» dialog fixture `[8, 13, 99]`).
3. `fix(standalone): «Умолчания шаблонов»`: in `TemplateDefaultsPage.tsx`, the in-flight lock over all controls plus the orphan-key safeguard (16, 25), «Убрать» off while the list has not loaded (29), focus after «Убрать» (22) and after a field refusal (26). In `CategoryDefaultDialog.tsx`, the no-fit error (21). One test each, with a delayed-stand run of the two touched files.
4. `docs(standalone)`: AGENTS «Office pages» (lock, «Убрать» off, focus, «Код N» in the field) and spec §5.5 to match. In the plan: «Отклонения при исполнении» (section (c)), and «Перенесено» gets items 4/8, 6, 13 and the `wizardFieldFor` → `fieldFromHost` fix.

## (c) Отклонения при исполнении — черновик

- **Счёт тестов.** План ждал Vitest 47 файлов / 1042 теста; вышло 47 / 1101: 59 тестов сверх плана. Задача 2 — +5, 3 — +8, 4 — +5, 5 — +12 (11 и один тест исправления), 6 — +13, 7 — +16, задача 1 — ни одного. Каждый лишний тест убивает однострочную мутацию, которую тесты плана пропускали. Набор 13 файлов итоговой проверки — 276 тестов вместо 217; под стендом с задержкой `setImmediate` он проходит так же. Cargo не перезапускался: Rust не менялся, 41 набор / 453 теста.
- **Изменённые тесты (число то же).**
  - Задача 4: два лишних теста задачи 3, считавшие ровно шесть столбцов, теперь закрепляют седьмой — «Действия».
  - Задача 5: лишний тест задачи 4 («says the action in each button's own text…») выбирает кнопку состояния по доступному имени: в ячейке появилась вторая кнопка.
  - Задача 7: лишний тест задачи 6 про живую область ищет заметку в `.standalone-form__actions`, потому что первой `.office-note` стала подсказка категорий.
- **Enter в поиске категорий (задача 5, решение контроллера, сообщено владельцу).** В коде брифа поиск `CategoryScopeField` не гасил Enter. Ревью в Chromium 154 с настоящей разметкой окна показало, что Enter отправляет форму окна через неявную отправку к «Сохранить» и сохраняет недоделанный выбор. Исправление `05a1d6789` — `onKeyDown`, отменяющий Enter на поле поиска, один тест и одна фраза в `AGENTS.md`. Тесты jsdom не могут показать, что браузер затем молчит (в jsdom нет неявной отправки): доказательство — проверка ревьюера в Chromium.
- **Документы шире буквы брифов.** Задача 5 дописала «and change its categories» (AGENTS) и «обе роли меняют окном» (спецификация §5.5). Задача 8 по дополнению контроллера A–E закрыла документные замечания задач 1, 3, 4, 5, 6, 7 (пункты 2, 7, 10, 14, 20, 23). Две формулировки отличаются от предложенных, потому что так говорит код: A — цифра 2 МиБ, D — правило сужения.
- **Брифы, поправленные контроллером.** Лишние тесты задач 3–4 сдвигали якоря конца файлов, поэтому контроллер правил брифы задач 4 и 5. Это заметка о процессе, не отклонение плана; числа плана в поздних задачах читаются выше на эти сдвиги.
- **Итоговая волна правок** (после итогового ревью; вписать по факту коммитов):
  - пункт 1 — тест передачи `templates` в `HostApi.bootstrap`;
  - пункты 11 и 12 — коды без справочника как флажки «Код N»; фокус после «Повторить» внутри поля;
  - пункты 16, 25 и 29 — блокировка всех элементов страницы умолчаний на время сохранения; полевой отказ без своего элемента — общим сообщением; «Убрать» выключена, пока список шаблонов не загружен;
  - пункты 22 и 26 — фокус после «Убрать» и на отказанный выбор;
  - пункт 21 — текст «нет подходящих шаблонов» как ошибка поля;
  - пункты 15, 19 и 28 — заголовки тестов.
- **Текст плана.** В «Перенесено» (план 5) функция названа `wizardFieldFor`; в коде это `fieldFromHost` (`src/wizard/wizard-form.ts`).
- **Перенесено дополнительно.** Единый порядок «по имени, затем по id» и общая нормализация поиска (пункты 4 и 8) — в план 1e4. Полный список категорий не только в `title` (пункт 6) — в план 1e4 или план полировки. Объявление ошибок полей и фокус на первом неверном поле в `FormDialog` (пункт 13) — в план полировки.

## (d) What could not be verified

- No real webview or Tauri window was used. That leaves unconfirmed:
  - the layout of the two-button actions cell and the 280 px category list;
  - wrapping of long ЧЗ group names in the defaults table;
  - focus behaviour beyond jsdom: Modal trap, Escape after the in-field «Повторить»;
  - that implicit submission is now quiet. The Task 5 reviewer's Chromium probe is the only evidence.
- No Windows run, no live host or station, and no check that a station receives the switched or narrowed template or the changed defaults.
- No screen reader: announcement of field errors, the `role="alert"` notices, live counts and the purpose tags.
- The wizard against a real host. A host-side bootstrap with `templates` is covered by the 1e1 Cargo suites, not re-run here.
- The in-flight scenarios of Minor 2 were reasoned from code (and reproduced by the Task 7 implementer for item 25). I did not write a new probe.
