# Plan 1e4, task 2 — report (import of label code)

Status: DONE. Commit `ceefd43f0` «feat(standalone): импорт кода этикетки — ZPL, TSPL и JSON с проверкой и полями шаблона» (base fbbb8c762; trailer: exactly one `Co-Authored-By: Claude Opus 5.5` line, verified with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## What was done

Plan steps 1–6 applied verbatim: the two test files, `FormDialog` `width`, `import-analysis.ts`, `ImportFieldsPanel.tsx`, `ImportCodeDialog.tsx`, `office.templateImport` and `office.labelFields` keys, `.template-import*` CSS. All anchors matched exactly once. Host, proto, shell, station and `packages/*` untouched.

## Evidence

- Baseline before the task: 49 files / 1141 tests (as the dispatch said).
- RED: `vitest run test/import-analysis.test.ts test/import-code-dialog.test.tsx` → exit 1, 2 files failed, `Tests no tests`; `Failed to resolve import "../src/office/templates/import-analysis.js"` and `"../src/office/templates/ImportCodeDialog.js"`.
- GREEN (plan tests only): 2 files, 17 tests passed (import-analysis 8, import-code-dialog 9).
- Verbose run of both files: 34 passed, stderr empty (0 bytes). Delayed-`setImmediate` stand: 34 passed, stderr empty; the two stand files removed.
- Final gates: prettier --check on all 8 files clean; `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`; typecheck 0, lint 0; full `test`: **51 files / 1175 tests** passed.
- Counts: plan expected 51 / 1150 (its author's base 1133). Measured base 1141, so plan-equivalent is 1141 + 17 = 1158; plus 17 own extras = 1175 (analysis 8+5 = 13, dialog 9+12 = 21; 34 in all).

## Mutants (all with backup under /tmp/claude/1e4t2, `cmp` silent and sha256 equal after restore; script /tmp/claude/1e4t2/mut.py). Every one failed its covering test.

Plan mutants 1–8:

| #   | mutant                           | test that failed    | key line                                             |
| --- | -------------------------------- | ------------------- | ---------------------------------------------------- |
| P1  | `spec: parsed.spec`              | hangs over the edge | `expected 57 to be less than 57`                     |
| P2  | drop `...(name …)`               | wrapper's name      | `expected undefined to be 'Паллета 58×40'`           |
| P3  | no `forget()` on code edit       | drops the check     | `expected <strong></strong> to be null`              |
| P4  | `canReplace = analysis !== null` | acknowledged        | submit `to have property "disabled" with value true` |
| P5  | `dpi: initialDpi`                | drops the check     | `Unable to find … 39,29 × 27,09 мм`                  |
| P6  | drop `width` pass-through        | wide                | `expected '480px' to be '1040px'`                    |
| P7  | json token always `{{…}}`        | bare names for JSON | `Unable to find … qty.boxes`                         |
| P8  | drop `setCopied(true)`           | copies a field      | `Unable to find … Поле скопировано.`                 |

Extras (tests I added, with the mutant that made them necessary; the plan's tests alone left each alive or untested):

| #      | mutant                                                                                                        | added test                                                             | key line                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| E1     | `labelSampleData("box")`                                                                                      | measures the layout with the sample data…                              | `expected [] to deeply equal ['name']`                             |
| E2     | `labelRenderOptions("box")`                                                                                   | same                                                                   | `expected ['km'] to deeply equal []`                               |
| E3     | drop `if (!(error instanceof DomainError)) throw error`                                                       | does not swallow an error that is not the domain's                     | `expected function to throw an error, but it didn't`               |
| E4     | issues branch disabled                                                                                        | existing schema-failure test                                           | issues object mismatch                                             |
| E5     | JSON `purpose: "pallet"` constant                                                                             | existing wrapper test                                                  | warnings `[]`                                                      |
| E6     | code `dpi: 203` constant                                                                                      | existing ZPL resolution test                                           | `expected 58.057… to be less than 58.057…`                         |
| E7     | code `language: "zpl"` constant                                                                               | existing TSPL test                                                     | `expected false to be true`                                        |
| E8a–d  | `dangerouslySetInnerHTML` for the dropped-line source, issue message, parser message, unknown-property source | renders imported code, names and messages as text, never as markup     | missing text or `to contain '<b>x</b>'`                            |
| E9     | unknown-property row shows the purpose-mismatch text                                                          | names a property the model does not have…                              | `expected 'foo — не совпадает…' to be 'foo — этого свойства…'`     |
| E10a/b | `adjustedIds.length >= 0` / `> 1`                                                                             | tells how many elements it moved inside the label…                     | `expected <p></p> to be null` / `Unable to find … Прижато … 1`     |
| E11    | `source === ""` instead of `.trim()`                                                                          | keeps «Проверить код» off for code that is only blanks                 | `disabled` expected true                                           |
| E12    | `onReplace` without `canReplace`                                                                              | does not replace the layout on a submit that skips the acknowledgement | `expected "vi.fn()" to not be called at all`                       |
| E13a/b | `forget` keeps `acknowledged` / `check` does not call `forget`                                                | asks for the acknowledgement again…                                    | `expected 'true' to be 'false'`                                    |
| E14    | `onClose={() => undefined}`                                                                                   | closes without replacing                                               | `to be called 1 times, but got 0`                                  |
| E15    | field hint texts swapped                                                                                      | words the field hint for the syntax…                                   | `Unable to find … Вставьте поле целиком…`                          |
| E16a/b | `setCopyFailed(false)` / `setCopied(false)` dropped                                                           | forgets a failed copy once the next one succeeds / existing copy test  | `Unable to find … Поле скопировано.` / `… Не удалось скопировать…` |
| E17    | `copy(field)` instead of `copy(token)`                                                                        | existing copy test                                                     | `to be called with arguments: ['{{sscc}}']`                        |
| E18    | `date` and `expiry` label keys swapped                                                                        | labels every field the domain can print                                | `expected 'Годен до{{date}}' to be 'Дата{{date}}'`                 |
| E24    | `toFormat` loses `tspl`                                                                                       | names the code field after the chosen format                           | `Unable to find a label … Код TSPL (TSC)`                          |
| E25    | unsaved note always shown                                                                                     | existing first dialog test                                             | `expected <p class="office-note"></p> to be null`                  |

Extra tests, analysis (5): purpose-sensitive fit (qty at 40 mm moves under pallet, not box; sscc moves under box, not product duplicate; a 0.5 mm Data Matrix at 50 mm moves under box, not product duplicate); unknown-property warnings with dotted paths; non-`DomainError` is rethrown (one `null as unknown as string` cast in the test, with a comment); `{"spec":1}` and `[]` become messages; every schema issue is listed. Dialog (12): markup test (item 3 of the dispatch), unknown-property row, adjusted count shown only when non-zero, blank code, submit that skips acknowledgement, acknowledgement asked again after edit and after re-check, «Отмена», hint per syntax, failed copy cleared by next success, bare-name copy for JSON, every field's label paired with its token, code-field label per format.

Markup test notes: the dialog renders only React text children (`<code>`, `<li>`, `Alert`); the test feeds markup through an unsupported ZPL line, a JSON parse error (V8 echoes up to ~10 characters, so the markup is `<b>x</b>`, an environment-dependent echo on Node ≥ 24), an element id inside a schema issue message, and an unknown property name; it asserts no `img/script/b/i/u/s` element appears in the dialog and the literal text is present.

## Mutants argued equivalent or unreachable

- `issue.path === "" ? "spec" : issue.path` in `ImportErrorAlert`: an empty issue path needs a root-level schema failure, but `parseLabelJson` rejects non-objects first with a message, and every other issue has a key or `elements` path (checked `{}`, empty elements, duplicate ids, a 4000 mm ZPL page). Unreachable through `analyzeImport`; kept as the plan has it. A reviewer could kill it only by mocking the domain.
- `error.code === "LABEL_INVALID"` and `isIssueList` in `analyzeImport`: `parseLabelTemplate` is the only source of an array `cause` and always builds well-formed `{path, message}`, so dropping either guard changes nothing observable; they are type guards replacing a cast.
- `forget()` inside `check` matters only for the acknowledgement (killed by E13b); for error and analysis the same inputs always give the same outcome.

## Concerns

- None blocking. The plan's `ImportOutcome` formatting and all plan code were kept verbatim; prettier `--write` was run on my files and changed nothing in the plan's source files.
- Browser, real clipboard, and visual layout of the 1040 px two-column dialog were not exercised (jsdom only); the CSS is plan-verbatim and unrendered.
