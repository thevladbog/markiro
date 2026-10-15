# А4 — final whole-part review (plan 2026-10-11-standalone-a4-pallet-sheets-logo)

Reviewed: branch `claude/prt`, review commit `6801b17fc`, in the detached scratch worktree
`/tmp/claude/wt/rv-a4`. **Scope correction:** the dispatch named base `747dee842` ("everything
before it is ДРВ"), but Tasks 1–4 of А4 are first-parent commits BEFORE that merge:
`26513900a` (T1), `32090b9d8` (T2), `36a9d6994` (T3), `741a21072` (T4); `747dee842` only merged the
ДРВ fix wave on top of T4. `git diff 747dee842 6801b17fc` therefore holds Tasks 5–8 only. This
review covers all eight task commits (T1–T4 by `git show`, T5–T8 by the range diff).

## Verdict

**Needs fixes before the beta** — 0 Critical, 3 Important, 14 Minor. The A4/logo design is sound
and well tested (host bounds, frozen snapshot, one job per pallet close, no auto-resend, A4 only for
pallet + driver at 300 dpi, RAW refusal, whole-number scale, printable-area check before
`StartDocW`, DC cleanup), but Task 6 silently broke a ДРВ guarantee (driver-mode labels lost the
bundled-face rasterizer), the addendum's nullable `ShiftUpdate.palletSheetTemplateId` is still open,
and the warehouse reprint (СКЛ, other stream) does not know A4 printers or the logo — that seam
must be closed in the PRT → integration merge before a beta.

## (a) Findings, most severe first

### Important

**I1. Driver-mode labels no longer use the bundled face (regression of ДРВ by Task 6).**
`src/floor/print/shift-render.ts:85,106`: `shiftLabelRender` sets
`const rasterize = deps.rasterize ?? rasterizeText` and always passes it to
`renderLabel(spec, fields, printer, rasterize, logo)`. `renderLabel` picks
`rasterize ?? rasterizeDriverText` for `mode: "windows_driver"` (`label-render.ts:126-133`), so the
app's floor render (WorkScreen now always uses `shiftLabelRender(shift)`, `WorkScreen.tsx:683`)
hands driver pages the best-effort `rasterizeText`. Before Task 6 WorkScreen passed
`props.render` (undefined) and `prepareLabelJob` called `renderLabel` with no rasterizer, i.e.
`rasterizeDriverText`. Effect: a driver page can freeze a FALLBACK face (wrong metrics, clipped or
overflowing text) into the job's bytes, which reprints replay — exactly what ДРВ's
`rasterizeDriverText` exists to refuse (`RasterUnavailableError` → `render_failed`). Proven with a
scratch probe test (mock of `renderLabel`, real `shiftLabelRender(shift, {loadLogo})`, driver
printer): the 4th argument is `rasterizeText` (test passed, file removed). Tests did not catch it
because every floor test injects `deps.rasterize`/fakes. Not affected: RAW labels (same default as
before), A4 sheets (`rasterizeSheetText`). Fix: pass `deps.rasterize` through unchanged
(`renderLabel(spec, fields, printer, deps.rasterize, logo)`), plus a test that a driver label from
`shiftLabelRender` without `deps.rasterize` reaches `rasterizeDriverText` (and RAW `rasterizeText`
or `undefined`).

**I2. `ShiftUpdate.palletSheetTemplateId` cannot be cleared (addendum T5; plan-mandated gap).**
`proto/src/lib.rs` `ShiftUpdate.pallet_sheet_template_id: Option<String>`; host
`office_shifts.rs` keeps the current sheet on `None`; Zod/`requests.ts:473-476` send it only when
it changed; `sheet-options.ts:38` therefore withholds «Основной лист организации» from a shift that
holds a sheet. A planned shift cannot return to the main sheet except by saving pallets off and
then on again. Fix as the addendum says: `Option<Option<String>>` with the existing double-option
helper (`proto/src/lib.rs:195`, as `counterparty_id`), explicit `null` = "the organization's main
sheet, resolved now" (`default_sheet`, may be none), `null` without pallets accepted as no-op,
`null` on an open shift is a fixed-field change (`shift_status`) only if it changes the value; Zod
`.nullable().optional()` (strict), builder sends `null` when the form picks `""` for a shift that
holds a sheet, `sheetOptions` always offers «Основной лист»; proto fixture + parity, host tests
(plan/edit/open), exact audit `{from,to}`.

**I3. Cross-stream seam: the warehouse reprint (СКЛ, `claude/wh` → integration) knows neither the
A4 paper nor the logo.** Integration `src/floor/warehouse/warehouse-work.ts:287-298,481`:
`resolvePrinter(settings, PRINT_PURPOSE[kind])` + `renderLabel(spec, fields, printer, undefined,
options)` + `runtime.send(job.id, printer.target, bytes)`. After A4 merges, `resolvePrinter(…,
"pallet")` may return an A4 printer (A4 is allowed for pallets): the warehouse renders a thermal
page and sends it without `paper` (and, pre-ДРВ-merge, without `mode`) — at best a
`geometry_mismatch`, at worst a label-size page on the office laser; and every warehouse thermal
reprint leaves the `organization_logo` box empty while the original label (now) carries the
organization or Markiro logo. Neither plan owns it (СКЛ: «Перепечатка листов A4 паллеты — план A4»;
А4 plan does not mention the warehouse). Fix in the merge commit (or the first commit after it):
warehouse pallet reprint treats `printer.paper === "a4"` as `printer_unconfigured` (or renders the
sheet if the subject shift's frozen snapshot is at hand), passes `mode`/`paper` to `send`, and
renders with the logo rule (subject shift's frozen organization logo if available, else Markiro),
with tests; one line in §29/§30 and AGENTS.

### Minor

- **M1. Resolution whitelist not pinned beyond 203 dpi** (`printer/sheet.rs:157`): scratch mutant
  adding `450` (and `900`) to `300 | 600 | 1200` SURVIVED — the only "odd resolution" test uses 203.
  `scale = c.dpi_x / 300` is integer division, so an allowed 360/450 dpi device would print the
  sheet at 83 %/67 % silently. Add 360, 450 and 2400 to the refusal test.
- **M2. The logo is frozen into EVERY snapshot** (`shifts.rs` `snapshot`): up to 87 384 chars even
  for layouts without an `organization_logo` box and shifts without a sheet; it counts against the
  327 680-byte bound. Uploading a large logo can make a previously opening shift
  `snapshot_too_large` (AGENTS says so; §29 and the runbook do not). DOC now; CARRY "freeze the
  logo only when a layout has the box or a sheet is frozen".
- **M3. `decodeLogoFile` comment overclaims** (`labels/logo.ts:33-37`): the 4 MiB file cap does not
  bound the decoder's allocation (a 4 MiB PNG/WebP can declare 20 000 × 20 000 px → GBs of RGBA in
  `image.decode()`; an admin's own file can crash the office webview renderer). Not a host risk
  (host only takes thresholded bits). Fix the comment; CARRY a header dimension check (PNG IHDR,
  JPEG SOF, WebP VP8/VP8L/VP8X) before `decode()`. SVG: `<img>` + canvas runs no script and loads
  no external resource in Chromium (SVG-as-image isolation) and CSP `img-src 'self' data: blob:`;
  huge declared SVG sizes are shrunk by `fitLogoSize` before drawing (vector, no blow-up).
- **M4. «палет» vs «паллет»**: 9 new ru.json strings (e.g. `paperHint`: «…печатает палету… «Паллета»»,
  `office.palletSheets.title` «Листы палет А4») against 139 «паллет» elsewhere; also §29 and the
  runbook. Unify to «паллет».
- **M5. `SetStretchBltMode` after `StartDocW`** (`driver.rs:821`): a 0 there is reported
  `delivery_unknown` although nothing can have printed; it could be set in `open` before
  `StartDocW` (cloud parity kept it after `StartPage`). CARRY.
- **M6. `StretchDIBits > 0`**: a driver returning 0 for a good scaled blit would end every sheet
  `delivery_unknown` (the document is aborted before `EndPage`, so in practice nothing prints and
  «Напечатать снова» loops). No safe automatic downgrade exists inside ДРВ's rule "after
  `StartDocW` = unknown"; runbook step 12 catches it. CARRY.
- **M7. 20 s webview send limit vs ~1 MB spool; queue freed at 30 s** while Win32 may run on (ДРВ
  M3). Documented in AGENTS and runbook step 8. CARRY.
- **M8. «Основной лист организации» is resolved at PLANNING**, not at opening: a later change of
  the main sheet does not reach planned shifts (and the option then disappears for them). DOC in §29
  and the office hint.
- **M9. A4 pallet printer + shift without a sheet** (no default, none chosen): every pallet close
  leaves a `failed render_failed` job that the operator must handle before the next label — no
  up-front warning at shift entry or in the shift dialog. CARRY (UX), DOC in runbook.
- **M10. Office downloads while the logo query loads** (`use-label-logo.ts`): ZPL/TSPL file with an
  empty logo box, silently (T6 c3). CARRY.
- **M11. Runbook has no thermal-logo check**: Task 6 changes the bytes of every stock label with an
  `organization_logo` box (Markiro by default) — `^GFA`/`BITMAP` on a real Zebra/TSC at 203/300,
  scan still reads, office upload of PNG/JPEG/SVG in WebView2. FIX (docs).
- **M12. A4 job bytes ≈ 1.45 MB base64 per pallet**, kept 30 days by retention, re-read through IPC
  by `OPEN_JOB_READ_SQL` on every label-due check while an A4 job waits. CARRY (note in AGENTS).
- **M13. Shift opened before the upgrade** (snapshot without `organization`): its thermal labels
  switch from an empty box to Markiro mid-shift. Cloud parity. DROP (one line in §29 optional).
- **M14. A4 test print is portrait only**; landscape/two-A5 only through a real shift (runbook
  step 4). DROP.

### Checked and sound (no finding)

- Host: migration `0016` is additive (two tables, two `ALTER … ADD COLUMN`, partial index, two
  triggers); in the integration tree (`/tmp/claude/wt/integ`, HEAD `0ca4d78d0`) host migrations are
  `0001–0012, 0015`; with А4 `0016` there is no number clash and no table overlap (0015 touches only
  `warehouse_reprints`); sqlx applies by version and `restore.rs` migrates older copies forward.
  Routes: logo GET any office role, PUT/DELETE admin with in-tx re-check; sheets catalog roles with
  in-tx re-check; default only an enabled sheet, never disabled/deleted; planned shifts block delete
  (`shiftIds` in details), active/closed keep a dangling id by design; no revision/feed (А4-6) is
  stated honestly in AGENTS and §29 (a station sees a new logo/sheet only in the next shift's
  snapshot). `validate::mono_logo`: bounds, canonical base64, exact stride × height, zero padding
  per row; audit never holds bits.
- Station: sheet rendered only from the frozen snapshot (`renderShiftSheet`), SHIFT production date;
  one job per pallet close inside the close transaction; `sending` before send; unknown never
  resent; `printAgain` reuses bytes only for same mode/paper/language/dpi; A4 never for box/duplicate
  (settings read, resolvePrinter, printerForAgain, «Другой принтер» list, setup lists); RAW + A4
  refused `invalid_target`; missing sheet/organization → `render_failed`, pallet still closes; box
  label first (`ORDER BY created_at, purpose`).
- Shell: `sheet_orientation`/`sheet_draw_plan` arithmetic, 0.5 mm guard (ceil at device dpi),
  physical page ±0.5 mm, printable area inside the page, negative origin = −offset; DEVMODE sheet
  branch drops FORMNAME/PAPERWIDTH/PAPERLENGTH, sets ORIENTATION/PAPERSIZE/COPIES/SCALE/DUPLEX,
  merged DEVMODE size re-checked, `mode_holds` incl. duplex only when `DM_DUPLEX` survives; `Device`
  built before the plan check so `DeleteDC` runs on refusal; no panicking arithmetic (whitelisted
  dpi, A4-bounded sizes).
- Commits: each ends with exactly one `Co-Authored-By: Claude Opus 5.5` line; `git diff --check`
  clean over `7c1458672..6801b17fc`.

## (b) TRIAGE

| Item                                                                     | Source                       | Decision                          | Reason                                            |
| ------------------------------------------------------------------------ | ---------------------------- | --------------------------------- | ------------------------------------------------- |
| I1 driver face                                                           | review                       | FIX (wave 1)                      | ДРВ guarantee broken on every driver label        |
| I2 nullable sheet                                                        | addendum T5, T4 c3, T5 c3/D1 | FIX (wave 2)                      | plan-mandated                                     |
| I3 warehouse × A4/logo                                                   | review (cross-stream)        | FIX at integration merge (wave 5) | wrong output on A4, logo parity                   |
| M1 dpi whitelist test                                                    | review mutant                | FIX (wave 3)                      | one test, real silent-misscale risk               |
| M2 logo in every snapshot                                                | review                       | DOC (wave 4) + CARRY              | AGENTS honest, §29/runbook silent                 |
| M3 decode bomb / comment                                                 | review                       | FIX comment (wave 3), CARRY sniff | self-inflicted, renderer only                     |
| M4 палет/паллет                                                          | review                       | FIX (wave 3)                      | product spelling is «паллет»                      |
| M5 SetStretchBltMode place                                               | review                       | CARRY                             | cloud parity, low probability                     |
| M6 StretchDIBits > 0                                                     | T7 c2, T8 c1                 | CARRY                             | runbook step 12                                   |
| M7 20 s / 30 s                                                           | T7 c4, T8 c2                 | CARRY                             | documented                                        |
| M8 main sheet at planning                                                | review                       | DOC (wave 4)                      |                                                   |
| M9 A4 + no sheet                                                         | review                       | DOC (wave 4), CARRY UX            |                                                   |
| M10 download while loading                                               | T6 c3                        | CARRY                             | office convenience                                |
| M11 runbook thermal logo                                                 | review, T6 c1                | DOC (wave 4)                      | beta needs it                                     |
| M12 A4 bytes size                                                        | review                       | CARRY                             | retention exists                                  |
| M13 pre-А4 snapshot logo                                                 | review, T8 c5                | DROP                              | cloud parity                                      |
| M14 portrait-only test                                                   | review                       | DROP                              | runbook step 4                                    |
| T1 c1 forms-parity base failures                                         | T1                           | DROP                              | fixed by merge `a2be24573`                        |
| T1 c2 empty MIME refused                                                 | T1                           | DROP                              | T5 words it, FileDropZone `accept`                |
| T1 c3 / T5 c1 / T6 c1 / T7 c1 / T8 c1,c3 real webview, Windows, hardware | reports                      | CARRY                             | owner checklist below                             |
| T1 c4, T7 c5, T8 c7 graphify                                             | reports                      | DROP                              | no graph in the worktrees                         |
| T2 c1 no revision for logo                                               | T2                           | DROP                              | А4-6, documented                                  |
| T2 c2 host takes any bits                                                | T2                           | DROP                              | bits are only dots; webview validates pictures    |
| T2 c3 M07 equivalent                                                     | T2                           | DROP                              | defence in depth                                  |
| T3 c1 name uniqueness / addendum warn                                    | T3                           | DROP                              | T5 warns (chip + alert + id prefix)               |
| T3 c2 / addendum disabled-missing sheet at open                          | T3                           | DROP                              | T4: disabled frozen as is, missing → none, tested |
| T3 c3 dangling id                                                        | T3                           | DROP                              | by design, snapshot owns the sheet                |
| T3 c4 stock sheets deletable                                             | T3                           | DROP                              | re-add is idempotent by key                       |
| T3 c5 404 on repeated delete                                             | T3                           | DROP                              | office re-reads the list                          |
| T3 c6 / T4 c4 host 0013–0015 absent                                      | T3/T4                        | DROP                              | integration checked: 0015 + 0016, no clash        |
| T4 c1 unreadable layout → null                                           | T4                           | DROP                              | brief; line keeps printing thermal                |
| T4 c2 missing sheet → none                                               | T4                           | DROP                              | brief; documented                                 |
| T5 c4 preview fallback                                                   | T5                           | DROP                              | same rule as print                                |
| T5 c5 sheet name on shift card                                           | T5                           | CARRY                             | later office polish                               |
| T6 c2 diagnostic in webview console                                      | T6                           | CARRY                             | needs shell IPC                                   |
| T6 c4 Markiro retried per label                                          | T6                           | DROP                              | cached on success                                 |
| T6 c5 template screen silent fallback                                    | T6                           | CARRY                             | logo card says it                                 |
| T7 c3 empty required area                                                | T7                           | DROP                              | T8 asserts real bounds                            |
| T8 c4 64 px of «Бумага»                                                  | T8                           | CARRY                             | runbook step 13                                   |
| T8 c6 «Перенесено»                                                       | T8                           | DROP                              | plan scope                                        |

### Fix wave (≤ 5 commits)

1. `fix(standalone): driver labels of a shift keep the bundled face` — `shift-render.ts` passes
   `deps.rasterize` unchanged to `renderLabel`; test: driver printer through `shiftLabelRender`
   without `deps.rasterize` reaches `rasterizeDriverText` (refuses when the face is unavailable),
   RAW keeps `rasterizeText`; mutant evidence.
2. `feat(standalone): a planned shift can go back to the main A4 sheet` — `ShiftUpdate.palletSheetTemplateId`
   double-option (null = main sheet resolved now), host `update_shift`, Zod strict
   `.nullable().optional()`, `requests.ts` builder, `sheetOptions` always offers «Основной лист»,
   proto fixture + parity test, host tests (planned edit to null with/without default, null on an
   open shift, audit), office tests.
3. `fix(standalone): A4 polish` — sheet.rs refusal test for 360/450/2400 dpi; `decodeLogoFile`
   comment states the cap bounds the file, not the decoded size; «палет» → «паллет» in ru.json.
4. `docs(standalone): A4 runbook and §29` — runbook: thermal-logo checks (office upload PNG/JPEG/SVG
   in WebView2 incl. an SVG with an external `href` showing nothing fetched; Markiro and own logo on
   Zebra ZPL and TSC TSPL at 203/300, scan reads), «Основной лист» resolved at planning, A4 printer
   - shift without a sheet = `render_failed` per pallet, logo in every snapshot vs
     `snapshot_too_large`; §29 the same three lines; spelling.
5. `fix(standalone): warehouse reprint and A4/logo` — in or right after the PRT → integration merge:
   warehouse refuses an A4 printer for pallet reprints (`printer_unconfigured`) or renders the sheet
   from a frozen snapshot, passes `mode`/`paper`, gives thermal reprints the logo rule; tests; one
   line in §29/§30 and AGENTS.

### Owner A4 checklist for the local Windows beta (priority order)

1. Office: upload a PNG and an SVG logo in the Tauri window (WebView2) — preview appears; an SVG
   with an external image reference shows nothing loaded; a non-image is refused with a text.
2. Thermal labels with the Markiro logo and then the own logo on the real Zebra (ZPL) and TSC
   (TSPL) at 203/300: logo inside its box, nothing overlaps, SSCC/codes still scan.
3. A4 printer setup (runbook «Листы палет А4», steps 1–3): «Бумага: Лист А4», 300 dpi locked, A4
   absent from box/duplicate lists; «Пробная печать» → one page, 1:1 by ruler, ≥10 mm margins,
   SSCC scan «Код совпал». Keep `drv-log.txt`.
4. Real shift with pallets (step 7): box label first, then exactly one sheet; SSCC/dates match;
   driver labels (if any) still in IBM Plex after wave 1.
5. Landscape and two-A5 sheets (step 4), Letter/large-margin refusal (steps 5–6).
6. Failure paths: paused queue, printer off, restart mid-job, «Другой принтер» (steps 9–11); watch
   for `step=StretchDIBits returned=0` (step 12) and the 20 s timeout on the 1 MB spool (step 8).
7. 64 px of the new setup controls (step 13).

## (c) Отклонения при исполнении (для раздела плана)

- Task 1: `decodeLogoFile` сверх брифа — белый список MIME (png/jpeg/webp/svg+xml) и предел файла
  4 МиБ до чтения, ошибки `LogoDecodeError` с кодами; `rasterizeSheetText` выражен через общий с
  `rasterizeDriverText` помощник; `downsampleMonoRaster` отказывает дробному множителю; `dist`
  домена пересобран (устаревший). Тесты: `readFileSync(new URL(…))` вместо `fileURLToPath`.
- Task 2: логотип НЕ поднимает ревизию хоста и не идёт в ленту (по брифу и А4-6, вопреки тексту
  диспетчеризации); нет ETag/sha256; хост не разбирает картинки — только биты; отдельного предела
  тела нет (2 МиБ axum по умолчанию, проверено тестом); `DELETE` отвечает `200 {logo: null}`.
- Task 3: `PalletSheetDefaultUpdate.templateId` обязателен (nullable, `present`), чтобы `{}` не
  сбрасывал основной лист; в отказе `template_in_use` — `shiftIds`; аудит основного листа через
  `update_details`; в этом дереве отказ проверки — `400 validation_failed`, не 422; удаление
  неизвестного листа — 404 (без надгробий).
- Task 4: нечитаемый макет листа или логотип на станции — `null`, смена открывается (бриф), а не
  отказ (диспетчеризация); отсутствующий в таблице лист замораживается как «нет листа», а не как
  основной; `shift.create` называет лист только при его наличии; `forms-parity.test.ts` получил
  умолчание `palletSheetTemplateId: null` для облачного фикстура; добавлен тест предела снимка с
  листом и логотипом (`snapshot_too_large`).
- Task 5: «Основной лист организации» не предлагается смене, у которой уже есть лист
  (`ShiftUpdate` не умеет `null` — закрывается в волне исправлений); повтор названий
  предупреждается (`StatusChip` «Название повторяется», общий Alert, начало id в выборе смены);
  листы читаются только при включённых паллетах; `Table` принимает `getRowKey`.
- Task 6: логотип передаётся и в путь драйвера (`renderMonoLabel`, паритет с облаком), сверх
  брифа; `PreviewPane` получает логотип пропсом, а не хуком; диагностическая строка — в консоль
  webview. Внесённая регрессия: `shiftLabelRender` всегда передаёт `rasterizeText`, и страницы
  драйвера потеряли `rasterizeDriverText` — исправляется в волне.
- Task 7: успех масштабированного вывода — `StretchDIBits > 0` (у этикетки `== h`);
  `SetStretchBltMode` вызывается после `StartPage` (как в облаке); проверка размера
  объединённого DEVMODE только для листа; утверждения времени компиляции для констант DEVMODE;
  ветка Windows только проверена на типы пробным крейтом.
- Task 8: новые тестовые файлы вместо названных в брифе (`floor-setup-a4`, `floor-pallet-sheet`,
  `floor-work-pallet-sheet`); помощник `sheetedShift`; SSCC брифа с неверной контрольной цифрой
  заменён на `FIRST_SSCC`; дата производства смены не бывает `null`; изготовитель тестового листа
  внедряемый (`a4Sheet`); пробная печать А4 — только вертикальный лист; инцидент процесса —
  исходники случайно откатаны и восстановлены тем же скриптом, проверено `cmp`.
- Ревью: базой Tasks 5–8 назван `747dee842`, но Tasks 1–4 лежат до него; проверены все восемь
  коммитов.

## Evidence

- Worktree `/tmp/claude/wt/rv-a4` (detached `6801b17fc`), build state cloned from
  `/tmp/claude/wt/integ` (55 s), `@markiro/domain` rebuilt, `cargo build --workspace --tests
--offline --locked` 55 s; `git status --short` empty at the end.
- Focused Vitest (13 files: floor-pallet-sheet, shift-sheet-render, floor-print-driver,
  workstation-settings, label-logo, sheet-render, floor-label-render, shift-render, sheet-options,
  shift-edit, shift-dialog, floor-work-pallet-sheet, floor-setup-a4): 293 passed
  (`/tmp/claude/wt/rv-a4-vt-base.log`).
- Cargo (sandboxed, no loopback): `markiro-standalone --lib printer::` 118 passed; host
  `device_shifts` 32, `office_shifts` 41, `org_logo` 13, `pallet_sheets` 16 passed.
- I1 probe: scratch `test/zz-rv-driver-face.test.ts` (mocked `renderLabel`) asserted the driver
  label got `rasterizeText` — passed; file deleted.
- Mutants (`/tmp/claude/rv-a4-mut/mut.py`, logs beside it; every restore sha256-equal and touched):
  23 run, 22 killed, 1 survived.
  - TS (killed): T1 A4 branch of `shiftLabelRender` off; T2 RAW+A4 refusal dropped; T3 paper not
    handed to the shell; T4 `sameRender` ignores paper; T5 `printerForAgain` without
    `printsPurpose`; T6 A4 accepted at any dpi; T7 «Другой принтер» lists A4 for a box; T8 «Основной
    лист» offered to a shift with a sheet; T9 sheet without production date; T10 `resolvePrinter`
    without `printsPurpose`; T11 box count from units; T12 INN dropped.
  - Shell (killed): R1 guard 0; R2 page tolerance 3 mm; R3 sheet mm tolerance 1 mm; R4
    `mode_holds` ignores paper; R5 ignores duplex; R6 `drawn >= 0`; R7 negative offset accepted.
    **Survived:** R8 extra resolution (`| 900`, `| 450`) in the whitelist (M1).
  - Host (killed): H1 pallets turned on by an edit take no default sheet; H2 missing sheet at
    entry is an internal error.
- Integration migrations listed: `/tmp/claude/wt/integ/apps/standalone/host/migrations` = 0001–0012,
  0015; shell 0001–0010, 0012, 0013 (А4 takes no shell migration).
