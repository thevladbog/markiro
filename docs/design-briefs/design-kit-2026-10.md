# Markiro design kit — October 2026

Status: proposal for owner approval. Nothing in product code changes in this task.
Source of truth for the drawings: `docs/design-briefs/check_with_reprint.pen`, boards
`Kit · Компоненты (определения)`, `Kit · Основы`, `Kit · Кнопки и поля`,
`Kit · Обратная связь`, `Kit · Навигация`, `Kit · Данные`, `Kit · Экраны`
(each in light and dark). PNG exports: `~/Downloads/markiro-design-kit/`.

Direction (taken from the three approved station redraws): calm, high-contrast
industrial touch UI; warm near-black and warm off-white themes; the primary action is
a large solid button filled with `fg` (inverts per theme); a selected state is a `fg`
fill plus a check icon or a text state, never colour alone; generous radii; the
"one layer" rule (see §3): no container inside a container for decoration;
hairlines instead of shadows; one gradient only (the product card). Fonts: IBM Plex Sans and IBM Plex Mono (bundled), icons Phosphor
light (weight 300). One system for three surfaces: station floor, standalone office,
SaaS admin.

## 1. Tokens

Names are the .pen variables. Values for light and dark are exact. `*` = added by this
kit (existing document variables `bg surface panel fg muted line ok okbg warn warnbg
err errbg` are unchanged). Contrast column: light / dark.

| Token                                                                                                                                                                                | Role                                                                            | Dark      | Light     | Contrast                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------- | --------- | ------------------------------------- |
| `bg`                                                                                                                                                                                 | Фон экрана/страницы                                                             | `#131216` | `#FAFAF8` | —                                     |
| `surface`                                                                                                                                                                            | Карточка L1                                                                     | `#1C1B21` | `#FFFFFF` | —                                     |
| `panel`                                                                                                                                                                              | Функциональные вставки: трек сегмента, выбранная строка, клавиши, шапка таблицы | `#232228` | `#F0EFEA` | —                                     |
| `fg`                                                                                                                                                                                 | Основной текст; заливка primary-кнопки и выбранного                             | `#FAFAF8` | `#17161A` | 18.01 / 16.36 on `surface`            |
| `muted`                                                                                                                                                                              | Вторичный текст                                                                 | `#B6B3AB` | `#45433E` | 9.88 / 8.16 on `surface`              |
| `muted2` *                                                                                                                                                                           | Подписи, подсказки, плейсхолдеры                                                | `#8E8B83` | `#6B6862` | 5.55 / 5.02 on `surface`              |
| `dis` *                                                                                                                                                                              | Disabled (вне AA по WCAG 1.4.3)                                                 | `#5B5952` | `#A5A29A` | 2.55 / 2.44 (исключён)                |
| `line`                                                                                                                                                                               | Hairline, разделители                                                           | `#2E2D33` | `#E0DED7` | —                                     |
| `line2` *                                                                                                                                                                            | Граница кнопок и карточек                                                       | `#45444B` | `#C9C6BD` | —                                     |
| `linectl` *                                                                                                                                                                          | NEW: граница полей, чекбоксов, радио (UI 3:1)                                   | `#6F6D76` | `#8A877F` | 3.59 / 3.36 on `surface` (UI)         |
| `ok`                                                                                                                                                                                 | Успех, принято, активно                                                         | `#3DDC7A` | `#116335` | 6.57 / 8.15 on `okbg`                 |
| `okbg`                                                                                                                                                                               | Фон ok                                                                          | `#142E1D` | `#E7F6EC` | —                                     |
| `warn`                                                                                                                                                                               | Дубль, внимание                                                                 | `#FFB84D` | `#8A4C07` | 5.99 / 8.65 on `warnbg`               |
| `warnbg`                                                                                                                                                                             | Фон warn                                                                        | `#33250E` | `#FDF0DC` | —                                     |
| `err`                                                                                                                                                                                | Ошибка, брак, опасное действие                                                  | `#FF6B5E` | `#A1231A` | 6.53 / 5.64 on `errbg`                |
| `errbg`                                                                                                                                                                              | Фон err                                                                         | `#391A16` | `#FDEAE7` | —                                     |
| `info` *                                                                                                                                                                             | Синхронизация, план, справка                                                    | `#6DB2FF` | `#1A4F9C` | 6.84 / 6.78 on `infobg`               |
| `infobg` *                                                                                                                                                                           | Фон info                                                                        | `#152740` | `#E5EFFC` | —                                     |
| `done` *                                                                                                                                                                             | Завершено штатно                                                                | `#9CC2A9` | `#3F5E4A` | 6.37 / 8.07 on `donebg`               |
| `donebg` *                                                                                                                                                                           | Фон done                                                                        | `#1A251D` | `#EDF2EE` | —                                     |
| `accent` *                                                                                                                                                                           | Бренд-зелёный: свечение успеха, заливки (не текст)                              | `#3DDC7A` | `#0FAF56` | 2.76 / 10.41 on `bg` (только заливка) |
| `accentui` *                                                                                                                                                                         | NEW: индикатор вкладки, UI-акцент на bg (3:1)                                   | `#3DDC7A` | `#0B9448` | 3.93 / 9.54 on `surface` (UI)         |
| `focus` *                                                                                                                                                                            | Кольцо фокуса                                                                   | `#6DB2FF` | `#1A4F9C` | 7.95 / 7.70 on `surface` (UI)         |
| `onerr` *                                                                                                                                                                            | NEW: текст на сплошном err                                                      | `#391A16` | `#FFFFFF` | 7.58 / 5.64 on `err`                  |
| `violet` *                                                                                                                                                                           | Категория 1                                                                     | `#B3A0E0` | `#563091` | 8.09 / 6.93 on `violetbg`             |
| `violetbg` *                                                                                                                                                                         | Фон категории 1                                                                 | `#241C3A` | `#F1EBFB` | —                                     |
| `teal` *                                                                                                                                                                             | Категория 2                                                                     | `#79C4CB` | `#0E5B63` | 6.82 / 7.51 on `tealbg`               |
| `tealbg` *                                                                                                                                                                           | Фон категории 2                                                                 | `#0F2B2F` | `#E2F3F5` | —                                     |
| `magenta` *                                                                                                                                                                          | Категория 3                                                                     | `#E094BA` | `#8E2A63` | 6.78 / 7.06 on `magentabg`            |
| `magentabg` *                                                                                                                                                                        | Фон категории 3                                                                 | `#32172A` | `#FBE9F3` | —                                     |
| `steel` *                                                                                                                                                                            | Категория 4                                                                     | `#A9B3C4` | `#3F4756` | 7.97 / 7.59 on `steelbg`              |
| `steelbg` *                                                                                                                                                                          | Фон категории 4                                                                 | `#1F212A` | `#EBEDF1` | —                                     |
| `brand1` *                                                                                                                                                                           | NEW (light): карточка товара, градиент 1 (в dark = прежний #4e1d27)             | `#4E1D27` | `#F3D5DB` | —                                     |
| `brand2` *                                                                                                                                                                           | Градиент 2 (dark #281015)                                                       | `#281015` | `#F8E4E8` | —                                     |
| `brand3` *                                                                                                                                                                           | Градиент 3 (dark #15090C)                                                       | `#15090C` | `#FCF1F3` | —                                     |
| `brandline` *                                                                                                                                                                        | NEW: рамка карточки товара                                                      | `#5A2A34` | `#E3B8C0` | —                                     |
| Number and string variables added: `r-card` (now 24), `r-ctl` 20, `r-sm` 12 (`r-core` 20 stays in the .pen but is unused after the one-layer revision and is not carried into code), |
| `font-ui` IBM Plex Sans, `font-mono` IBM Plex Mono.                                                                                                                                  |

### 1.1 WCAG contrast (computed in code, WCAG 2.x relative luminance)

Text pairs need 4.5:1; UI pairs (focus ring, input borders, tab indicator) 3:1.

| Pair                                                         | Target | Light      | Dark       |
| ------------------------------------------------------------ | ------ | ---------- | ---------- |
| `fg` on `bg`                                                 | 4.5    | 17.23 pass | 17.85 pass |
| `fg` on `surface`                                            | 4.5    | 18.01 pass | 16.36 pass |
| `fg` on `panel`                                              | 4.5    | 15.64 pass | 15.10 pass |
| `muted` on `bg`                                              | 4.5    | 9.45 pass  | 8.90 pass  |
| `muted` on `surface`                                         | 4.5    | 9.88 pass  | 8.16 pass  |
| `muted` on `panel`                                           | 4.5    | 8.58 pass  | 7.53 pass  |
| `muted2` on `bg`                                             | 4.5    | 5.31 pass  | 5.48 pass  |
| `muted2` on `surface`                                        | 4.5    | 5.55 pass  | 5.02 pass  |
| `muted2` on `panel`                                          | 4.5    | 4.82 pass  | 4.64 pass  |
| `bg` on `fg`                                                 | 4.5    | 17.23 pass | 17.85 pass |
| `onerr` on `err`                                             | 4.5    | 7.58 pass  | 5.64 pass  |
| `fg` on `brand1`                                             | 4.5    | 13.16 pass | 13.14 pass |
| `ok` on `okbg`                                               | 4.5    | 6.57 pass  | 8.15 pass  |
| `warn` on `warnbg`                                           | 4.5    | 5.99 pass  | 8.65 pass  |
| `err` on `errbg`                                             | 4.5    | 6.53 pass  | 5.64 pass  |
| `info` on `infobg`                                           | 4.5    | 6.84 pass  | 6.78 pass  |
| `done` on `donebg`                                           | 4.5    | 6.37 pass  | 8.07 pass  |
| `violet` on `violetbg`                                       | 4.5    | 8.09 pass  | 6.93 pass  |
| `teal` on `tealbg`                                           | 4.5    | 6.82 pass  | 7.51 pass  |
| `magenta` on `magentabg`                                     | 4.5    | 6.78 pass  | 7.06 pass  |
| `steel` on `steelbg`                                         | 4.5    | 7.97 pass  | 7.59 pass  |
| `ok` on `surface`                                            | 4.5    | 7.34 pass  | 9.54 pass  |
| `err` on `surface`                                           | 4.5    | 7.58 pass  | 6.12 pass  |
| `focus` on `bg`                                              | 3      | 7.60 pass  | 8.41 pass  |
| `accent` on `bg`                                             | 3      | 2.76 FAIL  | 10.41 pass |
| `accentui` on `bg`                                           | 3      | 3.76 pass  | 10.41 pass |
| `line2` on `surface`                                         | 3      | 1.71 FAIL  | 1.78 FAIL  |
| `linectl` on `surface`                                       | 3      | 3.59 pass  | 3.36 pass  |
| `linectl` on `panel`                                         | 3      | 3.12 pass  | 3.10 pass  |
| Pairs below AA in the current system and the fixes proposed: |

1. `accent` `#0FAF56` on `bg` (light) is 2.76:1 — below 3:1 as an active-tab
   indicator. Fix: new token `accentui` = `#0B9448` (3.76:1 on bg, 3.93 on surface,
   3.41 on panel). `accent` stays for fills and the success glow, never for text or
   a thin indicator on light. Dark is unchanged (`#3DDC7A`, 10.4:1).
2. `line2` (the border of fields) is 1.71 / 1.78:1 on `surface` — fails 1.4.11 for
   input boundaries. Fix: new token `linectl` = `#8A877F` light (3.59 on surface)
   and `#6F6D76` dark (3.36 on surface, 3.10 on panel). `line` and `line2` remain
   decorative (hairlines, card borders, button outlines that carry a text label).
3. `dis` is intentionally outside AA (disabled controls are exempt); state is
   also carried by the missing hover/press and the `disabled` attribute.
4. Light solid `err` needs a white label (`onerr`), dark solid `err` a dark label:
   7.58 / 5.64:1.
5. `muted2` on `panel` is 4.82 light / 4.64 dark — passes but with little margin;
   do not lighten it further.

## 2. Type scale

Only Plex Sans and Plex Mono. All numbers, counters and codes are Plex Mono
(tabular). Floor minimum 18 px, office minimum 12 px.

| Role                             | Floor (touch)                  | Office (desktop)                |
| -------------------------------- | ------------------------------ | ------------------------------- |
| Counter XL / Counter / Counter S | Mono 600, 96/100, 64/68, 48/52 | Mono 600 28–44 (KPI)            |
| Display / Title                  | Sans 700 32/38 (was 28)        | Display 700 32/38, H1 700 28/34 |
| Heading                          | Sans 600 24/30 (was 22)        | H2 600 20/26, H3 600 16/22      |
| Body strong                      | Sans 600 20/28 (was 18)        | Body L 400 16/24                |
| Body                             | Sans 400 18/26                 | Body 400 14/20, Body S 13/18    |
| Caption                          | not used below 18              | Caption 500 12/16               |
| Code / meta                      | Mono 400 18/26                 | Mono 400 13/18, 12/16           |

## 3. Spacing, radii, levels (one layer)

- Spacing: 4 8 12 16 20 24 32 40 48 64. Floor: gaps between touch targets at least
  12, card padding 24–32. Office: 8 / 12 / 16.
- Radii: 12 (chips, small), 16 (office 44 px controls), 18–20 (photo, floor 64 controls),
  22 (floor 64 pill-ish), 24 (L1 cards, floor 84 buttons), 999 (chips, switch).
- Levels ("one layer" rule): **L0** page `bg`; **L1** card or panel — `surface` +
  1 px `line` hairline, radius 20–24, content padding inside the card itself, no outer
  "shell"; **L2** overlay (modal, drawer, menu, toast) — the only place for a soft shadow
  `0 8 24 rgba(0,0,0,.28)`. A container inside a container just for decoration is
  forbidden. Sections inside a card are separated by hairline dividers or spacing. A
  tinted `panel` fill is allowed only for functional insets: segmented-control track,
  selected row, keypad key faces, code chips, table header. A state fill (`okbg`,
  `errbg`...) is the card's own fill, not a second backing.
- Photo: ONE rounded frame (radius 18–20, neutral fill, 1 px hairline, contain-fit image).
- Keypad: keys directly on one flat `surface` panel; readout is a plain bordered field,
  2 px `fg` border only while it is the active field.
- The product card is the only gradient (`brand1 → brand2 → brand3`, dark
  `#4e1d27 → #281015 → #15090c`; light a soft rose tint
  `#F3D5DB → #F8E4E8 → #FCF1F3`, border `brandline`), one layer: the photo sits directly
  on the card with its own hairline; facts have no frames. Text uses `fg`.

## 4. Components

Reusable components in the .pen (instances via `ref`, theme-aware through variables):
`Button`, `Chip`, `Switch`, `Field`, `NavItem`, `Tab`, `Alert` (with a nested
`Button`). Everything else is composed from these inside the boards.

| Component                                | Variants                                                             | Sizes                                                                         | States                                                                                                                                    | Notes                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Button                                   | primary (`fg`), secondary (`surface`+`line2`), danger (`err`), ghost | floor 84 (r28, 22 px label) and 64 (r22, 20 px); office 44 (r16) and 36 (r12) | default, pressed (scale 0.97, 150 ms), focus (3 px `focus` ring outside), disabled (`panel`, `dis`), loading (spinner, label "Загрузка…") | label is always text; icon optional                                                                             |
| Segmented                                | 2–4 options                                                          | floor 64, office 36                                                           | selected = `fg` fill + check + weight 600                                                                                                 |                                                                                                                 |
| Switch / switch card                     | on, off                                                              | 56×32                                                                         | on shows a check inside the knob                                                                                                          | switch card is ONE L1 card; selected = 2 px `fg` border + the switch + the word «Включено»                      |
| Text / number / date / select field      | label, hint, error, read-only, disabled                              | office 44 (r16), floor 64 (r22)                                               | focus, error (2 px `err` border, "Ошибка ·" prefix, icon)                                                                                 | border uses `linectl`                                                                                           |
| Search                                   | pill                                                                 | 44                                                                            |                                                                                                                                           |                                                                                                                 |
| Checkbox / radio                         |                                                                      | 28 box, 44 row target (office), 64 (floor)                                    | checked = fill + check/dot, disabled, error                                                                                               |                                                                                                                 |
| Keypad + readout                         | 3×4                                                                  | key 76–96 high                                                                | pressed                                                                                                                                   | keys (`panel` faces) on one flat `surface` panel; readout is a plain bordered field, 2 px `fg` only when active |
| Alert                                    | info, ok, warn, err                                                  | width fill                                                                    | optional action                                                                                                                           | icon on the first text line; action sits right with a 14 px gap; banner variant for licence/trial               |
| Toast                                    | ok, err, info                                                        | 520                                                                           |                                                                                                                                           | overlay shadow; errors do not auto-close                                                                        |
| Chip / phase tag                         | 11 phases + 4 category tones                                         | office 22, floor 34, wall 40                                                  |                                                                                                                                           | glyph and tone derive from the phase only (see §6)                                                              |
| Empty state, skeleton                    |                                                                      |                                                                               |                                                                                                                                           | static skeleton (no shimmer under reduced motion)                                                               |
| Confirm dialog, modal, drawer            |                                                                      | modal 560, drawer 520–720                                                     |                                                                                                                                           | L2: single surface + shadow; focus trap; Esc                                                                    |
| Sidebar                                  | expanded 272, collapsed 76                                           | item 44 / 52                                                                  | active = `fg` fill, inverse text, weight 600                                                                                              | ONE item style; group labels 11 px caps                                                                         |
| Tabs                                     |                                                                      |                                                                               | active = bold + single 3 px `accentui` bar; focus = 3 px ring                                                                             | no text underline anywhere                                                                                      |
| Breadcrumbs, page header, theme selector |                                                                      |                                                                               |                                                                                                                                           | selector: Системная (default) · Светлая · Тёмная, selected carries a check                                      |
| SaaS rail                                | numbered items 01–10                                                 | 44                                                                            | active = `fg` fill                                                                                                                        | numbers are Plex Mono                                                                                           |
| Table                                    | header 44, row 56 (dense 44)                                         |                                                                               | selected row: checkbox + `panel` fill + 4 px `fg` bar + weight 600; empty / loading / error                                               | row actions 36                                                                                                  |
| Pagination                               | page size 10/25/50/100, default 10                                   | 44                                                                            | first/prev/next/last, disabled                                                                                                            | "Показано N–M из K"                                                                                             |
| Filters row                              | label above, hint below, aligned                                     | 44                                                                            |                                                                                                                                           |                                                                                                                 |
| Definition list, KPI, history row        |                                                                      |                                                                               |                                                                                                                                           | "Принято в смене" is the single large counter (Mono 600 96)                                                     |
| Photo square                             | any aspect                                                           | 132                                                                           |                                                                                                                                           | one rounded frame (r 18–20, hairline), image `contain`                                                          |

## 5. Accessibility rules

- Text contrast 4.5:1, large text and UI 3:1 (see §1.1). Do not introduce a pair
  that is not in the table without computing it.
- Focus: 3 px ring in `focus` outside the control with a 2 px gap on every
  interactive element; never `outline: none` without a replacement.
- State is never colour alone: selection has a fill plus check or word; errors have
  an icon and the word «Ошибка»; tags always have a glyph and a label.
- Targets: floor at least 64 px (primary 84), office at least 44 px, dense table
  actions 36 px; keep 12 px between floor targets. The production-browser contract
  (every interactive floor element ≥ 64 px) stays.
- No scrolling on the 1280×1024 and 1280×800 floor screens.
- Screen readers: toasts `role=status` (errors `alert`), dialogs `aria-modal`,
  collapsed sidebar items keep `aria-label`, tabs follow the roving tabindex pattern.

## 6. Motion rules

Motion exists only as press feedback: scale 0.97, 150 ms, `cubic-bezier(0.32, 0.72, 0, 1)`.
Office hover/focus highlight 140 ms without movement. Drawers and modals may fade in
(140 ms). Under `prefers-reduced-motion` everything is instant and the press state is
shown by fill/icon only. Forbidden: parallax, springs, auto-scroll, flashing above 3 Hz.

Phase tags (unchanged rule, PR #610): glyph and tone come only from the phase —
draft ✎ neutral, planned ◷ info, active ▸ ok, running ⟳ info, done ✓ done,
attention ! warn, duplicate ⧉ warn, failed ✕ err, retired ✕ neutral, dismantled ⊘
neutral, none · neutral. Grey is allowed in exactly four phases. Categories use
violet → teal → magenta → steel in order.

## 7. Do / Don't

Do: use `fg` fill for the one primary action per screen; show selected = fill + check;
keep one layer per container; keep numbers in Plex Mono; use variables only.
Don't: nest a container in a container for decoration (double backing); add shadows to cards; use `accent` for text or thin lines on light; colour a
tag by taste (derive from phase); underline tab text; put a dpi column in template
lists; hard-code hex in new components; use more than one large counter per screen.

## 8. Migration map (packages/ui and station `--floor-*`)

### Stays

- Colour semantics and values of: `--surface-page/card/panel` (= `bg/surface/panel`),
  `--fg-1/2` (= `fg/muted`), `--line`, all `--ok-* --err-* --warn-* --info-*` text and
  bg values, `--done-*`, `--cat-*`, `--focus-ring`, the dark theme values.
- IBM Plex stack and the font files, the office type ramp, the 4 px spacing grid,
  Phosphor-style outlined icons, `StatusChip` phase vocabulary, `Badge` for categories.
- Component APIs of `Alert`, `Modal`, `Drawer`, `Table`, `Pager`, `Field`,
  `StatusChip`, `FilterBar`, `DefinitionGrid`, `EmptyState`, `Toast` (visual restyle
  only).

### Changes

- `--surface-inverse`/`--fg-1` become the primary-button fill (`fg`): the current
  primary is `--ink`; value is the same, the role name changes to `fg`.
- Radii: `--r-1..3` (4/8/12) → 12/16/20/24; office controls `--control-md` 40 → 44,
  `--control-sm` 32 → 36; `--mk-radius-operational: 2px` is dropped.
- `--control-floor` 64 stays; add `--control-floor-primary` 84.
- `--fg-3` becomes `muted2`; `--line-strong` keeps its value but is renamed `line2`
  and no longer used for field borders (new `linectl`).
- Floor type: `--floor-title` 28 → 32, `--floor-lg` 22 → 24, `--floor-body-strong`
  18 → 20; `--floor-body` 18, `--floor-counter*` unchanged.
- Shadows: `--shadow-1/2` removed from cards; `--shadow-3` kept for overlays only
  (value `0 8 24 rgba(0,0,0,.28)`).
- Tabs (`DataTabs`): remove text underline; add the `accentui` indicator.
- Sidebar (`Sidebar`, `OperationalRail`): `--mk-rail-*` dark rail replaced by themed
  `surface` panel; one item style, active = `fg` fill. SaaS rail gets numbering.
- Sidebar active/selected states in tables, segments and radio cards gain a check.
- Alert: icon on first line, action aligned with a gap; banner variant added.

### New

- Tokens: `muted2`(alias), `linectl`, `accentui`, `onerr`, `brand1..3`, `brandline`,
  `r-card` 24, `r-ctl`, `r-sm`, motion tokens (`press-scale`, `press-ms`, `ease`).
- Components: switch card (single L1), flat keypad + readout, theme selector, photo
  square, banner, numbered rail, selected-row marker. No bezel/shell container.
- Light-theme counterpart of the product-card gradient.

### Removed

- Hard-coded gradient/stroke hexes on the product card (`#4e1d27…`, `#5a2a34`).
- `--mk-surface-*`, `--mk-border-*`, `--mk-accent-operational` aliases once nothing
  imports them; `--mk-radius-operational`; dpi column in template lists (already out
  of product); text-only tab underline.

## 9. Adoption plan

1. Tokens (packages/ui `tokens.css`): add new variables, keep old names as aliases for
   one release; update `theme.tsx`. Risk: low. Tests: `packages/ui` render tests, a
   contrast unit test fed from the table in §1.1.
2. Shared components (`Button`, `Field/Input`, `Checkbox/Radio`, `Alert`,
   `StatusChip`, `Tabs`, `Table`, `Pager`, `Modal/Drawer`, `Toast`): restyle behind the
   same props. Risk: office layout shifts from 40 → 44 px; snapshot churn in admin,
   standalone and saas-admin component tests.
3. Station: floor tokens, 84 px primary, flat L1 containers (remove the photo and keypad shells), light theme (the station
   is dark-only today; light needs the theme switch and kiosk-mode review). Risk:
   the production-browser touch-target contract and no-scroll check at 1280×800 /
   1280×1024; update `tools/production-browser` station specs and README screenshots.
4. Standalone office: sidebar, header (theme selector), tables, drawers. Risk: the
   `apps/standalone` webview shares components with the station; run the standalone
   Vitest suite and Windows manual checks.
5. SaaS admin: numbered rail, definition-list layouts, offers/reports specs
   (`tools/production-browser/*-tests` assert UI behaviour). Risk: platform auth
   boundary is untouched; spec churn only.

Cross-cutting test impact: `pnpm --filter @markiro/ui test`, admin, kiosk, station,
saas-admin, standalone component tests; `pnpm test:production-bundle:contract`;
`pnpm test:production-docs:browser`; visual confirmation in a browser and on the
Windows station is separate from automated checks.

## 10. Open design decisions

See the report that accompanied this document: light theme on the station, floor
title 32, 84 px primary, flat single-layer containers (confirmed by the owner), radii for dense office controls, selected sidebar item = `fg`
fill, rail numbering in the office, tinted light product-card gradient, `accentui`,
`linectl`, reduced-motion press state, and category tone order.

## 11. What we dropped and why

Dropped: the nested "double bezel" (outer `surface` shell + hairline, inner `panel` core,
8 px gap) and the `r-core` radius that existed only for it.
Why: the owner does not like the style, and it was decorative — it doubled borders, wasted
8–14 px per edge on the 1280×800 floor screens and made radii dependent on a padding
(shell = core + gap). One layer is simpler to build, to theme and to test.
What replaced it: L0/L1/L2 levels (§3). Photo = one framed square; keypad = keys on one
flat panel with a bordered readout; product card = one gradient layer; switch card = one
card with a 2 px `fg` border when on; toasts, dialogs and KPI use the state fill as the
card's own fill. `panel` tint stays only for functional insets (segmented track,
selected row, key faces, table header, code chips).
Legibility checks: keypad keys now sit on `surface`, so they keep a `panel` face and a
hairline (dark: `panel` #232228 on `surface` #1C1B21 is a quiet step, the hairline carries
the key boundary); the photo on the brand card keeps its own 1 px `line` border so the
neutral photo background does not merge with the rose/dark gradient.

## 12. Накатка кита · шаг A (станция: основа)

Done on branch `claude/kit-station-foundation` (nothing pushed). Foundation only; the
individual floor screens (new shift, work screen, hub cards, close, warehouse, setup) are
restyled by the next steps.

What was done:

- `packages/ui/src/tokens.css`, additive: `--muted2 --line2 --linectl --accentui --onerr
--brand1..3 --brandline` with the kit §1 light and dark values; kit-named aliases of the
  existing semantic tokens (`--bg --surface --panel --fg --muted --dis --ok/okbg --warn/warnbg
--err/errbg --info/infobg --done/donebg --focus --violet.. --steel..`), declared in both theme
  blocks; `--r-sm 12 --r-ctl 20 --r-card 24`; `--shadow-overlay`; `--control-floor-primary 84`;
  `--press-scale 0.97 --press-ms 150ms --ease`. No existing name changed; `--panel` is now
  theme-aware (it was light-only, and unused). Other apps and the cloud station do not change.
- `packages/ui/test/contrast.test.ts`: WCAG ratios computed from the values in `tokens.css`
  for both themes (every §1.1 pair; text 4.5, UI 3, incl. `accentui`, `linectl`); the known
  failures (`line2`, `dis`) are asserted as exclusions. `PinPad` gets a `mk-pinpad` /
  `mk-pinpad--floor` class (no visual change outside the standalone floor).
- `apps/standalone/src/floor/floor-kit.css` (new, imported last by `main.tsx`): floor type scale
  (title 32, heading 24, body-strong 20, body 18; counters unchanged), radii (controls 22, primary
  24, cards 24), press feedback (scale 0.97 / 150 ms; under reduced motion no scale and the press
  shows as a fill), 3 px focus ring with a 2 px gap, buttons (secondary `line2`, danger solid
  `err` + `onerr`, disabled `panel` + `dis`, selected `[aria-pressed=true]` = `fg` fill + check),
  opt-in `floor-primary` class (84 px), `floor-segmented` and `floor-switch` primitives, flat L1
  card, fields (`linectl` border, 2 px `err` error, `panel` disabled), round floor tags, Alert
  (glyph on the first text line, 14 px gap to the action, floor type), flat keypad (`panel` faces +
  hairline, 72 px and up). All rules sit under `:where(.floor-frame, .station-screen)`; the office
  and `.standalone-screen` pre-floor screens are untouched.
- Themes: `index.html` no longer forces `data-theme="dark"`; `public/theme-init.js` (external, so
  the Tauri CSP `script-src 'self'` needs no exception) sets `data-theme` from `markiro.theme` or
  the OS before first paint; `ThemeProvider` (default `system`) takes over. `StationBrand` follows
  the theme (it was invisible on light).
- Hard-coded colours removed from the floor: product-card gradients `#2c2b31 #1d1c21 #141317` and
  the `hsl(var(--product-hue)…)` per-product gradients (work band, hub card photo) -> `brand1..3`
  - `brandline` (the per-product hue no longer paints the card; `useProductAccent` and the
    `data-accent` attribute stay for later use); `#fff` and `rgb(255 255 255 / n%)` text and tints on
    the band -> `fg`, `muted`, `color-mix(fg …)`; filled box cell label `#fff` -> `fg-on-ok-solid`
    (white on `ok-solid` was 2.7:1 on light); `rgb(250 250 248 / 70%)` monograms -> `muted`;
    `hsl(… 14%)` photo tile -> `panel` + hairline; overlay shadows (`0 16px 48px …`, `0 18px 48px …`,
    `0 12px 32px …`) -> `--shadow-overlay`; photo shadows (box-shadow, drop-shadow) dropped.
- Kept on purpose, named as a literal-colour block in `floor-kit.css` `:root`: the physical sheet
  and its ink (`--floor-paper #fff`, `--floor-paper-ink`, `--floor-scan-ink`, `--floor-paper-ok/warn/err`)
  used by the label previews and the scanner self-test symbol (a scanner reads dark on white in
  either theme). A Vitest guard fails on any other literal colour in `src/floor/**/*.css`.

Deviations and notes for the next steps:

- Button, Input, Alert and PinPad style themselves inline, so the floor overrides use
  `!important` on exactly those properties until step 2 moves them to classes.
- The 84 px primary is opt-in (`className="floor-primary"`): the screens' footers are 72 px and a
  blanket 84 would break their no-scroll layouts. The NewShift/work-screen steps must give the
  footer 84 px and add the class.
- Radii: task text says 20–24; kit §4 says r28 for the 84 button. Used 22 / 24.
- Floor tag font 16 px (was 15); the kit's 18 px minimum would need wider tags on the hub card.
- Not wired into any screen: `floor-segmented`, `floor-switch` (the new shift's mode and pallet
  switch still use aria-pressed buttons, which get the selected look generically), the keypad
  panel shell (keys only; no outer panel added), and the readout's active 2 px `fg` border.
- Screens still carry their own old layout (hub card 2-column, new shift single column in the
  harness shots); the approved frames are for the next executors.
- Verified: Vitest (ui 327, standalone 7382 + admin 1703, kiosk 673, station 2247, saas-admin 644,
  signer 49), tsc in all of them, eslint in ui and standalone, `deploy/production` contract tests
  (580). The `tools/production-browser` station specs target the cloud station and do not load the
  standalone floor; they were not run. Not verified: Windows/WebView2 (`:has()`, `color-mix`,
  `content: "✓" / ""`), the Tauri CSP with `theme-init.js`, a real kiosk-mode session, hardware.

## 13. Накатка кита · шаг B (станция: «Новая смена», параметры)

Done on branch `claude/kit-newshift` (from `claude/integration`, nothing pushed). Only the details
step of the new shift (`NewShift.tsx`); the template-choice step and the pallet A4 sheet step keep their
flow and take the kit through the classes of step A. The work screen, the status bar and the other
floor screens are not touched. `floor-kit.css` is not edited: the new controls live in
`apps/standalone/src/floor/kit/` (components and `floor-controls.css`, scoped like the rest of the kit).

What was done:

- One layer (§3): the photo is ONE frame (`PhotoSquare`, radius 20, hairline, neutral fill
  `--floor-paper`) sitting directly on the product card, which is the kit's one gradient
  (`brand1 → brand3`, `brandline`; light = rose tint). The keypad is keys on the screen's one flat
  `surface` panel. No shell, no inner shell.
- The owner's photo bug: the old rule `.new-shift__product-photo .product-photo { max-height: 100% }` sat
  in a `display: grid` box with an automatic track, so the track grew to the picture's natural height and
  `overflow: hidden` cut the rest. Now the core is `position: relative` of a fixed size
  (`--floor-photo`: 208 px, 104 px on a short panel), the `<img>` is `position: absolute; inset: 0;
object-fit: contain; max-height: none`, and takes no part in the layout. Measured in Chromium with
  300x800 and 900x300 pictures: the image box equals the square (minus the 1 px frame) in both.
- Components (`src/floor/kit/`): `PhotoSquare` / `ProductPhotoSquare`; `ModeSegment` (a labelled
  `radiogroup`, two `radio` options at 64 px, check on the selected one, a polite one-line hint, roving
  tabindex, arrows); `SwitchCard` (one L1 card that is the `switch`: 2 px `fg` border when on, a check in
  the knob and the words «Включено / Выключено»); `NumericKeypad` (3x4, keys 72 px and up, buttons only,
  a tap does not take the focus); `NumericReadout` (a bordered field that is a button, not an input; 2 px
  `fg` border only while active; a thin-space grouping drawn by boxes, the text stays bare digits);
  `numeric-entry.ts` (`appendDigit`, `dropDigit`, `groupDigits`, `useKeyboardDigits`).
- NewShift: two zones in one grid (3fr / 2fr). Left: product card (name 28/34, two lines, GTIN, facts
  «В коробе: N шт.» and «Паллета: N коробов», no «Объём»), «Режим работы» with the owner's hints, ONE
  switch card (the duplicate in «Проверка»; «С паллетами» in «Агрегация» when the product has pallets;
  «Шаблон: …» when the duplicate is on and one template fits), the two dates. Right: the readout(s) and
  the keypad; «Агрегация» shows «В коробе, шт.» and «План, шт.» as two readouts and tapping one chooses
  the field the keypad edits. The keypad edits the form's own digit strings (`plannedQty`,
  `boxCapacity`); `plannedQtyRule`, `shiftBoxCapacityRule` and their messages are unchanged and judge at
  «Далее». Footer 84 px (primary `floor-primary`, twice as wide), on every step of the new shift.
- Keys of a physical keyboard (digits, Backspace, Delete = «Очистить») are heard on the keypad's area,
  not on the window. A wedge scanner is a keyboard too: a run of digits faster than 40 ms apart is a
  scan, so its digits are taken back, the rest dropped, and its closing Enter does not press the focused
  key. The NewShift screen starts no scan listener on this step (as before).
- No scroll at 1280x1024 and 1280x800 (dark and light). 800: screen padding and gap 12 px, readouts
  64 px each in aggregation, the product facts and the hint lines give way (hints also while a message is
  shown).

Deviations from the approved design and the kit, and why:

- The switch is 96x52 (84x44 on the short panel) as drawn in the approved frames, not the kit §4 56x32:
  the whole card is the target either way.
- Key digits are Plex Mono 500 (kit §2: numbers are mono); the frames draw them in Plex Sans.
- The segment is 64 px (kit §4), not the mock's 68.
- The readout is a `button` named by its label, value and unit (not a `spinbutton`), so tapping chooses the
  field. The mock's «Enter on the readout = Далее» is not implemented (Enter presses the button).
- The slot under the readouts shows ONE message: the active field's error (the keypad moves to the first
  wrong field on «Далее», the capacity first), else the hint. The other readout is marked
  `aria-invalid` and says its own message when tapped. Two simultaneous messages do not fit a fixed
  slot. The slot has an icon and the word «Ошибка ·» (kit §5).
- The keypad cannot type «0» as a first digit, so «0» and letters can no longer reach the rules from the
  screen; tests that fed «0»/«много» now feed an eight-digit plan (99 999 999) or a six-digit capacity.
- «Далее» with the duplicate on still goes to the duplicate template step even when one template fits
  (the line «Шаблон: …» is shown too): the check of the label is chosen there.
- The dates are still the `DatePicker` (calendar kept); only its trigger is restyled (`linectl` border,
  radius 22). The calendar tile of the frame is not drawn.
- The kit's four controls are native `<button>`s: ESLint's `no-restricted-syntax` is disabled in those four
  files with a reason, and `floor-controls.test.ts` allows raw buttons in `src/floor/kit` only (it pins
  the exact four files).
- The needs-link hint moved into the polite message region; the message sits under the left zone and the
  keypad panel spans its row, so a message never shortens the keys.

Verified: tsc, eslint, prettier; Vitest (new `floor-kit-controls` 25, `floor-new-shift-css` 12, 11 new
NewShift cases, 23 existing NewShift cases updated); the full `vitest run` of `apps/standalone`; Chromium
screenshots and measurements (below, `/tmp/claude/shots/kit-b/`). Not verified: WebView2 on Windows
(`:has()`, `color-mix`, `content: "✓" / ""` from step A), a touch screen or a real scanner, the real
status bar height (the harness stands in an 81 px bar), the `tools/production-browser` station specs
(they target the cloud station).

## 14. Накатка кита · шаг C (станция: рабочий экран и остальные экраны цеха)

Done on branch `claude/kit-work` (from `claude/integration`; nothing pushed). Design: the
approved work screen «Проверка с дублем» (`HVdQ6`), the data and alert boards of the kit.

What the work screen is now (`apps/standalone/src/floor/work/`, `unit-labels/`):

- Product strip (`ShiftBand`): the brand-gradient card, the product photo as one rounded
  104 px frame (contain-fit, never cropped; monogram without a photo), the name, chips (shift
  number, GTIN, mode: «Проверка с дубликатом» / «Проверка» / «Агрегация», the counterparty
  last, the one that shrinks), and the single counter «ПРИНЯТО В СМЕНЕ» (`.work-shift-band__count`,
  the only element of the screen that carries the accepted count; plan and its percent under
  it) with the small «Дубли» and «Ошибки» of a validation shift beside it.
- «Последний скан» (`LastScan`): one large status word with a glyph on the verdict's tone —
  ПРИНЯТ (ok), ДУБЛЬ (warn palette, the copy glyph), ОШИБКА (err), ПАУЗА/ЗАКРЫТА (warn),
  ОЖИДАНИЕ (neutral) — the code's tail in mono and the scan's time; the line of words only where
  the word leaves something to say (why it is a duplicate, which GTIN); never the count.
- «Дубликат Data Matrix» (`UnitLabelPanel`): three vertical steps (Код принят → Этикетка
  напечатана → Проверка этикетки), each `ready` (ok), `pending` (panel, dashed glyph),
  `current` (fg outline, filled dot) or `error` (err, with its recovery button), and one line of
  the label's state with its code's end. With the check off the third step reads «Проверка
  этикетки выключена».
- «История сканирований» (`ScanHistory`): the one list (the second one, «Последние сканы» of the
  validation panel, is gone with `ValidationPanel`): last 8 scans as time · result chip (glyph +
  word) · code, «Вся история», a note at the foot when there are more. The list is the only
  scroll region of the screen, reachable by keyboard. The work screen reads it once
  (`useScanHistory`) and the hero takes the code's tail from the same read.
- A box shift keeps its open box cells, the pallet strip and the close actions; its hero
  (word and code in one row), its two figures (closed boxes, last SSCC) and the same history
  stand in the right column.
- Footer: three actions at the kit's 84 px (`floor-primary`), «История этикеток» / «Исключения»
  secondary, «Выйти из смены» warning, «Закрыть смену» danger (outline variants of `Button`).

Why the page scrolled: `.floor-frame` is `min-height: 100dvh`, so any content taller than the
window grew the page. The work screen now sets `height: 100dvh` and `overflow: hidden` on the
frame (`:has(> .work-screen)`), a fixed grid (content row + the 84 px footer row, the
instruments' one row `minmax(0, 1fr)`), and the history list scrolls inside itself. Checked in
Chromium at 1280×1024 and 1280×800, dark and light: document scroll 0, no element past the
window, no interactive element under 64 px.

Derived from existing state (no change to the state machines):

- The three steps come from the unit-label job alone (`duplicateSteps`, pure, tested): no job →
  all pending; the job exists → «Код принят» ready; attempt `sent` or the check done/skipped →
  «Напечатана» ready; `prepared`/`sending`, or a decision being saved (`busy`) → current;
  `failed_before_send`/`delivery_unknown` with no check settling it → error; the check: verified
  or skipped → ready, a sent label under a required check → current, otherwise pending (`checkOff`
  from the snapshot's policy).
- The error step's recovery is `unit.retry` («Повторить»: the label read again, a lost send
  becomes unknown, nothing is sent). The reprint with a reason stays in the label's window, which
  opens over the work for every unresolved label.
- The hero's word and tone come from the `Last` outcome (`lastWord`, `lastTone`; duplicate has its
  own tone now); the code's tail from the newest history row with the same `scannedAt`.
- The band's «Дубли»/«Ошибки» are the existing validation counts; a box shift has none and
  shows no such tiles.

Behaviour that is presentation only but changed visibly: a scan the unit label refused (no crypto
tail, no render) was listed in the validation panel's outcomes; it is not journalled, so it is not
in the history, and the hero says it; «Принято: в коробе 2 из 12.» became «В коробе 2 из 12.»
(the word «Принято» appears once on the screen, as the band's label).

Other floor screens:

- The reason lists of the shift close and of the label reprint (`floor-choice`,
  `unit-label-reasons`) used `--accent` and `!important` borders against floor-kit: the selected
  row is now the kit's (2 px `fg` border, `fg` mark with a check, weight 600), the unselected
  border is floor-kit's. The workstation setup's focus outline `--accent` -> `--focus`.
- The hub card's photo is a `panel` frame with a hairline (the gradient is the work band's).
- `useProductAccent`/`data-accent` are no longer used by the work screen. The code stays in
  `shifts/ProductPhoto.tsx` and `photo-accent.ts` because the hub card and the new-shift screen
  (`ProductPanel`) still call it and `ProductPhoto` belongs to the parallel new-shift step; remove
  it together with that step.

Verified: tsc, ESLint (src, test), Prettier, the touched Vitest files, the full `vitest run`;
Chromium screenshots (jsdom-rendered real screens + the built CSS) in `/tmp/claude/shots/kit-c/`.
Not verified: Windows/WebView2 (`:has()`, `color-mix`, `100dvh`), a real status bar height (the
harness uses an 80 px stand-in for the one-row bar), the real kiosk window with the OS taskbar,
hardware, and the queue, warehouse and workstation-setup screens in a browser (token review only).
