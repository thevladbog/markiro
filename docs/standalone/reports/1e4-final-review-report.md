# Plan 1e4, part 1e4a: final whole-part review

Range `cda9d9f1d..7dc6d54b9` (12 commits), branch `claude/autonomous-desktop-station-9e6f13`.

**Verdict: WITH FIXES.** Critical 0, Important 0, Minor 3 new (N1–N3). The 31 queued minors are triaged below: 18 FIX, 5 CARRY, 8 DROP, 0 DOC.

The part works as one machine. I traced every seam the brief lists through the code and the host handlers and found no way to:

- show a stale record as the current one,
- send an edit against the wrong revision,
- leave a deleted template selectable as a default,
- lose edits without the user knowing.

What remains is polish. Two queued items rest on premises that do not hold: item 11 (the office uses `createMemoryRouter`) and item 13 (in a browser, implicit submission skips a disabled default button). They are re-rated below.

## What I checked and ran

- **Production files read in full from the tree:** `editor-model`, `label-geometry`, `label-samples`, `import-analysis`, `editor-failure`, `download`, `TemplateEditor`, `TemplateEditorPage`, `LabelSizeDialog`, `DeleteTemplateDialog`, `ImportCodeDialog`, `ImportFieldsPanel`, `TemplatesPage`, `TemplateFailureAlert`, `FormDialog`, `office-query`, `routes`, `records` (the diff hunk), `template-options` (the diff hunk).
- **Documents:** the `AGENTS.md` and spec hunks of the diff package.
- **Tests:** the test helpers and the index of `template-editor.test.tsx`.
- **Cross-checked against other code:**
  - `apps/admin/src/pages/labels/{geometry,preview-data}.ts`;
  - `packages/domain/src/labels/model.ts` (`specShape`, `dpiSchema`, element shapes);
  - `apps/standalone/host/src/routes/templates.rs` (`update_template`, `delete_template`);
  - `host/src/validate.rs` (`template_spec`, `MAX_SPEC_BYTES = 256 * 1024`, `MAX_SPEC_DEPTH = 64`);
  - `@markiro/ui` `Button` (default `type="button"`) and `Textarea` (inline `font` shorthand);
  - `OfficeShell.tsx` (`NavLink end`);
  - `Office.tsx` (`createMemoryRouter`).
- **Gates I re-checked cheaply:** the trailers are exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` on each of the 12 commits. `git diff --check cda9d9f1d..7dc6d54b9` is clean. The `--stat` of `apps/station packages apps/standalone/{host,proto,src-tauri} pnpm-lock.yaml apps/standalone/package.json` is empty. The `\u04` grep finds only `src/host/pairing-code.ts:66`.
- **Test arithmetic:** +8 +17 +11 +12 +7 +7 +4 +2 +0 = 68, and 1191 + 68 = 1259. This matches.
- **My own one-line mutants** (each file copied to `/tmp/claude/fr/`, restored with `cp`, `cmp` silent, sha256 identical before and after, `git status --short` empty at the end):

| Mutant                                               | Where                    | Result                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: drop `layoutFollowsPurpose &&` in `choosePurpose` | `TemplateEditor.tsx:144` | KILLED by «copies a template from its editor and keeps the layout when the copy's purpose changes» (copy of a stock pallet whose layout equals the starting one) |
| B: drop `opened.purpose !== draft.purpose \|\|`      | `editor-model.ts:179`    | KILLED by «finds a change in anything a save sends…»                                                                                                             |
| C: `product_duplicate: {}` render options            | `label-samples.ts:36`    | KILLED by 4 tests (editor-model ×2, import-analysis, template-editor «measures the elements with the sample data…»)                                              |

- **Delayed-`setImmediate` stand** (3 ms), run once over `template-editor`, `import-code-dialog` and `templates-page`: 3 files, 145 tests passed. Both stand files were deleted and the tree is clean.

## (a) Findings, most severe first

There are no Critical or Important findings. New Minors (beyond the queue):

**N1 (Minor): header actions stay live while a save is in flight.**

- **Where:** `TemplateEditor.tsx:255-271`, together with queued item 26.
- **Scenario:** «Копировать», «Удалить» and «К шаблонам» are outside the `fieldset` that a save disables. During an in-flight update, «Удалить» opens the delete dialog. Confirming it sends a DELETE right behind the PUT, and both answers call `backToList`: two navigations, and the notice comes from whichever lands last. «Копировать» and «К шаблонам» raise the leave dialog over a save that may still succeed. The leave-then-success case is item 26.
- **Fix (with item 26):** disable «Копировать» and «Удалить» while `saving`. Keep «К шaблонам» and guard `backToList` with a `mounted` ref.

**N2 (Minor, documents): two document sentences become false once the fix wave lands items 10 and 12.**

- **Where:**
  - `AGENTS.md:1207-1209` («the sidebar's «Шаблоны» is not highlighted there: `NavLink end`») and `:1257-1259` («worded above the form without a remedy; the editor does not measure it first»);
  - spec `:791-792` («пункт «Шаблоны» на них не подсвечен») and `:818-820` («без совета, заранее размер не измеряя»).
- **Fix:** both are true today. Update them in the same wave as the code, and mention there that the products are read again after a delete (item 24).

**N3 (Minor): an internal error of a domain parser is invisible to the user.**

- **Where:** `import-analysis.ts:81` → `ImportCodeDialog.tsx:72-77`.
- **Scenario:** `analyzeImport` rethrows anything that is not a `DomainError`, which is right: it should not hide bugs. But the dialog calls it from a click handler, so React does not catch it. The user sees «Проверить код» do nothing; the error is only in the console. This is cloud parity, and unreachable unless the domain has a bug.
- **Fix:** CARRY to a polish plan. A generic «Проверка не удалась» there, still rethrowing for the console, would make a domain bug visible.

### Seam-by-seam

**1. Editor model ↔ cloud ↔ domain.**

- **Faithful port.** `fitElementWithinLabel` and `fitSpecElements` are line-for-line ports of `apps/admin/src/pages/labels/geometry.ts`. The cloud's `elementBoundsMm` re-exports the domain's, which the port imports directly. Only the failure shape changed: `{ ok: false }` instead of `reason: "ELEMENT_TOO_LARGE"`. The samples are byte-identical to `preview-data.ts`: the same synthetic KM with `\u001d`, the pallet's own SSCC, qty 240.
- **Nothing of the domain re-implemented.** Parsers, schema, `assertDuplicateTemplate`, `labelTemplateUsesField` and `EGAIS_PRODUCT_GROUP_CODE` all come from `@markiro/domain`. `MIN_SIZE_MM = 10` and `MAX_SIZE_MM = 300` match `specShape`. `DPI_CHOICES` matches `dpiSchema` (203 | 300), so `toDpi` cannot silently turn a stored resolution into 203.
- **What the editor sends.** Every save sends `checkedSpec` output (parsed by `labelTemplateSpecSchema`, unknown keys stripped, so a JSON `__proto__` key never reaches the host). The schema's depth is about 4, so the host's 64-level rule is unreachable.
- **The 256 KB rule.**
  - **No real hole.** The host measures `serde_json::to_string(spec).len()`. JavaScript's `JSON.stringify` writes the same bytes for this content (raw UTF-8, the same `\uXXXX` escapes for control characters, `/` not escaped), and `update_template` compares `Value`s order-insensitively. A client pre-check `new TextEncoder().encode(JSON.stringify(spec)).length > 262144` therefore mirrors the host exactly for real layouts.
  - **The gap is UX only.** Without the pre-check, an oversized layout (a ZPL code near 256 KB with many `"` or `\`) costs a round trip and a remedy-less message (item 10).
  - **The station.** It parses the same schema, so no editor-made spec is one it refuses.
- **No spurious writes.** On an edit, the first save sends the schema's normalization of the stored layout. The host writes it only if `*spec != current.spec`. Every writer is this app, so nothing is written spuriously.

**2. Wire layer.**

- **Builders.** `templateCreate` names every field. `templateUpdate(opened, …)` sends only the name, flag and categories that changed, always the layout, and the OPENED `rev`.
- **Name.** It is trimmed by `templateNameRule`. A name that differs only by spaces is skipped by the builder, and the host then returns the record as it is, without a new revision (`templates.rs:293-297`).
- **Categories.** `scopeCodes` sends `null` or the codes ascending.
- **Copy.** It is `template={null}`, so it creates from the source layout.
- **Stock templates.** They never reach `TemplateEditor` (they get `EditorUnavailable` with a copy). The host still guards them: `stock_template` on update maps to `errors.stock`, on delete to `errors.stockDelete`.
- **`not_found`.** On update it is mapped. On delete it is defensive: the host answers 204 when the tombstone stands.
- **Failure paths.** `name` and `chzProductGroupCodes` go under their control, `spec` above the form, and `stale_revision` goes to `writeFailure` with `onReload`. Nothing retries with `details.currentRev` (mutant row of item 21).
- **Products after a delete.** The delete clears their preferences and bumps their `rev` (`templates.rs:374-388`). The products cache is not dropped (item 24). The worst case is a recoverable `stale_revision` in the product dialog (`PRODUCT_STALE_FIELDS` also covers a dead template id).

**3. The caches.**

- **The editor's read.** `officeKeys.template(id)` is read on every mount and shown only once `isFetchedAfterMount`. The client has no focus or reconnect refetch (`createOfficeQueryClient`), and no invalidation matches the `["office","template",id]` prefix. The only refetch while the editor is shown is the user's «Загрузить заново» after `stale_revision`, where dropping the edits is intended. So no background refetch can remount `key={rev}` or swap in `LoadError` under live edits.
- **The list.** A create, update or delete removes `officeKeys.templates` exactly. «Шаблоны», «Умолчания шаблонов» and the product dialog all read it afresh.
- **Defaults.** A deleted template cannot be a default (`template_is_default`).
- **The old `template(id)` entry after a save.** It is harmless: the next opening waits for a fresh read.
- **Remaining gaps:** the load-error flash (item 20) and the products cache (item 24).

**4. Write paths.**

- **The rules hold in the editor.** Only the awaited write is in `try`. `backToList` comes after `try/catch`, and every `catch` ends with `return`. The `inFlight` ref is set synchronously, and the `fieldset` is disabled while saving.
- **Delete** uses `FormDialog`'s own guard.
- **Size form and import dialog** resolve immediately.
- **The 200-character cap with « — копия»** is refused client-side before sending (item 23).
- **Import over edits** shows the `unsaved` note; there is no second confirmation, as planned.
- **`duplicateInvalid`.** It is guarded only by the disabled button (item 13). See the triage for why that is already enough in a browser.

**5. Leave blocker.**

- **The blocker function** reads `leaving.current` at call time and compares pathnames, so a search change does not ask.
- **Stale reload.** The `key={rev}` remount releases and re-registers the only blocker in the app (none elsewhere: grep).
- **No stuck state.** «Отмена» and Escape reset it. A completed navigation resets blockers. A save that lands while the dialog is up navigates with `leaving = true`.
- **Open:** save in flight plus leave (item 26, plus N1), and closing the window (item 27, the shell).

**6. Untrusted input.**

- **Rendering.** No `dangerouslySetInnerHTML`, `<Trans>` or `innerHTML` under `src/office/templates` (the only hit in `src` is the pre-existing `devices/PairingDataMatrix.tsx` SVG). Names, code, warnings and parser messages are React text.
- **Parser messages and size caps.** Parser messages stay English without line numbers (item 8, documented). The import uses the domain's caps on code, commands and elements, and the host is the backstop at save.
- **Hostile JSON.** The schema strips prototype keys. V8's `JSON.parse` is iterative, so deep nesting is not a stack risk.
- **File names.** `[^\p{L}\p{N}_-]+` turns path characters into `-` and keeps Cyrillic. Windows reserved stems (`CON`) and the blob revoke (item 14) are unverified in WebView2.

**7. Accessibility and UI.**

- **In place:** labels everywhere, `closeLabel` through `FormDialog`, `empty` on the list table, a live «dirty» note, a live clipboard note, both roles through `useCan("editCatalog")`, state in words.
- **Open:** the import result's live region (item 5), focus on a bare `div` after a scope refusal (item 15), focus after a failed «Применить» (item 18), sidebar highlight (item 12), the monospace font of the code field (item 4: confirmed dead, because `Textarea`'s inline `font: var(--text-body)` beats the class).

**8. Documents.**

- **Accurate.** The `AGENTS.md` «Catalog and label templates», «Protocol» and «Office pages» hunks and spec §5.5 match the code sentence by sentence. 1e4b is named as the second part, not done. The spec's §8 row covers 1e4. Item 17 is already documented in both.
- **Detail left to the plan.** Neither document repeats the owner's `opentype.js` step; the plan's Task 10 holds it exactly. I accept that as the right level of detail.
- **To update in the wave:** see N2.

**9. Tests.**

- **Quality.** Every open waits for `settle()` before it touches the page, and double clicks share one `act`. The stand run was clean, and my three mutants were all killed.
- **Open:** item 6 (the only cast in `apps/standalone`), item 7 (V8 wording), items 16 and 19 (restore and glyph coupling), items 22/25 (looped tests), item 29 (`byNameThenId` survivor).

**10. Scope and process.**

- **Clean:** the allowed paths only, no dependency or lockfile change, the trailers, `diff --check`.

## (b) Triage of the queued minors

| #   | Decision    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FIX         | Cheap: `vi.mock("@markiro/domain", importOriginal)` with `assertDuplicateTemplate` throwing `TypeError`, then `toThrow(TypeError)`. Shares a new test file with item 6.                                                                                                                                                                                                                                                    |
| 2   | DROP        | Checked: no editor path mutates `BLANK_SPEC` or a sample. `resizedSpec`/`fitSpecElements` spread, `replaceLayout` replaces, `startingSpec` builds pallet and duplicate fresh, `elementBoundsMm` only reads. Cloud parity.                                                                                                                                                                                                  |
| 3   | DROP        | Faithful port of an unreachable re-check. Removing it would diverge from the cloud for nothing.                                                                                                                                                                                                                                                                                                                            |
| 4   | FIX         | Confirmed dead CSS. Use `style={{ font: "var(--text-code)" }}` on the `Textarea` (a token, no shorthand/longhand mix) and delete the `font-family` line in `shell.css:288`. Needs a browser look.                                                                                                                                                                                                                          |
| 5   | FIX         | Always-mounted `aria-live="polite"` wrapper around the result, as in `ImportFieldsPanel`.                                                                                                                                                                                                                                                                                                                                  |
| 6   | FIX         | Remove the only cast with `vi.mock` (`parseLabelCode` throws `TypeError`) in its own file, shared with item 1.                                                                                                                                                                                                                                                                                                             |
| 7   | FIX         | Carry the markup through a domain-owned message (e.g. an unknown placeholder `{{<b>x</b>}}`), not V8's `JSON.parse` text.                                                                                                                                                                                                                                                                                                  |
| 8   | CARRY       | Russian parser messages plus «Строка N»: a polish plan. Documented as English today.                                                                                                                                                                                                                                                                                                                                       |
| 9   | DROP        | Resolved in Task 3 (`specRejected`). The remaining remedy is item 10.                                                                                                                                                                                                                                                                                                                                                      |
| 10  | FIX         | Choose the client pre-check. It is exact against `validate::template_spec` (see seam 1): a helper in `editor-model.ts`, checked in `submit` after `checkedSpec`, giving an alert with a remedy. Keep the host mapping as backstop. Reword `errors.specRejected` without «64 уровней» (unreachable). Update the documents (N2).                                                                                             |
| 11  | DROP        | Premise wrong: the office runs on `createMemoryRouter` (`Office.tsx:45`). Its location state does not survive a webview reload (the office remounts at `/`), and the memory router ignores browser Back. A later «К шаблонам» pushes a fresh entry without state, so the notice cannot re-show. `replace: true` is a harmless one-liner if the fixer touches that line anyway.                                             |
| 12  | FIX         | `end={item.to === "/"}` on the sidebar `NavLink` (`OfficeShell.tsx:52`). `/templates` then matches `/templates/*` but not `/template-defaults`. Add a test and update the documents (N2).                                                                                                                                                                                                                                  |
| 13  | FIX (guard) | `if (duplicateInvalid) return;` at the top of `submit`. Rationale corrected: a browser cannot submit through Enter while «Сохранить» is disabled (implicit submission skips a disabled default button, and every other `Button` is `type="button"`). The guard only covers `requestSubmit`. Owner question: on a new template Enter equals clicking an enabled «Сохранить»; that is ordinary form semantics, not a hazard. |
| 14  | CARRY       | Revoke after `click()` is fine in Chromium/WebView2 in practice; verify live. Already listed as unverified in `AGENTS.md`/spec.                                                                                                                                                                                                                                                                                            |
| 15  | FIX         | Give the wrapper `role="group"` + `aria-labelledby` (the card title), or focus the checked radio.                                                                                                                                                                                                                                                                                                                          |
| 16  | FIX         | Move `recordBlobUrls().restore()` into `afterEach`. Add a host `field` refusal test for focus on the name. The unreachable `checkedSpec === null` UI branch may stay untested (unit-covered).                                                                                                                                                                                                                              |
| 17  | DROP        | Done by Task 9: `AGENTS.md:1231-1232` and spec `:804-805` already say «Свой размер» changes nothing on a preset.                                                                                                                                                                                                                                                                                                           |
| 18  | CARRY       | Focus after a failed «Применить»: with 1e3 items 13/26 in a `FormDialog`-level polish plan.                                                                                                                                                                                                                                                                                                                                |
| 19  | FIX         | Assert the Alert text without the icon glyph (`within(alert).getByText(...)` or a text matcher).                                                                                                                                                                                                                                                                                                                           |
| 20  | FIX         | In `OpenedTemplate` (`TemplateEditorPage.tsx:96-107`), check `!template.isFetchedAfterMount` → `PageLoading` BEFORE the error branch. TanStack v5 counts an error update in `isFetchedAfterMount`, so a fresh error still shows. Test: stale save → failed reload → leave → reopen with a pending read → «Загрузка…», not the old «Нет связи».                                                                             |
| 21  | DROP        | Record-keeping only: the mutant row is now known killed.                                                                                                                                                                                                                                                                                                                                                                   |
| 22  | FIX         | `it.each` or labelled `expect(..., label)`. Same commit as item 25.                                                                                                                                                                                                                                                                                                                                                        |
| 23  | CARRY       | Owner/UX: truncate the source name before « — копия»? Today it is refused before sending, with focus on the name.                                                                                                                                                                                                                                                                                                          |
| 24  | FIX         | After a delete, also `removeQueries({ queryKey: officeKeys.products, exact: true })`. The host bumped every affected product's `rev`. Test: delete → products page shows loading / re-reads.                                                                                                                                                                                                                               |
| 25  | FIX         | With item 22.                                                                                                                                                                                                                                                                                                                                                                                                              |
| 26  | FIX         | `mounted` ref checked in `backToList`, plus N1 (disable «Копировать»/«Удалить» while saving). Test: save held, leave via the menu, resolve the save, stay on the menu page.                                                                                                                                                                                                                                                |
| 27  | CARRY       | Window close is Tauri `CloseRequested` in `src-tauri`: a shell plan or the owner.                                                                                                                                                                                                                                                                                                                                          |
| 28  | DROP        | Brief-mandated trivially true line; the following steps carry the assertion.                                                                                                                                                                                                                                                                                                                                               |
| 29  | FIX         | Direct unit tests of `byNameThenId`: reflexive 0, id tie-break both ways, antisymmetry. They kill the surviving `(a.id < b.id ? -1 : 1)` mutant.                                                                                                                                                                                                                                                                           |
| 30  | DROP        | Three one-line mappings in three different contexts (list dialogs, editor save, delete). A shared helper would couple them for no behaviour gain.                                                                                                                                                                                                                                                                          |
| 31  | FIX         | Trivial comment rewrap in `template-options.ts:815-816`.                                                                                                                                                                                                                                                                                                                                                                   |

Proposed fix wave: one fixer, five commits, each with its RED/GREEN and a one-line mutant per new guard.

1. `test(standalone): тесты редактора — без приведения, без формулировок V8 и с подписанными случаями`: items 1+6 (one new file with `vi.mock`), 7, 16, 19, 22+25, 29; plus item 31 (comment).
2. `fix(standalone): запись в редакторе — уход во время сохранения, повторная загрузка и товары после удаления`: items 26 + N1, 13, 20, 24.
3. `fix(standalone): редактор измеряет макет до сохранения`: item 10 (helper, `submit`, `ru.json` text with a remedy, tests).
4. `fix(standalone): доступность редактора и импорта`: items 5, 15, 4, 12 (sidebar by prefix, test).
5. `docs(standalone): итоговая волна плана 1e4a`: N2 (`AGENTS.md`, spec §5.5), and the plan's «Отклонения при исполнении» (draft below) with the fix wave recorded.

## (c) Deviations to record (draft for «Отклонения при исполнении»)

- **Счёт тестов.** План заканчивается на Vitest 53 файла / 1191 тест; исполнение — 53 / 1259 (+68 сверх плана): задача 1 +8 (6 своих и 2 правки), 2 +17, 3 +11, 4 +12 (9 своих и 3 правки), 5 +7, 6 +7, 7 +4, 8 +2, 9 0. Cargo не перезапускался (Rust не менялся; 41 набор, 453 теста). Итоговая волна правок добавляет свои тесты (счёт — в её отчёте).
- **Исправленные тесты плана.** Тест, который перебирал `[undefined, TECHNOLOGIST]` и так ни разу не проверял администратора, в правке задачи 3 и в задаче 5 перебирает `[SESSION.user, TECHNOLOGIST]`. Якоря брифов в конце `template-editor.test.tsx` контроллер поправлял по ходу, потому что тесты сверх плана сдвигали конец файла.
- **Решения контроллера после ревью задач.**
  - Задача 1: два теста ранних проверок размера в `fitElementWithinLabel` (довод исполнителя об «эквивалентных мутантах» оказался неверен).
  - Задача 4: отдельные признаки «ось тронута» для ширины и высоты в `LabelSizeDialog`. Иначе заготовку нельзя было выбрать, когда сохранённый размер округлялся до её текста (импорт 58-мм этикетки в 300 dpi).
- **Отступления планировщика от брифа (приняты).**
  - После создания, правки и удаления кэш списка выбрасывается (`removeQueries`).
  - Редактор читает шаблон под `officeKeys.template(id)` и показывает его, только когда он прочитан в это посещение.
  - Удаление — в шапке редактора; строка типового шаблона предлагает «Копировать».
  - Выгрузки ZPL и TSPL перенесены в 1e4b.
  - `fitSpecElements` и образцы назначения перенесены в приложение, `packages/*` не тронуты.
  - После сохранения и удаления офис возвращается к «Шаблонам» с уведомлением.
  - Новый шаблон начинается без названия.
  - Смена назначения меняет макет только у нетронутой новой заготовки.
- **Уточнения итоговой проверки.**
  - Пункт 11 очереди отброшен: офис работает на `createMemoryRouter`, состояние перехода не переживает перезагрузку, а кнопки «Назад» браузера у памяти маршрутизатора нет.
  - Пункт 13 оставлен как страж для `requestSubmit`: в браузере Enter не отправляет форму, пока «Сохранить» выключена.
  - Проверка размера макета в 256 КБ сделана на клиенте и совпадает с `validate::template_spec`. Отказ хоста остаётся запасным.
- **Итоговая волна правок** — пункты 1, 4–7, 10, 12, 13, 15, 16, 19, 20, 22, 24–26, 29, 31 очереди и замечание N1 итоговой проверки (кнопки шапки во время сохранения). Перенесено: 8, 14, 18, 23, 27 и N3 итоговой проверки (ошибка разборщика вне `DomainError` не видна пользователю).
- **Не проверено вживую** (см. ниже): вебвью Tauri, WebView2, Windows, живой хост и станции, скринридер, раскладка окон.

## (d) What could not be verified

- **A real Tauri webview: WebView2 on Windows and WKWebView on the macOS dev build.**
  - The JSON download through a blob URL and `<a download>`: whether WebView2's download UI shows, whether revoking right after `click()` keeps the data, file names with Cyrillic and Windows-reserved stems (`CON.json`).
  - The clipboard in «Копировать» on the field tokens (`navigator.clipboard.writeText`): permissions in WebView2.
- **Layout on a real screen.**
  - The 1040 px import dialog at the office's real window sizes: two columns, the scroll of the code field, the field list.
  - The size form.
  - The monospace font of the code field after item 4.
  - The sidebar highlight after item 12.
  - The 52/64 px touch sizes are not a concern in the office, but nothing was looked at.
- **Focus and screen readers.**
  - Focus return after each dialog and Escape in each.
  - Announcement of the live regions (dirty note, import result after item 5, clipboard note) and of the refusal focus targets (item 15).
- **A live host and stations.**
  - Request bodies are proven by the builders, their fixtures and `HostApi` mocks; the host's check order by reading `templates.rs` and the plan 1e1 Cargo suites.
  - That stations receive a created, changed or deleted template (copies tested in plan 1e2, never live).
  - The products' cleared preferences on a delete as seen on a station.
- **The host's byte measurement.** That `serde_json::to_string` and `JSON.stringify` give equal lengths for real layouts is reasoned from both serializers, not measured against a running host.
- **Window close and session end.** Windows is needed for the service-hosted office. Session-end and window-close behaviour (not guarded, documented) is unverified.

## (e) Recommendations on the owner questions

1. **Move `fitSpecElements` and the samples into `@markiro/domain`: yes, as its own small plan before 1e4b's preview.**
   - The root `AGENTS.md` asks for reusable label rules in the domain. There are now two verbatim copies.
   - 1e4b's renderer would measure with the same samples, a third consumer.
   - The rasterizer (canvas) stays app-level.
   - One commit touches `packages/domain` plus both apps, with the cloud's geometry tests moved along.
2. **WebView2 `<a download>`: verify live on Windows before 1e4b adds ZPL/TSPL downloads on the same path.**
   - If WebView2 in Tauri 2 refuses or misplaces the file, add one shell save command (a dialog plus a write) and route all three downloads through it. That is a `src-tauri` change and needs the owner's go-ahead.
3. **Return to the list after a save: keep it for 1e4a.**
   - It avoids a «post-save» editor state and revision juggling.
   - Reconsider when the 1e4b preview makes layout iteration common. Staying would only need the saved record fed back as `opened`; `key={rev}` already remounts.
4. **Delete in the header: keep it.** The row is capped at three actions, and a destructive action next to the record's details is safer than in a dense table row.
5. **Leave confirmation after `not_found`: keep it.** The user may still want «Скачать JSON» to recreate the template, or a copy of the draft. Dropping the confirmation would lose that silently.
6. **Seeding button for pre-1e3 sites: CARRY.** A JSON import of a stock template now covers it. Ship the stock JSONs in the docs, or add a button only when a real site asks.
