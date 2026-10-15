# Main follow-up report: #703 rasterizer port, rustls bump

Status: DONE_WITH_CONCERNS. Task 1 done and committed; Task 2 (rustls) STOPPED: the sandbox refused crates.io.
Worktree /tmp/claude/wt/integ, branch claude/integration, BASE 0a7811526.

Commit: `000b02bfe` feat(standalone): the text rasterizer and the preview follow the standard labels (#703) (one Co-Authored-By: Claude Opus 5.5 trailer). Tree clean, nothing pushed.

## Task 1: #703 in the standalone

Read `git show bbcfc9c05`: the station and admin rasterizers changed identically (24 lines); the domain changed the model, zpl.ts/tspl.ts/render-plan.ts, bounds.ts.

### What changed

- `apps/standalone/src/labels/rasterizer.ts`: line box `ceil(fontSizePx * (lineHeight ?? 1.5))`; for a bounded text with `minFontSizePx` the font shrinks one dot at a time while the measure exceeds `maxWidthPx` and size > min, the measure context and the drawing font follow, and if it still does not fit it throws `Label quantity exceeds its box at minimum font size` (same message as the station). The line height uses the shrunk size. Byte-for-byte the station's logic, on the standalone's own canvas helper (with its 4096 cap).
- `apps/standalone/src/office/templates/label-renderer.ts` (office preview; `floor/print/label-render.ts` needed no change, it goes through the domain generators, which pass `fontFamily`/`lineHeight`/`minFontSizePx` to the rasterizer by themselves):
  - `rasterTextElements` also takes elements that name a `lineHeight` or `fontFamily` (the domain's `renderTextLikeElement` rasterizes them even in ASCII), so preview = print.
  - `compositeTextRasters` passes `fontFamily: element.fontFamily ?? "sans-serif"`, `lineHeight`, and `minFontSizePx = ptToDots(minFontSizePt, spec.dpi)` only when set (same as the domain).
  - native drawing under the bitmap uses `element.lineHeight ?? LINE_HEIGHT_EM` and `element.fontFamily`.
  - `drawLabel`: explicit `case "organization_logo"` that draws nothing.
- Other #703 domain items the standalone consumes (`textFormat` quantity_number/sscc_with_title/sscc_spaced, `minFontSizePt` bounds, `gs1Constraint`, strict schema) are domain functions (`labelFieldDisplayValue`, `labelTemplateSpecSchema`); the standalone already uses them through `textOf` and the editor, nothing to port. The strict schema parses all 21 seeded specs (new test).

### Exactly what happens with the logo (decision П15 pending, no asset bundled)

- Print: `generateZpl/Tspl` with no `logo` dependency skip the element (`if (!deps.logo) break;`): the logo area is blank white, no `^GFA`/`BITMAP`, no throw. Test: for every stock template with the logo, the bytes of `renderLabel` with the element equal the bytes without it (4 printer variants).
- Preview: `drawLabel` leaves the area white, `compositeTextRasters` ignores it. Nothing is drawn, so preview = print (both blank). It does NOT match what the cloud station prints (org logo or the bundled Markiro logo) until П15 is decided; the station would need `renderLabelLogo`/`logo` passed to `generateZpl`/`generateTspl` in `label-render.ts`, the office preview, and the template download.
- `organization_logo` is accepted by the office editor (domain schema) and by the host (spec is opaque JSON).

### Known preview/print difference (unchanged by this task)

If the rasterizer throws (the shrink-to-fit refusal, too-large canvas), the print records `render_failed`, while the office preview keeps the element's native drawing (existing behaviour of `compositeTextRasters`). Not changed.

### Tests (TDD)

RED: `/tmp/claude/impl-main-followup/red-raster.txt` (7 failed of 40 before the rasterizer edit), `red-renderer.txt` (4 failed before the preview edit), `red-stock.txt` (stock file run against the base rasterizer: 2 failed, the shrink and the refusal).

- `test/label-raster.test.ts`: fake canvas measure now follows the font size (`charWidth` may be a function); 9 new tests (line height 1.2 / default 1.5 / ceil, shrink one dot at a time to a fitting size and draw at that size, line height from the shrunk size, exact fit keeps the size, minimum itself allowed, throws below it and never tries a smaller size, no shrink without a minimum, no shrink unbounded, measure context follows the shrinking font).
- `test/label-renderer.test.ts`: 5 new tests (ASCII element with lineHeight/fontFamily is rasterized exactly as `generateZpl` asks, others not; rasterizer options incl. family/lineHeight/minFontSizePx at 300 dpi; parity of preview calls with ZPL and TSPL calls for all 21 stock templates with their purpose's sample data; native line step/family; logo draws/rasterizes/prints nothing).
- `test/stock-templates-render.test.ts` (new, 6 tests): `stockTemplates()` = 21 templates, within `MAX_STOCK_TEMPLATES` 32 (TS constant and the Rust source `host/src/routes/bootstrap.rs` regex), strict-schema parse, every seeded template renders with the real `rasterizeText` (fake canvas, 0.6 em glyph) for a 240-char Cyrillic name/counterparty, qty 9999, boxes 999 in zpl/tspl x 203/300 dpi (84 renders), logo bytes equal no-logo bytes, a quantity too wide at 17 pt on the 75x120 box shrinks to 45 px, a 40-digit quantity is refused.
  NOTE: the wizard seeds **21** templates (16 box, 2 duplicate, 3 pallet), not 19 as the drift report and the brief said; the test pins 21 (a change must be a deliberate edit).

### Mutants (script `/tmp/claude/impl-main-followup/mutate.py`, output `mutants.jsonl`; each original copied to `orig/<id>.bak`, sha256 before = after for every run, file touched; `git status` clean of mutations)

| id                                                                                                                                                                                                                             | one-line mutant                                                           | killed by                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------- |
| R1                                                                                                                                                                                                                             | line height ignored (`* 1.5`)                                             | 3 raster tests                        |
| R2                                                                                                                                                                                                                             | default 1.5 -> 1.4                                                        | 10 raster tests                       |
| R3                                                                                                                                                                                                                             | floor `> min` -> `>= min`                                                 | "throws ... never goes below"         |
| R4                                                                                                                                                                                                                             | no floor (`> 0`)                                                          | throw tests (raster + stock)          |
| R5                                                                                                                                                                                                                             | loop `>` -> `>=` (exact fit shrinks)                                      | exact-fit test, stock shrink to 45 px |
| R6                                                                                                                                                                                                                             | never throw at the minimum                                                | throw tests (raster + stock)          |
| R7                                                                                                                                                                                                                             | throw test `>` -> `>=` (exact fit at min throws)                          | 4 tests                               |
| R8                                                                                                                                                                                                                             | drawing font not updated while shrinking                                  | 3 tests                               |
| R9                                                                                                                                                                                                                             | measure context font not updated                                          | 7 tests                               |
| R10                                                                                                                                                                                                                            | shrink step 1 -> 2                                                        | 3 tests                               |
| R11                                                                                                                                                                                                                            | `bounded && minFontSizePx !== undefined` -> `bounded`                     | 9 tests                               |
| L1                                                                                                                                                                                                                             | no element asks for a bitmap                                              | stock parity, ASCII test              |
| L2                                                                                                                                                                                                                             | lineHeight does not ask for a bitmap                                      | stock parity, ASCII test              |
| L3                                                                                                                                                                                                                             | fontFamily does not ask for a bitmap                                      | ASCII test                            |
| L4                                                                                                                                                                                                                             | rasterizer always gets sans-serif                                         | 3 tests                               |
| L5                                                                                                                                                                                                                             | minFontSizePx not passed                                                  | options test, stock parity            |
| L6                                                                                                                                                                                                                             | lineHeight not passed                                                     | 3 tests                               |
| L7                                                                                                                                                                                                                             | minFontSizePx at 203 dpi always                                           | options test (300 dpi)                |
| L8                                                                                                                                                                                                                             | native line step ignores lineHeight                                       | native spacing test                   |
| L9                                                                                                                                                                                                                             | native font ignores family                                                | native spacing test                   |
| L10                                                                                                                                                                                                                            | organization_logo drawn as a black block                                  | logo test                             |
| S1                                                                                                                                                                                                                             | wizard `MAX_STOCK_TEMPLATES` 32 -> 31                                     | cap test                              |
| S2                                                                                                                                                                                                                             | Rust `MAX_STOCK_TEMPLATES` 32 -> 33 (source text; no cargo run during it) | cap test (regex)                      |
| All 22 killed. Equivalent/not mutated: removing the no-op `case "organization_logo"` (a switch without default behaves the same; L10 pins that nothing is drawn); `bounded &&` removal alone (`measure > undefined` is false). |

### Gates (all in /tmp/claude/wt/integ)

- typecheck exit 0 (one typing fix in the new test after the first run), lint exit 0, build exit 0.
- Full Vitest `--testTimeout=60000 --hookTimeout=60000`: 134 files, 4028 passed, 0 failed (4007 before + 21 new), no stderr.
- Parity: `export-parity` and `forms-parity` in the full run and focused (verbose) run of 5 files: 336 passed, 0 stderr.
- `cargo fmt --check --all` clean (no Rust change). Prettier (cwd = worktree root, `.prettierignore`, repo-relative) proven live with a scratch file (exit 1, deleted); the 5 changed files clean. `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; clean tree.
- Not applicable: the delayed-`setImmediate` stand (no React/effect test changed).
- Not run: real fonts (IBM Plex metrics), a real canvas, real TSC/ZPL printers, WebView2 (all under jsdom with fake canvases). Whether a real quantity fits its box at the minimum size with the real face is not proven; the cloud station has the same dependency.

## Task 2: rustls 0.23.43 -> 0.23.45: NOT DONE

`cargo update -p rustls --precise 0.23.45 --manifest-path /tmp/claude/wt/integ/apps/standalone/Cargo.toml` (sandboxed) failed at once: `failed to download from https://index.crates.io/config.json ... CONNECT tunnel failed, response 403`; sandbox violation `deny network-outbound index.crates.io:443`. Per the brief I stopped and did not work around it. `Cargo.lock` is unchanged (`git status` clean; a copy of the original is in `/tmp/claude/impl-main-followup/Cargo.lock.orig`). The controller can allow `index.crates.io` (and very likely `static.crates.io` for the .crate download; if the lock has no 0.23.45 entry yet the index is needed, then the download of the crate) and re-dispatch: `cargo update -p rustls --precise 0.23.45 --manifest-path .../apps/standalone/Cargo.toml`, then inspect `git diff Cargo.lock` (rustls only + necessary companions), then one unsandboxed `cargo test --workspace --locked` (expect >= 1112 passed, 0 failed). The checksum line for rustls at `Cargo.lock:3729-3732` is the one that moves.

## Concerns

1. Task 2 open (network); the host still serves TLS on rustls 0.23.43 (GHSA-2mjx-qc3c-rqvc).
2. The logo prints blank in the standalone (and in its preview) while the cloud station prints a logo: decision П15.
3. Seeded template count is 21, not 19.
4. Real-font fit of quantities and real-printer output are unverified.
