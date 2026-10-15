# Plan 1e4, Task 1 report: editor model without a screen

Base `cda9d9f1d`. Commit `f4b950c32 feat(standalone): модель редактора шаблона — размеры, проверка макета, подгонка элементов` (trailer: exactly one `Co-Authored-By: Claude Opus 5.5` line, verified with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## What was done

Created, verbatim from the brief: `src/office/templates/{label-samples,label-geometry,editor-model}.ts` and `test/{label-geometry,editor-model}.test.ts`. Then added 6 tests of my own (see below). No other file touched; no cargo, no installs, no stash.

## RED / GREEN

- RED: `vitest run test/label-geometry.test.ts test/editor-model.test.ts` -> exit 1, 2 files, 0 tests: `Failed to resolve import "../src/office/templates/editor-model.js"` and `"../src/office/templates/label-geometry.js"` (the plan expected `label-samples.js` for the second; the import order in the file makes `editor-model.js` fail first. Same class of failure).
- GREEN (plan's 20 tests): 2 files, 20 passed. `--reporter=verbose`: stderr 0 bytes. Under the delayed-`setImmediate` stand: 20 passed; stand files removed.
- GREEN after my additions: 2 files, 26 passed (`label-geometry` 9, `editor-model` 17). Verbose: stderr 0 bytes. Delay stand: 26 passed (run on the final files).
- Full package: `test` -> 49 files, 1139 tests (baseline 47 files / 1113 confirmed by arithmetic: 1139 = 1113 + 26). Plan said 49 / 1133 after the plan's 20 tests; the difference of 6 is exactly my extra tests.
- `typecheck` exit 0, `lint` exit 0, `prettier --check` on the 5 files clean, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.

## Mutants (all on one-line scratch edits, every run restores byte-identically)

Harness: `/tmp/claude/1e4t1/mut.py` backs the file up to `/tmp/claude/1e4t1/m/<label>.before`, hashes it, applies one exact-once replacement, runs the covering test file, copies the backup back, `cmp`s and re-hashes (all runs: `cmp=True hash_same=True`). Sha256 of the three source files before all mutants and after: identical (`/tmp/claude/1e4t1/sha-before.txt` vs `sha-after.txt`). Outputs: `/tmp/claude/1e4t1/m/*.out`.

Plan mutants 1-10 (M1..M10, run with the plan's `-t` filter): all FAIL as expected.

| Mutant                                  | Failing test (key line)                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| M1 `deltaY = 0`                         | label-geometry: slides an element back over the edges it hangs across        |
| M2 drop `x2Mm` shift                    | label-geometry: moves both ends of a line by the same amount                 |
| M3 drop `adjustedIds.push`              | label-geometry: fits a whole layout and names the elements it moved          |
| M4 no comma replace                     | editor-model: reads a typed size...                                          |
| M5 `>` instead of `>=` MIN              | editor-model: reads a typed size...                                          |
| M6 send `spec` not `parsed.data`        | editor-model: sends a layout as the domain's schema makes it                 |
| M7 drop purpose guard in duplicate rule | editor-model: holds a product duplicate to the domain's duplicate rule       |
| M8 drop `scope.mode === "selected"`     | editor-model: warns about the EGAIS field...                                 |
| M9 drop name comparison                 | editor-model: finds a change in anything a save sends                        |
| M10 ASCII-only file name                | editor-model: makes a file name of a template name, keeping Cyrillic letters |

Extra mutants (the plan's tests did not cover some; I added tests, then ran them all against the final tests):

| Mutant                                                                                | Failing test                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| X01 drop `finiteSize` guard in `fitElementWithinLabel`                                | refuses a label that has no finite positive size (new)                              |
| X02 drop `finiteSize` guard in `fitSpecElements`                                      | same (new)                                                                          |
| X03 drop `y2Mm` shift of a line                                                       | moves both ends of an upright line over the top edge (new)                          |
| X04 drop `yMm` shift of a line                                                        | same (new)                                                                          |
| X05 `EPSILON = 0`                                                                     | forgives the float noise (new)                                                      |
| X06 `EPSILON = 1e-6`                                                                  | same (new)                                                                          |
| X09 `deltaX = 0`                                                                      | slides an element back                                                              |
| X10 non-line move drops `xMm`                                                         | slides an element back                                                              |
| X11 unmoved element reports `adjusted: true`                                          | leaves an element that fits where it is                                             |
| X12 `fitSpecElements` returns the old `spec`                                          | fits a whole layout and names the elements                                          |
| X13 drop `if (!fit.ok) return fit`                                                    | refuses the whole layout when one element does not fit                              |
| X14 `&&` -> `                                                                         |                                                                                     | ` in the "no move needed" test | moves both ends of a line |
| X16 `60x40` -> `60x41`                                                                | offers the five stock label sizes and 203 and 300 dpi (new)                         |
| X17 `DPI_CHOICES = [203]`                                                             | same (new)                                                                          |
| X18 `readSpec` returns the input, not parsed data                                     | drops the unknown keys of a stored layout (new)                                     |
| X19 `resizedSpec` always measures with the box sample                                 | measures a layout with the sample and the code drawing of its own purpose (new)     |
| X20 `resizedSpec` always measures natively                                            | same (new)                                                                          |
| X21 pallet starts blank                                                               | starts a box empty...                                                               |
| X22 duplicate starts blank                                                            | same                                                                                |
| X23, X24, X25, X26 drop purpose / enabled / scope / spec comparison in `draftChanged` | finds a change in anything a save sends                                             |
| X27 raw `draft.scope.codes` instead of `scopeCodes`                                   | same                                                                                |
| X28 drop `!` before `sameCategories`                                                  | same                                                                                |
| X29 drop `$` anchor of the size regex                                                 | reads a typed size...                                                               |
| X30 decimals required in the size regex                                               | same                                                                                |
| X31 swap `toDpi` result                                                               | takes 300 dpi from a select...                                                      |
| X32 JSON indent 4 / X33 no final newline / X34 key order                              | downloads a template as `{ name, purpose, spec }`...                                |
| X35 no edge-dash strip / X36 no `+` in the file-name regex / X37 no `label` fallback  | makes a file name...                                                                |
| X38 drop `!` in EGAIS check / X39 `labelTemplateUsesField` -> `true`                  | warns about the EGAIS field...                                                      |
| X40 duplicate rule returns `false` on `DomainError`                                   | holds a product duplicate to the duplicate rule                                     |
| X41 `MAX_TEMPLATE_NAME = 201`                                                         | trims a name and refuses...                                                         |
| X42 `MAX_SIZE_MM = 299`                                                               | reads a typed size...                                                               |
| X43 drop `trim()` in `parseSizeMm`                                                    | same                                                                                |
| X44 `resizedSpec` returns the old `spec`                                              | resizes a layout...                                                                 |
| X45 `resizedSpec` drops `heightMm`                                                    | same                                                                                |
| X46, X47 pallet `sscc` / `qty` changed                                                | measures a duplicate with its own sample                                            |
| X48 duplicate `product.gtin` changed                                                  | same (new relation check: code starts with `01` + GTIN)                             |
| X49 duplicate `km.code` without group separator                                       | same (new)                                                                          |
| X50 drop duplicate `product.printName`                                                | same (new `not.toBe` the box's name; first run SURVIVED, then killed)               |
| X51, X52 duplicate `qty` / `sscc` changed                                             | same                                                                                |
| X53 duplicate raster -> native / X54 box raster / X55 pallet raster                   | measures a layout with the sample and the code drawing... / measures a duplicate... |

Survivors, all reasoned as equivalent (not fixable by a test):

- X07 (drop the `bounds.h > heightMm + EPSILON` clause) and X08 (drop the `bounds.w > widthMm + EPSILON` clause) in `fitElementWithinLabel`: the final `after` check (`after.x + after.w > spec.widthMm + EPSILON`, same for y) refuses the same elements, because an element larger than the label always lands at a negative start after the clamp. The early clauses are a redundant defensive guard; kept as the brief has them.
- Not mutated: the `after` block itself (unreachable for the present element kinds: a move never changes size), and `throw error` for a non-`DomainError` in `duplicateLayoutInvalid` (no input of the schema-valid kind raises another error type).

## Tests added beyond the plan (6)

label-geometry: "moves both ends of an upright line over the top edge" (needed `y2Mm` / `yMm` of a line); "forgives the float noise of a sum of millimetres, and no more than that" (EPSILON both ways, width and height); "refuses a label that has no finite positive size, even an empty one" (zero, negative, NaN, Infinity on both axes, through both functions). The test helper `box` gained an optional `{ widthMm, heightMm }` argument (first draft used object spreads that failed typecheck).

editor-model: "offers the five stock label sizes and 203 and 300 dpi"; "drops the unknown keys of a stored layout as it reads it"; "measures a layout with the sample and the code drawing of its own purpose" (qty field: «240» does not fit 10 mm, «1» and the box sample do; the duplicate's raster code fits 58x40, measured natively as a box it does not); plus extra assertions inside "measures a duplicate with its own sample" (box sample equals `sampleLabelData()`, duplicate `km.code` is `01` + its GTIN + the rest + `\u001d`, printName differs from the box's).

## Concerns / notes

- Plan counts: plan said 49 files / 1133 tests; measured 49 / 1139 because of the 6 extra tests.
- `fitElementWithinLabel`'s early width/height clauses are redundant with the final bounds check (X07/X08 above); not changed, as the brief gives the code verbatim.
- Mutation runs ride on `rtk`-wrapped pnpm; counts taken from files (`grep -E "Test Files|Tests "`), not from pipes.
- Rendering note for Task 2+: `escapeValue: false`, so template names go only as React text children / attribute values.
- A first mutation run hung because of a stray `sha256sum` with no argument on macOS (reads stdin); killed, no source file was ever modified by it (verified by the final hash comparison).

## Fix round 1

Base HEAD: f4b950c3264c205b107504f3c08e11405a9d8901. Fixes Important 1 of the review: the early `bounds.w > widthMm + EPSILON` / `bounds.h > heightMm + EPSILON` clauses of `fitElementWithinLabel` are NOT equivalent mutants (the earlier "Survivors" claim about X07/X08 is withdrawn). An oversized element starting exactly at `size - own size` gets a zero shift and would return `ok: true` without them. Only `apps/standalone/test/label-geometry.test.ts` changed; no source file.

Tests added (after the last test):

- "refuses an element wider than the label even when it starts exactly at the label width minus its own width": `box("a", -5, 0)` (20 wide) in `spec([], 15, 40)` -> `{ ok: false }`.
- "refuses an element taller than the label even when it starts exactly at the label height minus its own height": `box("a", 0, -2, { widthMm: 5, heightMm: 12 })` in `spec([], 58, 10)` -> `{ ok: false }`.

| Mutant (one line)                                         | Failing test                                                     | Key line                                                                                            | Restore proof                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| delete `bounds.w > spec.widthMm + EPSILON \|\|`           | the "wider than the label ... width minus its own width" test    | `AssertionError: expected { ok: true, …(2) } to strictly equal { ok: false }` (1 failed, 10 passed) | sha256 4f8d7df3…9b3e before and after, `cmp` identical to /tmp/claude copy |
| replace `bounds.h > spec.heightMm + EPSILON` with `false` | the "taller than the label ... height minus its own height" test | same message (1 failed, 10 passed)                                                                  | same sha256, `cmp` identical                                               |

Unmutated code: label-geometry.test.ts 11 passed (verbose, no stderr). Whole package: 49 files / 1141 tests passed. prettier --check and `git diff --check` clean.
