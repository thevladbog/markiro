# Task 4 report — размер этикетки и разрешение макета

Status: DONE. Commit 59b65ff24 `feat(standalone): редактор шаблона — размер этикетки и разрешение макета` (base 57a798fb5; trailer is one Opus 5.5 line).

## What was done

Plan applied verbatim (every anchor matched once): `LabelSizeDialog.tsx` created; `TemplateEditor.tsx` (import, `sizing` state, «Изменить размер» button in `template-editor__size`, dialog outside the page form); `ru.json` (`changeSize`, `sizeDialog.*`); `shell.css` (`.template-editor__size`, `.template-size`, appended after `.template-editor__actions`, the only place the CSS anchor matches). Five plan tests + 9 extras in `test/template-editor.test.tsx`.

## TDD evidence

- Baseline: template-editor.test.tsx 24 passed; whole package 53 files / 1203 tests.
- RED (plan tests only): `Tests 5 failed | 24 passed (29)`, the five new tests, all `Unable to find ... "Изменить размер"` (plan: 5 failed | 13 passed (18); shift +11 in this file).
- GREEN: 29 passed; with extras 38 passed (verbose, stderr empty, 0 bytes; delayed-setImmediate stand 38 passed, stand files removed).
- Full: `pnpm test` 53 files / 1217 tests (plan 1172; controller-predicted 1208 + my 9 extras = 1217). typecheck, lint, prettier --check, git diff --check clean; `grep '\u04'` only pairing-code.ts:66. cargo not run (no Rust).

## Plan mutants (all FAIL as expected, restored with cmp + shasum identical)

| #   | mutant                               | failing test / key line                                                                          |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | `widthMm = parseSizeMm(width)`       | exact size: `expected { widthMm: 58.06 ...} to strictly equal { widthMm: 58.05714285714285 ...}` |
| 2   | no `resizedSpec`                     | moves the elements inside: dialog not found                                                      |
| 3   | `resizedSpec(spec, ...)` without dpi | `Unable to find ... 58,5 × 40 мм · 300 dpi`                                                      |
| 4   | drop `setWidth(preset)`              | takes a preset: value '100'                                                                      |
| 5   | `setInvalid(false,false)`            | refuses a size: text not found                                                                   |
| 6   | `preset ?? "58x40"`                  | typed size: value 'custom'                                                                       |

## Extra mutants (my tests; whole file run each, restored byte-identically)

| mutant                                                     | killed by                                                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1 `heightMm = parseSizeMm(height)`                        | exact height test (strictEqual spec)                                                                                                                                 |
| X2 `useState("203")` for dpi                               | exact height test, "opens on the resolution"                                                                                                                         |
| X3a/X3b width/height onChange stops clearing its error     | refuses a size (1 left) / one-axis test                                                                                                                              |
| X3c/X3d onChange clears both errors                        | refuses a size / one-axis test (other field's error must stay)                                                                                                       |
| X4/X5 width/height onChange stops clearing too-large alert | "clears the too-large message"                                                                                                                                       |
| X6 preset choice stops clearing field errors               | one-axis test                                                                                                                                                        |
| X7 drop `setHeight(preset)`                                | 5 tests                                                                                                                                                              |
| X7b preset choice stops clearing too-large                 | moves-the-elements test                                                                                                                                              |
| X8 `\|\|` -> `&&` in the invalid guard                     | survived the plan tests (tooLarge alert next to the field error); killed after I added `queryByRole("alert")` null for malformed input (parse table + one-axis test) |
| X9 swap width/height error flags                           | parse table, one-axis test                                                                                                                                           |
| X10 hard-code purpose "box"                                | purpose test (product_duplicate 58x40 -> 100x100: `ok` for duplicate, too large for box sample)                                                                      |
| X11 editor: `onResize` does not call `change`              | 9 tests                                                                                                                                                              |
| X12 editor: dialog not closed after resize                 | 2 tests                                                                                                                                                              |
| X13 drop `inputMode="decimal"`                             | parse table (also asserts type is not number)                                                                                                                        |
| X15 drop dpi hint                                          | presets test                                                                                                                                                         |
| X16 `maximumFractionDigits: 1`                             | both exact tests                                                                                                                                                     |
| X19 `onClose` no-op                                        | cancel test                                                                                                                                                          |
| X20 «Изменить размер» button `type="submit"`               | survived first (page form refused by empty name); killed by new test "opens beside the page's form without submitting it" (name typed, createTemplate not called)    |
| X21 dpi select ignored                                     | 3 tests                                                                                                                                                              |
| X22 close dialog on too-large                              | 2 tests                                                                                                                                                              |
| Survivors argued equivalent:                               |

- X17 (drop `setTooLarge(false)` at the start of submit): a later submit ends in too-large again, in success (dialog unmounts), or in invalid, which needs a typed change, and every onChange and preset choice already clears the alert; dpi does not change fit (mm-based). Ran: 37 passed.
- X18 (`presetOf(widthMm ?? 0, heightMm ?? 0)`): no preset has a 0 side, so null axes never match; also a type error. Ran: 37 passed.
- X14 (drop `if (chosen === undefined) return`): the presets test still passes but the run exits 1 with an unhandled `TypeError: Cannot read properties of undefined (reading 'widthMm')` from the React handler, so it is killed at run level, not by an assertion.

## Extras added (9 tests beyond the plan's 5)

1 parse table through the dialog (15 refused forms incl. empty, spaces, negative, `+`, exponents, `Infinity`, `0x20`, 9,99 / 300,01, malformed commas; 7 accepted forms incl. point, spaces, `10`, `300`, `058`, `10,00`; inputmode); 2 one axis refused only under its own field; 3 too-large clears on either field, layout and dpi kept on refusal; 4 exact height + dpi-only change keeps both axes exact; 5 opens on layout dpi and on just-applied size/dpi; 6 presets list/labels, each preset fills both fields, «Свой размер» leaves typed fields, dpi options and hint; 7 cancel forgets typing, applied size marks draft changed, no create call; 8 purpose measures with its own sample data; 9 opening the dialog does not submit the page form.

## Notes / concerns

- Fixture arithmetic: my first TALL_ZPL expectation said 41,28; the correct value is 330*25.4/203 = 41,29 (test fixed, code unchanged).
- Observation (not changed, not asserted): an untouched axis keeps its exact value, so a layout of 58.004 mm shows «58» but the select reads «Свой размер» (preset match uses the exact value). Consistent with the plan's rule.
- No changes outside the five brief files. `packages/ui/src/.claude` exists in the tree as an untracked/ignored directory (not mine, not shown by git status).
- Not verified: real browser/visual layout of the new CSS (`template-editor__size`, `template-size`), 64px interactive-height contract of tools/production-browser applies to the station only.

## Fix round 1

Base 59b65ff24, fix commit b98858bff `fix(standalone): выбранный размер из списка не заменяется прежним точным значением` (one Opus 5.5 trailer).

**Change** (`LabelSizeDialog.tsx`, test file only): `touched = { width, height }` state. An axis is touched when its text is changed by typing or when a preset is chosen (a preset sets both). `widthMm = touched.width ? parseSizeMm(width) : spec.widthMm` (same for height). `shownWidth/Height` now only seed the initial field text. Doc comment updated. Semantics decided: once an axis is touched its text is its value, also when typed back to the text shown (e.g. «57» then «58» sends exactly 58, not 57.9967); typing the identical text fires no change event, so it does not touch. Minors: none of the review's Minor items touch these lines; all left as is. Test helper `importedSpec(source, dpi = 203)` got a dpi parameter.

**New tests** (size describe, sample `^PW685 ^LL472` imported at 300 dpi = 57.9967 x 39.96 mm, field «58»):

1. «sends exactly the preset's size when a stored width only shows as the preset's text»: preset 58x40, select stays on `58x40`, saved spec is exactly 58 x 40.
2. «keeps the exact width of an axis the user never touched while the other axis is typed over»: type height 40, saved width is exactly 57.9967.
3. «takes the text of a field the user changed as its value, even when it is typed back to the text shown»: width «57» then «58», height «40»: select `58x40`, saved 58 x 40.

**RED** (before the fix, `-t "the label's size"`): 2 failed (tests 1 and 3, `Expected "58x40", Received "custom"`) | 15 passed; test 2 passes on the old code by design (it guards the kept-exact rule, killed by the mutants below).

**Mutants** (restored byte-identically each time: `cmp` silent, sha256 f307a1d0…b697 equal to the fixed copy in /tmp/claude/LSD.fixed):

| Mutant                                          | Failing tests                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| drop `setTouched` in `choosePreset`             | new test 1 + 4 older preset tests (5 failed)                                        |
| drop `setTouched` in width onChange             | new test 3 + 8 older (9 failed)                                                     |
| drop `setTouched` in height onChange            | new tests 2, 3 + 3 older (5 failed)                                                 |
| `widthMm = parseSizeMm(width)` (exactness lost) | new test 2 + «keeps the exact size of an axis left as it was»                       |
| `heightMm = parseSizeMm(height)`                | «keeps the exact height of an axis left as it was, and a resolution changed alone…» |

**Gates:** file `--reporter=verbose`: 41 passed, no warnings/act/unhandled output; delayed-`setImmediate` stand: 41 passed (stand files removed); typecheck 0; lint 0; whole package 53 files / 1220 tests passed (1217 + 3); prettier --check clean; `git diff --check` clean; `\u04` grep only `src/host/pairing-code.ts:66`; `git status --short` empty after the commit.
