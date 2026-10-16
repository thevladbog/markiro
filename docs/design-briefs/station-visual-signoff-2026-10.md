# Station visual sign-off, 2026-10

Branch `claude/station-audit` (from `claude/integration` 5b63d8536, nothing pushed). Scope: the whole
standalone STATION floor on the design kit (steps A, B, C), before the kit goes to the office.

## Method

Harness: the real React screens are rendered under jsdom with the existing test fixtures; the DOM is
written to HTML and shown in Chromium (playwright-core) with the real built CSS (`vite build`). Every
screenshot carries the REAL `FloorStatusBar` (one-row header, link dot, chips including the low-SSCC chip,
operator / shift line, sync, window control, «Сменить оператора») in the real `.floor-frame`; the 80 px
stand-in of steps A–C is gone. Dark and light, 1280×1024 and 1280×800 (sign-in and setup also 1024×768).
Files: `/tmp/claude/shots/station-audit/` (`harness-final/` the jsdom specs, `shoot.mjs` the checker, `shots/<group>/<screen>/<theme>-<size>.png`,
`html/results.json` the raw measurements). Contact sheets (dark | light, 1280×1024): `~/Downloads/markiro-station-audit/`.

Automatic checks on every shot: document scroll 0 (both axes); nodes beyond the viewport (outside inner scroll
regions); truncated / clipped text; every interactive element ≥ 64 px; text contrast from computed styles against
the effective background (gradients: worst stop; large text 3:1, other 4.5:1; disabled controls excluded);
focus ring on 48 Tab stops; literal colours in inline styles. Literal colours in CSS: Vitest guard (strict, below).
Every contact sheet was looked at.

## Result

111 screens/states × 2 themes, 486 shots (1280×1024 and 1280×800 for all, 1024×768 for sign-in and setup).

| Group                                                                                                                                                                                    | Screens / states | ok     | fixed  | known limitation |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------ | ------ | ---------------- |
| Status bar and alerts (offline, refused, 4 license states + grace + emergency, 3 update offers, worst case, link popover, sync panel ok/bad, window exit/error, switch-operator confirm) | 19               | 9      | 8      | 2                |
| Sign-in (badge, unknown badge, wrong layout, tabel, PIN ×3, wrong PIN, lockout, no copies, idle/removed notice)                                                                          | 12               | 10     | 2      | 0                |
| Hub (empty, two, many with long titles/modes/pallets, pallets, offline + license)                                                                                                        | 5                | 1      | 4      | 0                |
| New shift (search ×4, details agg/plan/error/pallets/validation/dup, box template, pallet template, A4 sheet, dup template, calendar, create error)                                      | 16               | 14     | 2      | 0                |
| Work (wait, awaiting, printing, confirmed, duplicate + flash, error + flash, many, step error, agg, pallets ×3, leave)                                                                   | 17               | 12     | 5      | 0                |
| Exceptions (actions, clear, disassemble ×5 incl. reason lists, reprint ×2, pallet ×3), close (box, validation, pallet), unit history                                                     | 16               | 12     | 4      | 0                |
| Queue (empty, full, confirm, offline)                                                                                                                                                    | 4                | 4      | 0      | 0                |
| Warehouse (start, reason, templates, started, found, again, again-reason, offline, manual, not found, finish, unit, pallet)                                                              | 13               | 13     | 0      | 0                |
| Workstation setup (printers empty/filled/form/error, scanner, check, sound, scanners scope, unpair dialog)                                                                               | 9                | 3      | 5      | 1                |
| **Total**                                                                                                                                                                                | **111**          | **78** | **30** | **3**            |

Counts are per screen/state (both themes and all sizes agree). Final automated run of the work screens after the last
fix: 44 shots, 0 findings; the other groups' last full run had only the items listed under «known limitation».

## Defects found and fixed

| Defect                                                                                                                     | Where                                                               | Fix                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Link dot showed the browser's two-tone `outset` frame (no border style); 52 px target                                      | status bar                                                          | 64 px, `1px solid transparent` frame beating the kit's `!important`                                                              |
| Link popover anchored at its right edge ran off the window's left                                                          | status bar                                                          | anchored at the dot's left, `max-width` within the window                                                                        |
| Operator name cut to «Анна Кузн…» by the scanner chip's words                                                              | status bar                                                          | the neutral scanner chip keeps only its dot under 1300 px (warn/error chips never collapse)                                      |
| Window-mode error box shrank to 230 px and overlapped its «Закрыть»                                                        | rail                                                                | `width: max-content`, kit radius and 2 px `err` border                                                                           |
| Field focus (`mk-input`) had no ring (the control is outline-less)                                                         | all floor fields                                                    | kit 3 px ring on `:focus-within`                                                                                                 |
| Shared tags written at 12 px / 22 px (host line, status chips, scan history, hub card)                                     | floor-wide                                                          | `.mk-tag--office` lifted to the floor size (34 px / 16 px) inside the floor roots; hub card and history chips ask `size="floor"` |
| Hub cards stretched to 500 px with a full-height photo strip, 13 px facts                                                  | hub                                                                 | content-height cards, square 120 px photo, 16 px facts, pill tags                                                                |
| Calendar days/arrows 32 px                                                                                                 | new shift                                                           | popover is outside the frame: `body:has(.floor-frame)` rules, 64 px days and arrows, 7×64 px grid                                |
| Exception cards fainter than every other button (`--line` border `!important`), 2-px blue/red ring on the typed-tail field | exceptions                                                          | kit `line2` border, kit radius, field uses the kit's active 2 px `fg` border                                                     |
| Shift close card had a shadow on light only                                                                                | close                                                               | flat                                                                                                                             |
| Two-line sign-in refusals clipped (fixed 64 px row + `overflow: hidden`); 14 px badge help                                 | sign-in                                                             | row grows (`minmax(64px, auto)`), 18 px floor body                                                                               |
| Setup tabs: «Проверка сканера» cut in a quarter of 780 px, 64 px row cut the track, non-kit selected look                  | setup                                                               | kit segmented control: `fit-content` track, `fg` fill selected tab, no fixed row                                                 |
| Scanner-check kind: a second blue outline on the selected button (looked like focus)                                       | setup                                                               | outline removed, kit selected look only                                                                                          |
| Band chips squeezed the counterparty to «для: …»                                                                           | work                                                                | chips wrap                                                                                                                       |
| Hero code and line cut at 1280×800                                                                                         | work                                                                | smaller hero and line heights under 900 px height                                                                                |
| Dead per-product accent code (`useProductAccent`, `data-accent`, `photo-accent.ts`, `hueFromGtin`)                         | hub, new shift                                                      | removed (nothing paints from it)                                                                                                 |
| Guard regex `(^                                                                                                            | \})\s*([^{}@]+)\{` never saw the first rule inside an at-rule block | `floor-kit.test.ts`                                                                                                              | small CSS tokenizer (`test/support/css-rules.ts`); every rule of floor-kit.css incl. `@media` checked; `:root` block pinned by name |

Reconciled `!important` fights: exception-flow (`border-color`, `border-radius`, active field), shift-close (card), hub (calendar,
status-bar dot) now agree with floor-kit.css. The remaining `!important` in those files are on properties the shared
`Button`/`Input`/`PinPad` write inline (unchanged reason) or are danger-specific by design.

## Contrast: problem pairs

The computed-style check found no pair under the threshold after the fixes. Items it surfaced during the pass were all
sizing or structure, not colour: no text/background pair measured under 4.5:1 (3:1 large) in either theme; disabled controls
(`dis` on `panel`) are excluded by WCAG and by the kit (see `packages/ui/test/contrast.test.ts`).

| Pair                                | Where                      | Ratio     | Verdict |
| ----------------------------------- | -------------------------- | --------- | ------- |
| `fg` on band gradient (`brand1..3`) | work band                  | ≥ 13      | ok      |
| `warn-fg` on `warn-bg`              | alerts, chips              | ≥ 4.5     | ok      |
| `onerr` on `err`                    | danger button, both themes | 7.6 / 5.6 | ok      |
| `muted` on `panel` (steps, history) | work                       | ≥ 4.5     | ok      |

## Tests

New/extended: `floor-kit.test.ts` (strict scope guard, tokenizer, `:root` pin), `floor-station-audit.test.ts` (18 contracts, one per
fix), `floor-product-photo-path.test.tsx` (no accent attribute or hue variable). Existing assertions were not weakened; the
removed accent test (`dominantAccent`) went with its code.

## Known limitations / open items

1. Setup «Звук» panel: the card is mostly empty around one row of controls (layout is old, not a defect of the kit); redesign with the office rollout.
2. Brand mark under 1024×768 in the sign-in header is clipped to its mark («маркиро» word shortened by the equal-column header) — by design for the narrow layout.
3. Status bar chips collapse by priority under 1300 px (words go to the tooltip); the long-name «Анна Кузнецова» still ellipsises beside the warning chips at 1280 px when the low-SSCC and unsent chips are both on. The full text is the tooltip.
4. Long counterparty line on a hub card is clamped to one line (title attribute holds the full name).
5. Scan history rows in the 1280×800 box layout are an inner scroll region (intentional, keyboard reachable); its `ul` is reported by the 64 px check only as a scrollable list.
6. The calendar's popover sits at the page origin in the static capture (portal positioning needs the real layout engine); its size and tap targets were checked, its placement was not.
7. `.mk-data-tabs` / `mk-select` / `Reconfirm` markup comes from `packages/ui`; their rollout to the office is the next step.
8. Not captured: the real update install dialog (`UpdateFromHostDialog`), the kiosk exit when the OS taskbar is visible, loading spinners (animations are frozen in the harness).

## Terminal checklist (BEETLE, WebView2) — owner ticks

- [ ] `:has()` rules apply: the work screen does not scroll (page), the hub photo/card layout and the date popover take the touch sizes.
- [ ] `color-mix()` surfaces (band chips, tints) are drawn, not transparent.
- [ ] `100dvh` fills the window exactly in the kiosk window, also when the OS taskbar is shown (no page scroll, footer on screen).
- [ ] `content: "✓" / ""` marks appear on selected buttons and switches (and are not read twice by a reader).
- [ ] Windows font rendering: IBM Plex Sans / Mono Cyrillic crisp at 16–20 px; mono digits in the work counters not blurred.
- [ ] Touch: every control reacts to a finger without hover; press scale (0.97) not sticky; the 64 px dot and rail buttons are hit reliably.
- [ ] Scanner: wedge scan on sign-in, in the work (Data Matrix with GS), in the exceptions' SSCC search; the keypad ignores a scan's digits.
- [ ] Printers: ZPL/TSPL label, A4 driver sheet; the duplicate step reads «Проверка этикетки» correctly; test prints from the setup.
- [ ] Theme: dark and light both on the terminal; «Системная» follows Windows; no flash of the wrong theme at start (`theme-init.js` under the Tauri CSP).
- [ ] Kiosk window: exit asks for the badge / tabel+PIN; the error box «Не удалось выйти…» is readable; window mode glyph clear.
- [ ] Sound: «Проверить звук» audible at each level.
- [ ] License banners and update offer alerts at a real width (the status bar stays one row).
- [ ] Calendar popover opens beside its field, within the window.
