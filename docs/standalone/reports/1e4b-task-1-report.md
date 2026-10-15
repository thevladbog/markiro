# Plan 1e4b, Task 1 report: text rasterizer and font coverage (`src/labels/`)

Status: DONE_WITH_CONCERNS (concerns are only the count difference and the equivalent-mutant arguments below).
Base: 9f05b3c0c. Commit: `3212beec4 feat(standalone): растеризатор текста и проверка покрытия шрифтов` (trailer: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`).

## What was done

- Created `apps/standalone/src/labels/{opentype.d.ts,font-coverage.ts,rasterizer.ts}` verbatim from the brief, and `apps/standalone/test/label-raster.test.ts` (brief's 9 tests verbatim + 18 extra tests, see below). Baseline confirmed first: 54 files / 1295 tests, exit 0. All anchors were "Create"; nothing else touched (`test/setup.ts` untouched, no dependency, no pnpm install).

## RED / GREEN

- RED (`vitest run test/label-raster.test.ts`, exit 1): `1 file, Tests no tests` — `Failed to resolve import "../src/labels/font-coverage.js" from "test/label-raster.test.ts"`.
- GREEN with the brief's tests only: `vitest run --reporter=verbose test/label-raster.test.ts` — 1 file, 9 passed, stderr empty. Under the delayed-`setImmediate` stand: 9 passed; stand files removed.
- Final GREEN (with extras): 1 file, 27 passed, stderr empty; delayed stand: 27 passed; both stand files removed (`git status --short` empty after commit).

## Counts

- Brief says: this task = 1 file / 9 tests; whole suite 55 files / 1304 tests.
- Measured: this file 27 tests (brief's 9 + 18 extras); whole suite 55 files / 1322 tests (1295 + 27). The +18 over the plan is entirely my extra tests.

## Mutant table

Method: `/tmp/claude/mut/run.py` — copy before, sha256 before, one exact one-line replacement (asserted to match once), run `vitest run test/label-raster.test.ts`, restore from copy, `cmp` and sha256 after. Every row: restore hash equal and `cmp` silent. "Brief" = the brief's own 6 mutants, run with `-t` filter as the brief states; their failures match the brief's expected lines exactly.

Brief mutants (all killed, as expected):

| #   | Mutant                            | Failing test                           | Key line                                                                                       |
| --- | --------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| M1  | drop `response.ok` check          | fails on a font file that did not load | `expected [Function] to throw error matching /HTTP 404/ but got 'the status is checked first'` |
| M2  | `.some` -> `.every`               | reads both subsets                     | `expected false to be true`                                                                    |
| M3  | `glyph <= 0` -> `glyph < 0`       | parses font bytes                      | `expected true to be false`                                                                    |
| M4  | Sans Cyrillic import `.woff2?url` | finds Cyrillic in the bundled files    | `promise rejected "Error: WOFF2 require an external decompre…"`                                |
| M5  | `fonts.load(font)` without text   | loads the bundled face                 | `expected "vi.fn()" to be called with arguments`                                               |
| M6  | drop `sans-serif` mapping         | maps the generic families              | `expected 'sans-serif' to be 'IBM Plex Sans, sans-serif'`                                      |

The brief's 9 tests covered NONE of `rasterizeTextSync` (wrap, lines, widths, drawing, packing): the canvas path was entirely unexercised (jsdom has no canvas, the tests only used `getContext -> null`). I added a recording fake canvas (`fakeCanvases`, installed with `Object.defineProperty` on `HTMLCanvasElement.prototype.getContext`, restored in `afterEach` from the saved descriptor; no casts) and the extras below. Extra mutants, all killed by the final test file (full-file run, exit 1) unless marked:

| #         | One-line mutant                              | Killed by (extra test)                                                   |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| E1        | sample drops `Ё`                             | needs every letter of the sample (pins the constant)                     |
| E2        | sample `Щ`->`Ж`                              | same                                                                     |
| E3        | swap Sans latin/cyrillic files               | bundled files test / pairs each family                                   |
| E4        | Sans uses the Mono files                     | pairs each family with its own files                                     |
| E5        | `sample` default `""`                        | finds a glyph for every character… / needs every letter                  |
| E6        | `checkCyrillicCoverage` ignores `sample` arg | checks the sample it is given                                            |
| E7        | only second subset (`slice(1).some`)         | passes when the first subset alone covers                                |
| E8        | only first subset (`slice(0,1).some`)        | reads both subsets… (brief)                                              |
| E10       | error message drops the URL                  | names the file and the status                                            |
| E11       | error message drops the status               | same                                                                     |
| E13       | `if (response.ok)`                           | fails on a font file that did not load                                   |
| R1        | line height `Math.floor`                     | draws one unbounded line (box 32 for 21px)                               |
| R2        | line height `*1.4`                           | same                                                                     |
| R3        | width `Math.floor`                           | rounds a fractional measure up (charWidth 10.4 -> 63)                    |
| R4        | natural width `Math.min` over lines          | wraps to maxWidthPx and maxLines                                         |
| R5        | `Math.max(0, …)`                             | never wider than maxWidthPx, nor narrower than one dot (`ПП`/5 and `""`) |
| R6        | drop the `Math.min(maxWidthPx, …)` clamp     | same (whitespace-only text, 30 dots in a 20-dot box)                     |
| R41       | clamp `Math.min` -> `Math.max`               | wraps / keeps one line / never wider                                     |
| R7        | `maxWidthPx > 0` -> `>= 0`                   | does not wrap without a positive maxWidthPx (0)                          |
| R8        | `maxLines ?? 1` -> `?? 2`                    | keeps one line when maxLines is not given                                |
| R9 / R9b  | white/black fill styles swapped              | draws one unbounded line                                                 |
| R10       | `textBaseline` `"middle"` -> `"top"`         | same                                                                     |
| R11       | no `lineHeight/2` centring                   | same / wraps                                                             |
| R12       | `index` not times `lineHeight`               | wraps (second line y 48)                                                 |
| R13 / R14 | measuring / drawing `font` unset             | draws one unbounded line (font on both surfaces)                         |
| R15       | canvas width/height swapped                  | surfaces sizes `[1,1],[60,32]`                                           |
| R16       | `getContext("webgl")`                        | same (`kind`)                                                            |
| R17       | measuring canvas 2x2                         | same                                                                     |
| R18       | `await` on `fonts.load` dropped              | waits for the face to load before it makes a canvas                      |
| R19       | font-load failure made fatal                 | draws anyway when the face fails to load                                 |
| R20       | always `new Error(String(error))`            | brief's refusal test (instance) + rejects with an Error… (identity)      |
| R20b      | rethrow raw (no wrapping)                    | rejects with an Error whatever was thrown                                |
| R21       | `fillRect(0,0,width,1)` / R36 origin `(1,1)` | draws one unbounded line (rect args)                                     |
| R22 / R37 | `getImageData` height 1 / origin (1,1)       | `reads` assertions                                                       |
| R24       | `bitmapToZplHex(…, height, width)`           | packed hex / bytesPerRow                                                 |
| R25       | result drops `height`                        | `toEqual` on the whole raster                                            |
| R26       | bold weights swapped                         | brief's load test and draws bold text in 700                             |
| R29       | wrap limit `maxWidthPx - 1`                  | keeps a line that is exactly maxWidthPx wide whole                       |
| R29b      | wrap limit `maxWidthPx + 1`                  | cuts a line that is a hair wider (charWidth 10.05)                       |
| R30       | drop `monospace` mapping                     | maps the generic families (brief) / draws bold                           |
| R31       | default error message changed                | says what is missing, and keeps a message it was given                   |
| R32       | `this.name` removed                          | brief's refusal test (`name`)                                            |
| R35       | text x offset 1                              | draws one unbounded line                                                 |
| R38       | height not times line count                  | wraps to maxWidthPx and maxLines                                         |
| R40       | `${sizePx + 1}px` in the font shorthand      | draws one unbounded line                                                 |

First sweep survivors, then dealt with: R29 (the wrap limit `maxWidthPx - 1`) and R29b (`+ 1`) survived (all my widths were multiples of 10) -> added the exact-fit test and the 10.05-dot test; both now killed (R29: `expected [ 'aaaaaaaa…' ] to deeply equal [ 'aaaaaaaaaa' ]`; R29b: `expected [ 'aaaaaaaaaa' ] to deeply equal [ 'aaaaaaaa…' ]`). R3 (Math.floor) was killed only after I added the fractional test, in the same sweep order (the sweep ran after it).

Equivalent mutants (three, each argued):

- R23 `convertToMonochrome(data, height, width)`: that function uses `width` and `height` only as `new Uint8Array(width * height)`; the loop runs over `rgba.length` and indexes `i / 4`. The product is symmetric, so the output is byte-identical. Equivalent.
- R39 dropping the `bounded ?` choice (`wrapTextToWidth(text, measure, maxWidthPx ?? 0, …)`): `bounded` false means `maxWidthPx` is `undefined`, `<= 0` or NaN; `wrapTextToWidth` starts with `if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [text]`, the same result as the `[text]` branch. Equivalent given the domain's guard (the `bounded` flag still matters for the width clamp, which the "does not wrap without a positive maxWidthPx" test covers: 0 gives 160, not 1).
- E9 `glyph === null || glyph <= 0` -> `glyph <= 0`: at runtime `null <= 0` is `true`, so behaviour is identical; but the type checker rejects the mutant (`src/labels/font-coverage.ts(31,9): error TS18047: 'glyph' is possibly 'null'`), so the null branch is there for TypeScript, not behaviour. Also `document.fonts?.load` vs `document.fonts.load`: jsdom has no `document.fonts`, the TypeError would be swallowed by the very `try/catch` around it, so the optional chain only avoids an exception, not a behaviour; not testable.

## Extra tests (18, all in `test/label-raster.test.ts`)

Describe "the text rasterizer's drawing" (13 new): unbounded line drawn/packed; bold weight 700 (Mono); wrap + maxLines + ellipsis + box size; default one line; clamp and one-dot minimum; no wrap without positive maxWidthPx (undefined/0/-5); exact fit; hair-over fit (10.05); fractional measure rounds up; waits for the face to load; draws when load fails; rejection is always an Error (non-Error thrown, Error kept by identity); error message/name. Describe "the font coverage check" (5 new): sample constant and every letter needed; custom sample; first subset alone suffices; each family pairs its own latin/cyrillic files; error names file and status. Total 9 (brief) + 13 + 5 = 27, matching the run.

## Checks

- `prettier --check apps/standalone/src/labels apps/standalone/test/label-raster.test.ts` clean (I ran `prettier --write` on my added test code once); `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.
- `typecheck` exit 0; `lint` exit 0 (the `throw "plain text"` in a test helper passes the repo's lint config); full `test`: 55 files / 1322 tests, exit 0.
- Not run: cargo (no Rust touched), build (task touches no shell/dist), browser rendering (this task only verifies canvas drawing against a recording fake; real canvas pixels and real font loading in a webview are not exercised, nor is the Vite production build's `?url` output beyond the test-time `/@fs` path).

## Files

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/labels/opentype.d.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/labels/font-coverage.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/labels/rasterizer.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/label-raster.test.ts`

## Self-review / concerns

- Source modules are byte-for-byte the brief's code (only the test file gained extras). The later plan tasks may add a global `getContext` stub to `test/setup.ts` (task 3); my fake overrides it per test via `defineProperty` and restores the saved descriptor in `afterEach`, so it stays compatible, but that interaction is untested until task 3.
- A `.claude/.cc-writes` directory exists at the repo root `.claude/`; it is git-ignored and was not created by a `cd` from me (I never `cd`).
- Suite count differs from the plan (1322 vs 1304) only because of the 18 extra tests; subsequent tasks' expected totals should be shifted by +18.
