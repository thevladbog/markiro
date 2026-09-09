# Design Brief 10 — Handheld (TSD) Android App

> Addition to the 00–09 series. This brief covers a **new product surface**:
> a native Android application for industrial handheld terminals (ТСД —
> терминал сбора данных) with a built-in barcode scanner and a hardware
> trigger. It reuses the shift, aggregation, inventory and device-pairing
> semantics already defined for the line station (brief 04, brief 07,
> `docs/superpowers/specs/2026-08-24-inventory-v1-architecture.md`) and
> introduces a third **handheld mode** of the design system next to office
> and floor mode (brief 02).
>
> Design source: local Pencil canvas `docs/design-briefs/markiro-tsd.pen`
> (intentionally untracked, see brief 09 for why). RU primary + EN, dark
> default + light, portrait only.

Status: design decisions approved in brainstorming on 2026-09-10; first full
set of mockups drawn the same day (94 frames incl. the reverse-aggregation
future flow, see the file structure section).
Corrections are expected during review; this document is updated when a
mockup changes a decision.

## Why a handheld

Every code-facing surface today is tied to one spot: the station stands at
the line, the kiosk at the pickup point, the cabinet's box-sell page at the
till. A handheld is for the person who **walks**: along the racks during an
inventory, along a short line without a tablet and a USB scanner, across the
floor to check what a given box or unit is. The small plant that cannot
afford a tablet, a hardware agent and a desktop printer per line should be
able to start with one handheld and one Wi-Fi label printer.

## Scope decisions

| Decision      | Choice                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contours (v1) | **Line mode** (validation + aggregation, as a peer terminal of the shift), **inventory** (check and repack while walking), **code check** (read-only lookup). Out of v1: receiving/shipping/warehouse movements, disposal, box-sell display, pallet building outside a shift. **Reverse aggregation** with a pre-printed SSCC pool is a later phase but is drawn (§6a) so the shell accommodates it. |
| Devices       | Industrial Android handhelds with a hardware trigger are the primary target (Zebra TC2x, Honeywell EDA5x, Urovo DT50, Атол Smart, Chainway). An ordinary Android phone with camera scanning is a **secondary** target for inventory and code check only; the line mode is not designed for a camera.                                                                                                 |
| Printing      | The handheld prints box labels **itself**: a network printer near the line over Wi-Fi (TCP 9100, ZPL/TSPL from `@markiro/domain`) and a belt-worn mobile printer over Bluetooth. No hardware agent.                                                                                                                                                                                                  |
| Stack         | **Native Kotlin.** The design is a standalone handheld mode in the Markiro language; it does not reuse station React components.                                                                                                                                                                                                                                                                     |
| Navigation    | **Hub with modes.** After sign-in a hub with large tiles; each mode is self-contained. No bottom tabs, no scan-first ambiguity.                                                                                                                                                                                                                                                                      |

### Assumptions carried over from existing briefs and specs

- Device commissioning is brief 07: 8-digit single-use pairing code, 15 min
  TTL, the same code as a barcode, on-prem server address collapsed,
  revoke/re-pair from the cabinet. The handheld is a third device type
  (`handheld`) in the cabinet's Devices list and counts against the same
  device quota. **Dependency, not yet in code:** today `deviceTypes` in
  `apps/api/src/modules/devices/dto.ts` is `["station", "kiosk"]`, and the
  pairing, place, Devices list and subscription-quota branches follow it.
  Building this brief requires extending that enum and every type branch
  with `handheld` while keeping station and kiosk behaviour unchanged.
- Operator sign-in is brief 07 §4: badge scan → login + PIN → name search.
  Never a scrollable roster.
- Offline-first with a device-local journal and outbox; the handheld joins a
  shift as one more terminal, with the same cross-terminal duplicate,
  conflict and credential-generation semantics the station has.
- Inventory participation follows inventory v1: the handheld is a terminal
  of an inventory task, leaving is a per-terminal pause, closing happens in
  the cabinet.
- Portrait orientation only. Dark theme by default, light supported.
  Russian primary, English mirrors; layouts must survive RU string lengths.

## Handheld mode of the design system

Handheld mode sits between office and floor mode: the screen is small, but
the hands may be gloved and the eyes are often on the shelf, not the screen.

| Property         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base frame       | **360×640 dp portrait** (5″ 720×1280, the tightest target). Key screens also checked at 360×720 (5.7″ handhelds) and 412×915 (phone).                                                                                                                                                                                                                                                                                                                       |
| Safe areas       | Android status bar on top. The bottom system bar is **not** treated as safe: many rugged devices have hardware navigation keys, so primary actions do not sit on the very bottom edge.                                                                                                                                                                                                                                                                      |
| Scan input       | Hardware trigger only on handhelds; **no on-screen scan button**. Phone variant adds a full-width 64 dp «Сканировать» button that opens the camera.                                                                                                                                                                                                                                                                                                         |
| Touch targets    | Primary actions 64 dp full-width; list rows 56 dp; icon buttons ≥ 48 dp; keypad keys 72 dp.                                                                                                                                                                                                                                                                                                                                                                 |
| Type ramp        | `hh-body` 400 16/22 · `hh-body-strong` 600 18/24 · `hh-title` 700 22/28 · `hh-code` mono 500 20/24 · `hh-counter` mono 600 40/44 · `hh-counter-lg` mono 600 56/60. Tabular numerals everywhere. Fonts: IBM Plex Sans / IBM Plex Mono as in `packages/ui/src/tokens.css`.                                                                                                                                                                                    |
| Colors           | Tokens from `packages/ui/src/tokens.css`, dark set by default: surfaces `#131216 / #1c1b21 / #232228`, text `#fafaf8 / #b6b3ab / #8e8b83`, accent `#3ddc7a`, statuses ok/err/warn/info with their `-solid`, `-bg`, `-border`, `fg-on-*-solid` pairs. Brand stays monochrome; color is reserved for statuses and one primary CTA per screen.                                                                                                                 |
| Spacing / radius | `sp-2..sp-6` (8–24) for layout, `r-2` (8) for cards and buttons, `r-round` for chips. Borders over shadows: the "instrument" character from brief 02.                                                                                                                                                                                                                                                                                                       |
| Status strip     | 32 dp strip under the system bar: network, sync queue with count, printer, scanner. Present on the hub and inside modes; hidden on signal overlays.                                                                                                                                                                                                                                                                                                         |
| Signals          | Same four as brief 04 (success, error, duplicate, box complete) as **full-screen states**; the error signal is drawn in two variants (bad code, foreign GTIN), so the canvas holds five overlays; plus a third channel the station lacks: **vibration**. Success = one short pulse; error = two long pulses; duplicate = one long pulse; box complete = short-short. Sound and vibration can each be muted; the visual signal alone must remain sufficient. |
| Hardware keys    | Trigger = scan. Hardware Back = in-app back and never leaves a shift or task without confirmation. No other key mappings required in v1.                                                                                                                                                                                                                                                                                                                    |
| Motion           | 140 ms for state changes (`mk-motion-fast`); the success flash is ~400 ms, the error flash holds ~1.5 s or until the next scan.                                                                                                                                                                                                                                                                                                                             |

## Screens

Every screen carries empty / loading / error / offline states; the line and
inventory modes add the signal states. Copy follows the brief 01 tone: plain,
concrete, production language.

### 1. Pairing (first run, unbound, revoked)

Brief 07 §3 in portrait: title «Привязать устройство», numeric keypad for the
8-digit code, helper «Нажмите триггер и наведите на штрих-код из кабинета»,
collapsed «Адрес сервера» for on-prem, «Привязываем… загружаем настройки и
операторов» progress, three error states (invalid/expired → «Обновите код в
кабинете»; lockout → «Слишком много попыток»; unreachable → «Проверьте адрес и
сеть», retry), success naming the assigned place («ТСД привязан к линии 2»).

### 2. Operator sign-in and lock

- Upper half: large «Сканируйте бейдж» block with the scan hint.
- Lower half: keypad. Login (personnel number) → PIN, digits as dots.
- «Найти по имени» as a text link; typing 2–3 letters shows 3–5 matches.
- **Lock screen** after idle: operator name, PIN keypad only, badge scan also
  works. Returns straight into the active shift or task, no re-selection.
- Error states: wrong PIN (inline, keeps keypad), roster unavailable
  (offline and never synced), operator not found.

### 3. Hub

- Header: organization, operator name, assigned line/place, sign-out.
- **Active context card** when a shift or inventory task is joined:
  «Смена 14 · Вода 0,5 л · 1 240 / 3 000 · ещё 2 терминала» with
  «Продолжить». Same for an inventory task. Pending unprinted labels are
  shown on this card («1 этикетка не напечатана»).
- Four tiles in two rows: **Смена**, **Инвентаризация**, **Проверка кода**,
  **Настройки**. Each tile has a one-line status: «3 доступны», «2 задания»,
  «принтер не настроен».
- Pressing the trigger on the hub opens code check with the scanned code.
- Variants: offline banner on top; no shifts and no tasks; printer not set
  up (hint on the Смена tile because aggregation will need it).

### 4. Shift selection and ad-hoc shift

- Cards one per row, 96 dp: product, plan, mode chips «валидация» /
  «+ агрегация», line, tolling badge «для: Завод X». Own line first, then
  «Другие линии» with a confirmation when joining. An already joined shift
  is pinned on top with «Продолжить».
- «Новая смена» as the bottom primary action. Flow per brief 04 §3: scan a
  unit → product card → mode → box capacity and pallet yes/no → start.
  «Товара нет в каталоге» is a blocking screen with the scanned GTIN and two
  actions.
- States: empty («Смен нет — создайте в кабинете или начните новую»),
  loading, offline (cached list with «данные на 10:42»).

### 5. Work screen — validation

Vertical order on 640 dp: status strip → shift header (product, shift number,
tolling badge, «+2» teammates chip, overflow) → **last scan zone** ≈ 40 % of
height → counters row → recent scans feed (3–4 rows).

- Last scan zone: status word («ПРИНЯТ», «НЕВЕРНЫЙ КОД», «ЧУЖОЙ ГТИН»,
  «ДУБЛЬ»), icon, code tail in `hh-code`; for a duplicate also where and
  when it was first scanned.
- Counters: «Всего 1 240 / 3 000», «Этот ТСД 312», «Ошибки 4 · Дубли 2».
- Feed: time, tail, status; swipe up expands to full screen.
- Overflow «Ещё»: Исключения, Выйти из смены, Закрыть смену.

### 6. Work screen — aggregation and box close

The **box-fill grid** takes the main zone; the last scan collapses into a
one-line strip (status + tail) above the grid.

- Grid sized to box capacity (e.g. 4×5 for 20), filling as units are
  scanned. Above it «Короб 27 · 14 / 20». Below it the **pallet strip**
  «3 / 12 коробов» when pallets are enabled.
- **Box close** is a full-screen state: «Короб 27 закрыт», SSCC, print
  status block. On successful print it dismisses itself after ~1 s and the
  next box starts. On print failure it stays and shows actions (§8).
- «Закрыть короб досрочно» in overflow, with a confirmation that shows the
  unit count inside.
- Pallet completion mirrors box completion (label print, strip resets).

### 6a. Reverse aggregation (pre-printed SSCC pool)

Not in the first build, drawn now so the shell leaves room for it. The
cabinet prints a pool of SSCC labels in advance (box and pallet), so the line
needs no printer. Order of scans is inverted: **box label first, units
after**.

- **Shift creation** (step 2) gets a toggle «Этикетки коробов уже
  напечатаны» with the explanation «обратная агрегация: сначала скан пустого
  короба, потом единицы. Принтер на линии не нужен». When on, the label
  template row is replaced by «Пул SSCC · свободно 94 из 120».
- **Await box** state: the main zone asks «Отсканируйте пустой короб» with an
  accent border; unit scans in this state raise the red signal «СНАЧАЛА
  КОРОБ».
- **Box open**: blue signal «КОРОБ ОТКРЫТ» with the SSCC tail, the work screen
  shows the box with a chip «из пула» and an empty grid; the hint line reads
  «Закрыть: повторный скан этикетки или 20 / 20».
- **Close**: automatic at capacity (green «КОРОБ ЗАКРЫТ … 20 / 20»). Re-scanning
  the box label while it is partial opens a sheet «Закрыть короб неполным?»
  with «Закрыть 14 из 20» and the scan-to-confirm hint «или отсканируйте
  этикетку короба ещё раз».
- **Box closed** state replaces the print block with «Этикетка уже на коробе
  · печать не нужна · SSCC из пула помечен использованным».
- **Pallets** are also pre-printed: when a pallet is full the screen asks
  «Отсканируйте этикетку паллеты» before the next box can close into it.
- **Label errors**: «ЭТИКЕТКА ЗАНЯТА» (SSCC already used, with when) and
  «ЧУЖОЙ SSCC» (not from this organisation's pool).

### 7. Exceptions

Four action rows of 64 dp: «Расформировать короб», «Заменить единицу»,
«Перепечатать этикетку», «Отменить последнее действие». Each flow is a
stepper: header «Шаг 1 из 3 · Отсканируйте этикетку короба», the thing to
scan now shown large, confirmation by scan only, a text «Отмена» to abort.
Replace unit = scan box → scan unit out → scan unit in. Reprint = last label
or scan an SSCC.

### 8. Printing and recovery

Print status block (inside box close, repack, reprint):

- `printing` → «Печатаем этикетку…» with the printer name;
- `printed` → «Напечатано» and the SSCC;
- `failed` with a confirmed reason the printer reported before printing:
  «Нет бумаги», «Принтер не отвечает». Actions: **«Повторить»**, «Другой
  принтер», «Отложить этикетку».
- `unknown` when the job was sent but no confirmation came back (Bluetooth
  dropped mid-job, TCP timeout after write): «Результат печати неизвестен»
  in the attention colour. The operator looks at the printer and chooses
  **«Этикетка напечаталась»** (marks the attempt printed) or «Напечатать ещё
  раз» (an explicit same-SSCC reprint, audited as such, mirroring the
  station's duplicate-print recovery) or «Отложить этикетку». No automatic
  resend from this state.
- Print jobs are keyed by SSCC and attempt. «Повторить» and «Напечатать
  все» in the queue skip any SSCC whose last attempt is `unknown` until the
  operator resolves it, so a retry cannot silently print a second label for
  an accepted box.
- A deferred label lives in a queue, visible on the hub card and in the
  shift header as «1 этикетка не напечатана»; the queue screen lists them
  with per-item retry and print-all under the rule above.

### 9. Degradation and team

- Offline banner, calm: «Работаем офлайн · 37 сканов в очереди». When back
  online, the banner turns into sync progress and disappears.
- Sync conflicts: a list of conflicted codes with terminal and time,
  informational only; resolution stays in the cabinet.
- Scanner unavailable: full-screen state with a vendor-specific plain
  instruction (e.g. «Профиль DataWedge выключен») and a retry.
- Teammates chip «+2» opens a bottom sheet with each terminal's contribution.
- «Выйти из смены» = pause this terminal. «Закрыть смену» = confirmation →
  drain the outbox with progress → summary (total, per terminal, errors,
  duplicates, boxes, pallets) → done.

### 10. Inventory

- **Task list**: cards with product, GTIN, method «без переупаковки» /
  «с переупаковкой», progress «проверено 1 240 из 4 116», status. Opening a
  task asks the same terminal-access confirmation the station does.
- **Check screen**: same skeleton as validation with inventory verdicts:
  `accepted` (green «Принято»), `already counted` here or on another
  terminal (amber «Уже посчитано», with terminal and time), `ineligible`
  status (red «Не подлежит учёту» with the status name), `protected
MOVING_BY_UD` (chip «Защищён» with text, never color alone), `not in
snapshot` (red «Нет в снимке»). Scanning an SSCC counts the whole box from
  the snapshot; the result shows how many units were counted.
- Counters: «Проверено 1 240 / 4 116», «Этот ТСД 312», «Расхождения 7».
- **Repack** stepper: scan the old box → scan units into the new box until
  capacity → one production date per box (from scan or picked once) → «Короб
  готов» → print the new label → next box. Print recovery is §8.
- **Leave task** is blocked while a repack box is open («Закройте или
  отмените короб»), otherwise it is a per-terminal pause. Corrections are
  cabinet work; the handheld offers only «Отменить последний скан».

### 11. Code check

- Entry: hub tile or trigger on the hub. Screen «Отсканируйте код» with no
  buttons; the result replaces it.
- Unit card: type, product, GTIN, code tail, Chestny ZNAK status chip from
  the saved statuses, location (box SSCC → pallet), shift with date,
  terminal.
- SSCC card: box or pallet, product, quantity, status, collapsed contents,
  parent pallet.
- Read-only in v1, no actions. Recent checks listed below the scan prompt.
- Offline: answered from the local mirror with «данные на 10:42, офлайн»;
  if the code is not mirrored, the state «Нужна сеть».

### 12. Settings

- **Сканер**: sources — built-in (DataWedge / vendor SDK; the hardware
  trigger stays the only scan input on a handheld), a paired **Bluetooth
  scanner** (ring or handheld, e.g. Zebra RS5100, for two-handed work or for
  a phone), and the **camera, offered only on a phone without a built-in
  scanner** (the row is hidden on handhelds, matching the device rules in
  the handheld-mode table). Test scan shows the raw string with GS
  separators highlighted. Pairing a Bluetooth scanner is a two-step flow: scan
  the on-screen pairing barcode with the new scanner (or pick it from the
  discovered list) → «Сканер подключён» with a test-scan prompt and «Сделать
  этот сканер основным».
- **Принтер**: list of network printers (address:port) and paired Bluetooth
  printers, language ZPL/TSPL, dpi, test print, status. **Add printer**: pick
  Wi-Fi (IP + port 9100, language and dpi segmented controls, «Проверить
  связь») or Bluetooth (discovery list with «Сопрячь» / «Выбрать», «Искать
  снова»). **Test print** shows what was sent (Cyrillic line + barcode) and
  asks «Этикетка напечаталась чётко?» with yes / retry. Error state «Принтер
  не отвечает» names the address and timeout and offers retry / edit.
- **Звук и вибрация**: volume, mute, vibration on/off.
- Language, theme (dark / light / system).
- **Об устройстве**: name, place, server, version, last sync. Unbinding is
  cabinet-only; this screen only informs.

### 13. Phone variant

Drawn for four screens only: hub, inventory check, code-check scan and
code-check unit card. The
full-width «Сканировать» button (64 dp) sits above the bottom safe area; the
feed loses one row to make room. Line mode has no phone variant.

## Components — handheld mode

All interactive components have default / pressed / disabled / loading
states; no hover. Names are the intended Pencil component names.

| Component                               | Notes                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `hh/SystemBar`                          | 24 dp Android status bar stand-in (time, signal, battery)                                                                        |
| `hh/StatusStrip`                        | 32 dp; four `hh/Indicator` instances (icon + short label): network, sync with count, printer, scanner; never icon alone in error |
| `hh/AppBar`                             | 56 dp; back, title, context chip (shift/task), overflow                                                                          |
| `hh/Tile`                               | hub tile: icon, label, status line; 2×2 grid                                                                                     |
| `hh/ContextCard`                        | active shift or task with progress and «Продолжить»                                                                              |
| `hh/ShiftCard`                          | 96 dp list card with chips and tolling badge; inventory task cards are instances with overrides                                  |
| `hh/ScanResult`, `hh/ScanResultCompact` | large (200 dp) and one-line variants; verdicts ok / error / duplicate / attention / info                                         |
| `hh/SignalOverlay`                      | success / error / duplicate / box-complete; documents the vibration pattern per variant                                          |
| `hh/CounterRow`                         | label + mono tabular number, 2–3 per row                                                                                         |
| `hh/BoxFill`                            | compact grid, capacity-driven, filled / current / empty cells; `hh/PalletStrip` beneath                                          |
| `hh/Key`, `hh/Keypad`, `hh/PinDots`     | 72 dp key; 4×3 keypad with backspace and confirm; PIN dots                                                                       |
| `hh/ListRow` 56, `hh/ActionRow` 64      | list rows and exception actions                                                                                                  |
| `hh/StepHeader`                         | «Шаг 1 из 3 · …»                                                                                                                 |
| `hh/Button`                             | primary 64 full-width, secondary 56, destructive, text                                                                           |
| `hh/Banner`                             | offline / syncing / attention                                                                                                    |
| `hh/State`                              | full-screen empty / loading / error / offline / hardware                                                                         |
| `hh/Chip`                               | mode, ЧЗ status, tolling, teammates, protected                                                                                   |
| Bottom sheet                            | pattern, not a component: overlay + sheet frame built inline on each screen that needs it                                        |
| `hh/PrintStatus`                        | printing / printed / failed with reason and actions                                                                              |
| `hh/ScanButton`                         | phone variant only                                                                                                               |

## Pencil file structure (as drawn, 2026-09-10)

`markiro-tsd.pen` holds 28 reusable `hh/*` components on the top row
(`y = 0`) and 94 screen frames in rows below. Every screen is a top-level
360×640 frame with `clip: true`, named `NN-area/screen-state`; light-theme
copies carry `theme: {mode: "light"}` on the frame, phone copies are
412×915.

| Row (`y`) | Prefix                                          | Frames | Contents                                                                                                                        |
| --------- | ----------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------- |
| 0         | `hh/`                                           |     28 | Tokens as variables (dark/light axis `mode`) and the components listed above                                                    |
| 700       | `02-`                                           |     10 | Pairing (enter, binding, 3 errors, success), sign-in (badge/login, PIN, name search, lock)                                      |
| 1500      | `03-hub/`                                       |      4 | Active shift, idle, offline, active inventory                                                                                   |
| 2300      | `04-shift/`, `04-work/validation`, `04-signal/` |     11 | Shift list, other-line confirm, ad-hoc shift ×3, validation, 5 signal overlays (4 types, error ×2)                              |
| 3100      | `04-work/`, `04-exceptions/`                    |     10 | Aggregation, box close ×4 (printing, printed, failed, unknown), exceptions list, disassemble, replace, reprint, label queue     |
| 3900      | `04-work/`                                      |      8 | Offline, sync conflicts, scanner unavailable, teammates, more-sheet, close confirm/draining/summary                             |
| 4700      | `05-inv/`                                       |     12 | Tasks, task confirm, check, 5 verdicts, repack ×3, leave blocked                                                                |
| 5500      | `06-check/`, `07-settings/`                     |      9 | Scan, unit, box, offline, needs network; settings list, scanner, printer, sound                                                 |
| 6300      | `08-light/`, `09-phone/`                        |     11 | Light theme ×7, phone ×4 (with `hh/ScanButton`)                                                                                 |
| 7100      | `10-reverse/`                                   |     12 | Reverse aggregation: shift step 2 toggle, await box, box open/filling, partial-close sheet, box closed, await pallet, 5 signals |
| 7900      | `07-settings/`                                  |      7 | Scanner sources with Bluetooth, scanner pairing ×2, add printer, Bluetooth printer pairing, test print, printer error           |

Component ids worth knowing when editing instances: `hh/Key` (`s2WFw`),
`hh/Keypad` (`ZgiDi`), `hh/ScanResult` (`ydVm0`), `hh/SignalOverlay`
(`hjghB`), `hh/BoxFill` (`J1WFha`), `hh/State` (`CZH5q`), `hh/ListRow`
(`nb4tu`). Two Pencil quirks met while drawing: an instance that overrides
`width` must also set `height` explicitly, and a `$variable` does not work as
a `width`/`height` value, so control heights are literal numbers.

Drawing order followed the rows above; each row was screenshot-verified
before the next.

## Out of v1 (leave room)

- Receiving, shipping, movements and write-offs on the handheld.
- Pallet building outside a shift; disposal; box-sell display.
- Actions from the code-check card (reprint, disassemble).
- Corrections during inventory on the device.
- Per-line operator scoping and multiple places per handheld.

## Open questions

- Reverse aggregation: should a partial box close by re-scan require the
  confirmation sheet, or close immediately (drawn with the sheet, and the
  second scan counts as confirmation)?
- Reverse aggregation: are pallet labels also pre-printed (drawn that way), or
  does the pallet stay auto-numbered with a printed label?

- Which handheld models the first customers actually own; the base frame
  assumes 5″ 720×1280 and should be revisited if 5.7″ dominates.
- Whether the shift-close summary should be printable from the handheld.
- Whether the inventory needs a camera-less «enter code manually» fallback
  for damaged DataMatrix; the station does not have one today.
