# ДРВ — final whole-part review (review commit 7c1458672, base 2c726efba)

Scratch worktree: `/tmp/claude/wt/rv-drv` (detached at 7c1458672; build state cloned from integ; domain dist rebuilt; tree clean after every mutant).

## Verdict

**APPROVED WITH FIXES — safe to hand to the owner as a local Windows beta once fix-wave commits 1–2 land.**
Critical 0 · Important 2 · Minor 11.

The print discipline holds across the seams: the job row is `sending` before any IPC call; every
path from `StartDocW` on (failed StartDoc, failed page/draw/end, stalled > 30 s, dead worker, IPC
reject, unparseable answer, receipt naming another queue/document) ends `driver_unknown` →
job `unknown`, and nothing re-sends an unknown job without `printAgain` + reason. `sent` needs
`EndDoc > 0` plus a receipt that matches the queue and document name that were sent. The Windows queue
check is read-only. After a restart the receipt is gone (`no_receipt`) and a `sending` job becomes
`unknown`/`interrupted`. No observation (`present`, `absent`, `identity_mismatch`, `unavailable`)
ever changes a job's state. The unsafe `mod native` is a byte-for-byte port of the cloud's
`printer_windows.rs`, which has never run on hardware either. I read it line by line and found no
UB, handle leak, bounds error or panic path. Its real-world risk is driver behaviour, not memory
safety. Both Important findings concern whether the owner's first Windows test can be read and
diagnosed. Neither is a label-safety defect.

## (a) Findings, most severe first

### Important

**I1 (docs, plan-mandated text). The runbook's manual steps 6–7 promise outcomes a paused or offline queue cannot produce.**
`docs/runbooks/standalone-install.md` «Печать через драйвер Windows», step 6 says that with the
printer switched off or the queue paused the label reads «Принтер не ответил вовремя» or
«Windows не подтвердил задание…». With GDI spooling, `StartDocW`…`EndDoc` return as soon as the EMF
is spooled, whether or not the queue is paused or the printer is on. The answer is `ok:true` with a
receipt, and the job is `sent`. If the scan check is on, the panel waits for the scan, and
«Проверить очередь Windows» is shown there and reads `present`. If the check is off, the job is
done and no panel offers the queue check. Timeout/unknown appears only when a driver call really
blocks, e.g. a queue set to "print directly to the printer" with an unreachable network printer.
Step 7 has the same problem: «Печать прервалась» needs a restart _during_ an unanswered call. A
label sitting in a paused queue was already `sent` before the restart. As written, the owner will
report expected behaviour as a bug, or think the app detects an offline printer. The same text is
in the plan's Task 7 brief. Fix: commit 1.

**I2 (beta readiness). A refusal on a real driver cannot be diagnosed.**
On the first real driver, the likeliest outcome is one of: `geometry_mismatch` (driver ignores
`DMPAPER_USER`, swaps a wide label, reports 200 instead of 203 dpi, or returns `dmScale = 0`),
`driver_not_started` (DocumentProperties/CreateDC), or `driver_unknown` on every print (a driver
whose `StretchDIBits` returns something other than `h`, which aborts the document). The webview only
gets the code. The shell logs nothing for any driver step, even though `eprintln!` to stderr is an
established shell convention (installation.rs, office_files.rs, lib.rs). The runbook asks the owner
to report "разрешение в драйвере", but nothing shows what `GetDeviceCaps` returned. Without one
diagnostic line per refusal, a failed first test needs a second beta just to add logging. Fix:
commit 2. Write numbers and Win32 error codes only, no payload, then run the app from `cmd` with
`2> drv-log.txt` (stderr redirection works for a windows-subsystem exe started that way).

### Minor

- **M1 — the main driver path has no end-to-end pin.** Mutant C survived: `prepareLabelJob` rendering with
  `{language, dpi}` (mode dropped). In that case a driver printer's prepared job freezes ZPL bytes,
  and every label then fails `invalid_payload` on Windows. Every driver test inserts jobs
  through support helpers or `printAgain`. No test closes a box on a driver profile and checks
  that the prepared bytes decode as `mono-raster-v1` at the profile's dpi and go to
  `printWindowsRaster` once. FIX (commit 4).
- **M2 — the parity fixture is incomplete.** `hardware-shapes.json` pins 5 driver shapes. Rust
  serializes `identity_mismatch`/`unavailable`, but TS parses them only from literals (Task 2/3
  report concerns). FIX (commit 4): two keys on both sides, key count 7 → 9.
- **M3 — the queue is freed at 30 s while the Win32 call may still run** (plan-mandated, ported from the cloud). RAW keeps the address busy
  until the call really ends. For the driver, `print_windows_raster` answers at 30 s and the
  blocking thread may still be inside `StartDocW`/`EndDoc`. A later label to the same queue then
  starts a second, concurrent GDI job, so labels can come out of order, and a reason-backed
  reprint of the `timeout` label can produce a duplicate SSCC label when the hung one finally
  prints. AGENTS says that "the Win32 call is not cancelled" but does not say the queue is freed. CARRY:
  a per-queue in-shell busy set that refuses `before_start` while a worker is alive. DOC: one
  sentence in AGENTS «Hardware».
- **M4 — `present` ignores `statusFlags`.** A completed job kept by "keep printed documents"
  (`JOB_STATUS_PRINTED`), an errored job and a paused job all read «ещё может напечататься».
  Diagnostic only, so not dangerous. CARRY.
- **M5 — `draw` does not ensure a positive blit size.** `check_geometry` allows `offset_x = c.width`
  with `printable_width = 1` when the page has no required bounds. Then
  `w = min(p.width - offset_x, pw)` can be ≤ 0, and `StretchDIBits` with a negative width mirrors.
  This needs an absurd driver report and a label without barcodes, so it is practically unreachable.
  FIX (commit 3): require `offset_x < page.width && offset_y < page.height` before
  `StartDocW`, with a unit test.
- **M6 — the test print sets the driver's paper to 58×40 mm.** The setup test label is 58×40 mm, and the shell sets that as
  `DMPAPER_USER` for the job. On TSC/Godex-style drivers this sends a size command. On larger stock
  the test label is placed at the top-left, and the next job resets the size. The runbook does not
  say this. DOC (commit 1).
- **M7 — a rollback can print the frozen page RAW.** An older build drops the unknown `mode`, so a driver profile reads as RAW.
  Unresolved jobs (`prepared`/`failed`/`unknown`) would replay their frozen `MKRMNO1…` bytes RAW
  into the queue, and the printer would print garbage. The cloud acceptance says "do not downgrade
  while raster jobs are unresolved". DOC (commit 1).
- **M8 — two in-memory maps grow for the app run.** The runtime's `receipts`/`newest` maps grow by one small entry per printed job (bounded by labels per app run). DROP.
- **M9 — `x >= w` in `raster::decode` is implied by `x >= b[2]`, because `b[2] <= w`.** My mutant R-B
  survived as an equivalent mutant. The Task 1 report's "padding" row was a different mutant
  (scan range). Keep it as a defensive check. DROP.
- **M10 — `print` decodes the page twice** (`artifact` and then `decode`). This costs about 4 M bit checks at worst. DROP.
- **M11 — the queue answer is not announced to a screen reader.** The paragraph is not a live region. This matches the panel's other notes, whose
  alerts are `role="presentation"`. CARRY to a panel-wide a11y pass.

### Checked and found sound (no finding)

- **Unsafe, line by line.**
  - Handles. `Queue` is RAII-closed (`ClosePrinter`); its handle is not needed after `CreateDCW`. `Device` calls
    `DeleteDC` on every exit, including `geometry_mismatch` after the DC exists. `AbortDoc` runs
    after any post-`StartDocW` failure.
  - DEVMODE buffers. They are `Vec<u64>`, so 8-aligned, sized from `DocumentPropertiesW(…, 0)`
    (≥ `size_of::<DEVMODEW>()` = 220, ≤ 1 MiB). `dmSize`/`dmDriverExtra` are checked against
    `needed` before any field is touched. The merge goes into a separate output buffer, so the
    driver-private tail is kept.
  - Struct layout. windows-sys 0.61.2 `DEVMODEW` is `repr(C)` and not packed on x64, so
    `&mut …Anonymous1.Anonymous1` is fine. The union is written by field name (the order there is
    Orientation, PaperSize, PaperLength, PaperWidth).
  - Strings. UTF-16 names are NUL-terminated; `valid_name` refuses an interior NUL. Every
    temporary outlives its call.
  - Bitmap. `BITMAPINFOHEADER` is 40 bytes plus a 2-entry palette (0 = white, 1 = black, matching
    the format's 1 = black). The height is negative (top-down), and `ySrc` is from the top for a
    top-down DIB. `dib_pixels` builds DWORD rows; its length is stride × height, and no slice goes
    out of bounds.
  - `GetJobW`. A two-call size probe accepts only error 122. Errors 87/259 mean `absent`;
    `needed` is bounded; `pDocument` must lie in `[buffer, buffer+length)`, be 2-aligned and be
    NUL-terminated within the buffer, otherwise `unavailable`.
  - Threads. The DC is created and used on one blocking thread. No COM is assumed.
- **Raster parser.**
  - It reads nothing before `len ≥ 64`; `MAX_BYTES` = 2 MiB is checked before decoding, and the
    base64 length is bounded before allocating.
  - The size is bounded by the mm range (10–300) and dpi ∈ {203, 300}, so dimensions are at most
    3543 and every product fits in u32 with no overflow, even in debug.
  - `length` uses `checked_mul`/`checked_add`, and the trailer length must be exact, so truncated
    or oversized input is refused whole.
- **Panic containment.** Every native and parser call runs inside `spawn_blocking`.
  A panic becomes a `JoinError`, which maps to `delivery_unknown`/`unavailable`. There is no
  `panic = "abort"` profile. The async command bodies themselves cannot panic.
- **Shape parity and exhaustiveness.**
  - The TS switch is exhaustive with `never`.
  - A new Rust `&'static str` code fails Zod, which reads as `driver_unknown`: the safe direction.
  - Tauri argument names: `payloadBase64`/`documentName` are pinned by the ipc test.
- **Profile migration.** A profile without `mode` reads as RAW. RAW writes no key. An unknown mode, or `null`,
  is refused at read and save. `windows_driver` is allowed only for `usb`. Job snapshots go through the same parser.
  `printAgain` re-renders when the mode differs. Only `printAgain` passes a different printer and
  bytes (`rebind`), and that pair stays consistent.
- **Screens and i18n.**
  - Every code and observation state has a `floor.print.codes.*`/`floor.print.queue.*` key,
    pinned by a test.
  - The new controls are `size="floor"`, and «Проверить очередь» goes through the panel's
    `press` guard.
  - The texts never say "printed" for a queue answer.
  - No `language.toUpperCase()` display is left (`printerFormatText` everywhere).
- **Repository hygiene.** `Cargo.lock`, lockfile and manifests are unchanged apart from the
  `Win32_Storage_Xps` feature. `git diff --check` is clean. Each of the 7 commits has one trailer.

## (b) TRIAGE

| Item                                               | Source                | Decision                      | Reason                                                |
| -------------------------------------------------- | --------------------- | ----------------------------- | ----------------------------------------------------- |
| I1 runbook steps 6–7                               | review (plan text)    | FIX (c1)                      | owner's first test would be misread                   |
| I2 no driver diagnostics                           | review                | FIX (c2)                      | a failed first test is otherwise undiagnosable        |
| M1 prepare path unpinned                           | mutant C              | FIX (c4)                      | cheap; covers the main production path                |
| M2 fixture lacks 2 observation shapes              | review; T2/T3 concern | FIX (c4)                      | parity of all variants                                |
| M3 queue freed at 30 s while Win32 runs            | review                | DOC (c1/AGENTS) + CARRY guard | plan-mandated; rare hang case                         |
| M4 statusFlags ignored                             | review                | CARRY                         | diagnostic only                                       |
| M5 blit size not guaranteed > 0                    | review                | FIX (c3)                      | tiny guard before StartDoc                            |
| M6 test label 58×40 paper                          | review                | DOC (c1)                      | operator expectation                                  |
| M7 downgrade replays raster RAW                    | review                | DOC (c1)                      | cloud acceptance rule                                 |
| M8 receipt maps grow                               | review                | DROP                          | bounded, small                                        |
| M9 redundant `x >= w`                              | mutant R-B            | DROP                          | defensive, equivalent                                 |
| M10 double decode                                  | review                | DROP                          | negligible                                            |
| M11 no live region                                 | review                | CARRY                         | panel-wide pattern                                    |
| T1: native never executed                          | task 1                | CARRY                         | manual Windows checklist + `standalone-windows-build` |
| T1: graphify not run                               | tasks 1–7             | DROP                          | controller's step / no graph in stream tree           |
| T1: brief test vacuous on stub                     | task 1                | DROP                          | resolved by added tests                               |
| T2: supports→false / mangled receipt survivors     | task 2                | CARRY                         | only Windows can tell                                 |
| T2/T3: Zod parity 5 keys                           | tasks 2–3             | FIX (=M2)                     |                                                       |
| T3: i18n keys before T6                            | task 3                | DROP                          | resolved in T6                                        |
| T4: delayed-setImmediate stand not run             | task 4                | DROP                          | no effects in that file                               |
| T4/T7: IBM Plex in WebView2                        | tasks 4, 7            | CARRY                         | manual step 6 below                                   |
| T5: equivalent mutant #15                          | task 5                | DROP                          | redundant by construction                             |
| T6: 64 px not measurable; no 400 ms guard in setup | task 6                | CARRY / DROP                  | manual measurement; setup has no guard by design      |
| T7: production-browser has no standalone spec      | task 7                | CARRY                         | manual                                                |

### Fix wave (≤ 5 commits)

1. **docs: correct and complete the manual driver check.** In the runbook:
   - steps 6–7: a paused or offline queue gives `sent` and the queue check reads `present`;
     timeout/unknown only with a blocking queue; «Печать прервалась» only for a restart during
     an unanswered call;
   - the 58×40 test-label note;
   - the downgrade warning;
   - how to capture stderr;
   - the prioritized first-test list below.

   In AGENTS «Hardware», add one sentence: the queue is freed at 30 s while the Win32 call may go on (M3).

2. **feat(shell): one stderr line per driver refusal.** Name the step (`OpenPrinterW`,
   `DocumentPropertiesW` size/out/merge, `CreateDCW`, `StartDocW`, `StartPage`, `StretchDIBits`
   with its return value against `h`, `EndPage`, `EndDoc`) and the `GetLastError` value. On
   `geometry_mismatch`, also write the page's dots/dpi, `Caps` and the output DEVMODE's
   orientation, copies, scale, paper and print quality. Numbers only. Type-check with the probe
   crate (`cargo clippy --tests --target x86_64-pc-windows-msvc -- -D warnings`).
3. **fix(shell): `check_geometry` requires a printable origin inside the page** (M5). Add a unit
   test with no required bounds and `offset_x = width`.
4. **test(standalone): pin the driver path end to end, and add the two missing observation shapes.**
   - End to end (M1): a box closed on a driver profile has prepared bytes that `decodeMonoRaster`
     reads at the profile's dpi, and they reach `printWindowsRaster` once as `Markiro:<uuid>`.
   - Fixture (M2): `windowsJobIdentityMismatch`, `windowsJobUnavailable` in Rust and TS; key count 9.

## (c) Отклонения при исполнении (для раздела плана)

- Задача 1: clippy 1.93 отверг `start % 2 != 0` (`manual_is_multiple_of`) — в `native::observe`
  записано `!start.is_multiple_of(2)` (тот же смысл); `cargo fmt` переложил четыре длинных
  `assert!`; комментарий модуля `printer.rs` вставлен после строки `connection is not seen here.`;
  к тестам брифа добавлено 12 (разбор заголовка, границы, отступы строк, имя документа, порядок
  отказов), потому что тест «испорченной страницы» из брифа проходил и на заглушке.
- Задача 2: тела асинхронных команд вынесены в `print_within`/`observe_within`/`unknown_print`, чтобы
  ответ при пределе и при гибели потока проверялся коротким пределом, а не ожиданием 30 с; ответы те
  же, добавлено 5 тестов.
- Задача 3: в `default` исчерпывающего `switch` добавлена проверка `never` (новый код драйвера без
  сопоставления не компилируется); 38 тестов сверх брифа.
- Задача 4: в тесте брифа SSCC `046006820000035007` не проходит контрольную цифру GS1-128 при
  рисовании растра — взят `046006820000035008`; параметр `rasterize` у `renderLabel` стал
  необязательным (растеризатор по умолчанию выбирается по способу печати).
- Задача 5: макет `printWindowsRaster` в тесте типизирован `Promise<PrintResult>` (литерал брифа
  расширялся до `boolean`).
- Задача 6: эффект `supportsWindowsDriver` поставлен перед комментарием `usbAsk`, а не после
  последнего `useState` (все хуки — до раннего возврата); в тесте «RAW-принтер» добавлено ожидание
  загрузки настроек.
- Задача 7: §28 дописан в конец спецификации (разделов 25–27 в ветке ещё нет); в AGENTS, §28 и
  ручную проверку добавлены честные хвосты «не проверено» (вызовы спулера и GDI ни разу не
  запускались, IBM Plex в WebView2, контракт ≥ 64 px — вручную).
- Итоговое ревью: шаги 6–7 ручной проверки (текст плана) обещали «Принтер не ответил вовремя» /
  «Печать прервалась» для приостановленной очереди — при спулинге такое задание `sent`; исправляется
  волной правок (коммит 1).

## Evidence

- Build: `cargo build --workspace --tests --offline --locked` exit 0. Domain dist rebuilt for 7c1458672.
- Focused runs at 7c1458672:
  - Vitest, 4 driver files: 114 passed.
  - Vitest, 9 print/setup/work files: 322 passed.
  - `hardware.test.ts`: 115 passed.
  - cargo `--lib printer::`: 75 passed.
  - cargo `--test ipc driver_printing`: 1 passed.
  - cargo `--test hardware_shapes`: 1 passed.
- Windows target: probe crate `/tmp/claude/rv-drv-probe` (includes the review commit's
  `raster.rs`/`driver.rs` by path, windows-sys 0.61.2 with the manifest's features).
  `cargo clippy --tests --target x86_64-pc-windows-msvc -- -D warnings` is clean. Signatures were
  checked against the registry source: `PRINTER_HANDLE` struct, `GetDeviceCaps(i32)`,
  `StretchDIBits`, `GetJobW`, `DEVMODEW`/`JOB_INFO_1W` layouts. `mod native` diffs against the
  cloud's `1329be61c` `printer_windows.rs` show no semantic change.
- Mutants (my own; scripts `/tmp/claude/rv-drv-mut/{mut,rmut}.py`; logs alongside; every restore
  checked with sha256 and `cmp` and the file touched; `git status --short` empty): 15 run, 13 killed, 2 survived.
  - T14: send mode from `job.printer` instead of the rebind printer. Killed (2 tests).
  - T10: driver to a non-Windows target goes RAW. Killed.
  - B: `printAgain` renders without the mode. Killed (3).
  - **C: `prepareLabelJob` renders without the mode. SURVIVED** (M1).
  - D: test print renders without the mode. Killed (2).
  - E: `no_receipt` becomes `absent`. Killed (4).
  - F: delivery in doubt without a matching receipt becomes `driver_not_started`. Killed (5+).
  - G: `settleOutcome` drops `driver_unknown` from unknown. Killed (4).
  - J: rejected driver IPC becomes `not_sent`. Killed.
  - R-A: stalled print becomes `before_start`. Killed (2).
  - **R-B: padding `x >= w` dropped. SURVIVED, equivalent** (M9).
  - R-C: `dpi_y` check dropped. Killed (2).
  - R-D: receipt dropped after a failure past `begin`. Killed.
  - R-E: `artifact` skips `decode`. Killed.
  - R-F: exact length becomes `>`. Killed.

## Owner's first Windows test (priority order)

1. Start the beta from `cmd` with `2> drv-log.txt` (after fix 2). Note the printer model, driver name/version and the driver's dpi.
2. Setup → Windows queue → «Через драйвер Windows», dpi = driver's → «Пробная печать» on stock ≥ 58×40 mm.
   Measure the label (58×40 mm, not scaled, not mirrored, not inverted). The Code 128 scans and matches.
3. If the test print says «Размер бумаги или разрешение … не совпадают»: send `drv-log.txt` (caps vs page) and try the other dpi.
4. If every print says «Windows не подтвердил задание до конца» and nothing comes out, report it at once (StretchDIBits/EndDoc answer).
5. Profile dpi 300 on a 203 driver: refusal, nothing printed, nothing in the Windows queue.
6. A real shift on the real stock: close a box and a pallet. Check size, Cyrillic in IBM Plex, and that SSCC (GS1-128) and DataMatrix scan with exact payloads.
7. Pause the queue: the label is `sent`. The scan check waits, and «Проверить очередь Windows» reads «Задание находится в очереди». Resume: exactly one label comes out.
8. A queue that blocks (network printer unplugged, "print directly"): after 20 s «Принтер не ответил вовремя». Nothing reprints by itself. «Напечатать снова» asks for a reason. Note whether the original comes out later.
9. Restart the app during step 8's wait: «Печать прервалась», and «Проверить очередь» reads «Номер задания Windows неизвестен».
10. Switch the same queue back to «На языке принтера»: ZPL/TSPL prints as before. Measure the new setup controls (≥ 64 px).
