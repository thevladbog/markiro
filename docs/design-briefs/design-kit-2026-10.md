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
